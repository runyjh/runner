/**
 * Firestore 읽기 사본 (파이어베이스 프로젝트 runner-push)
 *  - 원본은 지금처럼 구글 시트. 저장할 때(그리고 시트를 직접 고쳤을 때) 화면에 보낼 묶음을 Firestore 문서로도 복사한다.
 *  - 정해 둔 화면만 Firestore 에서 읽고, 못 읽으면(설정 없음 · 오프라인 · 권한 · 오래된 문서) 지금처럼 서버(시트)에서 읽는다.
 *  - 로그인한 사람에게 파이어베이스 커스텀 토큰을 발급: 기사 = { r:'d', d:기사ID } → 자기 문서만, 관리자 = { r:'a' } → 전체 (firestore.rules).
 *  - 비밀 키(서비스 계정 키 JSON)는 코드에 두지 않는다: 스크립트 속성 FIREBASE_SA (없으면 푸시용 FCM_SA 를 같이 씀).
 *  - 끄기: 스크립트 속성 FS_OFF = 1 → 복사도 읽기도 안 함 (전부 시트에서).
 */
const FS_VER = 1; // 문서 모양이 바뀌면 올림 → 예전 문서는 안 읽음
// 파이어베이스 로그인 유효 시간 (토큰의 x = 이 시각까지만 읽기 허용 · firestore.rules).
// 파이어베이스는 한 번 로그인하면 스스로 계속 연장하므로, 퇴사·정지·관리자 삭제·비밀번호 변경이 늦어도 이 시간 안에 막히게 한다.
// 지나면 앱이 서버에 다시 받으러 오고, 서버는 그때 로그인·상태를 다시 확인한다.
const FS_TTL_DRV = 12 * 3600 * 1000, FS_TTL_ADM = 8 * 3600 * 1000;

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
    // 다른 기사 앱 함수와 같은 확인: 승인된 기사 · 비밀번호를 바꾼 뒤의 로그인 · 임시 비밀번호 변경 완료 · 퇴사 아님
    if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { ok: false, code: 'EXPIRED' };
    if (info.mustChange) return { ok: false, code: 'MUST_CHANGE' };
    const o = driverById_(s.d);
    if (!o || o.workStatus === '퇴사') return { ok: true, on: false };
    const x = Date.now() + FS_TTL_DRV;
    const t = fsCustomToken_('d_' + s.d, { r: 'd', d: String(s.d), x: x });
    return t ? { ok: true, on: true, token: t, web: fsWeb_(), ver: FS_VER, x: x } : { ok: true, on: false };
  });
}
/** 관리자 앱: 파이어베이스 로그인 토큰 */
function adm_fsToken(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    fsEnsureTrigger_();
    const x = Date.now() + FS_TTL_ADM;
    const t = fsCustomToken_('a_' + a.loginId, { r: 'a', x: x });
    return t ? { ok: true, on: true, token: t, web: fsWeb_(), ver: FS_VER, x: x } : { ok: true, on: false };
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
    softFail_('Firestore 복사 실패 (시트는 저장됨)', e);
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
  } catch (e) { softFail_('Firestore 지우기 실패', e); return 0; }
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

/** 데이터가 바뀜: meta.dirtyAt 올리기 + 1분 트리거가 다시 만들도록 표시
 *  area 'nb' = 공지·게시판이 바뀜 → meta.nbAt 도 올림 (기사앱 홈 사본은 nbAt 만 봄 → 다른 저장 때문에 홈 사본을 버리지 않음)
 *  nbAt 은 스크립트 속성 FS_NB_AT 에 보관 (캐시가 비어도 잃지 않게) */
function fsDirty_(area, extra) {
  try {
    if (!fsCfg_()) return;
    const now = Date.now(), d = fsDirty_.done || (fsDirty_.done = { areas: {}, ar: null });
    cache_().put('fs:dirty', String(now), 21600);
    const sp = PropertiesService.getScriptProperties();
    // 영역별 마지막 변경 시각 (관리자앱이 실시간으로 구독: sch = 기사스케줄 · pm = 품앗이 · nb = 공지·게시판) — 속성 FS_AREAS 에 보관
    if (!d.ar) {
      try { d.ar = JSON.parse(sp.getProperty('FS_AREAS') || '{}') || {}; } catch (e) { d.ar = {}; }
      if (!d.ar.nb) d.ar.nb = +(sp.getProperty('FS_NB_AT') || 0);
    }
    const ar = d.ar, key = area || 'all';
    if (area) {
      ar[area] = now;
      if (extra && extra.by) ar[area + 'By'] = String(extra.by).slice(0, 40);
      if (area === 'nb') { try { sp.setProperty('FS_NB_AT', String(now)); } catch (e) { /* 무시 */ } }
      try { sp.setProperty('FS_AREAS', JSON.stringify(ar)); } catch (e) { /* 무시 */ }
    }
    if (d.areas[key] || (!area && d.areas.any)) return; // 이번 실행에서 이미 알렸음 (영역 알림이 있었으면 일반 알림은 생략)
    d.areas[key] = 1; d.areas.any = 1;
    fsPut_([{ path: 'pub/meta', data: { dirtyAt: now, nbAt: ar.nb || 0, schAt: ar.sch || 0, schBy: ar.schBy || '', pmAt: ar.pm || 0, pmBy: ar.pmBy || '', tmAt: ar.tm || 0 } }], now);
  } catch (e) { softFail_('fsDirty_', e); }
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
/** 다시 만들기: 이번 주 관리자 표 + (withHome) 로그인 중인 기사들의 홈 (공지 · 게시판 최근 글)
 *  기사 홈 사본은 공지·게시판이 바뀌었을 때(nbAt)와 날이 바뀌었을 때만 다시 만든다 — 기사앱이 nbAt 만 보므로 그 밖의 저장 때는 만들어도 쓰이지 않음 */
function fsBuildSched_(withHome) {
  const sun = sundayOf_(new Date()), start = Utilities.formatDate(sun, CFG.TZ, 'yyyy-MM-dd');
  const t0 = Date.now(), docs = [];
  try { const a = schRead_(sun, addDays_(sun, SCH_DAYS - 1)); fsClean_(a); docs.push({ path: 'adm/sched', data: { start: start, res: a } }); } catch (e) { softFail_('fs adm/sched', e); }
  if (withHome === false) return fsPut_(docs, t0);
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
/**
 * 사본을 만드는 코드가 바뀌었는지 (배포할 때마다 확인): 바뀌었으면 예전 사본은 쓰지 않게 표시 → 새 코드로 다시 만듦.
 * 개발하면서 공지·게시판·기사스케줄 결과 모양을 바꿔도 손으로 할 일이 없다.
 */
function fsCodeCheck_() {
  try {
    const src = [api_notices, api_bdRecent, bdCard_, noticeFor_, noticeLive_, schRead_, schDriver_, fsBuildSched_, fsSaveDrvHome_, fsSaveAdmSched_].map(String).join('|') + '|' + FS_VER;
    const h = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, src, Utilities.Charset.UTF_8));
    const sp = PropertiesService.getScriptProperties();
    if (sp.getProperty('FS_CODE') !== h) { sp.setProperty('FS_CODE', h); fsDirty_(); return true; }
  } catch (e) { softFail_('fsCodeCheck_', e); }
  return false;
}
function fsSync() {
  if (!fsCfg_()) return;
  try { if (typeof hbMark_ === 'function') hbMark_('fs'); } catch (e) { /* 무시 */ } // 1분 트리거가 살아 있다는 표시 (15분에 한 번만 적음)
  fsCodeCheck_();
  const c = cache_(), dirty = +c.get('fs:dirty') || 0, built = +c.get('fs:built') || 0;
  const today = todayText_(), day = c.get('fs:day');
  if (!(dirty > built) && day === today) return;
  if (typeof fsCopyOn_ === 'function' && !fsCopyOn_()) return; // 읽기 사본 만들기를 꺼 둠 (app_settings fsCopy = off)
  // 겹침 방지는 캐시 표시로만: 전체 잠금(LockService)을 잡으면 사본을 만드는 몇 분 동안 앱의 모든 저장이 "다른 저장 작업이 처리 중"으로 막힌다
  if (c.get('fs:busy')) return;
  c.put('fs:busy', '1', 330);
  try {
    const nb = +(PropertiesService.getScriptProperties().getProperty('FS_NB_AT') || 0), nbBuilt = +c.get('fs:nbBuilt') || 0;
    const withHome = day !== today || !nbBuilt || nb > nbBuilt;
    const t = Date.now();
    const n = fsBuildSched_(withHome);
    c.put('fs:built', String(t), 21600); c.put('fs:day', today, 21600);
    if (withHome) c.put('fs:nbBuilt', String(Math.max(nb, 1)), 21600);
    c.put('fs:last', JSON.stringify({ at: nowText_(), n: n, ms: Date.now() - t, home: withHome }), 21600);
    try { if (typeof fsStat_ === 'function') fsStat_(Date.now() - t); } catch (e) { /* 무시 */ } // 하루에 사본 만들기에 쓴 시간 (자동 작업 시간 한도 확인용)
  } finally { c.remove('fs:busy'); }
}
/** 1분 트리거 설치 (없으면 · 관리자 로그인 때 확인) */
function fsEnsureTrigger_() {
  if (!fsCfg_() || cache_().get('fs:trg')) return;
  try {
    const have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'fsSync'; });
    if (!have) ScriptApp.newTrigger('fsSync').timeBased().everyMinutes(1).create();
    cache_().put('fs:trg', '1', 21600);
  } catch (e) { softFail_('fsSync 트리거 설치 실패', e); }
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

/** 기사를 지우면 그 기사 사본도 지움 */
function fsDropDriver_(ids) { try { if (fsCfg_() && ids && ids.length) fsDel_(ids.map(function (id) { return 'drv/' + id; })); } catch (e) { /* 무시 */ } }

/** 관리자: 영역별 마지막 변경 시각 (Firestore 구독을 못 쓸 때 60초마다 묻는 대비용) */
function adm_live(token) {
  return run_(function () {
    requireAdmin_(token);
    let ar = {};
    try { ar = JSON.parse(PropertiesService.getScriptProperties().getProperty('FS_AREAS') || '{}') || {}; } catch (e) { ar = {}; }
    return { ok: true, dirtyAt: +(cache_().get('fs:dirty') || 0), schAt: ar.sch || 0, schBy: ar.schBy || '', pmAt: ar.pm || 0, pmBy: ar.pmBy || '', nbAt: ar.nb || 0, tmAt: ar.tm || 0 };
  });
}
