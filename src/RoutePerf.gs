/**
 * 노선 수행률 관리 (쿠팡 주간 '수행률 안내 및 적정 라우트 위탁 협의' 파일)
 *  - 관리자 노선관리 [수행률 업로드]: 파일을 화면에서 읽어 줄 단위로 보내면(adm_perfSave) route_perf 탭에 주차×라우트로 쌓는다
 *    (같은 주차·라우트는 덮어쓰기 → 재발송본 처리 · 쿠팡은 4~6주만 주지만 여기엔 이력이 계속 남는다)
 *  - 조회(adm_perfList): 최근 N주 전체 + 라우트별 최신 등급 · 3~4등급 · 개선 요청
 *  - 기사 앱(api_myPerf): 관리자가 켜 두었을 때만(app_settings perfDrvOn) 내 기본노선의 최근 등급
 *  - 업로드 때 3~4등급·개선 요청이 있으면 업무스케줄에 메모 한 줄 (perfMemoOn, 기본 ON)
 *  라우트 코드는 정산코드(숫자+글자, 예 527B)로 맞춰 둔다 (쿠팡 파일의 527_B → 527B). 캠프는 짧은 이름(강서1).
 */
// route_perf 탭 열 정의(RPF)는 Code.gs (파일 읽는 순서와 상관없게)
const RPF_WEEKS_DEFAULT = 16;

function rpfVer_() { return cache_().get('rpf:v') || '0'; }
function rpfBump_() { try { cache_().put('rpf:v', Date.now() + Math.random().toString(36).slice(2, 6), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
/** 기사 앱에 내 라우트 등급 보여주기 (관리자 ON/OFF · 기본 ON) */
function perfDrvOn_() { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().perfDrvOn)); }
/** 업로드 때 3~4등급·개선 요청 메모 자동 (기본 ON) */
function perfMemoOn_() { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().perfMemoOn)); }

function rpfKey_(week, camp, code) { return week + '|' + camp + '|' + code; }
function rpfCode_(v) { return normCode_(v).replace(/[^0-9A-Z]/g, ''); }
function rpfCamp_(v) { return str_(v).replace(/\s*캠프\s*$/, '').replace(/\s+/g, ''); }
function rpfPct_(v) {
  if (v === '' || v == null) return '';
  const s = String(v).trim();
  if (/%$/.test(s)) { const n = Number(s.replace(/[^\d.\-]/g, '')); return isNaN(n) ? '' : String(Math.round(n * 10) / 10); }
  const n = Number(s.replace(/,/g, ''));
  if (isNaN(n)) return '';
  return String(Math.round((n <= 1.5 ? n * 100 : n) * 10) / 10); // 0.58 → 58
}
function rpfGrade_(v) { const n = Number(String(v).replace(/[^\d]/g, '')); return n >= 1 && n <= 4 ? String(n) : ''; }
/** ISO 주차(WK44) → 그 주 (일~토). 한 주 시작은 일요일: ISO 월요일 하루 전부터 */
function rpfWeekRange_(year, wk) {
  const jan4 = new Date(year, 0, 4), dow = jan4.getDay() || 7;
  const mon1 = addDays_(jan4, 1 - dow); // ISO 1주차 월요일
  const mon = addDays_(mon1, (wk - 1) * 7);
  return { from: ymd_(addDays_(mon, -1)), to: ymd_(addDays_(mon, 5)) };
}
function rpfAll_() {
  let rows = [];
  try { rows = readAll_(SH.RPERF).filter(function (o) { return o.key && o.week && o.code; }); } catch (e) { rows = []; }
  return rows;
}
function rpfView_(o) {
  return { key: o.key, week: o.week, wk: o.wk, from: o.from, to: o.to, wave: o.wave, camp: o.camp, code: o.code,
    perf: o.perf === '' ? null : Number(o.perf), grade: o.grade ? Number(o.grade) : null, ret: o.ret === '' ? null : Number(o.ret), retGrade: o.retGrade ? Number(o.retGrade) : null,
    improve: o.improve === 'Y', f1: o.f1, f2: o.f2, f3: o.f3, parcel: o.parcel, zip: o.zip, file: o.file, uploadedAt: o.uploadedAt };
}

/**
 * 관리자: 한 주차 저장. p = { year, wk, file, rows: [{ wave, camp, code, perf, grade, ret, retGrade, improve, f1, f2, f3, parcel, zip }] }
 *  - 파일의 과거 주차(WK43, WK42…)도 rows 에 같이 보내면 그 주차도 채워진다 (각 줄에 wk 를 넣어서)
 */
function adm_perfSave(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const year = Number(p.year) || new Date().getFullYear();
    const rows = Array.isArray(p.rows) ? p.rows : [];
    if (!rows.length) fail_('저장할 줄이 없습니다.');
    if (rows.length > 3000) fail_('한 번에 3000줄까지 올릴 수 있습니다.');
    const file = str_(p.file).slice(0, 120), now = nowText_();
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const sh = sheet_(SH.RPERF), c = cols_(SH.RPERF, true);
      const cur = rpfAll_(), byKey = {};
      cur.forEach(function (o) { byKey[o.key] = o; });
      const upd = [], add = [], seen = {}, weeks = {};
      let unchanged = 0;
      rows.forEach(function (r) {
        const wk = Number(r.wk || p.wk); if (!(wk >= 1 && wk <= 53)) return;
        const y = Number(r.year) || year;
        const camp = rpfCamp_(r.camp), code = rpfCode_(r.code);
        if (!camp || !code) return;
        const week = y + '-W' + (wk < 10 ? '0' : '') + wk, rg = rpfWeekRange_(y, wk);
        const key = rpfKey_(week, camp, code);
        if (seen[key]) return; seen[key] = 1;
        weeks[week] = 1;
        const o = { key: key, week: week, wk: 'WK' + wk, from: rg.from, to: rg.to, wave: str_(r.wave).slice(0, 10), camp: camp, code: code,
          perf: rpfPct_(r.perf), grade: rpfGrade_(r.grade), ret: rpfPct_(r.ret), retGrade: rpfGrade_(r.retGrade),
          improve: /개선|Y|요청/i.test(str_(r.improve)) ? 'Y' : '', f1: str_(r.f1).slice(0, 30), f2: str_(r.f2).slice(0, 30), f3: str_(r.f3).slice(0, 30),
          parcel: str_(r.parcel).slice(0, 30), zip: str_(r.zip).slice(0, 60), file: file, uploadedAt: now, by: a.name };
        const old = byKey[key];
        // 파일의 과거 주차 열(partial): 등급·수행률만 새로 받고 개선 요청·플래그는 그 주차 파일로 올렸던 값을 지킨다
        if (old && r.partial) ['wave', 'improve', 'f1', 'f2', 'f3', 'parcel', 'zip'].forEach(function (k) { if (str_(old[k])) o[k] = str_(old[k]); });
        if (old) {
          const same = ['wave', 'perf', 'grade', 'ret', 'retGrade', 'improve', 'f1', 'f2', 'f3', 'parcel', 'zip'].every(function (k) { return str_(old[k]) === o[k]; });
          if (same) { unchanged++; return; }
          upd.push({ row: old._row, o: o, old: old });
        } else add.push(o);
      });
      const toArr = function (o) { const arr = new Array(c.__w).fill(''); Object.keys(o).forEach(function (k) { if (c[k] !== undefined) arr[c[k]] = safeText_(o[k]); }); return arr; };
      upd.forEach(function (u) { sh.getRange(u.row, 1, 1, c.__w).setNumberFormat('@').setValues([toArr(u.o)]); });
      if (add.length) {
        const r0 = sh.getLastRow() + 1;
        if (r0 + add.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, add.length));
        sh.getRange(r0, 1, add.length, c.__w).setNumberFormat('@').setValues(add.map(toArr));
      }
      SpreadsheetApp.flush();
      rpfBump_();
      // 가장 최근 주차의 3~4등급 · 개선 요청 → 업무스케줄 메모 (주차마다 한 번만)
      const wkList = Object.keys(weeks).sort(), latest = wkList[wkList.length - 1];
      let memo = null;
      if (latest && perfMemoOn_()) {
        const lrows = add.concat(upd.map(function (u) { return u.o; })).filter(function (o) { return o.week === latest; });
        // 이번에 바뀐 게 없더라도(재업로드) 메모는 이미 있을 것이므로 새로 적지 않는다
        const bad = lrows.filter(function (o) { return o.grade === '3' || o.grade === '4'; }), imp = lrows.filter(function (o) { return o.improve === 'Y'; });
        if (bad.length || imp.length) memo = rpfMemo_(a, latest, lrows[0].wk, bad, imp);
      }
      logAdmin_(a, '수행률 업로드', wkList.join(', '), '새로 ' + add.length + ' · 바뀜 ' + upd.length + ' · 같음 ' + unchanged + (file ? ' · ' + file : ''));
      return { ok: true, added: add.length, changed: upd.length, unchanged: unchanged, weeks: wkList, memo: memo };
    } finally { lock.releaseLock(); }
  });
}
/** 업무스케줄 메모: '[수행률 WK44] 3~4등급 …' — 같은 주차 메모가 이미 있으면 다시 적지 않는다 */
function rpfMemo_(a, week, wk, bad, imp) {
  const tag = '[수행률 ' + wk + ']';
  try {
    const dup = readAll_(SH.MEMO).some(function (m) { return str_(m.content).indexOf(tag) === 0; });
    if (dup) return null;
  } catch (e) { /* 메모 탭 없음 */ }
  const fmt = function (o) { return o.camp + ' ' + o.code + '(' + (o.perf === '' ? '-' : o.perf + '%') + '·' + o.grade + '등급)'; };
  const today = todayText_(), t0 = parseYmd_(today);
  const lines = [];
  if (bad.length) lines.push('3~4등급 ' + bad.length + '개: ' + bad.map(fmt).join(', '));
  if (imp.length) lines.push('개선 요청(위탁 협의) ' + imp.length + '개: ' + imp.map(function (o) { return o.camp + ' ' + o.code; }).join(', ') +
    ' → 입차 기한 ' + ymd_(addDays_(t0, 5)).slice(5).replace('-', '/') + ' · 개선 기한 ' + ymd_(addDays_(t0, 12)).slice(5).replace('-', '/') + ' (수행률 95%·반품 90%)');
  const content = tag + ' ' + lines.join(' / ');
  const now = nowText_();
  appendObj_(SH.MEMO, { id: newMemoId_(), date: today, time: '', content: content.slice(0, 2000), done: '', cat: '', author: a.name, createdAt: now, updatedAt: now });
  return content;
}

/** 관리자: 최근 N주 전체 (라우트별 이력은 화면에서 묶는다) */
function adm_perfList(token, weeksN) {
  return run_(function () {
    requireAdmin_(token);
    const n = Math.max(4, Math.min(60, Number(weeksN) || RPF_WEEKS_DEFAULT));
    const ck = cache_(), key = 'rpf:l:' + rpfVer_() + ':' + n, hit = ck.get(key);
    if (hit) { try { const o = JSON.parse(hit); o.drvOn = perfDrvOn_(); o.memoOn = perfMemoOn_(); return o; } catch (e) { /* 다시 */ } }
    const all = rpfAll_();
    const weeks = Object.keys(all.reduce(function (m, o) { m[o.week] = 1; return m; }, {})).sort().reverse().slice(0, n);
    const wset = {}; weeks.forEach(function (w) { wset[w] = 1; });
    const rows = all.filter(function (o) { return wset[o.week]; }).map(rpfView_);
    const out = { ok: true, weeks: weeks.reverse(), rows: rows, totalWeeks: Object.keys(all.reduce(function (m, o) { m[o.week] = 1; return m; }, {})).length, drvOn: perfDrvOn_(), memoOn: perfMemoOn_(), lineage: rlnEdges_() };
    try { const j = JSON.stringify(out); if (j.length < 95000) ck.put(key, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
/** 관리자: 설정 (기사 앱 표시 · 메모 자동) */
function adm_perfSet(token, f) {
  return run_(function () {
    const a = requireAdmin_(token);
    f = f || {};
    if (f.drvOn !== undefined) { appSetPut_('perfDrvOn', f.drvOn ? 'ON' : 'OFF', '기사 앱 마이페이지에 내 라우트 수행률 등급 보여주기 (ON/OFF)'); logAdmin_(a, '수행률 설정', '기사 앱 표시', f.drvOn ? 'ON' : 'OFF'); }
    if (f.memoOn !== undefined) { appSetPut_('perfMemoOn', f.memoOn ? 'ON' : 'OFF', '수행률 업로드 때 3~4등급·개선 요청 업무스케줄 메모 자동 (ON/OFF)'); logAdmin_(a, '수행률 설정', '메모 자동', f.memoOn ? 'ON' : 'OFF'); }
    return { ok: true, drvOn: perfDrvOn_(), memoOn: perfMemoOn_() };
  });
}
/** 대시보드용: 최신 주차 요약 */
function rpfSummary_() {
  const all = rpfAll_();
  if (!all.length) return null;
  const weeks = Object.keys(all.reduce(function (m, o) { m[o.week] = 1; return m; }, {})).sort();
  const latest = weeks[weeks.length - 1], rows = all.filter(function (o) { return o.week === latest; });
  const bad = rows.filter(function (o) { return o.grade === '3' || o.grade === '4'; });
  return { week: latest, wk: rows[0].wk, from: rows[0].from, to: rows[0].to, routes: rows.length, g1: rows.filter(function (o) { return o.grade === '1'; }).length,
    g2: rows.filter(function (o) { return o.grade === '2'; }).length, bad: bad.length, improve: rows.filter(function (o) { return o.improve === 'Y'; }).length,
    badList: bad.slice(0, 8).map(function (o) { return o.camp + ' ' + o.code + ' ' + o.grade + '등급' + (o.perf !== '' ? ' ' + o.perf + '%' : ''); }), uploadedAt: rows[0].uploadedAt };
}

/**
 * 기사 앱: 내 라우트 수행률 (관리자가 켜 두었을 때만)
 *  - 고정 기사: 기본노선 라우트(mine) · 백업 기사(기본노선 없음): 최근 4주 기사스케줄에서 실제로 뛴 라우트(recent)
 *  - 그 아래 소속 캠프 전체 라우트의 최신 등급(campAll · 접힌 상태로)
 */
function api_myPerf(token) {
  return run_(function () {
    const u = pmUser_(token);
    if (!perfDrvOn_()) return { ok: true, on: false, routes: [] };
    const ck = cache_(), key = 'myperf:' + u.id + ':' + rpfVer_(), hit = ck.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 */ } }
    const o = driverById_(u.id) || {};
    const camp = rpfCamp_(o.schCamp || '');
    const base = rpfBaseCodes_(o.baseRoute || '');
    const all = rpfAll_();
    const weeksAll = Object.keys(all.reduce(function (m, r) { m[r.week] = 1; return m; }, {})).sort();
    const weeks = weeksAll.slice(-8), latest = weeksAll[weeksAll.length - 1] || '';
    const edges = rlnEdges_();
    const series = function (cp, code) {
      const keys = [cp + '|' + code].concat(rlnChain_(edges, cp, code).map(function (x) { return x.camp + '|' + x.code; })); // 이전 코드(개명·이관)의 이력도 이어 붙임
      const mine = all.filter(function (r) { return keys.indexOf(r.camp + '|' + r.code) >= 0 && weeks.indexOf(r.week) >= 0; });
      return { code: code, camp: cp, weeks: weeks.map(function (w) { const r = mine.filter(function (x) { return x.week === w; })[0]; return r ? { wk: r.wk, from: r.from, to: r.to, perf: r.perf === '' ? null : Number(r.perf), grade: r.grade ? Number(r.grade) : null, improve: r.improve === 'Y' } : { wk: 'WK' + Number(w.slice(6)), perf: null, grade: null }; }) };
    };
    const has = function (r) { return r.weeks.some(function (w) { return w.grade; }); };
    const out = { ok: true, on: true, camp: camp, backup: !base.length, weeks: weeks, routes: [], recent: [], campAll: [] };
    if (camp && base.length) out.routes = base.map(function (c) { return series(camp, c); }).filter(has);
    // 최근 4주 스케줄에서 뛴 라우트 (백업 기사 · 고정 기사도 다른 노선을 뛰었으면 같이)
    try {
      const today = parseYmd_(todayText_()), rec = {};
      const s = schRead_(sundayOf_(addDays_(today, -27)), today);
      const cells = s.cells[u.id] || {}, campShorts = (s.camps || []).map(function (c) { return rpfCamp_(c.name); });
      Object.keys(cells).forEach(function (d) {
        const v = String(cells[d] || '').toUpperCase();
        if (!v || /휴무|휴가|병가|미입차|비고/.test(v)) return;
        let cp = camp;
        campShorts.forEach(function (c) { if (c && v.indexOf(c.toUpperCase()) >= 0) cp = c; });
        rpfBaseCodes_(v.replace(/[^0-9A-Z가-힣,\s/]/g, ' ')).forEach(function (code) {
          if (!/^\d/.test(code)) return;
          const k = cp + '|' + code; rec[k] = rec[k] || { camp: cp, code: code, days: 0 }; rec[k].days++;
        });
      });
      out.recent = Object.keys(rec).map(function (k) { return rec[k]; }).filter(function (x) { return !(x.camp === camp && base.indexOf(x.code) >= 0); })
        .sort(function (a, b) { return b.days - a.days; }).slice(0, 8).map(function (x) { const r = series(x.camp, x.code); r.days = x.days; return r; }).filter(has);
    } catch (e) { out.recent = []; }
    if (camp && latest) {
      out.campAll = all.filter(function (r) { return r.camp === camp && r.week === latest; }).sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; })
        .map(function (r) { return { code: r.code, wk: r.wk, perf: r.perf === '' ? null : Number(r.perf), grade: r.grade ? Number(r.grade) : null, improve: r.improve === 'Y' }; });
    }
    // 월간 SLA 점수 (최신 집계기간) 를 라우트마다 붙인다
    try {
      const sla = slaAll_(), ps = Object.keys(sla.reduce(function (m, o) { m[o.period] = 1; return m; }, {})).sort(), lp = ps[ps.length - 1];
      if (lp) {
        const lrows = sla.filter(function (o) { return o.period === lp; }), th = slaThresholds_();
        const of = function (cp, code) { const keys = [cp + '|' + code].concat(rlnChain_(edges, cp, code).map(function (x) { return x.camp + '|' + x.code; })); const r = lrows.filter(function (o) { return keys.indexOf(o.camp + '|' + o.code) >= 0; })[0]; return r ? { total: r.total === '' ? null : Number(r.total), cs: r.cs === '' ? null : Number(r.cs), cx: r.cx === '' ? null : Number(r.cx) } : null; };
        out.routes.concat(out.recent).forEach(function (r) { r.sla = of(r.camp || camp, r.code); });
        out.campAll.forEach(function (x) { x.sla = of(camp, x.code); });
        const v = lrows.filter(function (o) { return o.code === '영업점'; })[0];
        out.sla = { period: lp, from: lrows[0].from, vendor: v ? Number(v.total) : null, th: th };
      }
    } catch (e) { /* SLA 없음 */ }
    try { const j = JSON.stringify(out); if (j.length < 90000) ck.put(key, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
/** 기본노선 글자 → 정산코드 목록. '110AB' → [110A, 110B] · '110A,116C' → [110A, 116C] · '백업' → [] */
function rpfBaseCodes_(br) {
  const out = [];
  String(br || '').toUpperCase().split(/[,\s/]+/).forEach(function (t) {
    const m = t.match(/^(\d{2,4})([A-Z]*)$/); if (!m) return;
    if (!m[2]) { out.push(m[1]); return; }
    m[2].split('').forEach(function (L) { out.push(m[1] + L); });
  });
  return out.filter(function (x, i, a) { return a.indexOf(x) === i; });
}

// ───────────────────────── SLA 점수 (쿠팡 '[QF] Vendor SLA' 월간 파일 · route_sla) ─────────────────────────
// 총점 100 = 미수행률 15 + 반품 미회수율 15 + 고객만족 50 + 고객불만 20. 집계기간이 누적(예 6/1~9/25)이라 기간 끝 날짜(period)로 구분한다.
const SLA_CAMP_DEFAULT = { AYG_1: '안양1', GSO_1: '강서1', GNP_1: '군포1', ICH_7: '인천7', ICH_8: '인천8', ISN_5: '일산5', SCH_1: '서초1', SHG_1: '시흥1', SHG_2: '시흥2', SWN_1: '수원1', HWS_1: '화성1' };
const SLA_GOOD = 95, SLA_WARN = 90; // 총점 색 기준 (설정 slaGood / slaWarn 로 바꿀 수 있음)
function slaThresholds_() { const a = appSet_(); return { good: Number(a.slaGood) || SLA_GOOD, warn: Number(a.slaWarn) || SLA_WARN }; }
/** 쿠팡 캠프코드 → 짧은 캠프 이름 (camps 탭 '쿠팡 캠프코드' 우선, 없으면 기본표) */
function slaCampMap_() {
  const m = Object.assign({}, SLA_CAMP_DEFAULT);
  try { readAll_(SH.CAMPS).forEach(function (c) { const k = str_(c.cpCode).toUpperCase(); if (k && c.name) m[k] = rpfCamp_(c.name); }); } catch (e) { /* 없음 */ }
  return m;
}
function slaNum_(v) { if (v === '' || v == null) return ''; const n = Number(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? '' : String(Math.round(n * 10) / 10); }
function slaAll_() { let rows = []; try { rows = readAll_(SH.RSLA).filter(function (o) { return o.key && o.period; }); } catch (e) { rows = []; } return rows; }
function slaView_(o) {
  const n = function (v) { return v === '' ? null : Number(v); };
  return { key: o.key, period: o.period, from: o.from, to: o.to, wave: o.wave, cpCamp: o.cpCamp, camp: o.camp, code: o.code, type: o.type,
    total: n(o.total), miss: n(o.miss), ret: n(o.ret), cs: n(o.cs), cx: n(o.cx), file: o.file, uploadedAt: o.uploadedAt };
}
/**
 * 관리자: SLA 파일 한 블록 저장. p = { from:'yyyy-MM-dd', to:'yyyy-MM-dd', file, vendor:{total,miss,ret,cs,cx}, rows:[{ wave, cpCamp, route, type, total, miss, ret, cs, cx }] }
 *  같은 기간(끝 날짜)·라우트는 덮어쓴다. 캠프코드 → 캠프 이름은 slaCampMap_.
 */
function adm_slaSave(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const from = normDate_(p.from), to = normDate_(p.to);
    if (!to) fail_('집계기간(Data End Date)을 확인해 주세요.');
    const rows = Array.isArray(p.rows) ? p.rows : [];
    if (!rows.length && !p.vendor) fail_('저장할 줄이 없습니다.');
    const file = str_(p.file).slice(0, 120), now = nowText_(), map = slaCampMap_();
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const sh = sheet_(SH.RSLA), c = cols_(SH.RSLA, true);
      const cur = slaAll_(), byKey = {};
      cur.forEach(function (o) { byKey[o.key] = o; });
      const mk = function (cpCamp, camp, code, r, wave, type) {
        return { key: to + '|' + camp + '|' + code, period: to, from: from || '', to: to, wave: str_(wave).slice(0, 10), cpCamp: cpCamp, camp: camp, code: code, type: str_(type).slice(0, 20),
          total: slaNum_(r.total), miss: slaNum_(r.miss), ret: slaNum_(r.ret), cs: slaNum_(r.cs), cx: slaNum_(r.cx), file: file, uploadedAt: now, by: a.name };
      };
      const list = [], unknownCamps = {};
      if (p.vendor) list.push(mk('', '', '영업점', p.vendor, '', '영업점'));
      rows.forEach(function (r) {
        const cp = str_(r.cpCamp).toUpperCase(), code = rpfCode_(r.route); if (!code) return;
        const camp = map[cp] || rpfCamp_(r.camp || '') || cp;
        if (!map[cp] && cp) unknownCamps[cp] = 1;
        list.push(mk(cp, camp, code, r, r.wave, r.type));
      });
      const seen = {}, upd = [], add = []; let unchanged = 0;
      list.forEach(function (o) {
        if (seen[o.key]) return; seen[o.key] = 1;
        const old = byKey[o.key];
        if (old) {
          if (['total', 'miss', 'ret', 'cs', 'cx', 'from'].every(function (k) { return str_(old[k]) === o[k]; })) { unchanged++; return; }
          upd.push({ row: old._row, o: o });
        } else add.push(o);
      });
      const toArr = function (o) { const arr = new Array(c.__w).fill(''); Object.keys(o).forEach(function (k) { if (c[k] !== undefined) arr[c[k]] = safeText_(o[k]); }); return arr; };
      upd.forEach(function (u) { sh.getRange(u.row, 1, 1, c.__w).setNumberFormat('@').setValues([toArr(u.o)]); });
      if (add.length) {
        const r0 = sh.getLastRow() + 1;
        if (r0 + add.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, add.length));
        sh.getRange(r0, 1, add.length, c.__w).setNumberFormat('@').setValues(add.map(toArr));
      }
      SpreadsheetApp.flush();
      rpfBump_();
      // 메모: 위험(총점 < warn) 라우트가 있고 이 기간 메모가 아직 없으면 한 줄
      let memo = null;
      const th = slaThresholds_();
      if (perfMemoOn_() && (add.length || upd.length)) {
        const bad = list.filter(function (o) { return o.code !== '영업점' && o.total !== '' && Number(o.total) < th.warn; });
        if (bad.length) memo = slaMemo_(a, to, bad, th);
      }
      logAdmin_(a, 'SLA 점수 업로드', (from || '') + '~' + to, '새로 ' + add.length + ' · 바뀜 ' + upd.length + ' · 같음 ' + unchanged + (file ? ' · ' + file : ''));
      return { ok: true, added: add.length, changed: upd.length, unchanged: unchanged, period: to, unknownCamps: Object.keys(unknownCamps), memo: memo };
    } finally { lock.releaseLock(); }
  });
}
function slaMemo_(a, period, bad, th) {
  const tag = '[SLA ~' + period.slice(5).replace('-', '/') + ']';
  try { if (readAll_(SH.MEMO).some(function (m) { return str_(m.content).indexOf(tag) === 0; })) return null; } catch (e) { /* 없음 */ }
  const content = tag + ' 총점 ' + th.warn + '점 미만 ' + bad.length + '개: ' + bad.sort(function (x, y) { return Number(x.total) - Number(y.total); })
    .map(function (o) { return o.camp + ' ' + o.code + '(' + o.total + '점·고객만족 ' + (o.cs || '-') + ')'; }).join(', ') + ' — 고객만족(50점) 항목 확인';
  const now = nowText_();
  appendObj_(SH.MEMO, { id: newMemoId_(), date: todayText_(), time: '', content: content.slice(0, 2000), done: '', cat: '', author: a.name, createdAt: now, updatedAt: now });
  return content;
}
/** 관리자: SLA 전체 (최근 N기간) — adm_perfList 와 따로 (수행률 패널 'SLA 점수' 탭) */
function adm_slaList(token, periodsN) {
  return run_(function () {
    requireAdmin_(token);
    const n = Math.max(3, Math.min(36, Number(periodsN) || 18));
    const ck = cache_(), key = 'sla:l:' + rpfVer_() + ':' + n, hit = ck.get(key);
    if (hit) { try { const o = JSON.parse(hit); o.th = slaThresholds_(); return o; } catch (e) { /* 다시 */ } }
    const all = slaAll_();
    const periods = Object.keys(all.reduce(function (m, o) { m[o.period] = 1; return m; }, {})).sort().slice(-n);
    const pset = {}; periods.forEach(function (x) { pset[x] = 1; });
    const out = { ok: true, periods: periods, rows: all.filter(function (o) { return pset[o.period]; }).map(slaView_), th: slaThresholds_(), campMap: slaCampMap_(), lineage: rlnEdges_() };
    try { const j = JSON.stringify(out); if (j.length < 95000) ck.put(key, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
/** 대시보드용 SLA 요약 (최신 기간) */
function slaSummary_() {
  const all = slaAll_();
  if (!all.length) return null;
  const periods = Object.keys(all.reduce(function (m, o) { m[o.period] = 1; return m; }, {})).sort();
  const latest = periods[periods.length - 1], prevP = periods[periods.length - 2] || '';
  const rows = all.filter(function (o) { return o.period === latest; }), th = slaThresholds_();
  const vendor = rows.filter(function (o) { return o.code === '영업점'; })[0];
  const prevVendor = prevP ? all.filter(function (o) { return o.period === prevP && o.code === '영업점'; })[0] : null;
  const routes = rows.filter(function (o) { return o.code !== '영업점' && o.total !== ''; });
  const low = routes.filter(function (o) { return Number(o.total) < th.warn; }).sort(function (x, y) { return Number(x.total) - Number(y.total); });
  return { period: latest, from: rows[0].from, vendor: vendor ? Number(vendor.total) : null, vendorPrev: prevVendor ? Number(prevVendor.total) : null, vendorCs: vendor ? Number(vendor.cs) : null,
    routes: routes.length, low: low.length, warn: routes.filter(function (o) { return Number(o.total) >= th.warn && Number(o.total) < th.good; }).length,
    lowList: low.slice(0, 6).map(function (o) { return o.camp + ' ' + o.code + ' ' + o.total + '점'; }), th: th };
}

// ───────────────────────── 라우트 계보 (route_lineage) ─────────────────────────
// 코드가 바뀐 라우트(605A → 723A · 안양1 110A → 군포1 212A)를 이어 붙인다. 1:1(개명·이관)만 이력을 잇고, 분할·병합은 나란히 보여 주기만 한다(점수는 합치지 않음).
const RLK = { RENAME: '개명', MOVE: '이관', SPLIT: '분할', MERGE: '병합' };
function rlnAll_() {
  let rows = [];
  try { rows = readAll_(SH.RLIN).filter(function (o) { return o.id && o.fromCode && o.toCode; }); } catch (e) { rows = []; }
  return rows;
}
/** 노선 이관 기록(route_changes · 노선이관 · 적용/예약)에서 만든 계보 — 저장하지 않고 합쳐서 보여 준다. 110AB → 212AB 는 글자 자리끼리 110A→212A, 110B→212B */
function rlnFromMoves_() {
  const out = [];
  try {
    const campName = rcCampNames_();
    rcRows_().filter(function (c) { return c.kind === RCK.MOVE && (c.status === RCS.DONE || c.status === RCS.WAIT); }).forEach(function (c) {
      const v = rcView_(c, campName);
      const fc = rpfCamp_(v.fromCamp), tc = rpfCamp_(v.toCamp), a = rpfBaseCodes_(v.fromRoute), b = rpfBaseCodes_(v.toRoute);
      if (!a.length || !b.length) return;
      if (a.length === b.length) a.forEach(function (x, i) { out.push({ id: 'MV-' + c.id + '-' + i, date: v.date, kind: RLK.MOVE, fromCamp: fc, fromCode: x, toCamp: tc, toCode: b[i], memo: '노선 이관' + (c.status === RCS.WAIT ? ' (예약)' : ''), src: 'move' }); });
      else a.forEach(function (x) { b.forEach(function (y) { out.push({ id: 'MV-' + c.id + '-' + x + y, date: v.date, kind: a.length > b.length ? RLK.MERGE : RLK.SPLIT, fromCamp: fc, fromCode: x, toCamp: tc, toCode: y, memo: '노선 이관', src: 'move' }); }); });
    });
  } catch (e) { /* 없음 */ }
  return out;
}
function rlnEdges_() {
  const saved = rlnAll_().map(function (o) { return { id: o.id, date: o.date, kind: o.kind, fromCamp: o.fromCamp, fromCode: o.fromCode, toCamp: o.toCamp, toCode: o.toCode, memo: o.memo, by: o.by, src: 'saved' }; });
  const has = {}; saved.forEach(function (e) { has[e.fromCamp + '|' + e.fromCode + '>' + e.toCamp + '|' + e.toCode] = 1; });
  return saved.concat(rlnFromMoves_().filter(function (e) { return !has[e.fromCamp + '|' + e.fromCode + '>' + e.toCamp + '|' + e.toCode]; }));
}
/** (캠프|코드) 의 1:1 이전 코드들 (가장 가까운 것부터) — 분할·병합에 닿으면 멈춤 */
function rlnChain_(edges, camp, code) {
  const key = function (c, x) { return c + '|' + x; };
  const inTo = {}, outFrom = {};
  edges.forEach(function (e) { const f = key(e.fromCamp, e.fromCode), t = key(e.toCamp, e.toCode); (inTo[t] = inTo[t] || []).push(f); (outFrom[f] = outFrom[f] || []).push(t); });
  const out = []; let cur = key(camp, code), guard = 0;
  while (guard++ < 20) {
    const prev = inTo[cur]; if (!prev || prev.length !== 1) break;
    const p = prev[0]; if ((outFrom[p] || []).length !== 1 || out.indexOf(p) >= 0 || p === key(camp, code)) break;
    out.push(p); cur = p;
  }
  return out.map(function (k) { const i = k.indexOf('|'); return { camp: k.slice(0, i), code: k.slice(i + 1) }; });
}
function adm_lineageList(token) {
  return run_(function () { requireAdmin_(token); return { ok: true, edges: rlnEdges_(), kinds: [RLK.RENAME, RLK.MOVE, RLK.SPLIT, RLK.MERGE] }; });
}
/** 관리자: 계보 여러 줄 저장 rows = [{ date, kind, fromCamp, fromCode, toCamp, toCode, memo }] (같은 이전→이후는 덮어쓰기) */
function adm_lineageSave(token, rows) {
  return run_(function () {
    const a = requireAdmin_(token);
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) fail_('저장할 줄이 없습니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const cur = rlnAll_(), byKey = {};
      cur.forEach(function (o) { byKey[o.fromCamp + '|' + o.fromCode + '>' + o.toCamp + '|' + o.toCode] = o; });
      const now = nowText_(); let added = 0, changed = 0;
      rows.forEach(function (r) {
        const fc = rpfCamp_(r.fromCamp), tc = rpfCamp_(r.toCamp || r.fromCamp), f = rpfCode_(r.fromCode), t = rpfCode_(r.toCode);
        if (!fc || !f || !t) return;
        if (fc === tc && f === t) return;
        const kind = [RLK.RENAME, RLK.MOVE, RLK.SPLIT, RLK.MERGE].indexOf(str_(r.kind)) >= 0 ? str_(r.kind) : (fc !== tc ? RLK.MOVE : RLK.RENAME);
        const o = { date: normDate_(r.date) || todayText_(), kind: kind, fromCamp: fc, fromCode: f, toCamp: tc, toCode: t, memo: str_(r.memo).slice(0, 100), by: a.name };
        const old = byKey[fc + '|' + f + '>' + tc + '|' + t];
        if (old) { writeFields_(SH.RLIN, old._row, o); changed++; }
        else { o.id = uniqId_('L'); o.createdAt = now; appendObj_(SH.RLIN, o); added++; }
      });
      SpreadsheetApp.flush(); rpfBump_();
      logAdmin_(a, '라우트 계보 저장', '', '새로 ' + added + ' · 바뀜 ' + changed);
      return { ok: true, added: added, changed: changed, edges: rlnEdges_() };
    } finally { lock.releaseLock(); }
  });
}
function adm_lineageDel(token, id) {
  return run_(function () {
    const a = requireAdmin_(token);
    const row = findRow_(SH.RLIN, 'id', str_(id));
    if (!row) fail_('계보 줄을 찾을 수 없습니다.');
    const lock = scriptLock_(); lock.waitLock(20000);
    try { delRows_(sheet_(SH.RLIN), [row]); SpreadsheetApp.flush(); rpfBump_(); } finally { lock.releaseLock(); }
    logAdmin_(a, '라우트 계보 삭제', str_(id), '');
    return { ok: true, edges: rlnEdges_() };
  });
}
/**
 * 자동 제안: 주간 수행률·SLA 이력에서 "이전 기간엔 있었는데 다음 기간에 사라진 코드"와 "새로 생긴 코드"를 같은 캠프 안에서 짝지음.
 *  - 숫자(구분1) 묶음끼리 글자 구성이 같으면 번호 순서대로 1:1 개명 (605ABCD→723ABCD, 606→724)
 *  - 글자 구성이 다르면 분할/병합 후보 (507CD+515CD → 205CD)
 *  이미 계보에 있는 짝은 뺀다. 관리자가 확인하고 저장한다.
 */
function adm_lineageSuggest(token) {
  return run_(function () {
    requireAdmin_(token);
    const edges = rlnEdges_(), has = {};
    edges.forEach(function (e) { has[e.fromCamp + '|' + e.fromCode + '>' + e.toCamp + '|' + e.toCode] = 1; });
    const seqs = [];
    // SLA: 기간 순 · 주간: 주차 순 (각각 캠프별 코드 집합)
    const build = function (rows, pk, dateOf) {
      const byP = {};
      rows.forEach(function (r) { if (r.code === '영업점') return; (byP[r[pk]] = byP[r[pk]] || { p: r[pk], date: dateOf(r), camps: {} }).camps[r.camp] = (byP[r[pk]].camps[r.camp] || {}); byP[r[pk]].camps[r.camp][r.code] = 1; });
      return Object.keys(byP).sort().map(function (k) { return byP[k]; });
    };
    seqs.push({ src: 'SLA', list: build(slaAll_(), 'period', function (r) { return r.from || r.period; }) });
    seqs.push({ src: '주간', list: build(rpfAll_(), 'week', function (r) { return r.from; }) });
    const sug = [], seen = {};
    seqs.forEach(function (sq) {
      for (let i = 1; i < sq.list.length; i++) {
        const a = sq.list[i - 1], b = sq.list[i];
        const camps = {}; Object.keys(a.camps).concat(Object.keys(b.camps)).forEach(function (c) { camps[c] = 1; });
        Object.keys(camps).forEach(function (camp) {
          const A = Object.keys(a.camps[camp] || {}), Bc = Object.keys(b.camps[camp] || {});
          const gone = A.filter(function (x) { return Bc.indexOf(x) < 0; }), fresh = Bc.filter(function (x) { return A.indexOf(x) < 0; });
          if (!gone.length || !fresh.length) return;
          const grp = function (list) { const g = {}; list.forEach(function (x) { const m = x.match(/^(\d+)([A-Z]*)$/); if (!m) return; (g[m[1]] = g[m[1]] || []).push(m[2]); }); Object.keys(g).forEach(function (k) { g[k].sort(); }); return g; };
          const G = grp(gone), F = grp(fresh), usedF = {};
          const pairs = [];
          Object.keys(G).sort().forEach(function (gn) {
            const sig = G[gn].join('');
            const cand = Object.keys(F).filter(function (fn) { return !usedF[fn] && F[fn].join('') === sig; }).sort();
            if (cand.length) { usedF[cand[0]] = 1; G[gn].forEach(function (L) { pairs.push({ kind: RLK.RENAME, f: gn + L, t: cand[0] + L }); }); delete G[gn]; }
          });
          const restG = Object.keys(G), restF = Object.keys(F).filter(function (fn) { return !usedF[fn]; });
          if (restG.length && restF.length) {
            const kind = gone.length > fresh.length ? RLK.MERGE : gone.length < fresh.length ? RLK.SPLIT : RLK.RENAME;
            restG.forEach(function (gn) { G[gn].forEach(function (L) { restF.forEach(function (fn) { F[fn].forEach(function (L2) { if (kind !== RLK.RENAME || L === L2) pairs.push({ kind: kind, f: gn + L, t: fn + L2 }); }); }); }); });
          }
          pairs.forEach(function (p) {
            const k = camp + '|' + p.f + '>' + camp + '|' + p.t;
            if (has[k] || seen[k]) return; seen[k] = 1;
            sug.push({ date: b.date, kind: p.kind, fromCamp: camp, fromCode: p.f, toCamp: camp, toCode: p.t, src: sq.src, memo: sq.src + ' ' + String(a.p).slice(0, 10) + ' → ' + String(b.p).slice(0, 10) });
          });
        });
      }
    });
    return { ok: true, suggestions: sug };
  });
}
