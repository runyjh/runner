/**
 * 대시보드 '오늘 한눈에' (검색창 아래): 숫자 칸 · 확인할 것 · 다가오는 변경 · 이번 주 근무 인원 · 공지 · 수행률 · 프로그램 상태
 *  adm_home     — 기사 · 스케줄 · 품앗이 · 공지 · 확인 기록 (시트 몇 개 · 90초 기억)
 *  adm_homeStl  — 정산 상태 · 정산 경고 · 계산서 미발행 · 가불금 (정산 계산이 들어가 따로 · 5분 기억)
 * 읽기만 한다. 한 부분이 실패해도 나머지는 그대로 나온다.
 *  확인할 것 한 줄 = { k, lv: 'r'(급함) | 'b'(참고), n, label, sub, go(누르면 갈 메뉴) } — 건이 있을 때만 줄이 생긴다
 *  다가오는 변경 한 줄 = { date, label, sub, go } (오늘 ~ 14일 뒤)
 */
const HOME = { SOON_DAYS: 14, TTL: 90, TTL_STL: 300 };
function homeKind_(v) {
  const s = str_(v);
  if (!s) return '';
  if (/미입차|노쇼/.test(s)) return 'mi';
  if (/병가/.test(s)) return 'sick';
  if (/휴무|휴가/.test(s)) return 'off';
  if (/용차/.test(s)) return 'yong';
  if (/퇴사/.test(s)) return 'off';
  return 'work';
}
function homeShort_(camp) { return str_(camp).replace(/\s*캠프\s*$/, ''); }
function homeNames_(list, max) { max = max || 3; return list.slice(0, max).join(' · ') + (list.length > max ? ' 외 ' + (list.length - max) : ''); }

function adm_home(token, fresh) {
  return run_(function () { requireAdmin_(token); return dashCached_('home:a', HOME.TTL, fresh, homeMain_); });
}
function homeMain_() {
  const today = todayText_(), t0 = parseYmd_(today), tom = ymd_(addDays_(t0, 1)), until = ymd_(addDays_(t0, HOME.SOON_DAYS));
  const out = { ok: true, today: today, tom: tom, tiles: {}, todo: [], soon: [], week: [], notice: [], perf: null, sys: null };
  const part = function (name, fn) { try { fn(); } catch (e) { softFail_('대시보드 ' + name, e); } };
  const todo = function (k, lv, n, label, sub, go) { if (n > 0) out.todo.push({ k: k, lv: lv, n: n, label: label, sub: str_(sub).slice(0, 140), go: go || '' }); };
  const soon = function (date, label, sub, go) { if (date >= today && date <= until) out.soon.push({ date: date, label: label, sub: str_(sub).slice(0, 140), go: go || '' }); };
  const drv = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name; });
  const isWork = function (o) { return o.status === ST.ACTIVE && str_(o.workStatus) !== '퇴사'; };
  const work = drv.filter(isWork);

  // ── 기사스케줄: 이번 주(일~토) + 내일
  part('스케줄', function () {
    const sun = addDays_(t0, -t0.getDay()), sat = addDays_(sun, 6), end = tom > ymd_(sat) ? addDays_(t0, 1) : sat;
    const s = schRead_(sun, end), by = {};
    s.dates.forEach(function (d) {
      const c = by[d] = { date: d, work: 0, off: 0, sick: 0, mi: 0, yong: 0, empty: 0, holiday: s.holidays[d] || '', miL: [], yongL: [], emptyBy: {} };
      s.drivers.forEach(function (dr) {
        const v = (s.cells[dr.id] || {})[d];
        if (dr.ex) { const k0 = homeKind_(v); if (k0) c[k0]++; return; }
        if (dr.status !== ST.ACTIVE || dr.workStatus === '퇴사' || isStaffCamp_(dr.camp)) return;
        if (dr.leaveDate && d >= dr.leaveDate) return;
        const k = homeKind_(v), cp = homeShort_(dr.camp);
        if (!k) { if (dr.campId) { c.empty++; c.emptyBy[cp] = (c.emptyBy[cp] || 0) + 1; } return; } // 소속 캠프 없는 백업 기사의 빈 칸은 '쉬는 날'이라 세지 않음
        c[k]++;
        if (k === 'mi') c.miL.push(dr.name + ' ' + cp + ' ' + str_(dr.baseRoute));
        if (k === 'yong') c.yongL.push(cp + ' ' + str_(dr.baseRoute));
      });
    });
    const td = by[today], tm = by[tom];
    if (td) { out.tiles.work = td.work; out.tiles.off = td.off + td.sick; out.tiles.sick = td.sick; out.tiles.miss = td.mi + td.empty; out.tiles.mi = td.mi; out.tiles.empty = td.empty; }
    if (tm) out.tiles.workTom = tm.work;
    out.week = schDateRange_(sun, sat).map(function (d) { const c = by[d] || {}; return { date: d, work: c.work || 0, empty: c.empty || 0, mi: c.mi || 0, holiday: c.holiday || '' }; });
    if (td) todo('mi', 'r', td.mi, '오늘 미입차 · 노쇼', homeNames_(td.miL), 'issue');
    if (tm) todo('empty', 'r', tm.empty, '내일 빈 칸 (스케줄 미입력)', Object.keys(tm.emptyBy).map(function (k) { return k + ' ' + tm.emptyBy[k] + '명'; }).join(' · '), 'sched');
    const yl = (td ? td.yongL.map(function (x) { return '오늘 ' + x; }) : []).concat(tm ? tm.yongL.map(function (x) { return '내일 ' + x; }) : []);
    todo('yong', 'b', yl.length, '용차 쓰는 날', homeNames_(yl), 'sched');
  });
  // ── 내일 처음 가는 기사
  part('처음 가는 노선', function () {
    const l = frFind_(tom);
    todo('first', 'r', l.length, '내일 처음 가는 기사', homeNames_(l.map(function (x) { return x.name + ' ' + homeShort_(x.campName) + ' ' + frJoin_(x.all); })), 'sched');
  });
  // ── 새벽 자료 점검 · 자동 작업
  part('자료 점검', function () {
    const ck = dataCheckView_() || {}, items = ck.items || [];
    items.forEach(function (x) { if (x.k !== 'err' && x.k !== 'hb') todo('ck:' + x.k, 'r', Number(x.n) || 0, x.label, homeNames_(x.list || [], 2), /^pm/.test(x.k) ? 'sched' : ''); });
    const err = items.filter(function (x) { return x.k === 'err'; })[0], hb = items.filter(function (x) { return x.k === 'hb'; });
    out.sys = { at: str_(ck.at), err: err ? Number(err.n) || 0 : 0, errList: err ? (err.list || []).slice(0, 4) : [], stopped: hb.map(function (x) { return x.label; }) };
  });
  // ── 기사
  part('기사', function () {
    const pend = drv.filter(function (o) { return o.status === ST.PENDING; });
    todo('pending', 'b', pend.length, '가입 승인 대기', homeNames_(pend.map(function (o) { return o.name; })), 'drivers');
    const field = work.filter(function (o) { return !titleOf_(o); });
    const noDoc = field.filter(function (o) { return !str_(o.docQual) || !str_(o.docLicense); });
    todo('doc', 'b', noDoc.length, '서류 미제출 기사 (자격증 · 면허증)', homeNames_(noDoc.map(function (o) { return o.name; })), 'drivers');
    const enr = work.filter(function (o) { return str_(o.enr) === '대상'; });
    todo('enr', 'b', enr.length, '산재·고용 입직신고 안 된 기사', homeNames_(enr.map(function (o) { return o.name; })), 'settle');
    drv.forEach(function (o) {
      const ld = normDate_(o.leaveDate) || '';
      if (str_(o.workStatus) === '퇴사' && ld) soon(ld, '퇴사 예정 · ' + o.name, o.status === ST.ACTIVE && leaveStopAt_(o) ? '앱 자동 정지 ' + leaveStopAt_(o) : '', 'drivers');
    });
  });
  // ── 접속 · 확인 기록 · 알림
  part('접속', function () {
    const ids = work.map(function (o) { return String(o.id); }), on = onlineMap_(ids), now = Date.now();
    out.tiles.online = ids.filter(function (id) { return on[id] && now - on[id] <= ONLINE.NOW_MS; }).length;
    const seen = readAll_(SH.SEEN), wid = {}; ids.forEach(function (id) { wid[id] = 1; });
    out.tiles.opened = seen.filter(function (r) { return r.kind === SEEN_KIND.OPEN && wid[r.driverId] && str_(r.ackAt).slice(0, 10) === today; }).length;
    const un = {};
    seen.forEach(function (r) { if (r.kind === SEEN_KIND.SCH && wid[r.driverId] && !str_(r.ackAt) && str_(r.key) >= today && str_(r.by) !== SEEN_CANCEL) un[r.driverId] = r.name; });
    todo('unseen', 'b', Object.keys(un).length, '스케줄 변경 미확인 기사', homeNames_(Object.keys(un).map(function (k) { return un[k]; })), 'applog');
    // 공지: 게시 중인 공지마다 읽은 기사 수 / 대상 기사 수
    const cn = {}; master_().camps.forEach(function (c) { cn[c.id] = c.name; });
    const read = {}; seen.forEach(function (r) { if (r.kind === SEEN_KIND.NOTICE) (read[r.key] = read[r.key] || {})[r.driverId] = 1; });
    noticeAll_().filter(function (n) { return noticeLive_(n, today); }).sort(noticeSort_).slice(0, 4).forEach(function (n) {
      const tg = work.filter(function (o) { return noticeFor_(n, cn[o.schCampId] || o.schCamp || '', o.id); });
      out.notice.push({ id: n.id, title: n.title, important: n.important, total: tg.length, read: tg.filter(function (o) { return (read[n.id] || {})[o.id]; }).length, end: n.end || '' });
      if (n.end) soon(n.end, '공지 게시 종료 · ' + n.title, '', 'notice');
    });
    let tok = {};
    readAll_(SH.PPUSH).forEach(function (t) { if (t.driverId && t.token) tok[t.driverId] = 1; });
    const noPush = work.filter(function (o) { return !titleOf_(o) && !tok[o.id]; });
    todo('nopush', 'b', noPush.length, '휴대폰 알림 못 받는 기사', homeNames_(noPush.map(function (o) { return o.name; })), 'applog');
  });
  // ── 품앗이
  part('품앗이', function () {
    const d = pmData_(), near = ymd_(addDays_(t0, 2));
    const live = d.jobs.filter(function (j) { return !pmPast_(j, today) && (j.status === PST.OPEN || j.status === PST.TALK || j.status === PST.DONE); });
    const liveId = {}; live.forEach(function (j) { liveId[j.id] = j; });
    const na = d.apps.filter(function (a) { return a.status === PAST.APPLY && liveId[a.jobId]; });
    out.tiles.pm = live.length; out.tiles.pmNew = na.length;
    todo('pmApply', 'r', na.length, '품앗이 새 지원', homeNames_(na.map(function (a) { return a.name + ' → ' + homeShort_(liveId[a.jobId].camp) + ' ' + str_(liveId[a.jobId].route); })), 'pumasi');
    const open = live.filter(function (j) { return j.status !== PST.DONE && j.date <= near; });
    todo('pmOpen', 'r', open.length, '임박한 품앗이 미확정 (모레까지)', homeNames_(open.map(function (j) { return j.date.slice(5).replace('-', '/') + ' ' + homeShort_(j.camp) + ' ' + str_(j.route); })), 'pumasi');
  });
  // ── 배번호 · 게시판
  part('배번호', function () {
    const l = readAll_(SH.BIB).filter(function (b) { return b.id && (b.status === BST.DRAFT || b.status === BST.PRINTED || b.status === BST.SUBMITTED); });
    todo('bib', 'b', l.length, '배번호 신청 처리 중 (허가 전)', '', 'bib');
  });
  part('게시판', function () {
    todo('report', 'b', readAll_(SH.BREP).filter(function (r) { return r.id && r.status !== '처리'; }).length, '게시판 신고', '', 'board');
  });
  // ── 다가오는 변경: 노선 변경 예약 · 공휴일 · 피크 기간 · 정산 일정
  part('노선 변경', function () {
    rcRows_().forEach(function (c) {
      if (c.status !== RCS.WAIT) return;
      if (c.kind === RCK.MOVE) { soon(c.date, '노선 이관', homeShort_(c.fromCamp) + ' ' + str_(c.fromRoute) + ' → ' + homeShort_(c.toCamp) + ' ' + str_(c.toRoute), 'route'); return; }
      if (c.parentId) return; // 이관에 딸린 기사 줄은 이관 한 줄로
      soon(c.date, '노선 변경 · ' + c.name, homeShort_(c.fromCamp) + ' ' + str_(c.fromRoute) + ' → ' + homeShort_(c.toCamp) + ' ' + str_(c.toRoute), 'route');
    });
  });
  part('공휴일', function () {
    for (let i = 0; i <= HOME.SOON_DAYS; i++) { const d = ymd_(addDays_(t0, i)); if (HOLIDAYS[d]) soon(d, '공휴일 · ' + HOLIDAYS[d], '', 'sched'); }
  });
  part('피크', function () {
    pkPeriods_(pkAll_()).forEach(function (p) { if (p.to >= today && p.from <= until) soon(p.from < today ? today : p.from, '피크 기간 · ' + p.period, p.from.slice(5).replace('-', '/') + ' ~ ' + p.to.slice(5).replace('-', '/'), 'route'); });
  });
  part('정산 일정', function () {
    if (!props_().STL_DB_ID) return;
    const cfg = stlCfg_(), cur = stlMonthNow_();
    [stlAddMonth_(cur, -1), cur].forEach(function (m) {
      const dt = stlDates_(m, cfg), mm = Number(m.slice(5)) + '월 정산';
      soon(dt.invoice, '세금계산서 발행 기한', mm, 'settle');
      soon(dt.coupang, '쿠팡 입금일', mm, 'settle');
      soon(dt.pay, '기사 정산 지급일', mm, 'settle');
    });
  });
  // ── 수행률 · SLA
  part('수행률', function () {
    const p = rpfSummary_(), s = slaSummary_();
    if (p || s) out.perf = { wk: p ? p.wk : '', bad: p ? p.bad : 0, improve: p ? p.improve : 0, slaLow: s ? s.low : 0, slaWarn: s ? s.warn : 0 };
  });
  out.todo.sort(function (a, b) { return (a.lv === b.lv ? 0 : a.lv === 'r' ? -1 : 1); });
  out.soon.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

function adm_homeStl(token, fresh) {
  return run_(function () { requireAdmin_(token); return dashCached_('home:s', HOME.TTL_STL, fresh, homeStl_); });
}
function homeStl_() {
  const out = { ok: true, todo: [], stl: null };
  if (!props_().STL_DB_ID) return out;
  const today = todayText_(), cur = stlMonthNow_(), prev = stlAddMonth_(cur, -1);
  const todo = function (k, lv, n, label, sub, go) { if (n > 0) out.todo.push({ k: k, lv: lv, n: n, label: label, sub: str_(sub).slice(0, 140), go: go || 'settle' }); };
  const mm = function (m) { return Number(m.slice(5)) + '월'; };
  try {
    const sum = stlResult_(cur, false).summary || {};
    const warn = (sum.warnings || []).filter(function (w) { return w.level !== 'info'; });
    const wn = warn.reduce(function (a, w) { return a + (w.count || 0); }, 0);
    out.stl = { month: cur, closed: !!stlClosedInfo_(cur), drivers: (sum.drivers || []).length, pay: (sum.dates || {}).pay || '', warn: wn };
    todo('stlWarn', 'r', wn, mm(cur) + ' 정산 경고', warn.slice(0, 3).map(function (w) { return w.label + ' ' + w.count; }).join(' · '));
  } catch (e) { softFail_('대시보드 정산', e); }
  try { // 계산서 미발행: 지난 정산월 (기한이 이 달 10일)
    const x = einvRows_(prev), no = x.rows.filter(function (r) { return !r.ti && !r.done; });
    if (out.stl) out.stl.einv = { month: prev, total: x.rows.length, done: x.rows.length - no.length, due: x.due };
    todo('einv', x.due && x.due < today ? 'r' : 'b', no.length, mm(prev) + ' 세금계산서 미발행 기사', homeNames_(no.map(function (r) { return r.name; })));
  } catch (e) { softFail_('대시보드 계산서', e); }
  try { // 가불금: 남은 금액이 있고 상계 예정일이 30일 안 (또는 지남)
    const lim = ymd_(addDays_(parseYmd_(today), 30));
    const adv = stlRead_('stl_advance').filter(function (r) { const due = stlYmd_(r.due); return stlNum_(r.amt) - stlNum_(r.paid) > 0 && due && due <= lim; });
    todo('adv', 'b', adv.length, '가불금 상환 예정', homeNames_(adv.map(function (r) { return str_(r.name) + ' ' + stlYmd_(r.due).slice(5).replace('-', '/'); })));
  } catch (e) { softFail_('대시보드 가불금', e); }
  return out;
}
