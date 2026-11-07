/**
 * 세금계산서 역발행 — 전자세금계산서 발행을 어려워하는 기사(공급자)를 대신해 사무실(공급받는자 = 러너)이 계산서를 만든다.
 * (예전 '러너_세금계산서 역발행.xlsm' 을 옮김: 세금계산서 서식 · 발행내역관리 · 거래처별현황 · 월별발행현황 · 홈택스 엑셀 업로드 양식)
 *
 *  - 한 장 = tax_invoices 탭 1줄. 품목은 4줄까지 (단가는 부가세 포함 금액: 공급가액 = 반올림(수량×단가÷1.1), 세액 = 수량×단가 − 공급가액)
 *  - 정산관리에서 바로 만들기: 정산월의 기사별 '세금계산서 발행' 금액(공급가액·세액 그대로)으로 기사마다 1장
 *  - 기사에게는 '공급자 보관용' 그림으로 전달 (기사 앱 정산서 보기 → 세금계산서) · 관리자 화면에서 그림 일괄 내보내기(ZIP)
 *  - 데이터: 러너 올인원 DB 의 tax_invoices 탭 (시트에서 직접 고쳐도 됨)
 */
const TI_KINDS = ['영수', '청구'];
const TI_NTS = ['미등록', '등록'];
const TI_DEF_TYPE = '운수업', TI_DEF_ITEM = '택배';
const TI_ITEMS = 4;

/** 공급받는자 (러너 = company 탭) */
function tiBuyer_() {
  const co = companyInfo_();
  COMPANY.forEach(function (c) { if (!co[c[0]]) co[c[0]] = c[2]; }); // company 탭에 없으면 기본값
  return { no: co.branchBizNo || '', name: co.branchName || '', ceo: co.branchCeo || '', addr: co.branchAddr || '', type: co.branchBizType || '운수 및 창고업', item: co.branchBizItem || '택배업', email: co.branchEmail || '' };
}
/** 공급자 후보: 기사(사업자 정보) + 용차업체 */
function tiSuppliers_() {
  const out = [];
  readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name; }).forEach(function (o) {
    out.push({ id: o.id, driverId: o.id, label: o.name + (o.bizName && o.bizName !== o.name ? ' (' + o.bizName + ')' : ''), active: o.status === ST.ACTIVE,
      no: o.bizNo || '', name: o.bizName || o.name, ceo: o.bizCeo || o.name, addr: o.bizAddr || '', type: o.bizType || TI_DEF_TYPE, item: o.bizItem || TI_DEF_ITEM, email: o.bizEmail || '' });
  });
  try {
    if (props_().STL_DB_ID) stlVendors_().list.forEach(function (v) {
      out.push({ id: v.key, driverId: '', label: v.name + ' (용차업체)', active: !v.stopped, no: v.bizNo, name: v.name, ceo: v.ceo || v.name, addr: v.addr || '', type: v.bizType || TI_DEF_TYPE, item: v.bizItem || TI_DEF_ITEM, email: v.email || '' });
    });
  } catch (e) { /* 정산 DB 없음 */ }
  return out.sort(function (a, b) { return (a.active ? 0 : 1) - (b.active ? 0 : 1) || a.label.localeCompare(b.label, 'ko'); });
}
function tiNum_(v) { const n = Number(String(v == null ? '' : v).replace(/[,\s원]/g, '')); return isFinite(n) ? Math.round(n) : 0; }
/** 시트 줄 → 화면용 */
function tiOut_(r) {
  const items = [];
  for (let i = 1; i <= TI_ITEMS; i++) {
    const it = { md: str_(r['i' + i + 'md']), name: str_(r['i' + i + 'name']), spec: str_(r['i' + i + 'spec']), qty: tiNum_(r['i' + i + 'qty']), price: tiNum_(r['i' + i + 'price']), supply: tiNum_(r['i' + i + 'supply']), tax: tiNum_(r['i' + i + 'tax']), note: str_(r['i' + i + 'note']) };
    if (it.name || it.supply || it.price) items.push(it);
  }
  return {
    id: r.id, month: str_(r.month), date: normDate_(r.date) || str_(r.date), book1: str_(r.book1), book2: str_(r.book2), serial: str_(r.serial),
    kind: r.kind === '청구' ? '청구' : '영수', nts: r.nts === '등록' ? '등록' : '미등록', pub: r.pub !== 'N',
    supId: str_(r.supId), supDriverId: str_(r.supDriverId),
    sup: { no: str_(r.supNo), name: str_(r.supName), ceo: str_(r.supCeo), addr: str_(r.supAddr), type: str_(r.supType), item: str_(r.supItem), email: str_(r.supEmail) },
    buy: { no: str_(r.buyNo), name: str_(r.buyName), ceo: str_(r.buyCeo), addr: str_(r.buyAddr), type: str_(r.buyType), item: str_(r.buyItem), email: str_(r.buyEmail) },
    items: items, supply: tiNum_(r.supply), tax: tiNum_(r.tax), total: tiNum_(r.total), cash: tiNum_(r.cash), check: tiNum_(r.check), bill: tiNum_(r.bill), credit: tiNum_(r.credit),
    note: str_(r.note), createdAt: r.createdAt, updatedAt: r.updatedAt
  };
}
/** 화면 → 시트 줄 (금액 다시 계산) */
function tiRow_(t) {
  const sup = t.sup || {}, buy = t.buy || {};
  const date = normDate_(t.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail_('작성일자를 확인해 주세요.');
  if (!str_(sup.no).replace(/\D/g, '')) fail_('공급자 사업자등록번호를 넣어 주세요. (정산관리 → 아이디 관리 → 명의자 사업자 정보)');
  if (str_(sup.no).replace(/\D/g, '').length !== 10) fail_('공급자 사업자등록번호는 10자리입니다.');
  if (!str_(sup.name)) fail_('공급자 상호를 넣어 주세요.');
  if (str_(buy.no).replace(/\D/g, '').length !== 10) fail_('공급받는자(러너) 사업자등록번호를 확인해 주세요. (배번호 관리 → 회사 정보)');
  const row = {
    month: str_(t.month), date: date, book1: str_(t.book1).slice(0, 10), book2: str_(t.book2).slice(0, 10), serial: str_(t.serial).slice(0, 30),
    kind: TI_KINDS.indexOf(t.kind) >= 0 ? t.kind : '영수', nts: TI_NTS.indexOf(t.nts) >= 0 ? t.nts : '미등록', pub: t.pub === false ? 'N' : 'Y',
    supId: str_(t.supId), supDriverId: str_(t.supDriverId),
    supNo: bizNoFmt_(sup.no), supName: str_(sup.name).slice(0, 70), supCeo: str_(sup.ceo).slice(0, 30), supAddr: str_(sup.addr).slice(0, 150), supType: str_(sup.type).slice(0, 40), supItem: str_(sup.item).slice(0, 60), supEmail: str_(sup.email).slice(0, 60),
    buyNo: bizNoFmt_(buy.no), buyName: str_(buy.name).slice(0, 70), buyCeo: str_(buy.ceo).slice(0, 30), buyAddr: str_(buy.addr).slice(0, 150), buyType: str_(buy.type).slice(0, 40), buyItem: str_(buy.item).slice(0, 60), buyEmail: str_(buy.email).slice(0, 60),
    cash: tiNum_(t.cash) || '', check: tiNum_(t.check) || '', bill: tiNum_(t.bill) || '', credit: tiNum_(t.credit) || '', note: str_(t.note).slice(0, 150)
  };
  const items = (t.items || []).filter(function (it) { return it && (str_(it.name) || tiNum_(it.price) || tiNum_(it.supply)); }).slice(0, TI_ITEMS);
  if (!items.length) fail_('품목을 1줄 이상 넣어 주세요.');
  let sumS = 0, sumT = 0;
  for (let i = 1; i <= TI_ITEMS; i++) {
    const it = items[i - 1];
    ['md', 'name', 'spec', 'qty', 'price', 'supply', 'tax', 'note'].forEach(function (k) { row['i' + i + k] = ''; });
    if (!it) continue;
    const qty = tiNum_(it.qty) || 1, price = tiNum_(it.price);
    // 공급가액·세액을 직접 준 경우(정산에서 만든 계산서)는 그대로, 아니면 부가세 포함 단가로 계산
    let supply = tiNum_(it.supply), tax = tiNum_(it.tax);
    if (!it.fixed || (!supply && !tax)) { const tot = qty * price; supply = Math.round(tot / 1.1); tax = tot - supply; }
    if (!str_(it.name)) fail_(i + '번째 품목 이름을 넣어 주세요.');
    const md = str_(it.md) || date.slice(5);
    Object.assign(row, { ['i' + i + 'md']: md, ['i' + i + 'name']: str_(it.name).slice(0, 100), ['i' + i + 'spec']: str_(it.spec).slice(0, 60), ['i' + i + 'qty']: qty, ['i' + i + 'price']: price, ['i' + i + 'supply']: supply, ['i' + i + 'tax']: tax, ['i' + i + 'note']: str_(it.note).slice(0, 100) });
    sumS += supply; sumT += tax;
  }
  row.supply = sumS; row.tax = sumT; row.total = sumS + sumT;
  return row;
}
function bizNoFmt_(v) { const d = str_(v).replace(/\D/g, ''); return d.length === 10 ? d.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3') : str_(v); }
function tiNewId_() {
  // 잠금 안에서 호출. 마지막 계산서를 지운 뒤에도 같은 번호를 다시 쓰지 않도록 지금까지 준 가장 큰 번호를 따로 적어 둔다
  let max = Number(str_(readAll_(SH.APPSET).filter(function (o) { return o.key === 'tiSeq'; }).map(function (o) { return o.value; })[0])) || 0;
  readAll_(SH.TAXINV).forEach(function (r) { const m = String(r.id || '').match(/^T(\d+)D$/); if (m) max = Math.max(max, Number(m[1])); });
  const f = function () { max++; return 'T' + max + 'D'; };
  f.save = function () { appSetPut_('tiSeq', String(max), '세금계산서 역발행: 마지막으로 준 계산서 번호 (지우지 마세요)'); };
  return f;
}

// ───────────────────────── 관리자 ─────────────────────────
/** 목록 전체 + 공급자 후보 + 공급받는자(러너) */
function adm_tiList(token) {
  return run_(function () {
    requireAdmin_(token);
    const on = {}, ids = {};
    readAll_(SH.DRIVERS).forEach(function (o) {
      if (str_(o.tiOn) === 'Y') on[String(o.id)] = 1;
      ids[String(o.id)] = [o.loginId, o.subId1, o.subId2].map(function (x) { return str_(x); }).filter(Boolean); // 기사 아이디 (메인 · 서브)
    });
    const list = readAll_(SH.TAXINV).filter(function (r) { return r.id; }).map(function (r) {
      const t = tiOut_(r), did = String(r.supDriverId || r.supId || ''), isDrv = !!did && !/^v:/.test(did);
      t.appOn = isDrv && !!on[did]; t.hasDrv = isDrv; t.loginIds = isDrv ? (ids[did] || []) : []; return t;
    })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }); });
    return { ok: true, list: list, suppliers: tiSuppliers_(), buyer: tiBuyer_(), today: todayText_(), kinds: TI_KINDS };
  });
}
/** 저장 (id 가 있으면 고침) */
function adm_tiSave(token, t) {
  return run_(function () {
    const a = requireAdmin_(token);
    const row = tiRow_(t || {});
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (t.id) {
        const r = findRow_(SH.TAXINV, 'id', str_(t.id));
        if (!r) fail_('계산서를 찾을 수 없습니다. 새로고침해 주세요.');
        row.updatedAt = now; row.admin = a.name;
        writeFields_(SH.TAXINV, r, row);
        logAdmin_(a, '세금계산서 수정', t.id, row.supName + ' ' + row.total);
        return { ok: true, id: t.id };
      }
      const next = tiNewId_(), id = next();
      appendObj_(SH.TAXINV, Object.assign({ id: id, createdAt: now, updatedAt: now, admin: a.name }, row));
      next.save();
      logAdmin_(a, '세금계산서 작성', id, row.supName + ' ' + row.total);
      return { ok: true, id: id };
    } finally { lock.releaseLock(); }
  });
}
/** 여러 장 한 번에: action = delete / nts:등록 / nts:미등록 / pub:Y / pub:N / kind:영수 / kind:청구 */
function adm_tiBulk(token, ids, action) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) fail_('계산서를 골라 주세요.');
    const want = {};
    ids.forEach(function (id) { want[str_(id)] = 1; });
    const m = String(action || '').match(/^(nts|pub|kind):(.+)$/);
    if (action !== 'delete' && !m) fail_('알 수 없는 작업입니다.');
    const lock = scriptLock_();
    lock.waitLock(30000);
    let n = 0;
    try {
      const rows = readAll_(SH.TAXINV).filter(function (r) { return want[r.id]; });
      if (action === 'delete') n = delRows_(sheet_(SH.TAXINV), rows.map(function (r) { return r._row; }));
      else {
        const f = {};
        if (m[1] === 'nts') f.nts = TI_NTS.indexOf(m[2]) >= 0 ? m[2] : '미등록';
        if (m[1] === 'pub') f.pub = m[2] === 'N' ? 'N' : 'Y';
        if (m[1] === 'kind') f.kind = TI_KINDS.indexOf(m[2]) >= 0 ? m[2] : '영수';
        f.updatedAt = nowText_();
        rows.forEach(function (r) { writeFields_(SH.TAXINV, r._row, f); n++; });
      }
      logAdmin_(a, '세금계산서 ' + action, n + '장', '');
    } finally { lock.releaseLock(); }
    return { ok: true, n: n };
  });
}
/**
 * 정산관리에서 만들기: month 정산월의 기사(명의자)·용차업체별 '세금계산서 발행' 금액으로 1장씩.
 * 이미 그 정산월·공급자 계산서가 있으면 건너뜀 (overwrite = true 면 금액·공급자 정보를 새로 고침).
 * 작성일자 = 정산월 말일, 품목 = 'N월 용역비', 수량 1, 단가 = 합계(부가세 포함), 공급가액·세액은 정산서 그대로.
 */
function adm_tiFromSettle(token, month, overwrite) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const res = stlResult_(month, false), cfg = stlCfg_();
    const dates = stlDates_(month, cfg), buyer = tiBuyer_();
    const sups = {};
    tiSuppliers_().forEach(function (s) { sups[s.id] = s; });
    const lock = scriptLock_();
    lock.waitLock(30000);
    const made = [], skipped = [], noBiz = [], notOn = [];
    // 역발행은 기사 정보에서 '역발행 기사'로 지정한 기사만 (용차업체는 만들지 않음)
    const on = {}; readAll_(SH.DRIVERS).forEach(function (o) { if (str_(o.tiOn) === 'Y') on[String(o.id)] = 1; });
    try {
      const old = {};
      readAll_(SH.TAXINV).forEach(function (r) { if (r.month === month && r.supId) old[r.supId] = r; });
      const next = tiNewId_(), now = nowText_(), add = [];
      res.summary.drivers.forEach(function (d) {
        if (!(d.invoice > 0)) return;
        const key = d.vendor ? stlVendorKey_(d.vendor) : d.ownerId;
        if (d.vendor || !on[String(key)]) { notOn.push(d.name); return; }
        const s = sups[key];
        if (!key || !s) { skipped.push(d.name + ' (명의자 없음)'); return; }
        if (str_(s.no).replace(/\D/g, '').length !== 10) { noBiz.push(d.name); return; }
        const mm = Number(month.slice(5, 7));
        const t = {
          month: month, date: dates.writeDate, kind: '영수', nts: '미등록', pub: true, supId: key, supDriverId: s.driverId,
          sup: s, buy: buyer, items: [{ md: dates.writeDate.slice(5), name: mm + '월 용역비', qty: 1, price: d.invoice, supply: d.supply, tax: d.tax, fixed: true }]
        };
        const row = tiRow_(t);
        const o = old[key];
        if (o) {
          if (!overwrite) { skipped.push(d.name + ' (이미 있음)'); return; }
          row.updatedAt = now; row.admin = a.name;
          writeFields_(SH.TAXINV, o._row, row);
          made.push(d.name);
          return;
        }
        add.push(Object.assign({ id: next(), createdAt: now, updatedAt: now, admin: a.name }, row));
        made.push(d.name);
      });
      if (add.length) { appendObjs_(SH.TAXINV, add); next.save(); }
      logAdmin_(a, '세금계산서 정산에서 만들기', month, made.length + '장');
    } finally { lock.releaseLock(); }
    return { ok: true, made: made, skipped: skipped, noBiz: noBiz, notOn: notOn };
  });
}

// ───────────────────────── 기사 앱 ─────────────────────────
/** 내 정산서 화면용: 그 정산월 나(명의자)의 공개된 계산서 (공급자 보관용 그림으로 보여 줌) */
function tiForDriver_(driverId, month) {
  // 기사 정보에서 '세금계산서 역발행 대상' 으로 지정한 기사에게만 보여 줌
  const me = driverById_(String(driverId));
  if (!me || str_(me.tiOn) !== 'Y') return [];
  return readAll_(SH.TAXINV).filter(function (r) { return r.id && r.month === month && r.pub !== 'N' && (r.supDriverId === driverId || r.supId === driverId); })
    .map(tiOut_).map(function (t) { delete t.createdAt; delete t.updatedAt; delete t.supId; return t; });
}
