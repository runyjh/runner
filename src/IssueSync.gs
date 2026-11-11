/**
 * 이슈 관리 ↔ 기사스케줄 자동 연동 (2026-11-01 부터 · 올인원 규칙)
 *
 * 이슈 = 결과 + 사유
 *  - 결과: 미입차(노선 물량 전부 뺌) · 노쇼(연락 없이 미입차) · 병가(아파서 쉼 · 물량 전부 뺌) · 물량조율(일부 회전만 뺌)
 *  - 뺀 회전: 물량조율일 때 'F3' / 'D2,F3' (회전) 또는 '529B' / '529B (F3)' (노선 단위)
 *  - 사유: 차량고장 · 차량사고 · 질병 · 부상 · 경조사 · 개인사정 · 기타 (스케줄 칸에서 자동으로 만든 이슈는 '사유 미정')
 *  - 대체: 쿠친 · 업체백업(우리 백업 기사가 회사 일로 투입) · 품앗이(우리 인원끼리 일 주고받기) · 외부용차 · 캠프 반납 · 없음 (업체백업·품앗이는 대신 뛴 기사도 기록)
 *  - 기간: 날짜 ~ 종료일
 *
 * 이슈 → 칸: 저장하면 그 기간 칸을 '미입차' / '노쇼' / '529AB (D1,D2)'(뛴 회전만)로 바꾸고, 바꾸기 전 값을 '원래 칸'에 남김
 *            지우거나 기간이 줄면 (칸이 아직 이슈가 넣은 값 그대로일 때만) 원래 값으로 되돌림
 * 칸 → 이슈: 기사스케줄에서 칸을 '미입차'·'노쇼'·기본노선보다 줄인 회전으로 고치면 '사유 미정' 이슈를 자동으로 만들고
 *            (전날 같은 이슈가 있으면 기간을 늘림), 칸을 다시 정상으로 고치면 그날을 이슈에서 뺌
 */
const ISS = {
  RULE_FROM: '2026-11-01',
  RESULTS: ['미입차', '노쇼', '병가', '물량조율'],
  REASONS: ['차량고장', '차량사고', '질병', '부상', '경조사', '개인사정', '기타'],
  SUBS: ['쿠친', '업체백업', '품앗이', '외부용차', '캠프 반납', '없음'],
  UNSET: '사유 미정',
  // 예전 구분 → 새 사유
  OLD_REASON: { '사고': '차량사고', '고장': '차량고장', '질병': '질병', '부상': '부상' }
};

function issExpand_(csv) {
  let lastNum = '';
  const out = [];
  String(csv || '').split(',').forEach(function (cp) {
    const t = cp.trim();
    if (!t) return;
    let m = t.match(/^(\d+)([A-Za-z]+)$/);
    if (m) { lastNum = m[1]; m[2].toUpperCase().split('').forEach(function (ch) { if (out.indexOf(lastNum + ch) < 0) out.push(lastNum + ch); }); return; }
    m = t.match(/^([A-Za-z]+)$/);
    if (m && lastNum) m[1].toUpperCase().split('').forEach(function (ch) { if (out.indexOf(lastNum + ch) < 0) out.push(lastNum + ch); });
  });
  return out;
}
/** 칸·기본노선 글자 → { camp: '강서1'(앞에 캠프가 적혀 있으면), units: { '529A': ['D1','D2'], … } } · 노선 글자가 아니면 null */
function issUnits_(text, defRots) {
  let s = str_(text).replace(/\r?\n/g, ' ');
  s = s.replace(/\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)/g, ' ').replace(/추가업무등록|업무등록/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim();
  let camp = '';
  const mc = s.match(/^([가-힣]+\d)\s*/);
  if (mc) { camp = mc[1]; s = s.slice(mc[0].length).trim(); }
  const per = {};
  s = s.replace(/(\d+[A-Za-z]+)\(([^)]*)\)/g, function (m0, rt, ro) {
    const rr = normRot_(ro); if (!rr.length) return m0;
    issExpand_(rt).forEach(function (x) { per[x] = rr; }); return rt;
  });
  let rot = null;
  const mR = s.match(/\(([^)]*)\)/);
  if (mR) { const rr = normRot_(mR[1]); if (rr.length) rot = rr; s = s.replace(/\([^)]*\)/g, ' '); }
  s = s.replace(/\s+/g, '');
  if (!s || !/^[0-9A-Za-z,]+$/.test(s)) return null;
  const list = issExpand_(s);
  if (!list.length) return null;
  const units = {};
  list.forEach(function (rt) { units[rt] = (per[rt] || rot || defRots).slice(); });
  return { camp: camp, units: units };
}
/** units → 칸 글자 ('529AB (D1,D2)' / '205C(D1),205D' · 캠프 기본 회전 전체면 회전 생략) */
function issCompose_(units, defRots, camp) {
  const keys = Object.keys(units).filter(function (rt) { return units[rt] && units[rt].length; }).sort();
  if (!keys.length) return '';
  const all = defRots.join(',');
  const rk = function (rt) { return ROTS.filter(function (r) { return units[rt].indexOf(r) >= 0; }).join(','); };
  const groups = [];
  keys.forEach(function (rt) {
    const n = rt.slice(0, -1), c = rt.slice(-1), k = rk(rt);
    const g = groups.filter(function (x) { return x.n === n && x.k === k; })[0];
    if (g) g.c += c; else groups.push({ n: n, c: c, k: k });
  });
  const ks = {}; groups.forEach(function (g) { ks[g.k] = 1; });
  let txt;
  if (Object.keys(ks).length === 1) {
    const k = groups[0].k;
    txt = groups.map(function (g) { return g.n + g.c; }).join(',') + (k !== all ? ' (' + k + ')' : '');
  } else txt = groups.map(function (g) { return g.n + g.c + (g.k !== all ? '(' + g.k + ')' : ''); }).join(',');
  return (camp ? camp + ' ' : '') + txt;
}
/** 뺀 물량 글자: 모든 노선에서 같은 회전을 뺐으면 'F3', 아니면 노선 단위 '529B' / '529B (F3)' */
function issCutText_(lost, baseUnits, defRots) {
  const bk = Object.keys(baseUnits), lk = Object.keys(lost);
  const k0 = lk.length ? lost[lk[0]].join(',') : '';
  if (lk.length === bk.length && lk.every(function (rt) { return lost[rt].join(',') === k0; }) && k0 !== defRots.join(',')) return k0;
  return issCompose_(lost, defRots, '');
}
/** 칸 글자가 이슈인지: { result, cut } 또는 null */
function issClassify_(value, base, defRots, ownCamp) {
  const v = str_(value);
  if (!v) return null;
  if (/노쇼/.test(v)) return { result: '노쇼', cut: '' };
  if (/미입차/.test(v)) return { result: '미입차', cut: '' };
  if (/^병가/.test(v)) return { result: '병가', cut: '' };
  const b = str_(base);
  if (!b || /백업|예비|용차/.test(b)) return null;
  if (/휴무|휴가|퇴사|출근|용차|변경/.test(v)) return null;
  const bu = issUnits_(b, defRots), cu = issUnits_(v, defRots);
  if (!bu || !cu) return null;
  if (cu.camp && cu.camp !== ownCamp) return null; // 다른 캠프 일
  const cuk = Object.keys(cu.units);
  for (let i = 0; i < cuk.length; i++) {
    const rt = cuk[i];
    if (!bu.units[rt]) return null; // 기본노선에 없는 노선을 뜀 → 이슈 아님
    if (cu.units[rt].some(function (r) { return bu.units[rt].indexOf(r) < 0; })) return null;
  }
  const lost = {};
  let any = false;
  Object.keys(bu.units).forEach(function (rt) {
    const have = cu.units[rt] || [];
    const miss = bu.units[rt].filter(function (r) { return have.indexOf(r) < 0; });
    if (miss.length) { lost[rt] = miss; any = true; }
  });
  return any ? { result: '물량조율', cut: issCutText_(lost, bu.units, defRots) } : null;
}
/** 물량조율: 원래 칸(비었거나 출근이면 기본노선)에서 뺀 물량을 빼고 남은 글자 (다 빠지면 '미입차') */
function issApplyCut_(src, base, defRots, cut) {
  const s = !str_(src) || str_(src) === '출근' ? str_(base) : str_(src);
  const u = issUnits_(s, defRots);
  if (!u) return null;
  const c = str_(cut);
  const rotsOnly = c && /^[\sDdFf0-9,\/]+$/.test(c) && !/\d{3}/.test(c) ? normRot_(c) : [];
  if (rotsOnly.length) Object.keys(u.units).forEach(function (rt) { u.units[rt] = u.units[rt].filter(function (r) { return rotsOnly.indexOf(r) < 0; }); });
  else {
    const cu = issUnits_(c, defRots);
    if (!cu) return null;
    Object.keys(cu.units).forEach(function (rt) { if (u.units[rt]) u.units[rt] = u.units[rt].filter(function (r) { return cu.units[rt].indexOf(r) < 0; }); });
  }
  return issCompose_(u.units, defRots, u.camp) || '미입차';
}
/** 그 이슈가 그날 칸에 넣는 글자 */
function issCellFor_(iss, orig, ctx) {
  if (iss.result === '미입차') return '미입차';
  if (iss.result === '노쇼') return '노쇼';
  if (iss.result === '병가') return '병가';
  if (iss.result === '물량조율' && iss.cut) { const v = issApplyCut_(orig, ctx.base, ctx.rots, iss.cut); return v === null ? null : v; }
  return null; // 칸을 바꾸지 않음
}
/** 기사 그날의 기본노선·캠프·기본 회전 (노선 변경 이력 반영) */
function issCtxMaker_() {
  const camps = {}; master_().camps.forEach(function (c) { camps[c.id] = c; });
  let rcAll = null;
  const shortOf = function (n) { return String(n || '').replace(/\s*캠프\s*$/, '').trim(); };
  return function (o, date) {
    let at = { campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute };
    try { if (rcAll === null) rcAll = rcByDriver_() || {}; at = rcAt_(at, rcAll[o.id], date); } catch (e) { /* 이력 없음 */ }
    const c = camps[at.campId] || {};
    const rots = normRot_(c.rot); return { base: str_(at.baseRoute), camp: shortOf(at.camp || c.name), rots: rots.length ? rots : ROTS.slice() };
  };
}
function issDates_(from, to) {
  const out = [];
  let d = parseYmd_(from);
  const e = parseYmd_(to);
  if (!d || !e) return out;
  while (d <= e && out.length < 400) { out.push(ymd_(d)); d = addDays_(d, 1); }
  return out;
}
/** 기사 줄의 칸 쓰기 (잠금 안에서) · 바뀐 칸 [{row,date,value,old}] 반환 */
function issWriteCells_(a, driverId, map) {
  const dates = Object.keys(map).sort();
  if (!dates.length) return [];
  const h = schEnsureDates_(parseYmd_(dates[0]), parseYmd_(dates[dates.length - 1]));
  const sh = schSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const cell = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).createTextFinder(String(driverId)).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return [];
  const r = cell.getRow(), out = [];
  dates.forEach(function (d) {
    const c = h.dates[d];
    if (c === undefined) return;
    const rg = sh.getRange(r, c + 1), old = str_(rg.getValue());
    if (old === map[d]) return;
    rg.setNumberFormat('@').setValue(safeText_(map[d]));
    out.push({ row: driverId, date: d, value: map[d], old: old });
  });
  if (out.length) { logSchChange_(a, out, out.length); try { stlBump_(); } catch (e) { /* 정산 캐시 */ } }
  return out;
}
/** 대신 뛴 우리 기사(업체백업·품앗이) */
function issOurs_(sub) { return sub === '업체백업' || sub === '품앗이'; }
function issSubDrv_(x) {
  if (!x || !issOurs_(x.sub) || !str_(x.subWho)) return null;
  const want = str_(x.subWho);
  const all = readAll_(SH.DRIVERS).filter(function (o) { return o.id && (o.id === want || o.name === want); });
  return all.filter(function (o) { return o.status === ST.ACTIVE; })[0] || all[0] || null;
}
/** 대신 뛴 기사 칸에 넣는 글자 = 원래 기사가 못 뛴 물량 (다른 캠프면 캠프 이름을 앞에) */
function issSubCell_(iss, mctx, sctx, src) {
  // 원래 기사의 그날 칸(이슈 넣기 전)이 노선이면 그것, 아니면(비었거나 출근) 기본노선 · 백업 기사는 그날 칸으로
  const s0 = str_(src) && str_(src) !== '출근' && issUnits_(src, mctx.rots) ? str_(src) : mctx.base;
  const bu = issUnits_(s0, mctx.rots);
  if (!bu) return null;
  const mcamp = bu.camp || mctx.camp;
  let units = bu.units;
  if (iss.result === '물량조율') {
    units = {};
    const c = str_(iss.cut), ro = /\d{3}/.test(c) ? [] : normRot_(c);
    if (ro.length) Object.keys(bu.units).forEach(function (rt) { const k = bu.units[rt].filter(function (r) { return ro.indexOf(r) >= 0; }); if (k.length) units[rt] = k; });
    else {
      const cu = issUnits_(c, mctx.rots); if (!cu) return null;
      Object.keys(cu.units).forEach(function (rt) { if (bu.units[rt]) { const k = bu.units[rt].filter(function (r) { return cu.units[rt].indexOf(r) >= 0; }); if (k.length) units[rt] = k; } });
    }
  }
  return issCompose_(units, mctx.rots, sctx.camp !== mcamp ? mcamp : '') || null;
}
/**
 * 이슈를 칸에 반영 (저장·수정·삭제 공통 · 잠금 안에서)
 * prev: 고치기 전 이슈(없으면 새 이슈) · next: 고친 뒤 이슈(없으면 삭제)
 * 1) 그 기사 칸: 미입차 / 노쇼 / 병가 / 뛴 회전만 남긴 노선 (11/1 이후)
 * 2) 대신 뛴 우리 기사(업체백업·품앗이) 칸: PDD(내일)부터 그 노선 (오늘까지는 실제 기록이라 건드리지 않음)
 * 원래 값은 '원래 칸'에 { 날짜: 값, '@sub': { id, cells: { 날짜: 값 } } } 로 보관 → 지우거나 바꾸면 (칸이 그대로일 때) 되돌림
 * dry: 덮어쓸 특별한 칸만 돌려 줌 · subOnly: 대신 뛴 기사 칸만 맞춤 (칸에서 이슈를 고쳤을 때)
 */
function issSyncCells_(a, drv, prev, next, dry, subOnly) {
  const ctxOf = issCtxMaker_();
  const live = function (x) { return x && x.link !== 'N' && x.result && ISS.RESULTS.indexOf(x.result) >= 0; };
  const span = function (x) { return live(x) ? issDates_(x.date, x.end || x.date).filter(function (d) { return d >= ISS.RULE_FROM; }) : []; };
  const pd = span(prev), nd = span(next);
  const orig = JSON.parse(JSON.stringify((prev && prev.orig) || {}));
  const conflicts = [];
  let cells = [];
  // 1) 그 기사 칸
  const all = pd.concat(nd.filter(function (d) { return pd.indexOf(d) < 0; }));
  if (all.length && !subOnly) {
    const cur = schCellsOf_(drv.id, all);
    const want = {};
    all.forEach(function (d) {
      const ctx = ctxOf(drv, d), now = cur[d] || '';
      const had = pd.indexOf(d) >= 0, has = nd.indexOf(d) >= 0;
      const o0 = had && orig.hasOwnProperty(d) ? orig[d] : now; // 이슈가 넣기 전 값
      const putPrev = had ? issCellFor_(prev, o0, ctx) : null;
      const mine = had && putPrev !== null && now === putPrev; // 칸이 아직 이 이슈가 넣은 값
      if (has) {
        const base0 = had ? (mine ? o0 : now) : now;
        const v = issCellFor_(next, base0, ctx);
        if (v === null) { if (had && mine) want[d] = o0; delete orig[d]; return; }
        if (now === v) { if (!orig.hasOwnProperty(d)) orig[d] = base0; return; }
        // 특별한 값(다른 캠프 일·휴무·다른 노선 등)을 덮어쓰면 확인
        if (!(had && mine) && now && now !== '출근' && now !== ctx.base && !/^(미입차|노쇼|병가)$/.test(now) && issClassify_(now, ctx.base, ctx.rots, ctx.camp) === null) conflicts.push({ name: drv.name, date: d, current: now, next: v });
        orig[d] = base0; want[d] = v;
      } else if (had) {
        if (mine) want[d] = o0;
        delete orig[d];
      }
    });
    if (!dry) cells = cells.concat(issWriteCells_(a, drv.id, want));
  }
  // 2) 대신 뛴 우리 기사 칸 (PDD = 내일부터)
  const pdd = schAddDays_(todayText_(), 1);
  const ps = orig['@sub'] || null, sPrev = ps && ps.id ? (readAll_(SH.DRIVERS).filter(function (o) { return o.id === ps.id; })[0] || null) : null;
  const sNext = live(next) ? issSubDrv_(next) : null;
  const so = Object.assign({}, (ps && ps.cells) || {});
  const ssPrev = sPrev ? pd.filter(function (d) { return d >= pdd; }) : [], ssNext = sNext && sNext.id !== drv.id ? nd.filter(function (d) { return d >= pdd; }) : [];
  const want = {}; // { 기사ID: { 날짜: 값 } }
  const put = function (id, d, v) { (want[id] = want[id] || {})[d] = v; };
  const sameSub = sPrev && sNext && sPrev.id === sNext.id;
  const sAll = ssPrev.concat(ssNext.filter(function (d) { return ssPrev.indexOf(d) < 0; }));
  const curP = sPrev && ssPrev.length ? schCellsOf_(sPrev.id, ssPrev) : {};
  const curN = sNext && ssNext.length ? (sameSub ? Object.assign({}, curP, schCellsOf_(sNext.id, ssNext.filter(function (d) { return !curP.hasOwnProperty(d); }))) : schCellsOf_(sNext.id, ssNext)) : {};
  const nso = {};
  sAll.forEach(function (d) {
    const mctx = ctxOf(drv, d);
    let mineP = false;
    if (sPrev && ssPrev.indexOf(d) >= 0) {
      const now = curP[d] || '', vp = issSubCell_(prev, mctx, ctxOf(sPrev, d), (prev.orig || {})[d]);
      mineP = vp !== null && now === vp;
      const stay = sameSub && ssNext.indexOf(d) >= 0;
      if (!stay && mineP && so.hasOwnProperty(d)) put(sPrev.id, d, so[d]);
    }
    if (sNext && ssNext.indexOf(d) >= 0) {
      const now = curN[d] || '', v = issSubCell_(next, mctx, ctxOf(sNext, d), orig.hasOwnProperty(d) ? orig[d] : (prev && prev.orig || {})[d]);
      if (v === null) return;
      const base0 = sameSub && mineP && so.hasOwnProperty(d) ? so[d] : now;
      nso[d] = base0;
      if (now === v) return;
      if (!(sameSub && mineP) && now && !/^(휴무|고정휴무|추가휴무|출근|백업)$/.test(now)) conflicts.push({ name: sNext.name, date: d, current: now, next: v });
      put(sNext.id, d, v);
    }
  });
  if (sNext && Object.keys(nso).length) orig['@sub'] = { id: sNext.id, name: sNext.name, cells: nso }; else delete orig['@sub'];
  if (dry) return { cells: [], orig: orig, conflicts: conflicts };
  Object.keys(want).forEach(function (id) { cells = cells.concat(issWriteCells_(a, id, want[id])); });
  return { cells: cells, orig: orig, conflicts: conflicts };
}

/**
 * 기사스케줄 칸 저장 뒤 (adm_schSave 잠금 안): 칸 → 이슈
 * saved: [{row, date, value, old}] (실제로 바뀐 칸) · 반환 { created: [이슈], changed: [이슈], removed: [이슈ID] }
 */
function issFromCells_(a, saved) {
  const out = { created: [], changed: [], removed: [] };
  const list = (saved || []).filter(function (x) { return x.date >= ISS.RULE_FROM && x.row && !/^NOTE\d+$/.test(x.row) && x.row.indexOf(SCH_PM_PREFIX) !== 0 && !schExParse_(x.row); });
  if (!list.length) return out;
  // 이슈와 상관없는 칸은 건너뛴다 (결과는 같고 읽기만 줄임): 그날 걸친 연동 이슈가 없고, 글자가 이슈가 될 수 없는 것(빈칸·휴무·출근 등)이면 할 일이 없다
  let issues = schIssues_();
  const cantBe = function (v) { v = str_(v); return !v || (!/노쇼|미입차|^병가/.test(v) && /휴무|휴가|퇴사|출근|용차|변경/.test(v)); }; // issClassify_ 가 기본노선을 보지 않고 null 을 내는 경우와 같음
  const hitOf = function (id, date) { return issues.filter(function (x) { return x.driverId === id && x.link !== 'N' && x.result && x.date <= date && date <= (x.end || x.date) && x.kind !== '지시'; })[0]; };
  const idle = function (ch) { return cantBe(ch.value) && !hitOf(ch.row, ch.date); }; // 이 칸은 할 일이 없음
  if (list.every(idle)) return out;
  // 기사 정보: 고친 기사가 몇 명 안 되면 그 줄만 읽고, 전체 목록은 필요할 때(여러 명 · 다른 기사 칸과 견줄 때)만 읽는다
  let all = null;
  const allDrv = function () { if (!all) { all = {}; readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) all[o.id] = o; }); } return all; };
  const ids = {}; list.forEach(function (ch) { if (!idle(ch)) ids[ch.row] = 1; });
  const few = Object.keys(ids).length <= 3, one = {};
  const drvOf = function (id) { if (all || !few) return allDrv()[id]; if (!(id in one)) one[id] = driverById_(id); return one[id]; };
  const ctxOf = issCtxMaker_();
  const sh = schIssueSheet_();
  if (!cache_().get('iss:headok')) { schIssueHeadFix_(sh); cache_().put('iss:headok', '1', 21600); } // 머리글 확인은 6시간에 한 번
  const save = function (x) { issWriteRow_(sh, x); };
  list.sort(function (p, q) { return p.row < q.row ? -1 : p.row > q.row ? 1 : p.date < q.date ? -1 : 1; }).forEach(function (ch) {
    if (idle(ch)) return; // (앞 칸 처리로 이슈가 바뀌었을 수 있어 그때그때 다시 봄)
    const o = drvOf(ch.row); if (!o) return;
    const ctx = ctxOf(o, ch.date);
    const cls = issClassify_(ch.value, ctx.base, ctx.rots, ctx.camp);
    // 그날 걸친 연동 이슈
    const hit = hitOf(o.id, ch.date);
    if (hit) {
      const expect = issCellFor_(hit, (hit.orig || {}).hasOwnProperty(ch.date) ? hit.orig[ch.date] : ch.old, ctx);
      if (expect !== null && expect === ch.value) return; // 그대로
      if (cls && cls.result === hit.result && (cls.result !== '물량조율' || cls.cut === hit.cut)) return;
      // 그날을 이슈에서 뺀다 (하루짜리면 이슈 삭제, 처음·끝이면 줄이고, 가운데면 둘로 나눔) · 대신 뛴 기사 칸도 같이 맞춤
      const before = JSON.parse(JSON.stringify(hit));
      const subFix = function (p0, n0) { const r = issSyncCells_(a, o, p0, n0, false, true); out.cells = (out.cells || []).concat(r.cells); return r.orig['@sub']; };
      const s = hit.date, e = hit.end || hit.date;
      if (s === e) { subFix(before, null); sh.deleteRow(hit.row); out.removed.push(hit.id); issues = schIssues_(); }
      else if (ch.date === s || ch.date === e) {
        if (ch.date === s) hit.date = schAddDays_(s, 1); else hit.end = schAddDays_(e, -1);
        delete (hit.orig || {})[ch.date];
        const sub = subFix(before, hit); if (sub) hit.orig['@sub'] = sub; else delete hit.orig['@sub'];
        save(hit); out.changed.push(hit);
      } else {
        const tail = Object.assign({}, hit, { id: issNewId_(), row: 0, date: schAddDays_(ch.date, 1), end: e, orig: {} });
        Object.keys(hit.orig || {}).forEach(function (d) { if (d > ch.date && d !== '@sub') { tail.orig[d] = hit.orig[d]; delete hit.orig[d]; } });
        delete (hit.orig || {})[ch.date];
        hit.end = schAddDays_(ch.date, -1);
        const sub = subFix(before, hit); if (sub) hit.orig['@sub'] = sub; else delete hit.orig['@sub'];
        save(hit); out.changed.push(hit);
        const sub2 = subFix(null, tail); if (sub2) tail.orig['@sub'] = sub2;
        save(tail); out.created.push(tail);
      }
      issues = schIssues_();
    }
    if (!cls) return;
    // 물량조율인데 뺀 회전을 같은 캠프 다른 기사가 그날 뛰기로 되어 있으면 (205C(D1),205D + 205C (D2,F3) 처럼 나눠 뛰는 날) 이슈 아님
    if (cls.result === '물량조율' && issCoveredByOthers_(o.id, ch.date, ctx, cls.cut, allDrv(), ctxOf)) return;
    // 전날 같은 결과의 연동 이슈가 있으면 기간을 늘림
    const prevDay = schAddDays_(ch.date, -1);
    const near = issues.filter(function (x) { return x.driverId === o.id && x.link !== 'N' && x.result === cls.result && (cls.result !== '물량조율' || x.cut === cls.cut) && (x.end || x.date) === prevDay; })[0];
    if (near) {
      const before = JSON.parse(JSON.stringify(near));
      near.end = ch.date; near.orig = near.orig || {}; near.orig[ch.date] = ch.old;
      if (issOurs_(near.sub)) { const r = issSyncCells_(a, o, before, near, false, true); out.cells = (out.cells || []).concat(r.cells); if (r.orig['@sub']) near.orig['@sub'] = r.orig['@sub']; }
      save(near); out.changed.push(near);
    } else {
      const x = { id: issNewId_(), row: 0, date: ch.date, end: ch.date, driverId: o.id, name: o.name, kind: ISS.UNSET, reason: '', action: '', by: a.name + ' (스케줄 칸)', at: nowText_(),
        result: cls.result, cut: cls.cut, sub: '', subWho: '', qty: '', link: 'Y', orig: {} };
      x.orig[ch.date] = ch.old;
      save(x); out.created.push(x);
    }
    issues = schIssues_();
  });
  return out;
}
/** 그날 같은 캠프의 다른 기사 칸이 뺀 물량을 모두 뛰는지 */
const _issCol = {};
function issCoveredByOthers_(myId, date, ctx, cut, drv, ctxOf) {
  if (!_issCol[date]) {
    const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow(), c = h.dates[date];
    _issCol[date] = c === undefined || last < 2 ? [] : (function () {
      const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
      const vals = sh.getRange(2, c + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
      return ids.map(function (id, i) { return { id: id, v: vals[i] }; });
    })();
  }
  const rotsOnly = /\d{3}/.test(cut) ? [] : normRot_(cut);
  const base = issUnits_(ctx.base, ctx.rots);
  if (!base) return false;
  const need = [];
  if (rotsOnly.length) Object.keys(base.units).forEach(function (rt) { rotsOnly.forEach(function (r) { if (base.units[rt].indexOf(r) >= 0) need.push(rt + '|' + r); }); });
  else { const cu = issUnits_(cut, ctx.rots); if (!cu) return false; Object.keys(cu.units).forEach(function (rt) { cu.units[rt].forEach(function (r) { need.push(rt + '|' + r); }); }); }
  if (!need.length) return false;
  const have = {};
  _issCol[date].forEach(function (x) {
    if (!x.v || x.id === myId) return;
    const pid = x.id.indexOf(SCH_PM_PREFIX) === 0 ? x.id.slice(SCH_PM_PREFIX.length) : x.id.split('~')[0];
    const od = drv[pid];
    const octx = od ? ctxOf(od, date) : null;
    let v = x.v;
    if (/^출근$/.test(v) && octx) v = octx.base;
    const u = issUnits_(v, ctx.rots);
    if (!u) return;
    const camp = u.camp || (octx ? octx.camp : '');
    if (camp !== ctx.camp) return;
    Object.keys(u.units).forEach(function (rt) { u.units[rt].forEach(function (r) { have[rt + '|' + r] = 1; }); });
  });
  return need.every(function (k) { return have[k]; });
}
function issNewId_() { return 'I' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100); }
/** 이슈 한 줄 쓰기 (x.row 가 있으면 그 줄, 없으면 맨 아래 · 잠금 안에서) */
function issWriteRow_(sh, x) {
  const days = issDates_(x.date, x.end || x.date).length || 1;
  const mi = x.result === '미입차' || x.result === '노쇼' || x.result === '병가' || (!x.result && x.mi);
  const vals = {
    '이슈ID': x.id, '날짜': x.date, '기사ID': x.driverId, '이름': x.name, '구분': x.kind, '사유': x.reason, '조치': x.action,
    '작성자': x.by, '작성일시': x.at, '미입차': mi ? 'Y' : '', '미입차일수': mi ? String(days) : '',
    '결과': x.result || '', '뺀 회전': x.cut || '', '대체': x.sub || '', '대체 기사': x.subWho || '', '종료일': x.end && x.end !== x.date ? x.end : '',
    '원래 칸': x.orig && Object.keys(x.orig).length ? JSON.stringify(x.orig) : '', '연동': x.link || '', '수량': x.qty || ''
  };
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(str_);
  const row = head.map(function (h) { return vals.hasOwnProperty(h) ? safeText_(vals[h]) : null; });
  const at = x.row || sh.getLastRow() + 1;
  if (x.row) {
    const cur = sh.getRange(at, 1, 1, head.length).getValues()[0];
    row.forEach(function (v, i) { if (v === null) row[i] = cur[i]; });
  } else row.forEach(function (v, i) { if (v === null) row[i] = ''; });
  sh.getRange(at, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  if (!x.row) x.row = at;
}
/** 화면에 돌려줄 이슈 (row·orig 빼고) */
function issView_(x) {
  const o = Object.assign({}, x);
  delete o.row; delete o.orig;
  o.mi = o.result === '미입차' || o.result === '노쇼' || o.result === '병가' || (!o.result && !!x.mi);
  o.subCells = x.orig && x.orig['@sub'] ? Object.keys(x.orig['@sub'].cells || {}).length : 0;
  o.miDays = o.mi ? issDates_(o.date, o.end || o.date).length : 0;
  return o;
}

// ───────────────────────── 기사 칸 편집 창: 한 번에 저장 ─────────────────────────
/**
 * 편집 창의 [저장] 한 번 = 서버 호출 한 번. 칸 · 대체 인원 칸 · 이슈(사유·대체·조치) · 지시사항을 차례로 처리하고 바뀐 것을 모아 돌려준다.
 * (화면이 칸 저장 → 이슈 고치기를 따로따로 부르다가 중간에 끊겨 절반만 저장되는 일을 없앰)
 * o = { row: 기사 줄 ID, date, end(기간 끝 · 없으면 하루), old: 화면에 보이던 칸 값, value: 새 칸 값,
 *       issue: null | { result: 병가/미입차/노쇼/물량조율, kind: 사유, reason: 사유 메모, sub: 대체 방법, subWho: 대체 인원 이름, qty, action },
 *       alt: null | { id: 대체 인원 기사ID, value: 그 칸에 넣을 노선 },
 *       inst: undefined(안 건드림) | 지시사항 글자('' = 지움) }
 * 반환 { ok, cells: [{row,date,value}], issues: [고쳐진 이슈], removed: [지워진 이슈ID], inst: 지시 이슈 | null, warn }
 *       처음 칸이 그 사이 다른 곳에서 바뀌었으면 { ok: false, code: 'CONFLICT', current }
 */
function adm_schCellApply(token, o) {
  o = o || {};
  const row = str_(o.row), date = parseYmd_(o.date) ? ymd_(parseYmd_(o.date)) : '';
  if (!row || !date) return { ok: false, msg: '기사와 날짜를 확인해 주세요.' };
  let end = parseYmd_(o.end) ? ymd_(parseYmd_(o.end)) : date;
  if (end < date) end = date;
  const dates = issDates_(date, end);
  if (dates.length > 62) return { ok: false, msg: '기간은 두 달까지 한 번에 넣을 수 있습니다.' };
  const value = String(o.value == null ? '' : o.value).replace(/\r\n?/g, '\n').trim();
  const iss = o.issue && ISS.RESULTS.indexOf(str_(o.issue.result)) >= 0 ? o.issue : null;
  const alt = o.alt && str_(o.alt.id) && str_(o.alt.value) ? { id: str_(o.alt.id), value: str_(o.alt.value) } : null;
  const out = { ok: true, cells: [], issues: [], removed: [], inst: undefined, warn: '' };
  const drvId = row.split('~')[0]; // 이슈 · 지시사항은 기사 단위 (구간 줄 'id~n' 도 같은 기사)
  const pdd = schAddDays_(todayText_(), 1);
  // 이슈가 대체 인원 칸을 대신 넣어 주는 날 = 이슈 결과가 있고 · 올인원 규칙 기간(11/1~)이고 · 내일 이후 · 대체가 우리 인원(업체백업·품앗이)
  const viaIssue = function (d) { return !!iss && issOurs_(str_(iss.sub)) && d >= ISS.RULE_FROM && d >= pdd && !schExParse_(row); };
  // 1) 칸 (기간 전체) + 이슈가 넣어 주지 않는 날의 대체 인원 칸
  let cur = {}, curAlt = {};
  try { cur = schCellsOf_(row, dates); if (alt) curAlt = schCellsOf_(alt.id, dates); } catch (e) { return { ok: false, msg: '스케줄을 읽지 못했습니다: ' + (e && e.message) }; }
  if (o.old !== undefined && String(o.old == null ? '' : o.old).trim() !== str_(cur[date])) return { ok: false, code: 'CONFLICT', current: str_(cur[date]), msg: '그 사이 다른 곳에서 이 칸이 바뀌었습니다. 최신 값으로 다시 열어 주세요.' };
  const changes = [];
  dates.forEach(function (d) {
    if (str_(cur[d]) !== value) changes.push({ row: row, date: d, value: value, old: str_(cur[d]) });
    if (alt && !viaIssue(d) && str_(curAlt[d]) !== alt.value) changes.push({ row: alt.id, date: d, value: alt.value, old: str_(curAlt[d]) });
  });
  let sync = null;
  if (changes.length) {
    const r1 = adm_schSave(token, changes);
    if (!r1.ok) return r1;
    const conf = {}; (r1.conflicts || []).forEach(function (c) { conf[c.row + '|' + c.date] = 1; });
    changes.forEach(function (c) { if (!conf[c.row + '|' + c.date]) out.cells.push({ row: c.row, date: c.date, value: c.value }); });
    if ((r1.conflicts || []).length) out.warn = '그 사이 바뀐 칸 ' + r1.conflicts.length + '개는 건너뛰었습니다.';
    if ((r1.pmLocked || []).length) out.warn = (out.warn ? out.warn + ' ' : '') + '배차 확정된 품앗이 칸은 바꾸지 않았습니다.';
    sync = r1.issueSync && !r1.issueSync.error ? r1.issueSync : null;
    if (sync) { out.removed = (sync.removed || []).slice(); out.issues = (sync.created || []).concat(sync.changed || []); out.cells = out.cells.concat(sync.cells || []); }
  }
  // 2) 이슈: 칸 저장으로 생긴(또는 원래 있던) 그날 이슈에 사유 · 대체 · 조치를 채운다 → 대체가 우리 인원이면 서버가 그 칸을 넣고 원래 값을 기억 (되돌릴 때 같이 돌아감)
  if (iss) {
    let hit = null;
    try { hit = schIssues_().filter(function (x) { return x.driverId === drvId && x.kind !== '지시' && x.result === str_(iss.result) && x.date <= date && date <= (x.end || x.date); })[0] || null; } catch (e) { hit = null; }
    // 이슈에 맡기려던 대체 인원 칸을 직접 넣는다 (이슈가 없거나 · 앞 날짜와 이어져 여기서 못 고칠 때 — 대체 인원이 빠지지 않게)
    const altDirect = function () {
      if (!alt) return;
      const ch = dates.filter(viaIssue).filter(function (d) { return str_(curAlt[d]) !== alt.value; }).map(function (d) { return { row: alt.id, date: d, value: alt.value, old: str_(curAlt[d]) }; });
      if (!ch.length) return;
      const rA = adm_schSave(token, ch);
      if (rA.ok) { const cf = {}; (rA.conflicts || []).forEach(function (c) { cf[c.row + '|' + c.date] = 1; }); ch.forEach(function (c) { if (!cf[c.row + '|' + c.date]) out.cells.push({ row: c.row, date: c.date, value: c.value }); }); }
      else out.warn = (out.warn ? out.warn + ' ' : '') + '대체 인원 칸 저장 실패: ' + rA.msg;
    };
    if (!hit) altDirect();
    else if (hit.date < date) { altDirect(); out.warn = (out.warn ? out.warn + ' ' : '') + '앞 날짜와 이어진 이슈라 사유 · 대체는 이슈 관리에서 고쳐 주세요.'; }
    else {
      const r2 = adm_schIssueSave(token, { id: hit.id, driverId: drvId, date: hit.date, end: hit.end || hit.date, result: hit.result, cut: hit.cut || '',
        kind: str_(iss.kind) || hit.kind || ISS.UNSET, reason: iss.reason === undefined ? (hit.reason || '') : str_(iss.reason), sub: str_(iss.sub), subWho: issOurs_(str_(iss.sub)) ? str_(iss.subWho) : '',
        qty: iss.qty === undefined ? (hit.qty || '') : str_(iss.qty), action: iss.action === undefined ? (hit.action || '') : str_(iss.action), force: true });
      if (!r2.ok) { altDirect(); out.warn = (out.warn ? out.warn + ' ' : '') + '이슈 저장 실패: ' + r2.msg; }
      else { out.issues = out.issues.filter(function (x) { return x.id !== r2.issue.id; }).concat([r2.issue]); out.cells = out.cells.concat(r2.cells || []); }
    }
  }
  // 3) 지시사항 (이슈 '지시')
  if (o.inst !== undefined) {
    const text = str_(o.inst).slice(0, 200);
    let curI = null;
    try { curI = schIssues_().filter(function (x) { return x.driverId === drvId && x.date === date && x.kind === '지시'; })[0] || null; } catch (e) { curI = null; }
    if (!text && curI) { const r3 = adm_schIssueDel(token, curI.id); if (r3.ok) { out.removed.push(curI.id); out.inst = null; } else out.warn = (out.warn ? out.warn + ' ' : '') + '지시사항 지우기 실패: ' + r3.msg; }
    else if (text && (!curI || curI.reason !== text)) { const r3 = adm_schIssueSave(token, { id: curI ? curI.id : '', date: date, driverId: drvId, kind: '지시', reason: text }); if (r3.ok) out.inst = r3.issue; else out.warn = (out.warn ? out.warn + ' ' : '') + '지시사항 저장 실패: ' + r3.msg; }
  }
  // 같은 칸이 여러 번 나오면 마지막 값만
  const last = {}; out.cells.forEach(function (c) { last[c.row + '|' + c.date] = c; });
  out.cells = Object.keys(last).map(function (k) { return last[k]; });
  return out;
}
