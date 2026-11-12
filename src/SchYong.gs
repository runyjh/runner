/**
 * 기사스케줄 '용차' 칸 ↔ 정산 [품앗이/용차 지정] 연결
 *
 * 칸 글자 (칸 입력 창이 만들어 줌):
 *   용차                         업체 미정 (예전 그대로 · 정산 연결 없음)
 *   용차 히어로                   히어로가 업체 아이디로 대신 배송 · 기사에게 차액 청구
 *   용차 히어로 (runyjg)          히어로가 러너 아이디 runyjg 로 배송 · 기사에게 차액 청구
 *   용차 히어로 (청구없음)         차액 청구 안 함 (러너 부담)
 * 다른 곳(근무일수 · 이슈 · 색)은 모두 '용차' 글자가 들어 있는지만 보므로 그대로 동작한다.
 *
 * 차액 청구 = stl_yongcha 에 '스케줄 자동 [기사ID]' 줄 하나 (날짜 · 수행자 = 업체 · 라우트 = 그날 담당 노선 · 차액부담 = 그 기사).
 *   단가를 비워 두므로 정산 기본 규칙 그대로: 기사 청구 = 노선관리 외부용차단가, 업체 지급 = 용차업체 표 단가, 건수 = 쿠팡 정산서에서 자동.
 * 칸이 바뀌거나 지워지면(직접 입력 · 붙여넣기 · 되돌리기 포함) 그 줄도 같이 지운다. 사람이 직접 적은 줄은 건드리지 않는다.
 */
const SCH_YONG_TAG = '스케줄 자동';

function schYongParse_(v) {
  const s = str_(v);
  const m = s.match(/^용차(?:\s+([\s\S]*))?$/);
  if (!m || /\n/.test(s)) return null;
  let rest = str_(m[1]), charge = true, id = '';
  if (/\(\s*청구\s*없음\s*\)/.test(rest)) { charge = false; rest = rest.replace(/\(\s*청구\s*없음\s*\)/, ' '); }
  rest = rest.replace(/\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)/, function (m0, x) { id = x; return ' '; });
  return { vendor: rest.replace(/\s+/g, ' ').trim(), id: id, charge: charge };
}

/** 기사스케줄 화면에 줄 용차업체 목록 [{ name, ids }] + 맡은 노선 (정산 DB 를 한 번만 읽음) */
function schVendorPack_() {
  const out = { vendors: [], routes: [] };
  try {
    stlVendors_().list.forEach(function (v) {
      if (v.stopped) return;
      out.vendors.push({ name: v.name, ids: v.ids });
      (v.routes || []).forEach(function (r) { out.routes.push({ name: v.name, camp: r.camp, code: r.code, units: r.units, from: v.rFrom || '', to: v.rTo || '' }); });
    });
  } catch (e) { /* 정산 DB 를 못 읽으면 빈 목록 */ }
  return out;
}

/**
 * 저장된 칸 목록(adm_schSave 의 savedList: [{row,date,value,old}])에서 용차가 걸린 칸만 정산 [품앗이/용차 지정]에 맞춘다. (스케줄 잠금 안에서 부름)
 * → { added, removed, warn: [글자] } · 걸린 칸이 없으면 null
 */
function schYongSync_(savedList) {
  const list = (savedList || []).filter(function (x) { return /^용차/.test(str_(x.value)) || /^용차/.test(str_(x.old)); });
  if (!list.length || typeof stlRead_ !== 'function') return null;
  const res = { added: 0, removed: 0, warn: [] };
  const drvOf = {}, ctxOf = issCtxMaker_();
  const closed = {};
  const isClosed = function (date) { const m = stlMonthOfDate_(date); if (closed[m] === undefined) { try { closed[m] = !!stlClosedInfo_(m); } catch (e) { closed[m] = false; } } return closed[m]; };
  const md = function (d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); };
  let rows = null, V = null;
  list.forEach(function (x) {
    const ex = schExParse_(x.row), drvId = ex ? ex.driverId : String(x.row).split('~')[0];
    if (drvOf[drvId] === undefined) drvOf[drvId] = driverById_(drvId) || null;
    const d = drvOf[drvId]; if (!d) return; // 비고 · 품앗이 줄
    const p = schYongParse_(x.value), was = schYongParse_(x.old);
    if (!(p && p.vendor) && !(was && was.vendor)) return; // 업체 없는 '용차' ↔ 다른 값: 정산 줄 없음
    if (isClosed(x.date)) { res.warn.push(md(x.date) + ' 은 마감된 정산월이라 용차 청구 기록은 바꾸지 않았습니다.'); return; }
    if (rows === null) rows = stlRead_('stl_yongcha');
    const tag = SCH_YONG_TAG + ' [' + drvId + ']';
    // 1) 이 기사 · 이 날짜의 자동 줄 지우기 (빈 줄로)
    rows.filter(function (r) { return r._row && stlYmd_(r.date) === x.date && str_(r.memo).indexOf(tag) >= 0; }).forEach(function (r) {
      const blank = {}; Object.keys(STL_TABS.stl_yongcha).forEach(function (k) { blank[k] = ''; });
      stlSetRow_('stl_yongcha', r._row, blank); r.date = ''; r.memo = ''; res.removed++;
    });
    if (!p || !p.vendor) return;
    // 2) 업체 확인
    if (V === null) { try { V = stlVendors_(); } catch (e) { V = { by: {}, list: [] }; } }
    const v = V.by[stlVendorKey_(p.vendor)];
    if (!v) { res.warn.push('용차업체 「' + p.vendor + '」 가 정산관리 용차업체 목록에 없습니다. 업체를 등록해야 정산에 잡힙니다.'); return; }
    if (p.id && !v.ids.some(function (y) { return stlLogin_(y) === stlLogin_(p.id); })) res.warn.push('아이디 ' + p.id + ' 는 ' + v.name + ' 아이디로 등록되어 있지 않습니다. 정산관리 › 아이디 관리에서 그 아이디의 용차업체를 ' + v.name + ' 로 지정해야 업체 정산에 잡힙니다.');
    if (!p.charge) return; // 청구 없음: 업체 정산은 업체 아이디 배송으로 자동, 기사 청구 줄만 안 만든다
    const base = ex ? str_((extraAssignOf_(d).filter(function (y) { return y.c === ex.campId; })[0] || {}).r) : ctxOf(d, x.date).base;
    const route = /^\d/.test(base) ? normCode_(base.replace(/\([^)]*\)|\[[^\]]*]/g, '')) : '';
    if (!route) { res.warn.push(md(x.date) + ' ' + d.name + ': 담당 노선이 없어 차액 청구 줄을 만들지 못했습니다. 정산관리 › 품앗이/용차 지정에 직접 적어 주세요.'); return; }
    // 사람이 이미 같은 날 · 같은 업체 · 같은 기사로 적어 둔 줄이 있으면 그 줄을 쓴다
    const dup = rows.some(function (r) { return stlYmd_(r.date) === x.date && stlVendorKey_(str_(r.who).replace(/\s*\((용차)?업체\)\s*$/, '')) === v.key && (str_(r.payerId) === str_(d.loginId) || str_(r.payer) === d.name); });
    if (dup) return;
    stlAppend_('stl_yongcha', [{ date: x.date, who: v.name, whoId: '', route: route, mode: '건당', price: '', qty: '', payer: d.name, payerId: d.loginId || '', payerPrice: '', memo: tag + ' ' + d.name + ' 칸 용차', gain: '', vendorPay: '' }]);
    rows.push({ date: x.date, who: v.name, payer: d.name, payerId: d.loginId || '', memo: tag });
    res.added++;
  });
  if (res.added || res.removed) { try { stlBump_(); } catch (e) { /* 정산 캐시 */ } }
  return res.added || res.removed || res.warn.length ? res : null;
}

// ───── 담당 없음 노선: '이날은 용차업체가 뜀' 날짜 지정 (기사스케줄 표시 · 미입차 계산용) ─────
//  계속 맡기는 노선은 정산관리 › 용차업체 '맡은 노선'(기간)에 등록하고, 여기는 하루 단위로 지정한다.
//  업체 정산은 업체 아이디 배송으로 자동 계산되므로 정산 줄은 만들지 않는다.
const SCH_UNV = { SHEET: 'unvendor', HEAD: ['날짜', '캠프ID', '노선', '업체', '작성자', '작성일시'] };
/** [{ row, date, campId, code, vendor }] (탭이 없으면 빈 목록) */
function schUnvRead_() {
  const sh = schSS_().getSheetByName(SCH_UNV.SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SCH_UNV.HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, date: r[0] instanceof Date ? ymd_(r[0]) : str_(r[0]), campId: str_(r[1]), code: str_(r[2]), vendor: str_(r[3]) };
  }).filter(function (x) { return x.date && x.campId && x.code && x.vendor; });
}
/** o = { campId, code, date, vendor } · vendor 가 비면 지정 풀기 → { ok, days } */
function adm_schUnVendor(token, o) {
  return run_(function () {
    const a = requireAdmin_(token);
    o = o || {};
    const d = parseYmd_(o.date); if (!d) fail_('날짜를 확인해 주세요.');
    const date = ymd_(d), campId = str_(o.campId), code = str_(o.code), vendor = str_(o.vendor);
    if (!campId || !code) fail_('캠프 · 노선을 확인해 주세요.');
    if (vendor) {
      let okV = false;
      try { okV = stlVendors_().list.some(function (v) { return v.name === vendor && !v.stopped; }); } catch (e) { okV = false; }
      if (!okV) fail_('용차업체 「' + vendor + '」 가 정산관리 용차업체 목록에 없습니다.');
    }
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const book = schSS_();
      let sh = book.getSheetByName(SCH_UNV.SHEET);
      if (!sh) { if (!vendor) return { ok: true, days: [] }; sh = book.insertSheet(SCH_UNV.SHEET); sh.getRange(1, 1, 1, SCH_UNV.HEAD.length).setValues([SCH_UNV.HEAD]); }
      const hit = schUnvRead_().filter(function (x) { return x.date === date && x.campId === campId && x.code === code; });
      // 같은 날 · 같은 노선은 한 줄만: 아래에서부터 지우고 새로 적는다
      hit.map(function (x) { return x.row; }).sort(function (p, q) { return q - p; }).forEach(function (r) { sh.deleteRow(r); });
      if (vendor) sh.getRange(sh.getLastRow() + 1, 1, 1, SCH_UNV.HEAD.length).setValues([[date, campId, code, vendor, a.name || a.loginId || '', nowText_()]]);
    } finally { lock.releaseLock(); }
    try { fsMark_('sch', { by: a.loginId }); } catch (e) { /* 사본 표시는 실패해도 저장은 됨 */ }
    return { ok: true, days: schUnvRead_().map(function (x) { return { date: x.date, campId: x.campId, code: x.code, name: x.vendor }; }) };
  });
}
