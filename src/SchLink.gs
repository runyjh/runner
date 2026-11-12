/**
 * 같은 근무자 연결 — 한 사람이 날짜를 나눠 두 명의의 아이디를 쓰는 경우 (한 아이디로 주 7일 등록이 안 돼서)
 *  서브아이디와 다른 점: 정산서 · 세금계산서가 명의별로 따로 나온다 (매출을 합치지 않음)
 *  설정: 명의 기사(예: 이윤형)의 '실제 근무자 기사ID' = 근무자(예: 정유정)
 *  스케줄: 근무자 한 줄. 다른 명의 아이디로 뛰는 날은 칸에 '노선 (그 아이디) 업무등록' (칸 입력 창에서 버튼으로 고름)
 *  근무일수: 근무자 본인 정산서 = 본인 아이디·서브아이디로 뛴 날 / 명의 정산서 = 근무자 줄에서 그 아이디가 적힌 날
 */
/** 칸 글자에 적힌 아이디들 (소문자) */
function schCellIds_(v) {
  const ids = [];
  str_(v).replace(/\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)/g, function (m0, id) { if (!/^[DF]\d$/i.test(id)) ids.push(id.toLowerCase()); return m0; });
  return ids;
}
/**
 * 연결 미리보기 · 실행 · 풀기
 *  ownerId = 명의 기사, workerId = 실제 근무자 ('' = 연결 풀기), apply = true 면 실행
 *  연결할 때: 이 정산 기간 시작 ~ 60일 뒤까지, 명의 기사 줄의 출근 칸을 근무자 줄로 옮긴다 ('노선 (명의 아이디) 업무등록')
 *    - 근무자 칸이 비었거나 쉬는 날이면 옮김 · 근무자 칸도 출근이면(동시 출근은 있을 수 없음) 근무자 칸을 두고 그 날은 옮기지 않음
 *  반환 { ok, moves: [{date, from, to, was}], conflicts: [{date, owner, worker}], linked }
 */
function adm_schWorkerLink(token, ownerId, workerId, apply) {
  return run_(function () {
    const a = requireAdmin_(token);
    const o = driverById_(str_(ownerId));
    if (!o) fail_('명의 기사를 찾을 수 없습니다.');
    const lock = scriptLock_();
    if (!str_(workerId)) { // 풀기
      if (!apply) return { ok: true, moves: [], conflicts: [], linked: false };
      lock.waitLock(20000);
      try { writeFields_(SH.DRIVERS, o._row, { workerId: '', updatedAt: nowText_() }); forgetDriver_(o); } finally { lock.releaseLock(); }
      try { stlBump_(); } catch (e) { /* 정산 캐시 */ }
      logAdmin_(a, '같은 근무자 연결 풀기', o.name + ' (' + o.id + ')', '');
      return { ok: true, moves: [], conflicts: [], linked: false };
    }
    const w = driverById_(str_(workerId));
    if (!w) fail_('근무자를 찾을 수 없습니다.');
    if (w.id === o.id) fail_('같은 기사입니다.');
    if (str_(w.workerId)) fail_(w.name + ' 기사는 이미 다른 근무자에게 연결된 명의입니다.');
    if (!str_(o.loginId)) fail_(o.name + ' 기사에 쿠팡플렉스 아이디가 없습니다.');
    if (readAll_(SH.DRIVERS).some(function (x) { return str_(x.workerId) === o.id; })) fail_(o.name + ' 기사에게 연결된 다른 명의가 있습니다. 먼저 그 연결을 풀어 주세요.');
    const today = todayText_();
    let from = today;
    try { from = stlPeriod_(stlMonthOfDate_(today)).from || today; } catch (e) { from = schAddDays_(today, -20); }
    const dates = issDates_(from, schAddDays_(today, 60));
    const oc = schCellsOf_(o.id, dates), wc = schCellsOf_(w.id, dates), ctxOf = issCtxMaker_();
    const shortOf = function (n) { return String(n || '').replace(/\s*캠프\s*$/, '').trim(); };
    const moves = [], conflicts = [];
    dates.forEach(function (d) {
      const ov = str_(oc[d]);
      if (!ov || !schWorkDay_(ov, schSubIdsOf_(o))) return; // 명의 줄이 그날 출근이 아니면 옮길 것 없음
      const wv = str_(wc[d]);
      if (schCellIds_(wv).indexOf(str_(o.loginId).toLowerCase()) >= 0) return; // 근무자 칸에 이미 그 아이디로 적혀 있음
      if (wv && !/^(휴무|고정휴무|추가휴무|휴가)$/.test(wv)) { conflicts.push({ date: d, owner: ov, worker: wv }); return; }
      const ox = ctxOf(o, d), wx = ctxOf(w, d);
      let route = /^출근/.test(ov) ? normCode_(str_(ox.base).replace(/\([^)]*\)|\[[^\]]*]/g, '')) : ov.replace(/\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)/g, ' ').replace(/업무등록/g, ' ').replace(/\s+/g, ' ').trim();
      if (!/\d{3,4}[A-Za-z]/.test(route)) { conflicts.push({ date: d, owner: ov, worker: wv, why: '노선을 알 수 없음' }); return; }
      if (/^\d/.test(route) && shortOf(ox.camp) && shortOf(ox.camp) !== shortOf(wx.camp)) route = shortOf(ox.camp) + ' ' + route;
      moves.push({ date: d, from: ov, to: route + ' (' + str_(o.loginId) + ') 업무등록', was: wv });
    });
    if (!apply) return { ok: true, moves: moves, conflicts: conflicts, linked: false, owner: { id: o.id, name: o.name, login: o.loginId }, worker: { id: w.id, name: w.name } };
    lock.waitLock(20000);
    try { writeFields_(SH.DRIVERS, o._row, { workerId: w.id, updatedAt: nowText_() }); forgetDriver_(o); } finally { lock.releaseLock(); }
    let saved = 0, skipped = 0;
    if (moves.length) {
      const r = adm_schSave(token, moves.map(function (m) { return { row: w.id, date: m.date, value: m.to, old: m.was }; }));
      if (!r.ok) return { ok: true, linked: true, moves: [], conflicts: conflicts, warn: '연결은 했지만 칸을 옮기지 못했습니다: ' + r.msg };
      saved = r.saved || 0; skipped = (r.conflicts || []).length;
    }
    try { stlBump_(); } catch (e) { /* 정산 캐시 */ }
    logAdmin_(a, '같은 근무자 연결', o.name + ' → ' + w.name, '옮긴 칸 ' + saved + ' · 겹쳐서 두지 않은 날 ' + conflicts.length);
    return { ok: true, linked: true, moves: moves, conflicts: conflicts, saved: saved, skipped: skipped };
  });
}
