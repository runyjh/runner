/**
 * 기존 정산 시트(러너_쿠팡정산관리_2026) → 러너 올인원 정산 DB 이관 (한 번만)
 *
 *  - 쿠팡 원천 · 분실파손 · 차수이력 · 공제·가감 · 가불금 · 용차내역 · 설정(항목·지급률·산재고용·정기수당·목표수당·매출분할·퇴사보류)
 *    → 정산 DB 탭으로 복사
 *  - 기사마스터(한 줄 = 쿠팡 아이디) → 정산 DB 아이디 관리(stl_ids: 메인/서브·명의자·단가 구분·정산 방식·보험 제외·프백 차감)
 *    + 일시단가(stl_tmp, 기사 + 기간) + 아이디 사용 기록(stl_usage: 명의자가 아닌 기사가 그 아이디를 쓰는 경우)
 *  - 명의자(기사)의 계좌·사업자 정보는 러너 올인원 DB drivers 의 "빈 칸만" 채움. 명의자가 러너 DB 에 없으면 '정지' 기사로 새로 만든다
 *  - 노선단가 → 노선관리 구분별 단가의 "빈 칸만" 채움 (원청단가 = 쿠팡 원단가, 기사단가 = 고정단가, 백업단가)
 *    opts.overwritePrices 면 다른 값도 덮어씀
 *  - 마지막에 기존 시트 조회월 결과와 새 계산을 기사별로 비교해 돌려준다
 *
 * opts = { dry: true(미리보기만), replace: true(정산 DB 에 이미 있는 기록을 지우고 다시), overwritePrices }
 */
function adm_stlMigrate(token, src, opts) {
  return run_(function () {
    const a = requireAdmin_(token);
    opts = opts || {};
    const m = String(src || '').match(/[-\w]{25,}/);
    if (!m) fail_('기존 정산 시트 주소(또는 파일 ID)를 넣어 주세요.');
    let book;
    try { book = SpreadsheetApp.openById(m[0]); } catch (e) { fail_('시트를 열 수 없습니다. 주소와 공유 권한을 확인해 주세요.'); }
    const need = function (name) { const sh = book.getSheetByName(name); if (!sh) fail_('기존 시트에 "' + name + '" 탭이 없습니다.'); return sh; };
    const rep = { dry: !!opts.dry, notes: [] };

    // ── 1) 읽기 ──
    const raw = mgRaw_(need('DB쿠팡정산서'));
    const rounds = mgRounds_(book.getSheetByName('DB계산'));
    const adj = mgAdjust_(need('공제·용차'));
    const setup = mgSetup_(need('설정'));
    const master = mgMaster_(need('기사마스터'));
    const priceRows = mgPrices_(need('노선단가'));
    rep.read = {
      raw: raw.raw.length, loss: raw.loss.length, months: Object.keys(raw.months).sort(), rounds: rounds.length,
      adjust: adj.adjust.length, advance: adj.advance.length, yongcha: adj.yongcha.length,
      items: setup.items.length, config: Object.keys(setup.config).length, camps: setup.camps.length, regular: setup.regular.length,
      target: setup.target.length, split: setup.split.length, leave: setup.leave.length, kinds: setup.kinds.length,
      master: master.length, prices: priceRows.length
    };

    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      // ── 2) 기사 (러너 올인원 DB) ──
      rep.drivers = mgDrivers_(master, !!opts.dry);
      // ── 3) 단가 (노선관리) ──
      rep.prices = mgPriceFill_(priceRows, !!opts.dry, !!opts.overwritePrices);
      if (!opts.dry) { bumpMaster_(); _cols[SH.DRIVERS] = null; }

      // ── 4) 정산 DB ──
      const idRows = mgIdRows_(master, rep.drivers);
      rep.ids = { count: idRows.ids.length, subs: idRows.ids.filter(function (x) { return x.role === '서브'; }).map(function (x) { return x.cid + ' → ' + x.main; }), usage: idRows.usage.map(function (u) { return u.cid + ' : ' + u.name + ' (명의자 ' + u._owner + ')'; }), tmp: idRows.tmp.length };
      const have = ['stl_raw', 'stl_adjust', 'stl_advance', 'stl_yongcha'].filter(function (t) { return stlSheet_(t).getLastRow() > 1; });
      if (have.length && !opts.replace && !opts.dry) fail_('정산 DB 에 이미 기록이 있습니다 (' + have.join(', ') + '). "기존 기록 지우고 다시" 를 체크해 주세요.');
      rep.existing = have;
      let D = null, X = null, nameMap = {};
      const res = function (name) { if (!X) return ''; const k = nameMap[name] || stlAcct_(X, D, name, ''); return k ? X.groups[k].cid : ''; };
      const nm = function (acct, name) { const g = acct && X ? X.groups[stlLogin_(acct)] : null; return g && g.ownerId ? D.byId[g.ownerId].name : name; };
      if (!opts.dry) {
        stlWriteAll_('stl_ids', idRows.ids);
        stlWriteAll_('stl_usage', idRows.usage);
        stlWriteAll_('stl_tmp', idRows.tmp);
        D = stlDrivers_(); X = stlIds_(D); nameMap = mgNameMap_(master, X);
        raw.raw.sort(function (x, y) { return x.month < y.month ? -1 : x.month > y.month ? 1 : 0; });
        raw.loss.sort(function (x, y) { return x.month < y.month ? -1 : x.month > y.month ? 1 : 0; });
        stlWriteAll_('stl_raw', raw.raw);
        stlWriteAll_('stl_loss', raw.loss);
        stlWriteAll_('stl_rounds', rounds);
        stlWriteAll_('stl_adjust', adj.adjust.map(function (x) { const id = res(x.name); return Object.assign(x, { acct: id, name: nm(id, x.name) }); }));
        stlWriteAll_('stl_advance', adj.advance.map(function (x) { const id = res(x.name); return Object.assign(x, { acct: id, name: nm(id, x.name) }); }));
        stlWriteAll_('stl_yongcha', adj.yongcha.map(function (x) {
          const w = res(x.who), p = res(x.payer);
          return Object.assign(x, { whoId: w, who: nm(w, x.who), payerId: p, payer: nm(p, x.payer) });
        }));
        if (setup.items.length) stlWriteAll_('stl_items', setup.items);
        if (setup.kinds.length) stlWriteAll_('stl_kinds', setup.kinds);
        if (setup.camps.length) stlWriteAll_('stl_camps', setup.camps);
        stlWriteAll_('stl_regular', setup.regular.map(function (x) { const id = res(x.name); return Object.assign(x, { acct: id, name: nm(id, x.name) }); }));
        stlWriteAll_('stl_target', setup.target.map(function (x) { const id = res(x.name); return Object.assign(x, { acct: id, name: nm(id, x.name) }); }));
        stlWriteAll_('stl_split', setup.split.map(function (x) {
          const f = res(x.from), t = res(x.to);
          return Object.assign(x, { fromId: f, from: nm(f, x.from), toId: t, to: nm(t, x.to) });
        }));
        stlWriteAll_('stl_leave', setup.leave.map(function (x) { const id = res(x.name); return Object.assign(x, { acct: id, name: nm(id, x.name) }); }));
        // 설정 값
        const cfgRows = STL_CFG.map(function (d) { return { label: d[1], value: setup.config[d[0]] !== undefined ? setup.config[d[0]] : d[2], desc: d[3] }; });
        stlWriteAll_('stl_config', cfgRows);
        stlBump_();
        const unresolved = {};
        adj.adjust.concat(adj.advance, setup.regular, setup.target, setup.leave).forEach(function (x) { if (x.name && !x.acct) unresolved[x.name] = 1; });
        adj.yongcha.forEach(function (x) { if (x.payer && !x.payerId) unresolved[x.payer] = 1; });
        rep.unresolved = Object.keys(unresolved);
        logAdmin_(a, '기존 정산 시트 이관', book.getName(), JSON.stringify(rep.read));
      }
    } finally {
      lock.releaseLock();
    }

    // ── 5) 비교 (기존 시트 조회월) ──
    if (!opts.dry) {
      try { rep.compare = mgCompare_(book.getSheetByName('DB계산'), master); } catch (e) { rep.compare = { error: String(e && e.message || e) }; }
    }
    return { ok: true, report: rep };
  });
}

// 머리글 정리: 띄어쓰기·줄바꿈 제거
function mgKey_(v) { return str_(v).replace(/\s+/g, ''); }
function mgFindCol_(head, label) {
  const k = mgKey_(label);
  for (let i = 0; i < head.length; i++) if (mgKey_(head[i]) === k) return i;
  for (let i = 0; i < head.length; i++) if (mgKey_(head[i]).indexOf(k) === 0) return i;
  return -1;
}
function mgCell_(v) {
  if (v instanceof Date) return ymd_(v);
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  return str_(v);
}

/** DB쿠팡정산서: 왼쪽 원천(1행 머리글) + 오른쪽 분실파손(2행 머리글) */
function mgRaw_(sh) {
  const last = sh.getLastRow(), width = sh.getLastColumn();
  const head = sh.getRange(1, 1, 3, width).getValues();
  const h1 = head[0];
  const rc = {
    kind: mgFindCol_(h1, '구분'), cid: mgFindCol_(h1, 'ID'), route: mgFindCol_(h1, '라우트'), date: mgFindCol_(h1, '배송일자'), camp: mgFindCol_(h1, '캠프명'),
    dtype: mgFindCol_(h1, '배송유형'), vendor: mgFindCol_(h1, '업체명'), qty: mgFindCol_(h1, '배송건수'), ret: mgFindCol_(h1, '반품건수'), price: mgFindCol_(h1, '단가'),
    inc: mgFindCol_(h1, '추가인센티브(건당)'), base: mgFindCol_(h1, '기본배송금액'), incAmt: mgFindCol_(h1, '추가인센티브금액'), total: mgFindCol_(h1, '총금액'),
    fresh: mgFindCol_(h1, '프레시백'), month: mgFindCol_(h1, '정산월'), round: mgFindCol_(h1, '차수')
  };
  ['cid', 'month', 'total'].forEach(function (k) { if (rc[k] < 0) fail_('DB쿠팡정산서 1행에서 "' + k + '" 열을 찾지 못했습니다.'); });
  // 분실파손: '날짜','캠프','ID' 가 이어진 머리글
  let lr = -1, lc = -1;
  for (let r = 0; r < 3 && lr < 0; r++) for (let c = 20; c < width - 2; c++) {
    if (mgKey_(head[r][c]) === '날짜' && mgKey_(head[r][c + 1]) === '캠프' && mgKey_(head[r][c + 2]) === 'ID') { lr = r; lc = c; break; }
  }
  const out = { raw: [], loss: [], months: {} };
  const maxC = Math.max.apply(null, Object.keys(rc).map(function (k) { return rc[k]; })) + 1;
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, maxC).getValues();
    vals.forEach(function (v) {
      const cid = str_(v[rc.cid]), month = str_(v[rc.month]);
      if (!cid || !stlMonthOk_(month)) return;
      const o = {};
      Object.keys(rc).forEach(function (k) { o[k] = rc[k] >= 0 ? mgCell_(v[rc[k]]) : ''; });
      o.date = stlYmd_(o.date);
      out.raw.push(o); out.months[month] = 1;
    });
  }
  if (lr >= 0) {
    const lh = head[lr].slice(lc, lc + 14);
    const lcx = {
      date: mgFindCol_(lh, '날짜'), camp: mgFindCol_(lh, '캠프'), cid: mgFindCol_(lh, 'ID'), type: mgFindCol_(lh, '유형'), detail: mgFindCol_(lh, '상세'),
      cnt: mgFindCol_(lh, '개수'), amt: mgFindCol_(lh, '차감금액'), vendor: mgFindCol_(lh, '업체명'), waybill: mgFindCol_(lh, '운송장번호'), item: mgFindCol_(lh, '상품명'),
      month: mgFindCol_(lh, '정산월'), round: mgFindCol_(lh, '차수')
    };
    const start = lr + 2;
    if (last >= start) {
      sh.getRange(start, lc + 1, last - start + 1, 14).getValues().forEach(function (v) {
        const cid = str_(v[lcx.cid]), month = str_(v[lcx.month]);
        if (!cid || !stlMonthOk_(month)) return;
        const o = {};
        Object.keys(lcx).forEach(function (k) { o[k] = lcx[k] >= 0 ? mgCell_(v[lcx[k]]) : ''; });
        o.date = stlYmd_(o.date);
        out.loss.push(o);
      });
    }
  }
  return out;
}
/** DB계산의 차수이력 표 ('정산월','차수','파일명' 머리글) */
function mgRounds_(sh) {
  if (!sh) return [];
  const width = sh.getLastColumn(), last = sh.getLastRow();
  const head = sh.getRange(1, 1, Math.min(12, last), width).getValues();
  for (let r = 0; r < head.length; r++) for (let c = 0; c < width - 8; c++) {
    if (mgKey_(head[r][c]) === '정산월' && mgKey_(head[r][c + 1]) === '차수' && mgKey_(head[r][c + 2]) === '파일명') {
      const out = [];
      if (last > r + 1) sh.getRange(r + 2, c + 1, last - r - 1, 9).getValues().forEach(function (v) {
        if (!stlMonthOk_(str_(v[0])) || !str_(v[4])) return;
        out.push({ month: str_(v[0]), round: mgCell_(v[1]), file: str_(v[2]), url: '', at: mgCell_(v[3]), cid: str_(v[4]), amt: mgCell_(v[5]), prev: mgCell_(v[6]), diff: mgCell_(v[7]), memo: str_(v[8]) });
      });
      return out;
    }
  }
  return [];
}
/** 공제·용차: 왼쪽 공제·가감(자동 구간 제외) / 가불금 원장 / 용차내역 */
function mgAdjust_(sh) {
  const last = sh.getLastRow(), width = Math.min(sh.getLastColumn(), 26);
  const v = sh.getRange(1, 1, last, width).getDisplayValues();
  let hr = -1;
  for (let r = 0; r < 12; r++) if (/^정산월/.test(mgKey_(v[r][0]))) { hr = r; break; }
  if (hr < 0) fail_('공제·용차 탭의 머리글(정산월)을 찾지 못했습니다.');
  const h = v[hr];
  const col = function (label, from) { for (let i = from || 0; i < h.length; i++) if (mgKey_(h[i]).indexOf(mgKey_(label)) === 0) return i; return -1; };
  const aName = col('기사명'), aItem = col('항목'), aAmt = col('금액'), aMemo = col('메모');
  const bName = col('기사명', aMemo + 1), bDate = col('지급일'), bAmt = col('가불금'), bDue = col('상계'), bPaid = col('상환금'), bMemo = col('메모', bPaid + 1);
  const cDate = col('날짜'), cWho = col('수행자'), cRoute = col('라우트'), cMode = col('지급구분'), cPrice = col('단가'), cQty = col('건수'), cPayer = col('차액부담'), cPP = col('부담기준단가'), cMemo = col('메모', cPP + 1);
  const out = { adjust: [], advance: [], yongcha: [] };
  let autoZone = false;
  const num = function (s) { return String(stlNum_(s) || ''); };
  for (let r = hr + 1; r < v.length; r++) {
    const row = v[r];
    if (/^▼/.test(str_(row[0]))) autoZone = true; // 정기 수당 등 자동 구간 (새 프로그램이 다시 만든다)
    if (!autoZone && stlMonthOk_(str_(row[0])) && str_(row[aName]) && str_(row[aItem])) {
      out.adjust.push({ month: str_(row[0]), name: str_(row[aName]), item: str_(row[aItem]), amt: num(row[aAmt]), memo: str_(row[aMemo]) });
    }
    if (bName >= 0 && str_(row[bName]) && stlNum_(row[bAmt])) {
      out.advance.push({ name: str_(row[bName]), date: stlYmd_(row[bDate]), amt: num(row[bAmt]), due: stlYmd_(row[bDue]), paid: num(row[bPaid]), memo: str_(row[bMemo]) });
    }
    if (cDate >= 0 && /^\d{4}-\d{2}-\d{2}/.test(stlYmd_(row[cDate])) && str_(row[cWho])) {
      out.yongcha.push({
        date: stlYmd_(row[cDate]), who: str_(row[cWho]), route: str_(row[cRoute]), mode: str_(row[cMode]) === '금액' ? '금액' : '건당',
        price: num(row[cPrice]), qty: num(row[cQty]), payer: str_(row[cPayer]), payerPrice: num(row[cPP]), memo: cMemo >= 0 ? str_(row[cMemo]) : ''
      });
    }
  }
  return out;
}
/** 설정 탭: 머리글 글자로 표를 찾는다 */
function mgSetup_(sh) {
  const last = sh.getLastRow(), width = Math.min(sh.getLastColumn(), 12);
  const v = sh.getRange(1, 1, last, width).getDisplayValues();
  const K = function (r, c) { return mgKey_((v[r] || [])[c]); };
  const out = { items: [], config: {}, camps: [], regular: [], target: [], split: [], leave: [], kinds: [] };
  const take = function (r0, fn) { for (let r = r0; r < v.length; r++) { if (!str_(v[r][1])) break; fn(v[r]); } };
  for (let r = 0; r < v.length; r++) {
    if (K(r, 1) === '순서' && K(r, 2) === '구분' && /^항목이름/.test(K(r, 3))) {
      take(r + 1, function (x) { if (str_(x[3])) out.items.push({ order: str_(x[1]), side: str_(x[2]), name: str_(x[3]), method: str_(x[4]), show: str_(x[5]), taxCut: str_(x[6]), desc: str_(x[7]) }); });
    } else if (K(r, 1) === '기사명' && K(r, 2) === '항목' && /^월금액/.test(K(r, 3))) {
      take(r + 1, function (x) { out.regular.push({ name: str_(x[1]), item: str_(x[2]), amt: String(stlNum_(x[3]) || ''), from: str_(x[4]), to: str_(x[5]), memo: str_(x[6]) }); });
    } else if (K(r, 1) === '기사명' && /^항목/.test(K(r, 2)) && /^연목표/.test(K(r, 3))) {
      take(r + 1, function (x) { out.target.push({ name: str_(x[1]), item: str_(x[2]), goal: String(stlNum_(x[3]) || ''), unit: String(stlNum_(x[4]) || '') }); });
    } else if (/^원기사/.test(K(r, 1)) && /^받는기사/.test(K(r, 2))) {
      take(r + 1, function (x) { out.split.push({ from: str_(x[1]), to: str_(x[2]), target: String(stlNum_(x[3]) || ''), unit: String(stlNum_(x[4]) || ''), repeat: /^true$/i.test(str_(x[7])) ? 'Y' : 'N', month: str_(x[8]) }); });
    } else if (K(r, 1) === '기사명' && /^퇴사월/.test(K(r, 2))) {
      take(r + 1, function (x) { out.leave.push({ name: str_(x[1]), month: str_(x[2]), amt: String(stlNum_(x[3]) || '') }); });
    } else if (K(r, 1) === '구분' && K(r, 2) === '캠프명' && /^경비/.test(K(r, 3))) {
      for (let q = r + 1; q < v.length && /^캠프/.test(K(q, 1)); q++) {
        if (str_(v[q][2])) out.camps.push({ camp: str_(v[q][2]), expense: str_(v[q][3]), san: str_(v[q][4]), goy: str_(v[q][5]), runner: str_(v[q][6]) });
      }
    }
  }
  // 지급률·보험·일정 값 (B열 이름 → C열 값)
  const LABELS = {
    incRate: '프백가중치(건당)기사지급률', freshRate: '프레시백회수인센티브기사지급률', uncFee: '미계약라우트업체수수료율', etcRate: '기타(프로모션·전월소급등)기사지급률',
    lossRate: '분실파손기사부담률', vat: '부가세율', lossVat: '분실파손금액도부가세포함환산', expense: '필요경비공제율',
    san: '산재보험료율', commute: '출퇴근재해요율', goy: '고용보험료율', goyMin: '고용보험적용최저월보수액', runner: '러너부담률기본값', insBasis: '보험계산기준',
    cpDay: '쿠팡입금일', payDay: '러너기사지급일', payShift: '러너지급일도휴일이면', email: '이메일(세금계산서수신)'
  };
  for (let r = 0; r < v.length; r++) {
    const k = K(r, 1);
    Object.keys(LABELS).forEach(function (key) { if (out.config[key] === undefined && k.indexOf(LABELS[key]) === 0 && str_(v[r][2])) out.config[key] = str_(v[r][2]); });
  }
  return out;
}
/** 기사마스터 (5행 머리글) */
function mgMaster_(sh) {
  const last = sh.getLastRow(), width = sh.getLastColumn();
  const v = sh.getRange(1, 1, last, width).getDisplayValues();
  let hr = -1;
  for (let r = 0; r < 10; r++) if (mgKey_(v[r][0]) === '기사명' && mgKey_(v[r][1]) === 'ID') { hr = r; break; }
  if (hr < 0) fail_('기사마스터 머리글(기사명, ID)을 찾지 못했습니다.');
  const h = v[hr];
  const c = function (label) { return mgFindCol_(h, label); };
  const C = {
    name: 0, cid: 1, sub: c('ID구분'), mode: c('지급방식'), code: c('코드구분'), status: c('상태'), bank: c('은행'), account: c('계좌번호'), holder: c('예금주'),
    bizNo: c('사업자등록번호'), bizName: c('상호'), email: c('이메일'), tmp: c('일시단가'), tmpRoutes: c('적용노선'), tmpFrom: c('시작일'), tmpTo: c('종료일'),
    fbCut: c('프레시백차감'), disp: c('표시명'), san: c('산재Y'), goy: c('고용Y')
  };
  const out = [];
  for (let r = hr + 1; r < v.length; r++) {
    const x = v[r];
    if (!str_(x[C.cid])) continue;
    const o = {};
    Object.keys(C).forEach(function (k) { o[k] = C[k] >= 0 ? str_(x[C[k]]) : ''; });
    o.disp = o.disp || o.name;
    out.push(o);
  }
  return out;
}
/** 노선단가 (5행 머리글: 캠프, 라우트, 고정단가, 백업단가, 비고, 쿠팡 원단가) */
function mgPrices_(sh) {
  const last = sh.getLastRow(), width = Math.min(sh.getLastColumn(), 13);
  const v = sh.getRange(1, 1, last, width).getDisplayValues();
  let hr = -1;
  for (let r = 0; r < 10; r++) if (mgKey_(v[r][0]) === '캠프' && mgKey_(v[r][1]) === '라우트') { hr = r; break; }
  if (hr < 0) fail_('노선단가 머리글(캠프, 라우트)을 찾지 못했습니다.');
  const h = v[hr];
  const cF = mgFindCol_(h, '고정단가'), cB = mgFindCol_(h, '백업단가'), cO = mgFindCol_(h, '쿠팡원단가');
  const out = [];
  for (let r = hr + 1; r < v.length; r++) {
    const x = v[r];
    if (!str_(x[0]) || !str_(x[1])) continue;
    out.push({ camp: str_(x[0]), route: normCode_(x[1]), fixed: stlNum_(x[cF]), backup: stlNum_(x[cB]), origin: cO >= 0 ? stlNum_(x[cO]) : 0 });
  }
  return out;
}

/** 이름 비교용: 띄어쓰기·괄호 안 글자 빼기 */
function mgNm_(v) { return str_(v).replace(/\([^)]*\)/g, '').replace(/\s+/g, ''); }
/** 한 글자 차이(오타)까지 같은 이름으로 본다 */
function mgSameName_(a, b) {
  a = mgNm_(a); b = mgNm_(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length !== b.length || a.length < 2) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d <= 1;
}
/**
 * 기사마스터 → 명의자(기사) 정하기 + 명의자 계좌·사업자 빈 칸 채우기.
 * 명의자 = 기사마스터 '기사명'. 러너 DB 에서 ① 그 아이디의 기사가 같은 이름(예금주·표시명, 한 글자 오타 허용)이면 그 기사
 * ② 아니면 같은 이름의 기사(한 명일 때) ③ 없으면 '정지' 상태로 새로 만든다.
 * 그 아이디의 러너 기사가 명의자와 다른 사람이면 "아이디 사용 기록"(그 기사가 이 아이디로 일함)으로 남긴다.
 */
function mgDrivers_(master, dry) {
  const rep = { created: [], filled: 0, fields: {}, conflicts: [], ownerOf: {}, workerOf: {} };
  const all = readAll_(SH.DRIVERS);
  const byLogin = {}, byName = {};
  all.forEach(function (o) { if (o.loginId) byLogin[stlLogin_(o.loginId)] = o; (byName[mgNm_(o.name)] = byName[mgNm_(o.name)] || []).push(o); });
  const person = {}; // 기사명 → 러너 기사
  master.forEach(function (x) {
    if (person[x.name]) return;
    const lg = byLogin[stlLogin_(x.cid)];
    let d = null;
    if (lg && (mgSameName_(lg.name, x.name) || mgSameName_(lg.name, x.disp) || mgSameName_(lg.name, x.holder))) d = lg;
    if (!d) { const n = byName[mgNm_(x.name)] || []; if (n.length === 1) d = n[0]; }
    if (!d) {
      // 같은 기사명의 다른 아이디 줄에서 찾기
      master.forEach(function (y) {
        if (d || y.name !== x.name) return;
        const l2 = byLogin[stlLogin_(y.cid)];
        if (l2 && (mgSameName_(l2.name, y.name) || mgSameName_(l2.name, y.holder))) d = l2;
      });
    }
    if (!d) {
      const obj = { id: dry ? 'NEW_' + x.name : newDriverId_(), name: x.disp || x.name, status: ST.STOPPED, createdAt: nowText_(), updatedAt: nowText_(), memo: '정산 이관으로 추가 (기사마스터 명의자: ' + x.name + ')' };
      if (!dry) obj._row = appendObj_(SH.DRIVERS, obj);
      d = obj;
      rep.created.push(obj.name);
    }
    person[x.name] = d;
  });
  master.forEach(function (x) {
    const k = stlLogin_(x.cid), d = person[x.name];
    rep.ownerOf[k] = d.id;
    const lg = byLogin[k];
    if (lg && lg.id !== d.id) rep.workerOf[k] = { id: lg.id, name: lg.name, owner: d.name };
  });
  // 명의자 계좌·사업자 정보 (빈 칸만)
  const done = {};
  master.forEach(function (x) {
    const d = person[x.name];
    if (done[d.id] && x.sub === '서브') return;
    const f = {};
    const fill = function (key, val, label) {
      if (!val) return;
      const cur = str_(d[key]);
      if (!cur) { f[key] = val; rep.fields[label] = (rep.fields[label] || 0) + 1; }
      else if (cur !== val && key !== 'account') rep.conflicts.push(d.name + ' · ' + label + ': 러너 "' + cur + '" / 기존 "' + val + '"');
    };
    fill('bankName', x.bank, '은행');
    fill('accountHolder', x.holder, '예금주');
    const acc = digits_(x.account);
    if (acc.length >= 8 && acc.length <= 16 && !d.accountEnc) { f.accountEnc = dry ? 'x' : encrypt_(acc); f.account = maskAccount_(acc); rep.fields['계좌번호'] = (rep.fields['계좌번호'] || 0) + 1; }
    const biz = digits_(x.bizNo);
    if (biz.length === 10) fill('bizNo', biz.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3'), '사업자번호');
    fill('bizName', x.bizName, '상호');
    fill('bizEmail', x.email, '계산서 이메일');
    if (Object.keys(f).length) {
      rep.filled++;
      if (!dry && d._row) { f.updatedAt = nowText_(); writeFields_(SH.DRIVERS, d._row, f); forgetDriver_(d); }
      Object.assign(d, f);
    }
    done[d.id] = 1;
  });
  rep.conflicts = rep.conflicts.slice(0, 80);
  rep.person = {};
  Object.keys(person).forEach(function (n) { rep.person[n] = { id: person[n].id, name: person[n].name }; });
  return rep;
}
/** 기사마스터 → 아이디 관리 · 일시단가 · 아이디 사용 기록 줄 */
function mgIdRows_(master, dr) {
  const mainOf = {};
  master.forEach(function (x) { if (x.sub !== '서브' && !mainOf[x.name]) mainOf[x.name] = x; });
  const ids = [], tmp = [], usage = [], seen = {};
  master.forEach(function (x) {
    const k = stlLogin_(x.cid);
    if (!k || seen[k]) return;
    seen[k] = 1;
    const p = dr.person[x.name] || {}, m = mainOf[x.name];
    const sub = x.sub === '서브' && m && stlLogin_(m.cid) !== k;
    ids.push({
      cid: x.cid, role: sub ? '서브' : '메인', main: sub ? m.cid : '', owner: p.name || x.name, ownerId: p.id || '',
      type: STL_TYPES.indexOf(x.code) >= 0 ? x.code : '', mode: x.mode === '용차형' ? '용차내역' : (x.code === '대표' || x.code === '운영자') ? '원청단가' : '',
      insEx: x.san === 'N' && x.goy === 'N' ? 'Y' : '', fbCut: sub ? '' : x.fbCut, status: !x.status || x.status === '근무' ? '사용' : '정지', memo: '기존 정산 시트 기사마스터'
    });
    if (!sub && stlNum_(x.tmp) > 0) tmp.push({ name: p.name || x.name, driverId: p.id || '', from: stlYmd_(x.tmpFrom), to: stlYmd_(x.tmpTo), price: String(stlNum_(x.tmp)), routes: x.tmpRoutes, memo: '기존 정산 시트 기사마스터' });
    const w = dr.workerOf[k];
    if (w) usage.push({ cid: x.cid, name: w.name, driverId: w.id, from: '', to: '', memo: '러너 DB 에서 이 아이디의 기사 (명의자 ' + w.owner + ')', _owner: w.owner });
  });
  return { ids: ids, tmp: tmp, usage: usage };
}
/** 노선단가 → 노선관리 구분별 단가 빈 칸 채우기 */
function mgPriceFill_(rows, dry, overwrite) {
  const rep = { added: 0, filled: 0, conflicts: [], noCamp: {}, noRoute: [] };
  const m = master_();
  const campByShort = {};
  m.camps.forEach(function (c) { campByShort[stlShort_(c.name)] = c; });
  const routesByCamp = {};
  m.routes.forEach(function (r) { (routesByCamp[r.campId] = routesByCamp[r.campId] || []).push(r); });
  const all = readAll_(SH.PRICES);
  const by = {};
  all.forEach(function (o) { if (o.campId && o.num) by[o.campId + '|' + normCode_(o.num) + '|' + normLevel_(o.level) + '|' + normCode_(o.value)] = o; });
  const add = [];
  const now = nowText_();
  rows.forEach(function (x) {
    const camp = campByShort[stlShort_(x.camp)];
    if (!camp) { rep.noCamp[x.camp] = 1; return; }
    const mm = x.route.match(/^(\d+)([A-Z])/);
    if (!mm) return;
    let level = 0;
    (routesByCamp[camp.id] || []).forEach(function (r) {
      if (r.g1 !== mm[1] || level) return;
      [r.g2, r.g3, r.g4, r.g5].forEach(function (g, i) { if (!level && g === mm[2]) level = i + 2; });
    });
    if (!level) { rep.noRoute.push(x.camp + ' ' + x.route); return; }
    const key = camp.id + '|' + mm[1] + '|' + level + '|' + mm[2];
    const want = { p1: x.origin ? String(x.origin) : '', p2: x.fixed ? String(x.fixed) : '', p3: x.backup ? String(x.backup) : '' };
    const cur = by[key];
    if (!cur) {
      const o = { id: uniqId_('P'), campId: camp.id, campName: camp.name, num: mm[1], level: '구분' + level, value: mm[2], p1: want.p1, p2: want.p2, p3: want.p3, createdAt: now, updatedAt: now };
      add.push(o); by[key] = o; rep.added++;
      return;
    }
    const f = {};
    ['p1', 'p2', 'p3'].forEach(function (k) {
      if (!want[k]) return;
      const c = normMoney_(cur[k]);
      if (!c) f[k] = want[k];
      else if (c !== want[k]) { if (overwrite) f[k] = want[k]; rep.conflicts.push(x.camp + ' ' + x.route + ' ' + RP[k] + ': 러너 ' + c + ' / 기존 ' + want[k] + (overwrite ? ' → 기존 값으로 바꿈' : '')); }
    });
    if (Object.keys(f).length) {
      rep.filled++;
      if (!dry && cur._row) { f.updatedAt = now; writeFields_(SH.PRICES, cur._row, f); }
    }
  });
  if (!dry && add.length) appendObjs_(SH.PRICES, add);
  rep.noCamp = Object.keys(rep.noCamp);
  rep.conflicts = rep.conflicts.slice(0, 120);
  return rep;
}
/** 기존 시트 기사명(표시명) → 정산 아이디(메인 아이디키) */
function mgNameMap_(master, X) {
  const out = {};
  if (!X) return out;
  master.forEach(function (x) {
    const idx = X.by[stlLogin_(x.cid)];
    if (!idx) return;
    if (!out[x.disp]) out[x.disp] = idx.mainKey;
    if (!out[x.name]) out[x.name] = idx.mainKey;
  });
  return out;
}
/** 기존 시트 DB계산 '월정산 — yyyy-MM' 표와 새 계산 비교 */
function mgCompare_(sh, master) {
  if (!sh) return null;
  const v = sh.getRange(1, 1, Math.min(sh.getLastRow(), 400), 30).getValues();
  const mm = str_(v[0][0]).match(/(\d{4}-\d{2})/);
  if (!mm) return null;
  const month = mm[1];
  let hr = -1;
  for (let r = 0; r < 10; r++) if (mgKey_(v[r][0]) === 'No' && mgKey_(v[r][1]) === '기사명') { hr = r; break; }
  if (hr < 0) return null;
  const h = v[hr];
  const C = { name: 1, qty: mgFindCol_(h, '배송건수'), invoice: mgFindCol_(h, '세금계산서합계'), san: mgFindCol_(h, '산재(기사)'), goy: mgFindCol_(h, '고용(기사)'), net: mgFindCol_(h, '실입금액') };
  const D = stlDrivers_(), X = stlIds_(D);
  const map = mgNameMap_(master, X);
  const res = stlCompute_(month);
  const byId = {};
  res.summary.drivers.forEach(function (d) { byId[d.id] = d; });
  const rows = [];
  const seen = {};
  for (let r = hr + 1; r < v.length; r++) {
    const name = str_(v[r][C.name]);
    if (!name) { if (!str_(v[r][0])) break; continue; }
    const id = map[name] || stlAcct_(X, D, name, '');
    const n = id ? byId[id] : null;
    if (id) seen[id] = 1;
    const o = { name: name, newName: n ? n.name + ' (' + n.cids.map(function (c) { return String(c).replace(/@.*$/, ''); }).join(', ') + ')' : (id ? stlAcctLabel_(X, D, id) : ''), oldQty: stlNum_(v[r][C.qty]), newQty: n ? n.qty : 0,
      oldInvoice: stlNum_(v[r][C.invoice]), newInvoice: n ? n.invoice : 0, oldNet: stlNum_(v[r][C.net]), newNet: n ? n.net : 0 };
    o.diff = Math.round(o.newNet - o.oldNet);
    rows.push(o);
  }
  res.summary.drivers.forEach(function (d) { if (!seen[d.id] && (d.invoice || d.net)) rows.push({ name: '', newName: d.name, oldQty: 0, newQty: d.qty, oldInvoice: 0, newInvoice: d.invoice, oldNet: 0, newNet: d.net, diff: d.net }); });
  const same = rows.filter(function (r) { return Math.abs(r.diff) < 1; }).length;
  return { month: month, rows: rows, same: same, total: rows.length };
}
