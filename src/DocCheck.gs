// ───────────────────────── 계산서/산재 관리 ─────────────────────────
// 1) 전자세금계산서 발행: 정산서의 합계금액(세금계산서 금액)을 기사가 러너 앞으로 발행했는지 체크 (inv_checks 탭)
//    · 러너가 역발행한 계산서(tax_invoices)가 있으면 자동으로 '역발행'으로 본다
// 2) 산재/고용 신고 상황: 정산에서 계산된 월보수액·산재·고용을 근로복지공단(고용·산재보험 토탈서비스)
//    '노무제공자 월 보수액 신고' 일괄 등록용 엑셀로 내보내고, 신고했는지 체크 (ins_reports 탭)
//    · 월보수액 = 보험 기준금액(세부정산 설정: 공급가/부가세포함) × (1 − 경비율)  ← 러너 손익의 신고 기준과 같은 식
//    · 신고 기한: 노무제공월(정산월)의 다음 달 말일

const DOC_JOB_DEFAULT = '944'; // 직종부호: 944 택배기사 (964 유통배송기사 · 961 화물차주(택배 지선·간선))

function docMonth_(month) {
  const months = stlMonths_();
  if (!stlMonthOk_(month)) month = months.withData.length ? months.withData[months.withData.length - 1] : stlAddMonth_(stlMonthNow_(), -1);
  return { month: month, months: months.slice() };
}
function docYn_(v) { return /^(y|yes|o|true|1|완료|발행|신고)$/i.test(str_(v)); }
/** 정산월 × 정산ID 줄 저장 (있으면 고침, 없으면 추가) */
function docUpsert_(sheet, month, list, a, pick) {
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    const rows = readAll_(sheet), at = {};
    rows.forEach(function (r) { if (r.month === month && r.acct) at[r.acct] = r._row; });
    const adds = [];
    list.forEach(function (x) {
      const acct = str_(x.acct); if (!acct) return;
      const f = pick(x);
      f.by = a.name; f.at = nowText_();
      if (at[acct]) writeFields_(sheet, at[acct], f);
      else { f.month = month; f.acct = acct; adds.push(f); }
    });
    if (adds.length) appendObjs_(sheet, adds);
    return list.length;
  } finally { lock.releaseLock(); }
}

// ── 1) 전자세금계산서 발행 체크 ──
function adm_einvList(token, month) {
  return run_(function () {
    requireAdmin_(token);
    const mm = docMonth_(month); month = mm.month;
    const x = einvRows_(month);
    return { ok: true, month: month, months: mm.months, writeDate: x.writeDate, due: x.due, closed: x.closed, rows: x.rows };
  });
}
/** 한 정산월의 기사(정산ID)별 계산서 금액 · 발행 체크 · 역발행 (월별 · 연간 보기 공용) */
function einvRows_(month) {
  {
    const res = stlResult_(month, false), sum = res.summary || {}, dates = sum.dates || {};
    // 러너가 역발행한 계산서 (기사 앱 공개 N 은 빼고)
    const ti = {};
    try {
      readAll_(SH.TAXINV).forEach(function (r) {
        if (!r.id || r.month !== month || r.pub === 'N') return;
        // supId 와 supDriverId 가 같은 기사 ID 인 경우가 많아 한 장을 두 번 더하지 않게 중복 제거
        [str_(r.supDriverId), str_(r.supId)].filter(function (k, i, a) { return k && a.indexOf(k) === i; }).forEach(function (k) {
          const o = ti[k] || (ti[k] = { total: 0, n: 0, nts: true, date: '' });
          o.total += stlNum_(r.total); o.n++; if (r.nts !== '등록') o.nts = false; if (!o.date || str_(r.date) > o.date) o.date = str_(r.date);
        });
      });
    } catch (e) { /* 역발행 탭 없음 */ }
    const chk = {};
    readAll_(SH.INVCHK).forEach(function (r) { if (r.month === month && r.acct) chk[r.acct] = r; });
    const drv = {};
    readAll_(SH.DRIVERS).forEach(function (d) { if (d.id) drv[d.id] = d; });
    const rows = (sum.drivers || []).filter(function (d) { return !d.ceo && d.invoice > 0; }).map(function (d) {
      const c = chk[d.id] || {}, o = drv[d.ownerId] || {};
      // 역발행 대상(기사 정보 '세금계산서 역발행' 지정) 기사만 역발행 계산서로 인정. 아니면 기사 본인 발행으로 체크
      const t0 = ti[d.id] || (d.ownerId && ti[d.ownerId]) || null, t = t0 && stlYes_(o.tiOn) ? t0 : null;
      return {
        acct: d.id, driverId: d.ownerId || '', name: d.name, vendor: d.vendor || '', bizNo: d.bizNo || '', bizName: d.bizName || '',
        supply: d.supply, tax: d.tax, total: d.invoice, tiOn: stlYes_(o.tiOn),
        ti: t ? { total: t.total, n: t.n, nts: t.nts, date: t.date } : null, tiIgnored: t0 && !t ? t0.n : 0,
        done: docYn_(c.done), date: c.date || '', approvalNo: c.approvalNo || '', memo: c.memo || '', by: c.by || '', at: c.at || '',
        savedTotal: stlNum_(c.total) || 0
      };
    });
    rows.sort(function (a, b) { return koCmp_(a.name, b.name); });
    return { writeDate: dates.write || '', due: dates.invoice || '', closed: !!sum.closed, rows: rows };
  }
}
/**
 * 연간 보기: 그 해 정산월(데이터 있는 달)마다 기사별 발행 여부를 모아 기사 × 월 표로.
 * from = 집계 시작 정산월 (app_settings einvFrom) — 그보다 앞 달은 체크 기록이 없어 '미발행'으로 잡히지 않게 뺀다.
 */
function adm_einvYear(token, year, from) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (from !== undefined && from !== null) { // 집계 시작월 바꾸기
      from = str_(from);
      if (from && !stlMonthOk_(from)) fail_('집계 시작월을 확인해 주세요.');
      appSetPut_('einvFrom', from, '전자세금계산서 연간 보기: 이 정산월부터 미발행을 셈');
      cache_().remove('appset');
      logAdmin_(a, '계산서 연간 집계 시작월', from || '처음부터', '');
    }
    const st = stlMonths_(), withData = (st.withData || []).slice().sort();
    const years = withData.map(function (m) { return m.slice(0, 4); }).filter(function (y, i, l) { return l.indexOf(y) === i; });
    year = /^\d{4}$/.test(str_(year)) ? str_(year) : (years.length ? years[years.length - 1] : String(new Date().getFullYear()));
    const startM = str_(appSet_().einvFrom);
    const months = withData.filter(function (m) { return m.slice(0, 4) === year; });
    const drv = {}, order = [];
    months.forEach(function (m) {
      const skip = startM && m < startM;
      einvRows_(m).rows.forEach(function (r) {
        let d = drv[r.acct];
        if (!d) { d = drv[r.acct] = { acct: r.acct, driverId: r.driverId, name: r.name, vendor: r.vendor, bizNo: r.bizNo, bizName: r.bizName, cells: {} }; order.push(d); }
        d.name = r.name; if (r.bizNo) d.bizNo = r.bizNo; if (r.bizName) d.bizName = r.bizName;
        d.cells[m] = { st: r.ti ? 'ti' : r.done ? 'done' : (skip ? 'skip' : 'no'), supply: r.supply, tax: r.tax, total: r.total,
          date: r.ti ? r.ti.date : r.date, approvalNo: r.approvalNo, memo: r.memo };
      });
    });
    order.sort(function (p, q) { return koCmp_(p.name, q.name); });
    return { ok: true, year: year, years: years, months: months, from: startM, drivers: order };
  });
}
/** list = [{ acct, driverId, name, total, done, date, approvalNo, memo }] */
function adm_einvSet(token, month, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    list = (Array.isArray(list) ? list : []).slice(0, 500);
    const n = docUpsert_(SH.INVCHK, month, list, a, function (x) {
      return { driverId: str_(x.driverId), name: str_(x.name), total: String(Math.round(stlNum_(x.total) || 0)), done: x.done ? 'Y' : '',
        date: x.done ? (stlYmd_(x.date) || todayText_()) : '', approvalNo: str_(x.approvalNo).slice(0, 40), memo: str_(x.memo).slice(0, 200) };
    });
    logAdmin_(a, '세금계산서 발행 체크', month, list.map(function (x) { return str_(x.name) + (x.done ? ' 발행' : ' 미발행'); }).join(', ').slice(0, 300));
    return { ok: true, n: n };
  });
}

// ── 2) 산재/고용 신고 상황 ──
function docInsCfg_() {
  const s = appSet_();
  let tpl = null;
  try { tpl = s.insTpl ? JSON.parse(s.insTpl) : null; } catch (e) { tpl = null; }
  let enr = null;
  try { enr = s.insEnrolled ? JSON.parse(s.insEnrolled) : null; } catch (e) { enr = null; }
  let mg = {};
  try { mg = s.insMerge ? JSON.parse(s.insMerge) || {} : {}; } catch (e) { mg = {}; }
  return { jobCode: str_(s.insJobCode) || DOC_JOB_DEFAULT, bizMgmtNo: str_(s.insBizMgmtNo) || '', tpl: tpl, enrolled: enr, merge: mg };
}
function adm_insRepList(token, month) {
  return run_(function () {
    requireAdmin_(token);
    const mm = docMonth_(month); month = mm.month;
    const res = stlResult_(month, false), sum = res.summary || {}, cfg = stlCfg_();
    const rr = Math.min(0.95, Math.max(0, cfg.runner)), dr = 1 - rr;
    const saved = {}, lastStart = {};
    readAll_(SH.INSREP).forEach(function (r) {
      if (!r.acct) return;
      if (r.month === month) saved[r.acct] = r;
      if (r.start && (!lastStart[r.acct] || r.month > lastStart[r.acct].m)) lastStart[r.acct] = { m: r.month, v: r.start };
    });
    const drv = {};
    readAll_(SH.DRIVERS).forEach(function (d) { if (d.id) drv[d.id] = d; });
    const rows = (sum.drivers || []).filter(function (d) { return !d.ceo && !d.vendor && d.invoice > 0; }).map(function (d) {
      const slip = (res.slips || {})[d.id] || {}, ins = slip.ins || {}, o = drv[d.ownerId] || {}, c = saved[d.id] || {};
      const base = cfg.insBasis === '부가세포함' ? d.invoice : d.supply;
      const bosu = Math.round(base * (1 - cfg.expense));
      const excluded = !!ins.excluded;
      const sanOn = !excluded && ((ins.san0 || 0) > 0 || (d.san || 0) > 0);
      const goyFlag = (ins.goy0 || 0) > 0 || (d.goy || 0) > 0;
      const goyOn = !excluded && bosu >= cfg.goyMin && goyFlag;
      // 공단 납부(전체) = 기사분 ÷ (1 − 러너 부담률)
      const sanAll = sanOn ? Math.round(bosu * (cfg.san + cfg.commute)) : 0, goyAll = goyOn ? Math.round(bosu * cfg.goy) : 0;
      const start0 = c.start || (lastStart[d.id] && lastStart[d.id].v) || stlYmd_(o.approvedAt) || stlYmd_(o.createdAt) || '';
      return {
        acct: d.id, driverId: d.ownerId || '', name: d.name, rrn: o.rrn || '', hasRrn: !!o.rrnEnc, leave: o.leaveDate || '',
        supply: d.supply, invoice: d.invoice, bosu: bosu, excluded: excluded, sanOn: sanOn, goyOn: goyOn,
        sanD: d.san || 0, goyD: d.goy || 0, runner: d.runnerIns || 0, sanAll: sanAll, goyAll: goyAll,
        start: start0, done: docYn_(c.done), date: c.date || '', memo: c.memo || '', by: c.by || '', at: c.at || '',
        savedBosu: stlNum_(c.bosu) || 0, goyFlag: goyFlag
      };
    });
    rows.sort(function (a, b) { return koCmp_(a.name, b.name); });
    // 하위 기사: 보험료를 상위 기사 한 사람으로 합쳐 신고 (설정 insMerge = { 하위 정산ID: 상위 정산ID })
    const icfg = docInsCfg_(), mg = icfg.merge || {}, byAcct = {};
    rows.forEach(function (x) { byAcct[x.acct] = x; x.own = { supply: x.supply, invoice: x.invoice, bosu: x.bosu, sanD: x.sanD, goyD: x.goyD, runner: x.runner, sanAll: x.sanAll, goyAll: x.goyAll }; });
    rows.forEach(function (x) {
      const pa = mg[x.acct]; if (!pa) return;
      const p = byAcct[pa];
      if (!p || p === x || mg[pa]) { x.parentMissing = pa; return; }
      x.parent = pa; x.parentName = p.name;
      (p.kids = p.kids || []).push(x.acct);
      ['supply', 'invoice', 'bosu', 'sanD', 'goyD', 'runner'].forEach(function (k) { p[k] = (p[k] || 0) + (x.own[k] || 0); });
      p.kidSan = p.kidSan || (!x.excluded && x.sanOn); p.kidGoy = p.kidGoy || (!x.excluded && x.goyFlag);
    });
    rows.forEach(function (p) {
      if (!p.kids) return;
      p.sanOn = !p.excluded && (p.sanOn || !!p.kidSan);
      p.goyOn = !p.excluded && p.bosu >= cfg.goyMin && (p.goyFlag || !!p.kidGoy);
      p.sanAll = p.sanOn ? Math.round(p.bosu * (cfg.san + cfg.commute)) : 0; p.goyAll = p.goyOn ? Math.round(p.bosu * cfg.goy) : 0;
      delete p.kidSan; delete p.kidGoy;
    });
    const p = stlAddMonth_(month, 1).split('-').map(Number);
    const due = ymd_(new Date(p[0], p[1], 0)); // 다음 달 말일
    return { ok: true, month: month, months: mm.months, due: due, closed: !!sum.closed, cfg: icfg,
      rates: { expense: cfg.expense, san: cfg.san + cfg.commute, goy: cfg.goy, runner: rr, goyMin: cfg.goyMin, basis: cfg.insBasis }, rows: rows };
  });
}
/** list = [{ acct, driverId, name, bosu, san, goy, start, done, date, memo }] */
function adm_insRepSet(token, month, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    list = (Array.isArray(list) ? list : []).slice(0, 500);
    const n = docUpsert_(SH.INSREP, month, list, a, function (x) {
      const f = { driverId: str_(x.driverId), name: str_(x.name), bosu: String(Math.round(stlNum_(x.bosu) || 0)), san: x.san ? 'Y' : '', goy: x.goy ? 'Y' : '',
        start: stlYmd_(x.start) || '', done: x.done ? 'Y' : '', date: x.done ? (stlYmd_(x.date) || todayText_()) : '', memo: str_(x.memo).slice(0, 200) };
      return f;
    });
    logAdmin_(a, '산재·고용 신고 체크', month, list.map(function (x) { return str_(x.name) + (x.done ? ' 신고' : ''); }).join(', ').slice(0, 300));
    return { ok: true, n: n };
  });
}
function adm_insRepCfg(token, o) {
  return run_(function () {
    const a = requireAdmin_(token);
    o = o || {};
    const job = str_(o.jobCode).replace(/\D/g, '').slice(0, 3);
    if (job && job.length !== 3) fail_('직종부호는 숫자 3자리입니다 (예: 944).');
    if (o.jobCode !== undefined) appSetPut_('insJobCode', job || DOC_JOB_DEFAULT, '산재/고용 신고: 노무제공자 직종부호 (944 택배기사)');
    if (o.bizMgmtNo !== undefined) appSetPut_('insBizMgmtNo', str_(o.bizMgmtNo).replace(/[^\d-]/g, '').slice(0, 20), '산재/고용 신고: 사업장관리번호');
    // 공단 엑셀 양식 (토탈서비스에서 받은 파일의 머리글 줄만): { file, sheet, top[[]], h, head[] }
    if (o.tpl !== undefined) {
      let t = '';
      if (o.tpl && Array.isArray(o.tpl.head) && Array.isArray(o.tpl.top)) {
        t = JSON.stringify({ file: str_(o.tpl.file).slice(0, 80), sheet: str_(o.tpl.sheet).slice(0, 31), h: Number(o.tpl.h) || 0,
          top: o.tpl.top.slice(0, 20).map(function (r) { return (Array.isArray(r) ? r : []).slice(0, 60).map(function (v) { return str_(v).slice(0, 60); }); }),
          head: o.tpl.head.slice(0, 60).map(function (v) { return str_(v).slice(0, 60); }) });
        if (t.length > 40000) fail_('양식 머리글이 너무 깁니다.');
      }
      appSetPut_('insTpl', t, '산재/고용 신고: 공단 엑셀 양식 머리글 (관리자 화면에서 올림)');
    }
    // 토탈서비스 양식에 이미 들어 있는 노무제공자 성명 = 입직신고된 사람 (없으면 입직신고 대상)
    if (o.enrolled !== undefined) {
      let t2 = '';
      if (o.enrolled && Array.isArray(o.enrolled.names)) {
        const names = o.enrolled.names.map(function (v) { return str_(v).replace(/\s+/g, '').slice(0, 30); }).filter(Boolean).slice(0, 2000);
        t2 = JSON.stringify({ file: str_(o.enrolled.file).slice(0, 80), at: todayText_(), names: names });
        if (t2.length > 45000) fail_('양식의 성명이 너무 많습니다.');
      }
      appSetPut_('insEnrolled', t2, '산재/고용 신고: 토탈서비스 양식에 들어 있는 노무제공자 성명 (입직신고 여부 판단)');
    }
    // 하위 기사 합치기: { child, parent } — parent 비우면 풀기
    if (o.merge !== undefined) {
      const ch = str_((o.merge || {}).child), pa = str_((o.merge || {}).parent);
      if (!ch) fail_('하위로 넣을 기사를 확인해 주세요.');
      const mg = docInsCfg_().merge || {};
      if (pa) {
        if (pa === ch) fail_('자기 자신을 상위로 지정할 수 없습니다.');
        if (mg[pa]) fail_('상위 기사가 이미 다른 기사의 하위입니다. 맨 위 기사를 고르세요.');
        if (Object.keys(mg).some(function (k) { return mg[k] === ch; })) fail_('이 기사 밑에 하위 기사가 있습니다. 하위를 먼저 풀어 주세요.');
        mg[ch] = pa;
      } else delete mg[ch];
      appSetPut_('insMerge', Object.keys(mg).length ? JSON.stringify(mg) : '', '산재/고용 신고: 하위 기사 → 상위 기사 합산 신고 { 하위 정산ID: 상위 정산ID }');
    }
    const c = docInsCfg_();
    logAdmin_(a, '산재·고용 신고 설정', '', '직종부호 ' + c.jobCode + ' · 관리번호 ' + c.bizMgmtNo + (c.tpl ? ' · 양식 ' + c.tpl.file : ''));
    return { ok: true, cfg: docInsCfg_() };
  });
}
/**
 * 공단 일괄 등록 엑셀용 자료 (주민등록번호 전체 포함 · 관리자 기록 남김)
 * accts = 내보낼 정산ID 목록, over = { acct: { start } } 화면에서 고친 자격취득일
 */
function adm_insRepExport(token, month, accts, over) {
  return run_(function () {
    const a = requireAdmin_(token);
    const r = adm_insRepList(token, month);
    if (!r.ok) return r;
    const want = {}; (Array.isArray(accts) ? accts : []).forEach(function (x) { want[str_(x)] = 1; });
    over = over || {};
    const drv = {};
    readAll_(SH.DRIVERS).forEach(function (d) { if (d.id) drv[d.id] = d; });
    const out = [], noRrn = [];
    r.rows.forEach(function (x) {
      if (!want[x.acct] || x.parent || x.excluded || (!x.sanOn && !x.goyOn)) return;
      const d = drv[x.driverId] || {};
      let rrn = '';
      try { rrn = d.rrnEnc ? decrypt_(d.rrnEnc) : ''; } catch (e) { rrn = ''; }
      if (!rrn) noRrn.push(x.name);
      out.push({ acct: x.acct, name: x.name, rrn: rrn, jobCode: r.cfg.jobCode, start: stlYmd_((over[x.acct] || {}).start) || x.start, bosu: x.bosu, san: x.sanOn, goy: x.goyOn });
    });
    logAdmin_(a, '산재·고용 신고 엑셀 출력', r.month, out.length + '명 (주민번호 포함)');
    return { ok: true, month: r.month, cfg: r.cfg, rows: out, noRrn: noRrn };
  });
}
