/**
 * 관리자 대시보드: 메뉴별 요약을 한 번에.
 *  adm_dash     — 기사·스케줄·품앗이·배번호·노선·업무스케줄·공지·게시판 (시트 몇 개만 읽어 빠름)
 *  adm_dashStl  — 정산서·매입매출·세금계산서 (정산 계산이 들어가 따로 · 결과는 5분 캐시를 씀)
 * 읽기만 한다 (데이터를 바꾸지 않음).
 */
function dashCellKind_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/미입차/.test(s)) return 'mi';
  if (/병가/.test(s)) return 'sick';
  if (/휴무|휴가/.test(s)) return 'off';
  if (/용차/.test(s)) return 'yong';
  return 'work';
}

/** 요약 결과는 2~5분 캐시 (여러 관리자·탭이 열어도 시트를 다시 읽지 않음). 화면의 [새로고침]은 fresh=true 로 바로 다시 읽는다 */
function dashCached_(key, ttl, fresh, make) {
  const c = cache_();
  if (!fresh) { const hit = c.get(key); if (hit) { try { const o = JSON.parse(hit); o.cached = true; return o; } catch (e) { /* 다시 만든다 */ } } }
  const out = make();
  try { const j = JSON.stringify(out); if (j.length < 95000) c.put(key, j, ttl); } catch (e) { /* 무시 */ }
  return out;
}
function adm_dash(token, fresh) {
  return run_(function () {
    requireAdmin_(token);
    return dashCached_('dash:a', 120, fresh, dashMain_);
  });
}
function dashMain_() {
    const today = todayText_(), t0 = parseYmd_(today), out = { ok: true, today: today };
    const drvAll = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name; });
    const isWork = function (o) { return o.status === ST.ACTIVE && o.workStatus !== '퇴사'; };

    // ── 기사 정보관리
    const cnt = function (list, f) { const m = {}; list.forEach(function (o) { const k = f(o) || '(없음)'; m[k] = (m[k] || 0) + 1; }); return m; };
    const ym = today.slice(0, 7);
    out.drivers = {
      total: drvAll.length,
      byStatus: cnt(drvAll, function (o) { return o.status; }),
      byWork: cnt(drvAll.filter(function (o) { return o.status === ST.ACTIVE; }), function (o) { return o.workStatus || '재직'; }),
      byType: cnt(drvAll.filter(isWork), function (o) { return o.driverType; }),
      noCamp: drvAll.filter(function (o) { return isWork(o) && !o.schCampId; }).map(function (o) { return o.name; }),
      newThisMonth: drvAll.filter(function (o) { return String(o.createdAt).slice(0, 7) === ym; }).length,
      pending: drvAll.filter(function (o) { return o.status === ST.PENDING; }).map(function (o) { return o.name; })
    };

    // ── 기사 스케줄 (오늘부터 7일)
    try {
      const s = schRead_(t0, addDays_(t0, 6));
      const days = s.dates.map(function (d) {
        const c = { date: d, work: 0, off: 0, sick: 0, mi: 0, yong: 0, empty: 0, holiday: s.holidays[d] || '' };
        s.drivers.forEach(function (dr) {
          if (dr.ex) { const v = (s.cells[dr.id] || {})[d]; if (v) c[dashCellKind_(v)]++; return; }
          if (dr.status !== ST.ACTIVE || dr.workStatus === '퇴사' || !dr.campId) return;
          const k = dashCellKind_((s.cells[dr.id] || {})[d]);
          if (k) c[k]++; else c.empty++;
        });
        return c;
      });
      out.sched = { days: days, issues: (s.issues || []).filter(function (x) { return x.date >= today; }).length, rcWait: (s.rcMoves || []).length };
    } catch (e) { out.sched = { err: String(e && e.message || e).slice(0, 120) }; }

    // ── 품앗이
    const jobs = readAll_(SH.PJOB).filter(function (j) { return j.id; });
    const apps = readAll_(SH.PAPP).filter(function (a) { return a.id; });
    const live = jobs.filter(function (j) { return j.date >= today; });
    out.pumasi = {
      open: live.filter(function (j) { return j.status === PST.OPEN; }).length,
      talk: live.filter(function (j) { return j.status === PST.TALK; }).length,
      done: live.filter(function (j) { return j.status === PST.DONE; }).length,
      waitApps: apps.filter(function (a) { return a.status === PAST.APPLY && a.date >= today; }).length,
      monthDone: jobs.filter(function (j) { return j.status === PST.DONE && String(j.date).slice(0, 7) === ym; }).length,
      next: live.filter(function (j) { return j.status !== PST.CANCEL && j.status !== PST.CLOSED; }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
        .slice(0, 4).map(function (j) { return { date: j.date, camp: j.camp, route: j.route, status: j.status, who: j.accepted || j.poster }; })
    };

    // ── 배번호
    const bibs = readAll_(SH.BIB).filter(function (b) { return b.id; });
    out.bib = { total: bibs.length, byStatus: cnt(bibs, function (b) { return b.status; }) };

    // ── 노선
    const camps = readAll_(SH.CAMPS).filter(function (c) { return c.id; });
    const routes = readAll_(SH.ROUTES).filter(function (r) { return r.id; });
    let rcWait = 0;
    try { rcWait = readAll_(SH.RCHG).filter(function (c) { return c.status === RCS.WAIT; }).length; } catch (e) { rcWait = 0; }
    const assigned = {};
    drvAll.filter(isWork).forEach(function (o) { if (o.schCampId) assigned[o.schCampId] = (assigned[o.schCampId] || 0) + 1; });
    out.route = {
      camps: camps.length,
      routes: routes.filter(function (r) { return r.status !== RST.OFF && r.status !== '중지'; }).length,
      routesOff: routes.filter(function (r) { return r.status === RST.OFF || r.status === '중지'; }).length,
      rcWait: rcWait,
      byCamp: camps.map(function (c) { return { name: c.name, routes: routes.filter(function (r) { return r.campId === c.id && r.status !== RST.OFF && r.status !== '중지'; }).length, drivers: assigned[c.id] || 0 }; })
        .sort(function (a, b) { return b.routes - a.routes; })
    };
    try { out.route.perf = rpfSummary_(); } catch (e) { out.route.perf = null; }

    // ── 업무스케줄 (메모)
    const memos = readAll_(SH.MEMO).map(function (o) { o.date = normDate_(o.date) || o.date; return o; }).filter(function (o) { return o.id && o.date; })
      .map(function (o) { const m = memoView_(o); m._date = o.date; return m; });
    const wk = ymd_(addDays_(t0, 6));
    out.memo = {
      today: memos.filter(function (m) { return m._date === today && !m.note; }).sort(memoSort_).map(function (m) { return { time: m.time || '', text: String(m.content || '').slice(0, 60), done: !!m.done }; }),
      week: memos.filter(function (m) { return m._date > today && m._date <= wk && !m.done && !m.note; }).length,
      overdue: memos.filter(function (m) { return m._date < today && !m.done && !m.note; }).length
    };

    // ── 공지사항
    const nts = readAll_(SH.NOTICE).filter(function (n) { return n.id; });
    const showing = nts.filter(function (n) { return n.status !== NST.OFF && (!n.start || n.start <= today) && (!n.end || n.end >= today); });
    out.notice = {
      showing: showing.length, important: showing.filter(function (n) { return String(n.important).toUpperCase() === 'Y'; }).length,
      hidden: nts.length - showing.length,
      latest: nts.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 3).map(function (n) { return { title: n.title, at: String(n.createdAt).slice(0, 10) }; })
    };

    // ── 소통 게시판
    try {
      const posts = readAll_(SH.BPOST).filter(function (p) { return p.id; });
      const wkAgo = ymd_(addDays_(t0, -6));
      out.board = {
        posts: posts.filter(function (p) { return p.status !== '삭제'; }).length,
        week: posts.filter(function (p) { return String(p.createdAt).slice(0, 10) >= wkAgo && p.status !== '삭제'; }).length,
        reports: readAll_(SH.BREP).filter(function (r) { return r.id && r.status !== '처리'; }).length,
        latest: posts.filter(function (p) { return p.status === '공개'; }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 3)
          .map(function (p) { return { title: p.title, author: p.author, at: String(p.createdAt).slice(0, 10), cmts: Number(p.cmts) || 0 }; })
      };
    } catch (e) { out.board = { err: '게시판 없음' }; }
    return out;
}

/** 정산 · 매입매출 · 세금계산서 요약 (지금 정산월 + 지난달) */
function adm_dashStl(token, fresh) {
  return run_(function () {
    requireAdmin_(token);
    return dashCached_('dash:s', 300, fresh, dashStl_);
  });
}
function dashStl_() {
    const cur = stlMonthNow_(), prev = stlAddMonth_(cur, -1), out = { ok: true, cur: cur, prev: prev, months: [] };
    [prev, cur].forEach(function (m) {
      let sum = null, err = '';
      try { sum = stlResult_(m, false).summary; } catch (e) { err = String(e && e.message || e).slice(0, 120); }
      const p = stlPnl_(m, sum), closed = stlClosedInfo_(m);
      const warn = sum && sum.warnings ? sum.warnings.filter(function (w) { return w.level !== 'info'; }) : [];
      out.months.push({
        month: m, closed: closed ? closed.at : '', hasData: p.hasData, err: err, period: sum ? sum.period : null,
        round: sum ? sum.round : '', roundAt: sum ? sum.roundAt : '', drivers: sum ? (sum.drivers || []).length : 0,
        qty: p.qty, salesSupply: p.salesSupply, drvSupply: p.drvSupply, profit: p.profit, cost: p.cost, staff: p.staff, net: p.net,
        warnN: warn.reduce(function (a, w) { return a + (w.count || 0); }, 0), warnKinds: warn.slice(0, 4).map(function (w) { return w.label + ' ' + w.count; })
      });
    });
    // 세금계산서 역발행: 지난달(최근 정산월) 기준
    try {
      const list = readAll_(SH.TAXINV).filter(function (t) { return t.id; });
      const by = function (m) {
        const l = list.filter(function (t) { return t.month === m; });
        return { n: l.length, pub: l.filter(function (t) { return t.pub !== 'N'; }).length,
          nts: l.filter(function (t) { return t.nts === '등록'; }).length,
          total: l.reduce(function (a, t) { return a + (Number(String(t.total).replace(/[^\d-]/g, '')) || 0); }, 0) };
      };
      const tiOn = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.tiOn === 'Y' && o.workStatus !== '퇴사'; }).length;
      out.tax = { prev: by(prev), cur: by(cur), targets: tiOn };
    } catch (e) { out.tax = { err: String(e && e.message || e).slice(0, 120) }; }
    return out;
}
