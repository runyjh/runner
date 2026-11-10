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
    const res = stlResult_(month, false), sum = res.summary || {}, dates = sum.dates || {};
    // 러너가 역발행한 계산서 (기사 앱 공개 N 은 빼고)
    const ti = {};
    try {
      readAll_(SH.TAXINV).forEach(function (r) {
        if (!r.id || r.month !== month || r.pub === 'N') return;
        [str_(r.supDriverId), str_(r.supId)].filter(Boolean).forEach(function (k) {
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
      const t = ti[d.id] || (d.ownerId && ti[d.ownerId]) || null;
      return {
        acct: d.id, driverId: d.ownerId || '', name: d.name, vendor: d.vendor || '', bizNo: d.bizNo || '', bizName: d.bizName || '',
        supply: d.supply, tax: d.tax, total: d.invoice, tiOn: stlYes_(o.tiOn),
        ti: t ? { total: t.total, n: t.n, nts: t.nts, date: t.date } : null,
        done: docYn_(c.done), date: c.date || '', approvalNo: c.approvalNo || '', memo: c.memo || '', by: c.by || '', at: c.at || '',
        savedTotal: stlNum_(c.total) || 0
      };
    });
    rows.sort(function (a, b) { return koCmp_(a.name, b.name); });
    return { ok: true, month: month, months: mm.months, writeDate: dates.write || '', due: dates.invoice || '', closed: !!sum.closed, rows: rows };
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
  return { jobCode: str_(s.insJobCode) || DOC_JOB_DEFAULT, bizMgmtNo: str_(s.insBizMgmtNo) || '', tpl: tpl, enrolled: enr };
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
      const goyOn = !excluded && bosu >= cfg.goyMin && ((ins.goy0 || 0) > 0 || (d.goy || 0) > 0);
      // 공단 납부(전체) = 기사분 ÷ (1 − 러너 부담률)
      const sanAll = sanOn ? Math.round(bosu * (cfg.san + cfg.commute)) : 0, goyAll = goyOn ? Math.round(bosu * cfg.goy) : 0;
      const start0 = c.start || (lastStart[d.id] && lastStart[d.id].v) || stlYmd_(o.approvedAt) || stlYmd_(o.createdAt) || '';
      return {
        acct: d.id, driverId: d.ownerId || '', name: d.name, rrn: o.rrn || '', hasRrn: !!o.rrnEnc, leave: o.leaveDate || '',
        supply: d.supply, invoice: d.invoice, bosu: bosu, excluded: excluded, sanOn: sanOn, goyOn: goyOn,
        sanD: d.san || 0, goyD: d.goy || 0, runner: d.runnerIns || 0, sanAll: sanAll, goyAll: goyAll,
        start: start0, done: docYn_(c.done), date: c.date || '', memo: c.memo || '', by: c.by || '', at: c.at || '',
        savedBosu: stlNum_(c.bosu) || 0
      };
    });
    rows.sort(function (a, b) { return koCmp_(a.name, b.name); });
    const p = stlAddMonth_(month, 1).split('-').map(Number);
    const due = ymd_(new Date(p[0], p[1], 0)); // 다음 달 말일
    return { ok: true, month: month, months: mm.months, due: due, closed: !!sum.closed, cfg: docInsCfg_(),
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
      if (!want[x.acct] || x.excluded || (!x.sanOn && !x.goyOn)) return;
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
