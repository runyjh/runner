/**
 * Firestore 읽기 사본 (파이어베이스 프로젝트 runner-push)
 *  - 원본은 지금처럼 구글 시트. 저장할 때(그리고 시트를 직접 고쳤을 때) 화면에 보낼 묶음을 Firestore 문서로도 복사한다.
 *  - 정해 둔 화면만 Firestore 에서 읽고, 못 읽으면(설정 없음 · 오프라인 · 권한 · 오래된 문서) 지금처럼 서버(시트)에서 읽는다.
 *  - 로그인한 사람에게 파이어베이스 커스텀 토큰을 발급: 기사 = { r:'d', d:기사ID } → 자기 문서만, 관리자 = { r:'a' } → 전체 (firestore.rules).
 *  - 비밀 키(서비스 계정 키 JSON)는 코드에 두지 않는다: 스크립트 속성 FIREBASE_SA (없으면 푸시용 FCM_SA 를 같이 씀).
 *  - 끄기: 스크립트 속성 FS_OFF = 1 → 복사도 읽기도 안 함 (전부 시트에서).
 */
const FS_VER = 1; // 문서 모양이 바뀌면 올림 → 예전 문서는 안 읽음

function fsCfg_() {
  const p = props_();
  if (str_(p.FS_OFF) === '1') return null;
  let sa = null;
  try { sa = JSON.parse(p.FIREBASE_SA || p.FCM_SA || 'null'); } catch (e) { sa = null; }
  if (!sa || !sa.client_email || !sa.private_key) return null;
  const pid = str_(p.FS_PROJECT) || sa.project_id || 'runner-push';
  return { sa: sa, pid: pid };
}
function fsB64_(o) { return Utilities.base64EncodeWebSafe(typeof o === 'string' ? o : JSON.stringify(o)).replace(/=+$/, ''); }
function fsSign_(sa, claim) {
  const head = fsB64_({ alg: 'RS256', typ: 'JWT' }), body = fsB64_(claim);
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(head + '.' + body, sa.private_key)).replace(/=+$/, '');
  return head + '.' + body + '.' + sig;
}
/** 서버 → Firestore 쓰기용 접근 토큰 (50분 캐시) */
function fsAccess_(cfg) {
  const c = cache_(), hit = c.get('fs:at');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const jwt = fsSign_(cfg.sa, { iss: cfg.sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', muteHttpExceptions: true, payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt } });
  const j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) throw new Error('Firestore 접근 토큰 실패: ' + res.getContentText().slice(0, 200));
  c.put('fs:at', j.access_token, 3000);
  return j.access_token;
}
/**
 * 로그인한 사람용 파이어베이스 커스텀 토큰 (1시간 안에 앱이 signInWithCustomToken 으로 바꿔 씀)
 * uid: 'd_기사ID' / 'a_관리자아이디'
 */
function fsCustomToken_(uid, claims) {
  const cfg = fsCfg_();
  if (!cfg) return null;
  const now = Math.floor(Date.now() / 1000);
  return fsSign_(cfg.sa, {
    iss: cfg.sa.client_email, sub: cfg.sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid: String(uid).slice(0, 120), claims: claims
  });
}
/** 앱 화면용 파이어베이스 웹 설정 (공개값) */
function fsWeb_() {
  const c = typeof pmPushCfg_ === 'function' ? pmPushCfg_() : { web: null };
  const w = c.web || (typeof PM_FCM_WEB !== 'undefined' ? PM_FCM_WEB : null);
  return w ? { apiKey: w.apiKey, authDomain: w.authDomain || '', projectId: w.projectId, appId: w.appId } : null;
}
/** 기사 앱: 파이어베이스 로그인 토큰 */
function api_fsToken(token) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE) return { ok: false, code: 'EXPIRED' };
    const t = fsCustomToken_('d_' + s.d, { r: 'd', d: String(s.d) });
    return t ? { ok: true, on: true, token: t, web: fsWeb_(), ver: FS_VER } : { ok: true, on: false };
  });
}
/** 관리자 앱: 파이어베이스 로그인 토큰 */
function adm_fsToken(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    fsEnsureTrigger_();
    const t = fsCustomToken_('a_' + a.loginId, { r: 'a' });
    return t ? { ok: true, on: true, token: t, web: fsWeb_(), ver: FS_VER } : { ok: true, on: false };
  });
}

/**
 * 문서 여러 개를 한 번에 쓰기 (documents:commit · 최대 450개씩)
 * docs: [{ path: 'drv/123/v/sched', data: 객체 }] → 문서 = { j: JSON 글자, at: 저장 시각(ms), v: FS_VER }
 * 실패해도 시트 저장은 그대로 (읽을 때 서버로 돌아감). 실패는 로그에만.
 */
function fsPut_(docs, atMs) {
  const cfg = fsCfg_();
  if (!cfg || !docs || !docs.length) return 0;
  if (cache_().get('fs:down')) return 0; // 최근에 실패 → 10분 동안 쉬었다가 (저장이 느려지지 않게)
  try {
    const at = fsAccess_(cfg), base = 'projects/' + cfg.pid + '/databases/(default)/documents/';
    let n = 0;
    for (let i = 0; i < docs.length; i += 450) {
      const writes = docs.slice(i, i + 450).map(function (d) {
        const j = JSON.stringify(d.data);
        if (j.length > 900000) throw new Error('문서가 너무 큽니다: ' + d.path);
        return { update: { name: base + d.path, fields: { j: { stringValue: j }, at: { integerValue: String(atMs || Date.now()) }, v: { integerValue: String(FS_VER) } } } };
      });
      const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + base.replace(/\/documents\/$/, '/documents') + ':commit', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + at },
        payload: JSON.stringify({ writes: writes })
      });
      if (res.getResponseCode() >= 300) throw new Error('Firestore 쓰기 실패 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
      n += writes.length;
    }
    return n;
  } catch (e) {
    console.error('Firestore 복사 실패 (시트는 저장됨): ' + (e && e.message));
    try { cache_().put('fs:err', nowText_() + ' ' + String(e && e.message).slice(0, 300), 21600); } catch (x) { /* 무시 */ }
    try { cache_().put('fs:down', '1', 600); } catch (x) { /* 무시 */ }
    return 0;
  }
}
/** 문서 지우기 (기사 삭제 등) */
function fsDel_(paths) {
  const cfg = fsCfg_();
  if (!cfg || !paths || !paths.length) return 0;
  try {
    const at = fsAccess_(cfg), base = 'projects/' + cfg.pid + '/databases/(default)/documents';
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + base + ':commit', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + at },
      payload: JSON.stringify({ writes: paths.map(function (p) { return { delete: base + '/' + p }; }) })
    });
    return res.getResponseCode() < 300 ? paths.length : 0;
  } catch (e) { console.error('Firestore 지우기 실패: ' + (e && e.message)); return 0; }
}

// ───────────────────────── 사본 화면 2개 (속도 측정으로 고름 · 2026-11-06) ─────────────────────────
// ① 기사 앱 홈 (앱 열 때): 서버 호출 4번 · 왕복 합 12.2초 (서버 일은 0.3초 — 나머지는 Apps Script 기본 대기) · 기사 전원이 앱을 열 때마다
// ② 관리자 기사스케줄 (이번 주): adm_schWeek 1번 5.8초 (서버 4.1초) · 가장 느린 관리자 화면
// 문서 묶음 (화면 1번 = 읽기 2번: 화면 문서 + pub/meta):
//   drv/{기사ID}   = { home: { today, notices(그 기사 캠프 공지), bd(게시판 최근 3개) } } ← 그 기사만 읽기
//   adm/sched      = { start: 이번 주 일요일, res: adm_schWeek 결과 }                  ← 관리자만
//   pub/meta       = { dirtyAt: 마지막으로 데이터가 바뀐 시각(ms) }                    ← 로그인한 사람
// 앱은 문서 at 이 dirtyAt 보다 나중이고 오늘 만든 것일 때만 씀 (아니면 서버 = 지금처럼).
// → 시트를 손으로 고쳐도(onSheetEdit / onSchEdit_) dirtyAt 이 바로 올라가 오래된 사본은 안 쓰인다.

/** 데이터가 바뀜: meta.dirtyAt 올리기 + 1분 트리거가 다시 만들도록 표시 */
function fsDirty_() {
  try {
    if (!fsCfg_()) return;
    const now = Date.now();
    cache_().put('fs:dirty', String(now), 21600);
    if (!fsDirty_.done) { fsDirty_.done = 1; fsPut_([{ path: 'pub/meta', data: { dirtyAt: now } }], now); }
  } catch (e) { console.error('fsDirty_: ' + (e && e.message)); }
}
/** 실행 안에서만 쓰는 임시 세션으로 기사 앱 함수 부르기 (사본 만들기용) */
function fsAs_(driverId, fn, args) {
  PERF_BENCH_ = { tok: Utilities.getUuid() + Utilities.getUuid(), s: { d: String(driverId), c: Date.now(), e: Date.now() + 60000, a: 0, th: 'fs' } };
  try { return fn.apply(null, [PERF_BENCH_.tok].concat(args || [])); } finally { PERF_BENCH_ = null; }
}
function fsClean_(r) { if (r && typeof r === 'object') delete r._ms; return r; }
/** 서버에서 읽은 김에 홈 사본도 저장 (api_notices 에서) */
function fsSaveDrvHome_(driverId, notices, t0) {
  if (!fsCfg_() || !notices || !notices.ok) return;
  let bd = null;
  try { bd = fsClean_(fsAs_(driverId, api_bdRecent, [])); } catch (e) { bd = null; }
  const n = JSON.parse(JSON.stringify(notices)); fsClean_(n);
  fsPut_([{ path: 'drv/' + driverId, data: { home: { today: n.today, notices: n.notices, bd: bd && bd.ok ? bd.posts : null } } }], t0);
}
function fsSaveAdmSched_(start, res, t0) {
  if (!fsCfg_() || !res || res.ok === false) return;
  const r = JSON.parse(JSON.stringify(res)); fsClean_(r);
  fsPut_([{ path: 'adm/sched', data: { start: start, res: r } }], t0);
}
/** 다시 만들기: 이번 주 관리자 표 + 로그인 중인 기사들의 홈 (공지 · 게시판 최근 글) */
function fsBuildSched_() {
  const sun = sundayOf_(new Date()), start = Utilities.formatDate(sun, CFG.TZ, 'yyyy-MM-dd');
  const t0 = Date.now(), docs = [];
  try { const a = schRead_(sun, addDays_(sun, SCH_DAYS - 1)); fsClean_(a); docs.push({ path: 'adm/sched', data: { start: start, res: a } }); } catch (e) { console.error('fs adm/sched: ' + e); }
  // 로그인(세션)이 살아 있는 기사만 — 나머지는 앱을 열 때 서버에서 읽으며 사본이 생김
  const now = Date.now(), live = {};
  readAll_(SH.SESSIONS).forEach(function (s) { const d = str_(s.driverId); if (d && d.indexOf(ADMIN_SESSION) !== 0 && toMs_(s.expiresAt) > now) live[d] = 1; });
  Object.keys(live).forEach(function (id) {
    if (Date.now() - t0 > 240000) return; // 4분 넘으면 나머지는 다음 번에
    try {
      const n = fsAs_(id, api_notices, []), b = fsAs_(id, api_bdRecent, []);
      if (n && n.ok) docs.push({ path: 'drv/' + id, data: { home: { today: n.today, notices: fsClean_(n).notices, bd: b && b.ok ? b.posts : null } } });
    } catch (e) { /* 그 기사만 건너뜀 */ }
  });
  return fsPut_(docs, t0);
}
/** 1분마다 (트리거): 바뀐 게 있으면 사본 다시 만들기 */
function fsSync() {
  if (!fsCfg_()) return;
  const c = cache_(), dirty = +c.get('fs:dirty') || 0, built = +c.get('fs:built') || 0;
  const today = todayText_(), day = c.get('fs:day');
  if (!(dirty > built) && day === today) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const t = Date.now();
    const n = fsBuildSched_();
    c.put('fs:built', String(t), 21600); c.put('fs:day', today, 21600);
    c.put('fs:last', JSON.stringify({ at: nowText_(), n: n, ms: Date.now() - t }), 21600);
  } finally { lock.releaseLock(); }
}
/** 1분 트리거 설치 (없으면 · 관리자 로그인 때 확인) */
function fsEnsureTrigger_() {
  if (!fsCfg_() || cache_().get('fs:trg')) return;
  try {
    const have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'fsSync'; });
    if (!have) ScriptApp.newTrigger('fsSync').timeBased().everyMinutes(1).create();
    cache_().put('fs:trg', '1', 21600);
  } catch (e) { console.error('fsSync 트리거 설치 실패: ' + e); }
}
/** 관리자: Firestore 사본 상태 */
function adm_fsStatus(token) {
  return run_(function () {
    requireAdmin_(token);
    const c = cache_(), cfg = fsCfg_();
    let last = null; try { last = JSON.parse(c.get('fs:last') || 'null'); } catch (e) { last = null; }
    return { ok: true, on: !!cfg, project: cfg ? cfg.pid : '', key: cfg ? (props_().FIREBASE_SA ? 'FIREBASE_SA' : 'FCM_SA') : '', err: c.get('fs:err') || '', last: last, trigger: !!c.get('fs:trg') };
  });
}
/** 관리자: 지금 사본 다시 만들기 */
function adm_fsRebuild(token) {
  return run_(function () {
    requireAdmin_(token);
    if (!fsCfg_()) fail_('스크립트 속성에 FIREBASE_SA(또는 FCM_SA) 서비스 계정 키가 없습니다.');
    cache_().remove('fs:down');
    fsEnsureTrigger_();
    const t = Date.now(), n = fsBuildSched_();
    cache_().put('fs:built', String(t), 21600); cache_().put('fs:day', todayText_(), 21600);
    return { ok: true, n: n, ms: Date.now() - t, err: n ? '' : cache_().get('fs:err') || '' };
  });
}
