/**
 * 전달사항 보내기 (관리자 → 기사)
 *  기사 앱 알림 목록 + 휴대폰 알림(푸시) + 앱 아이콘 숫자로 전달된다. (품앗이·정산 마감 알림과 같은 길)
 *  보낸 기록 DB 시트 "msg_log" : 때 · 보낸 사람 · 받는 사람 수 · 받는 사람 · 제목 · 내용 · 알림ID
 */
const MSG = { LOG: 'msg_log', HEAD: ['때', '보낸 사람', '받는 사람 수', '받는 사람', '제목', '내용', '알림ID'] };

function msgLog_(limit) {
  const sh = ss_().getSheetByName(MSG.LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(limit || 30, sh.getLastRow() - 1), from = sh.getLastRow() - n + 1;
  return sh.getRange(from, 1, n, MSG.HEAD.length).getValues().map(function (r) {
    return { at: str_(r[0]), by: str_(r[1]), n: Number(r[2]) || 0, to: str_(r[3]), title: str_(r[4]), body: str_(r[5]) };
  }).reverse();
}
/** 알림 켠 기기가 있는 기사 id (휴대폰 알림을 받을 수 있는 사람) */
function msgPushIds_() {
  const m = {};
  readAll_(SH.PPUSH).forEach(function (o) { if (o.driverId && o.token) (m[o.driverId] = m[o.driverId] || []).push(o.token); });
  return m;
}

/** 여러 기사에게 한 번에 보낼 때: 기기 목록을 한 번만 읽어 캐시에 넣는다 */
function msgPushPrime_(list) {
  try {
    const tok = msgPushIds_(), c = cache_();
    (list || []).forEach(function (x) { c.put('pmt:' + x.driverId, JSON.stringify(tok[x.driverId] || []), 600); });
    return tok;
  } catch (e) { return {}; }
}
/** 보내기 창 정보: 최근 보낸 기록 + 휴대폰 알림 켠 기사 */
function adm_msgInfo(token) {
  return run_(function () {
    requireAdmin_(token);
    return { ok: true, log: msgLog_(30), pushIds: Object.keys(msgPushIds_()) };
  });
}

/** 전달사항 보내기. ids = 기사 id 배열 (앱 사용 중인 기사만 받음) */
function adm_msgSend(token, ids, title, body) {
  return run_(function () {
    const a = requireAdmin_(token);
    title = str_(title).replace(/\s+/g, ' ').replace(/ · /g, ' ').slice(0, 60);
    body = String(body == null ? '' : body).replace(/\r/g, '').trim().slice(0, 1000);
    if (!title) fail_('제목을 입력해 주세요.');
    if (!body) fail_('내용을 입력해 주세요.');
    const want = {};
    (ids || []).forEach(function (x) { want[String(x)] = 1; });
    const drv = readAll_(SH.DRIVERS).filter(function (o) { return o.id && want[o.id] && o.status === ST.ACTIVE; });
    if (!drv.length) fail_('받을 기사가 없습니다. (기사 앱 사용 중인 기사만 받을 수 있습니다)');
    const mid = uniqId_('M'), jobId = 'MS-' + mid;
    const out = drv.map(function (o) { return { driverId: String(o.id), name: o.name, jobId: jobId, kind: 'msg', title: '📢 ' + title, text: body }; });
    // 휴대폰 알림용 기기 목록을 한 번에 읽어 둔다 (기사마다 시트를 읽지 않게)
    const tok = msgPushPrime_(out);
    const sh = uitSheet_(MSG.LOG, MSG.HEAD, '관리자앱 → 기사 정보관리 → 전달사항 보내기 기록');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      pmAlertAdd_(out);
      const names = drv.map(function (o) { return o.name; }).join(', ');
      sh.appendRow([nowText_(), a.name, drv.length, names.length > 2000 ? names.slice(0, 2000) + '…' : names, title, body, jobId]);
    } finally { lock.releaseLock(); }
    let sent = 0;
    try { sent = pmPushSend_(out) || 0; } catch (e) { console.error('전달사항 푸시 실패: ' + (e && e.message)); }
    logAdmin_(a, '전달사항 보내기', drv.length + '명', title);
    return { ok: true, n: drv.length, pushN: out.filter(function (x) { return (tok[x.driverId] || []).length; }).length, sent: sent, log: msgLog_(30) };
  });
}
