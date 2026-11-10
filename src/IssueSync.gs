/**
 * 이슈 관리 ↔ 기사스케줄 자동 연동 (2026-11-01 부터 · 올인원 규칙)
 *
 * 이슈 = 결과 + 사유
 *  - 결과: 미입차(노선 물량 전부 뺌) · 노쇼(연락 없이 미입차) · 물량조율(일부 회전만 뺌)
 *  - 뺀 회전: 물량조율일 때 'F3' / 'D2,F3' (회전) 또는 '529B' / '529B (F3)' (노선 단위)
 *  - 사유: 차량고장 · 차량사고 · 질병 · 부상 · 경조사 · 개인사정 · 기타 (스케줄 칸에서 자동으로 만든 이슈는 '사유 미정')
 *  - 대체: 쿠친 · 품앗이(우리 인원 · 대체 기사) · 외부용차 · 캠프 반납 · 없음
 *  - 기간: 날짜 ~ 종료일
 *
 * 이슈 → 칸: 저장하면 그 기간 칸을 '미입차' / '노쇼' / '529AB (D1,D2)'(뛴 회전만)로 바꾸고, 바꾸기 전 값을 '원래 칸'에 남김
 *            지우거나 기간이 줄면 (칸이 아직 이슈가 넣은 값 그대로일 때만) 원래 값으로 되돌림
 * 칸 → 이슈: 기사스케줄에서 칸을 '미입차'·'노쇼'·기본노선보다 줄인 회전으로 고치면 '사유 미정' 이슈를 자동으로 만들고
 *            (전날 같은 이슈가 있으면 기간을 늘림), 칸을 다시 정상으로 고치면 그날을 이슈에서 뺌
 */
const ISS = {
  RULE_FROM: '2026-11-01',
  RESULTS: ['미입차', '노쇼', '물량조율'],
  REASONS: ['차량고장', '차량사고', '질병', '부상', '경조사', '개인사정', '기타'],
  SUBS: ['쿠친', '품앗이', '외부용차', '캠프 반납', '없음'],
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
  const b = str_(base);
  if (!b || /백업|예비|용차/.test(b)) return null;
  if (/휴무|휴가|병가|퇴사|출근|용차|변경/.test(v)) return null;
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
/**
 * 이슈를 칸에 반영 (저장·수정·삭제 공통 · 잠금 안에서)
 * prev: 고치기 전 이슈(없으면 새 이슈) · next: 고친 뒤 이슈(없으면 삭제)
 * dry: 덮어쓸 특별한 칸만 돌려 줌 · 반환 { cells: [바뀐 칸], orig: 다음 '원래 칸', conflicts }
 */
function issSyncCells_(a, drv, prev, next, dry) {
  const ctxOf = issCtxMaker_();
  const live = function (x) { return x && x.link !== 'N' && x.result && ISS.RESULTS.indexOf(x.result) >= 0; };
  const span = function (x) { return live(x) ? issDates_(x.date, x.end || x.date).filter(function (d) { return d >= ISS.RULE_FROM; }) : []; };
  const pd = span(prev), nd = span(next);
  const all = pd.concat(nd.filter(function (d) { return pd.indexOf(d) < 0; }));
  const orig = Object.assign({}, (prev && prev.orig) || {});
  if (!all.length) return { cells: [], orig: next ? orig : {}, conflicts: [] };
  const cur = schCellsOf_(drv.id, all);
  const want = {}, conflicts = [];
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
      if (!(had && mine) && now && now !== '출근' && now !== ctx.base && !/^(미입차|노쇼)$/.test(now) && issClassify_(now, ctx.base, ctx.rots, ctx.camp) === null) conflicts.push({ date: d, current: now, next: v });
      orig[d] = base0; want[d] = v;
    } else if (had) {
      if (mine) want[d] = o0;
      delete orig[d];
    }
  });
  if (dry) return { cells: [], orig: orig, conflicts: conflicts };
  const cells = issWriteCells_(a, drv.id, want);
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
  const drv = {};
  readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) drv[o.id] = o; });
  const ctxOf = issCtxMaker_();
  const sh = schIssueSheet_();
  schIssueHeadFix_(sh);
  let issues = schIssues_();
  const save = function (x) { issWriteRow_(sh, x); };
  list.sort(function (p, q) { return p.row < q.row ? -1 : p.row > q.row ? 1 : p.date < q.date ? -1 : 1; }).forEach(function (ch) {
    const o = drv[ch.row]; if (!o) return;
    const ctx = ctxOf(o, ch.date);
    const cls = issClassify_(ch.value, ctx.base, ctx.rots, ctx.camp);
    // 그날 걸친 연동 이슈
    const hit = issues.filter(function (x) { return x.driverId === o.id && x.link !== 'N' && x.result && x.date <= ch.date && ch.date <= (x.end || x.date) && x.kind !== '지시'; })[0];
    if (hit) {
      const expect = issCellFor_(hit, (hit.orig || {}).hasOwnProperty(ch.date) ? hit.orig[ch.date] : ch.old, ctx);
      if (expect !== null && expect === ch.value) return; // 그대로
      if (cls && cls.result === hit.result && (cls.result !== '물량조율' || cls.cut === hit.cut)) return;
      // 그날을 이슈에서 뺀다 (하루짜리면 이슈 삭제, 처음·끝이면 줄이고, 가운데면 둘로 나눔)
      const s = hit.date, e = hit.end || hit.date;
      if (s === e) { sh.deleteRow(hit.row); out.removed.push(hit.id); issues = schIssues_(); }
      else if (ch.date === s || ch.date === e) {
        if (ch.date === s) hit.date = schAddDays_(s, 1); else hit.end = schAddDays_(e, -1);
        delete (hit.orig || {})[ch.date]; save(hit); out.changed.push(hit);
      } else {
        const tail = Object.assign({}, hit, { id: issNewId_(), row: 0, date: schAddDays_(ch.date, 1), end: e, orig: {} });
        Object.keys(hit.orig || {}).forEach(function (d) { if (d > ch.date) { tail.orig[d] = hit.orig[d]; delete hit.orig[d]; } });
        delete (hit.orig || {})[ch.date];
        hit.end = schAddDays_(ch.date, -1); save(hit); out.changed.push(hit);
        save(tail); out.created.push(tail);
      }
      issues = schIssues_();
    }
    if (!cls) return;
    // 물량조율인데 뺀 회전을 같은 캠프 다른 기사가 그날 뛰기로 되어 있으면 (205C(D1),205D + 205C (D2,F3) 처럼 나눠 뛰는 날) 이슈 아님
    if (cls.result === '물량조율' && issCoveredByOthers_(o.id, ch.date, ctx, cls.cut, drv, ctxOf)) return;
    // 전날 같은 결과의 연동 이슈가 있으면 기간을 늘림
    const prevDay = schAddDays_(ch.date, -1);
    const near = issues.filter(function (x) { return x.driverId === o.id && x.link !== 'N' && x.result === cls.result && (cls.result !== '물량조율' || x.cut === cls.cut) && (x.end || x.date) === prevDay; })[0];
    if (near) {
      near.end = ch.date; near.orig = near.orig || {}; near.orig[ch.date] = ch.old;
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
  const mi = x.result === '미입차' || x.result === '노쇼' || (!x.result && x.mi);
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
  o.mi = o.result === '미입차' || o.result === '노쇼' || (!o.result && !!x.mi);
  o.miDays = o.mi ? issDates_(o.date, o.end || o.date).length : 0;
  return o;
}
