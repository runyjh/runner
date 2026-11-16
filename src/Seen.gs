/**
 * 기사앱 확인 기록 (app_seen 시트)
 *  - 공지를 처음 연 시각 · 정산서(월)를 처음 연 시각 · 앱을 마지막으로 연 시각
 *  - 관리자가 기사스케줄 칸을 바꾸면 '스케줄 변경' 한 줄 → 기사가 앱에서 [확인했습니다] 를 누르면 확인 시각
 *  종류: notice(대상 = 공지ID) · slip(대상 = 정산월) · open(기사마다 한 줄 · 확인시각 = 마지막으로 연 시각 · 내용 = 연 날 수) · sch(대상 = 날짜)
 */
const SEEN_KIND = { NOTICE: 'notice', SLIP: 'slip', OPEN: 'open', SCH: 'sch' };
const SEEN_CANCEL = '취소'; // 확인 전에 원래 값으로 되돌린 변경

/** 잠금 안에서만: 여러 줄을 한 번에 붙인다 */
function seenAppend_(objs) {
  if (!objs.length) return;
  const c = cols_(SH.SEEN, true), sh = sheet_(SH.SEEN);
  const rows = objs.map(function (o) { const arr = new Array(c.__w).fill(''); Object.keys(o).forEach(function (k) { if (c[k] !== undefined) arr[c[k]] = safeText_(o[k]); }); return arr; });
  const r = sh.getLastRow() + 1;
  if (r + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 500);
  sh.getRange(r, 1, rows.length, c.__w).setNumberFormat('@').setValues(rows);
}
function seenChangeView_(o) { return { date: o.key, old: o.old, value: o.text, at: o.at }; }

/**
 * 기사 앱: 본 것을 기록하고(처음 한 번만), 아직 확인하지 않은 스케줄 변경을 돌려준다.
 * items = [{ k: 'notice'|'slip'|'open', key }] → { ok, changes: [{ date, old, value, at }], today }
 */
function api_seen(token, items) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    const id = String(s.d), now = nowText_(), today = todayText_();
    const want = (Array.isArray(items) ? items : []).slice(0, 40).map(function (x) { return { k: str_(x && x.k), key: str_(x && x.key).slice(0, 60) }; })
      .filter(function (x) { return x.k === SEEN_KIND.OPEN || ((x.k === SEEN_KIND.NOTICE || x.k === SEEN_KIND.SLIP) && x.key); })
      .filter(function () { return !s.pv; }); // 미리 보기는 아무것도 적지 않는다 (아직 확인 안 한 스케줄 변경만 읽어 줌)
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const mine = readAll_(SH.SEEN).filter(function (o) { return o.driverId === id; });
      const have = {};
      mine.forEach(function (o) { have[o.kind + '|' + o.key] = o; });
      const add = [];
      want.forEach(function (x) {
        if (x.k === SEEN_KIND.OPEN) {
          const o = have[SEEN_KIND.OPEN + '|'];
          if (!o) { const n = { kind: SEEN_KIND.OPEN, driverId: id, name: info.name, key: '', text: '1', at: now, ackAt: now }; add.push(n); have[SEEN_KIND.OPEN + '|'] = n; }
          else if (o._row && String(o.ackAt).slice(0, 10) !== today) writeFields_(SH.SEEN, o._row, { ackAt: now, text: String((Number(o.text) || 0) + 1) }); // 하루에 한 번만 고친다
          return;
        }
        const k = x.k + '|' + x.key;
        if (have[k]) return;
        const n = { kind: x.k, driverId: id, name: info.name, key: x.key, at: now };
        add.push(n); have[k] = n;
      });
      seenAppend_(add);
      const tom = schAddDays_(today, 1), nowMs = Date.now();
      const changes = mine.filter(function (o) { return o.kind === SEEN_KIND.SCH && !o.ackAt && o.key >= today && seenChangeDue_(o, tom, nowMs); }).map(seenChangeView_)
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      return { ok: true, changes: changes, today: today };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 스케줄 변경을 지금 기사에게 알릴 때인지: 오늘 · 내일(PDD) 변경은 바로, 그 뒤 날짜는 마지막으로 고친 뒤 10분 동안 더 안 바뀌었을 때
 *  (스케줄을 짜는 동안 앱을 열어 둔 기사에게 확인 창이 여러 번 뜨지 않게 — 바뀐 값 자체는 스케줄 화면에 바로 보인다)
 */
const SEEN_QUIET_MS = 600000;
function seenChangeDue_(o, tomorrow, nowMs) {
  if (str_(o.key) <= tomorrow) return true;
  const t = toMs_(o.at);
  return !t || nowMs - t >= SEEN_QUIET_MS;
}
/** 기사 앱: 스케줄 변경 [확인했습니다] — dates 가 없으면 아직 확인 안 한 것 전부 */
function api_seenAck(token, dates) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    const id = String(s.d), now = nowText_(), only = Array.isArray(dates) && dates.length ? dates.map(str_) : null;
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      let n = 0;
      readAll_(SH.SEEN).forEach(function (o) {
        if (o.driverId !== id || o.kind !== SEEN_KIND.SCH || o.ackAt || (only && only.indexOf(o.key) < 0)) return;
        writeFields_(SH.SEEN, o._row, { ackAt: now }); n++;
      });
      return { ok: true, n: n };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 기사스케줄 저장 뒤 (잠금 안에서 호출): 기사 줄의 '이미 값이 있던 칸'이 바뀌었으면 스케줄 변경 기록을 남긴다.
 * 오늘 이후 날짜만 · 처음 채우는 칸(빈칸 → 값)은 변경이 아님 · 확인 전에 또 바뀌면 그 줄을 고치고, 원래 값으로 돌아가면 취소로 닫는다
 */
function seenSchChanges_(a, savedList) {
  const today = todayText_();
  // 서브아이디 업무등록 표기만 붙거나 빠진 것은 기사에게 바뀐 것이 없으므로 기록하지 않는다
  const plain = function (v) { return str_(v).replace(/\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)/g, ' ').replace(/업무등록/g, ' ').replace(/\s+/g, ' ').trim(); };
  const list = (savedList || []).filter(function (x) {
    const row = str_(x.row);
    return row && !/^NOTE\d+$/.test(row) && row.indexOf(SCH_PM_PREFIX) !== 0 && !schExParse_(row) && x.date >= today && plain(x.old) !== '' && plain(x.old) !== plain(x.value);
  });
  if (!list.length) return 0;
  const now = nowText_(), open = {};
  readAll_(SH.SEEN).forEach(function (o) { if (o.kind === SEEN_KIND.SCH && !o.ackAt) open[o.driverId + '|' + o.key] = o; });
  const add = [];
  list.forEach(function (x) {
    const k = x.row + '|' + x.date, o = open[k], val = str_(x.value).replace(/\n/g, ' / '), old = str_(x.old).replace(/\n/g, ' / ');
    if (o && o._row) {
      if (plain(val) === plain(o.old)) { writeFields_(SH.SEEN, o._row, { ackAt: SEEN_CANCEL, text: val, at: now }); delete open[k]; }
      else writeFields_(SH.SEEN, o._row, { text: val, at: now, by: a.name || a.loginId });
      return;
    }
    if (o) { o.text = val; o.at = now; return; } // 같은 저장 안에서 같은 칸이 두 번
    const n = { kind: SEEN_KIND.SCH, driverId: x.row, name: '', key: x.date, old: old, text: val, at: now, by: a.name || a.loginId };
    add.push(n); open[k] = n;
  });
  seenAppend_(add);
  return list.length;
}

/** 관리자: 기사앱 확인 기록 한 번에 (기사앱 사용 기사 · 공지 · 기록 줄) */
function adm_seenList(token) {
  return run_(function () {
    requireAdmin_(token);
    const today = todayText_(), cn = {};
    master_().camps.forEach(function (c) { cn[c.id] = c.name; });
    const short = function (n) { return str_(n).replace(/\s+/g, '').replace(/캠프$/, ''); };
    const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.status === ST.ACTIVE; })
      .map(function (o) { return { id: String(o.id), name: o.name, camp: short(cn[o.schCampId] || o.schCamp || ''), title: titleOf_(o) || '' }; });
    const lim = Utilities.formatDate(new Date(Date.now() - 60 * 86400000), CFG.TZ, 'yyyy-MM-dd');
    const notices = noticeAll_().filter(function (n) { return n.status === NST.ON && (!n.end || n.end >= lim); }).sort(function (x, y) { const p = x.start || x.createdAt, q = y.start || y.createdAt; return p < q ? 1 : p > q ? -1 : 0; }).slice(0, 60)
      .map(function (n) { return { id: n.id, title: n.title, date: (n.start || n.createdAt || '').slice(0, 10), targets: noticeTargets_(n.target), targetDrv: n.targetDrv || [], live: noticeLive_(n, today), important: n.important }; });
    const rows = readAll_(SH.SEEN).filter(function (o) { return o.kind && o.driverId; })
      .map(function (o) { return { k: o.kind, d: o.driverId, key: o.key, old: o.old, text: o.text, at: o.at, ack: o.ackAt, by: o.by }; });
    return { ok: true, today: today, drivers: drivers, notices: notices, rows: rows, act: onlineMap_(drivers.map(function (d) { return d.id; })), now: Date.now(), nowMs: ONLINE.NOW_MS };
  });
}
// ───── 기사앱 접속 중 · 마지막 활동 시각 ─────
// 기사앱이 서버에 무언가 요청할 때마다(getSession_) 부른다. 시트에는 쓰지 않는다.
//  · 접속 중: 임시 기억 on:<기사ID> = "마지막 활동 ms|마지막으로 오래 남긴 ms" (1분에 한 번만 갱신)
//  · 마지막 활동(기한 없이): 스크립트 속성 APP_ONLINE = { 기사ID: 분 단위 시각 } — 기사당 10분에 한 번만 씀
const ONLINE = { LIVE_MS: 60000, KEEP_MS: 600000, PROP: 'APP_ONLINE', NOW_MS: 300000 };
function onlineTouch_(driverId) {
  try {
    const id = String(driverId || ''); if (!id) return;
    const ck = cache_(), key = 'on:' + id, now = Date.now();
    const p = String(ck.get(key) || '').split('|'), t = Number(p[0]) || 0, w = Number(p[1]) || 0;
    if (now - t < ONLINE.LIVE_MS) return;
    const keep = now - w >= ONLINE.KEEP_MS;
    ck.put(key, now + '|' + (keep ? now : w), 21600);
    if (!keep) return;
    const P = PropertiesService.getScriptProperties();
    let m = {}; try { m = JSON.parse(P.getProperty(ONLINE.PROP) || '{}') || {}; } catch (e) { m = {}; }
    m[id] = Math.floor(now / 60000);
    P.setProperty(ONLINE.PROP, JSON.stringify(m));
  } catch (e) { /* 접속 표시는 덤 — 실패해도 요청은 그대로 */ }
}
/** 기사별 마지막 활동 시각(ms) — 임시 기억(1분 단위)과 오래 남긴 값(10분 단위) 중 더 최근 것 */
function onlineMap_(ids) {
  const out = {};
  try { const m = JSON.parse(PropertiesService.getScriptProperties().getProperty(ONLINE.PROP) || '{}') || {}; Object.keys(m).forEach(function (id) { out[id] = (Number(m[id]) || 0) * 60000; }); } catch (e) { /* 없음 */ }
  try {
    const keys = (ids || []).map(function (id) { return 'on:' + id; }), hit = keys.length ? cache_().getAll(keys) : {};
    Object.keys(hit || {}).forEach(function (k) { const t = Number(String(hit[k]).split('|')[0]) || 0, id = k.slice(3); if (t > (out[id] || 0)) out[id] = t; });
  } catch (e) { /* 임시 기억을 못 읽으면 오래 남긴 값만 */ }
  return out;
}

/** 관리자: 공지를 아직 안 본 기사에게 휴대폰 알림 → { ok, target, pushed } */
function adm_seenNudge(token, noticeId) {
  return run_(function () {
    const a = requireAdmin_(token);
    const today = todayText_(), n = noticeAll_().filter(function (x) { return x.id === str_(noticeId); })[0];
    if (!n || !noticeLive_(n, today)) fail_('지금 게시 중인 공지가 아닙니다.');
    const cn = {};
    master_().camps.forEach(function (c) { cn[c.id] = c.name; });
    const seen = {};
    readAll_(SH.SEEN).forEach(function (o) { if (o.kind === SEEN_KIND.NOTICE && o.key === n.id) seen[o.driverId] = 1; });
    const list = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.status === ST.ACTIVE && !seen[String(o.id)] && noticeFor_(n, cn[o.schCampId] || o.schCamp || '', o.id); });
    let pushed = 0;
    try { pushed = pmPushSend_(list.map(function (o) { return { driverId: String(o.id), title: '📢 공지를 확인해 주세요', text: n.title, jobId: '', kind: 'notice' }; })) || 0; } catch (e) { softFail_('공지 확인 알림 실패', e); }
    logAdmin_(a, '공지 확인 알림', n.title, '안 본 기사 ' + list.length + '명 · 알림 ' + pushed + '건');
    return { ok: true, target: list.length, pushed: pushed };
  });
}
