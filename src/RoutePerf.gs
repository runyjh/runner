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
        // 업무스케줄에 짧게: '44주차 수행률 업로드 (3~4등급 4 · 개선 요청 1)'
        const lrows = rpfAll_().filter(function (o) { return o.week === latest; });
        const bad = lrows.filter(function (o) { return o.grade === '3' || o.grade === '4'; }).length, imp = lrows.filter(function (o) { return o.improve === 'Y'; }).length;
        memo = uploadMemo_(a, Number(latest.slice(6)) + '주차 수행률 업로드', [bad ? '3~4등급 ' + bad : '', imp ? '개선 요청 ' + imp : ''].filter(Boolean).join(' · '), !!(bad || imp));
      }
      logAdmin_(a, '수행률 업로드', wkList.join(', '), '새로 ' + add.length + ' · 바뀜 ' + upd.length + ' · 같음 ' + unchanged + (file ? ' · ' + file : ''));
      return { ok: true, added: add.length, changed: upd.length, unchanged: unchanged, weeks: wkList, memo: memo };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 업무 파일을 올렸을 때 업무스케줄에 남기는 짧은 한 줄 — '10월 정산서 업로드' · '44주차 수행률 업로드 (3~4등급 4)' · '9월 SLA 업로드 (위험 24)'
 *  같은 날 같은 제목이 이미 있으면 다시 적지 않는다 (괄호 안 숫자만 바뀌면 그 줄을 고친다).
 *  확인할 것이 있으면(needAction) 미완료, 없으면 완료로 적는다 (할 일 목록에 쌓이지 않게).
 */
function uploadMemo_(a, title, extra, needAction) {
  try {
    const today = todayText_(), now = nowText_();
    const content = title + (extra ? ' (' + extra + ')' : '');
    const same = readAll_(SH.MEMO).filter(function (m) { return (normDate_(m.date) || m.date) === today && (str_(m.content) === title || str_(m.content).indexOf(title + ' (') === 0); })[0];
    if (same) {
      if (str_(same.content) !== content) writeFields_(SH.MEMO, same._row, { content: content, done: needAction ? '' : 'Y', updatedAt: now });
      return content;
    }
    appendObj_(SH.MEMO, { id: newMemoId_(), date: today, time: '', content: content, done: needAction ? '' : 'Y', cat: '', author: a.name, createdAt: now, updatedAt: now });
    return content;
  } catch (e) { return null; }
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
    // 최근 4주 스케줄에서 뛴 라우트 — 백업 기사(기본노선 없음)만. 고정 기사는 기본노선 기준으로만 본다
    if (!base.length) try {
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
      if (perfMemoOn_()) {
        const bad = list.filter(function (o) { return o.code !== '영업점' && o.total !== '' && Number(o.total) < th.warn; }).length;
        memo = uploadMemo_(a, Number(to.slice(5, 7)) + '월 SLA 업로드', bad ? '위험 ' + bad : '', !!bad);
      }
      logAdmin_(a, 'SLA 점수 업로드', (from || '') + '~' + to, '새로 ' + add.length + ' · 바뀜 ' + upd.length + ' · 같음 ' + unchanged + (file ? ' · ' + file : ''));
      return { ok: true, added: add.length, changed: upd.length, unchanged: unchanged, period: to, unknownCamps: Object.keys(unknownCamps), memo: memo };
    } finally { lock.releaseLock(); }
  });
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
const RLK = { RENAME: '개명', MOVE: '이관', SPLIT: '분할', MERGE: '병합', END: '종료' }; // 종료 = 더 이상 운영하지 않는 라우트 (이후 라우트 없음)
function rlnAll_() {
  let rows = [];
  try { rows = readAll_(SH.RLIN).filter(function (o) { return o.id && o.fromCode && (o.toCode || o.kind === RLK.END); }); } catch (e) { rows = []; }
  return rows;
}
/** 노선 이관 기록(route_changes · 노선이관 · 적용/예약)에서 만든 계보 — 저장하지 않고 합쳐서 보여 준다. 110AB → 212AB 는 글자 자리끼리 110A→212A, 110B→212B */
function rlnFromMoves_() {
  const out = [];
  try {
    const campName = rcCampNames_();
    // 글자 없는 코드(110 → 212)는 자료에 있는 글자(110A·110B…)로 펼친다
    const letters = {};
    rpfAll_().concat(slaAll_()).forEach(function (r) { const m = String(r.code || '').match(/^(\d+)([A-Z])$/); if (m) (letters[r.camp + '|' + m[1]] = letters[r.camp + '|' + m[1]] || {})[m[2]] = 1; });
    const expand = function (camp, codes) { const o = []; codes.forEach(function (c) { if (/[A-Z]$/.test(c)) { o.push(c); return; } const L = Object.keys(letters[camp + '|' + c] || {}).sort(); if (L.length) L.forEach(function (x) { o.push(c + x); }); else o.push(c); }); return o; };
    const today = todayText_();
    // 적용일이 아직 안 온 예약 이관은 계보에 넣지 않는다 (적용되는 날부터 이어 붙임)
    rcRows_().filter(function (c) { return c.kind === RCK.MOVE && (c.status === RCS.DONE || (c.status === RCS.WAIT && c.date <= today)); }).forEach(function (c) {
      const v = rcView_(c, campName);
      const fc = rpfCamp_(v.fromCamp), tc = rpfCamp_(v.toCamp);
      let a = expand(fc, rpfBaseCodes_(v.fromRoute)), b = rpfBaseCodes_(v.toRoute);
      if (b.length === 1 && !/[A-Z]$/.test(b[0]) && a.length) b = a.map(function (x) { return b[0] + (x.match(/[A-Z]$/) || [''])[0]; }); // 212 → 212A·212B (이전 글자 따라)
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
  edges.forEach(function (e) { if (e.kind === RLK.END || !e.toCode) return; const f = key(e.fromCamp, e.fromCode), t = key(e.toCamp, e.toCode); (inTo[t] = inTo[t] || []).push(f); (outFrom[f] = outFrom[f] || []).push(t); });
  const out = []; let cur = key(camp, code), guard = 0;
  while (guard++ < 20) {
    const prev = inTo[cur]; if (!prev || prev.length !== 1) break;
    const p = prev[0]; if ((outFrom[p] || []).length !== 1 || out.indexOf(p) >= 0 || p === key(camp, code)) break;
    out.push(p); cur = p;
  }
  return out.map(function (k) { const i = k.indexOf('|'); return { camp: k.slice(0, i), code: k.slice(i + 1) }; });
}
function adm_lineageList(token) {
  return run_(function () { requireAdmin_(token); return { ok: true, edges: rlnEdges_(), kinds: [RLK.RENAME, RLK.MOVE, RLK.SPLIT, RLK.MERGE, RLK.END] }; });
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
        const end = str_(r.kind) === RLK.END;
        const fc = rpfCamp_(r.fromCamp), tc = end ? fc : rpfCamp_(r.toCamp || r.fromCamp), f = rpfCode_(r.fromCode), t = end ? '' : rpfCode_(r.toCode);
        if (!fc || !f || (!t && !end)) return;
        if (fc === tc && f === t) return;
        const kind = end ? RLK.END : ([RLK.RENAME, RLK.MOVE, RLK.SPLIT, RLK.MERGE].indexOf(str_(r.kind)) >= 0 ? str_(r.kind) : (fc !== tc ? RLK.MOVE : RLK.RENAME));
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
    seqs.push({ src: 'SLA', list: build(slaAll_(), 'period', function (r) { return r.period; }) });
    seqs.push({ src: '주간', list: build(rpfAll_(), 'week', function (r) { return r.from; }) });
    const sug = [], seen = {};
    seqs.forEach(function (sq) {
      for (let i = 1; i < sq.list.length; i++) {
        const a = sq.list[i - 1], b = sq.list[i];
        const camps = {}, leftover = { gone: [], fresh: [] }; Object.keys(a.camps).concat(Object.keys(b.camps)).forEach(function (c) { camps[c] = 1; });
        Object.keys(camps).forEach(function (camp) {
          const A = Object.keys(a.camps[camp] || {}), Bc = Object.keys(b.camps[camp] || {});
          const gone = A.filter(function (x) { return Bc.indexOf(x) < 0; }), fresh = Bc.filter(function (x) { return A.indexOf(x) < 0; });
          const grp0 = function (list) { const g = {}; list.forEach(function (x) { const m = x.match(/^(\d+)([A-Z]*)$/); if (!m) return; (g[m[1]] = g[m[1]] || []).push(m[2]); }); Object.keys(g).forEach(function (k) { g[k].sort(); }); return g; };
          if (!gone.length || !fresh.length) { // 한쪽만 있으면 다른 캠프와 맞춰 볼 후보로만 둔다 (캠프 간 이관)
            const G0 = grp0(gone), F0 = grp0(fresh);
            Object.keys(G0).forEach(function (gn) { leftover.gone.push({ camp: camp, num: gn, L: G0[gn] }); });
            Object.keys(F0).forEach(function (fn) { leftover.fresh.push({ camp: camp, num: fn, L: F0[fn] }); });
            return;
          }
          const grp = function (list) { const g = {}; list.forEach(function (x) { const m = x.match(/^(\d+)([A-Z]*)$/); if (!m) return; (g[m[1]] = g[m[1]] || []).push(m[2]); }); Object.keys(g).forEach(function (k) { g[k].sort(); }); return g; };
          const G = grp(gone), F = grp(fresh), usedF = {};
          const pairs = [];
          // 글자 구성(sig)이 같은 묶음끼리: 개수가 같으면 번호 순서대로 1:1 개명, 사라진 쪽이 많으면 병합·새 쪽이 많으면 분할 (같은 글자끼리 모두 후보)
          const sigs = {};
          Object.keys(G).forEach(function (gn) { const sg = G[gn].join(''); (sigs[sg] = sigs[sg] || { g: [], f: [] }).g.push(gn); });
          Object.keys(F).forEach(function (fn) { const sg = F[fn].join(''); (sigs[sg] = sigs[sg] || { g: [], f: [] }).f.push(fn); });
          Object.keys(sigs).forEach(function (sg) {
            const S = sigs[sg]; if (!S.g.length || !S.f.length) return;
            S.g.sort(); S.f.sort();
            if (S.g.length === S.f.length) S.g.forEach(function (gn, i) { G[gn].forEach(function (L) { pairs.push({ kind: RLK.RENAME, f: gn + L, t: S.f[i] + L }); }); });
            else { const kind = S.g.length > S.f.length ? RLK.MERGE : RLK.SPLIT; S.g.forEach(function (gn) { S.f.forEach(function (fn) { G[gn].forEach(function (L) { pairs.push({ kind: kind, f: gn + L, t: fn + L }); }); }); }); }
            S.g.forEach(function (gn) { delete G[gn]; }); S.f.forEach(function (fn) { usedF[fn] = 1; });
          });
          const restG = Object.keys(G), restF = Object.keys(F).filter(function (fn) { return !usedF[fn]; });
          if (restG.length && restF.length) {
            const kind = gone.length > fresh.length ? RLK.MERGE : gone.length < fresh.length ? RLK.SPLIT : RLK.RENAME;
            restG.forEach(function (gn) { G[gn].forEach(function (L) { restF.forEach(function (fn) { F[fn].forEach(function (L2) { if (kind !== RLK.RENAME || L === L2) pairs.push({ kind: kind, f: gn + L, t: fn + L2 }); }); }); }); });
          }
          // 짝이 안 맞은 묶음은 다른 캠프와 맞춰 본다 (이관 후보): 같은 시점에 다른 캠프에 같은 글자 구성이 새로 생겼으면
          Object.keys(G).forEach(function (gn) { if (!pairs.some(function (p) { return p.f.indexOf(gn) === 0; })) leftover.gone.push({ camp: camp, num: gn, L: G[gn] }); });
          Object.keys(F).forEach(function (fn) { if (!usedF[fn] && !pairs.some(function (p) { return p.t.indexOf(fn) === 0; })) leftover.fresh.push({ camp: camp, num: fn, L: F[fn] }); });
          pairs.forEach(function (p) {
            const k = camp + '|' + p.f + '>' + camp + '|' + p.t;
            if (has[k] || seen[k]) return; seen[k] = 1;
            sug.push({ date: b.date, kind: p.kind, fromCamp: camp, fromCode: p.f, toCamp: camp, toCode: p.t, src: sq.src, memo: sq.src + ' ' + String(a.p).slice(0, 10) + ' → ' + String(b.p).slice(0, 10) });
          });
        });
        leftover.gone.forEach(function (g) {
          const cand = leftover.fresh.filter(function (f) { return f.camp !== g.camp && f.L.join('') === g.L.join(''); });
          if (cand.length !== 1) {
            // 이어받는 라우트가 없고 그 뒤 기간에도 다시 안 나오면 '종료' 후보
            const later = sq.list.slice(i + 1).some(function (x) { return g.L.some(function (L) { return (x.camps[g.camp] || {})[g.num + L]; }); });
            if (!later && sq.src === 'SLA') g.L.forEach(function (L) {
              const k = g.camp + '|' + g.num + L + '>' + g.camp + '|';
              if (has[k] || seen[k]) return; seen[k] = 1;
              sug.push({ date: b.date, kind: RLK.END, fromCamp: g.camp, fromCode: g.num + L, toCamp: g.camp, toCode: '', src: sq.src, memo: sq.src + ' ' + String(b.p).slice(0, 10) + ' 부터 없음 · 이어받은 라우트 없음' });
            });
            return;
          }
          g.L.forEach(function (L) {
            const k = g.camp + '|' + g.num + L + '>' + cand[0].camp + '|' + cand[0].num + L;
            if (has[k] || seen[k]) return; seen[k] = 1;
            sug.push({ date: b.date, kind: RLK.MOVE, fromCamp: g.camp, fromCode: g.num + L, toCamp: cand[0].camp, toCode: cand[0].num + L, src: sq.src, memo: sq.src + ' ' + String(a.p).slice(0, 10) + ' → ' + String(b.p).slice(0, 10) + ' · 다른 캠프에 같은 구성이 새로 생김' });
          });
        });
      }
    });
    // 이미 변경이력이 있는 이전 라우트는 빼고, 그 결과 병합·분할 후보가 1:1 이 되면 개명으로 바꾼다
    const fromHas = {}; edges.forEach(function (e) { fromHas[e.fromCamp + '|' + e.fromCode] = 1; });
    const left = sug.filter(function (x) { return !fromHas[x.fromCamp + '|' + x.fromCode]; });
    const inCnt = {}, outCnt = {};
    left.forEach(function (x) { if (x.kind === RLK.END) return; const t = x.toCamp + '|' + x.toCode, f = x.fromCamp + '|' + x.fromCode; inCnt[t] = (inCnt[t] || 0) + 1; outCnt[f] = (outCnt[f] || 0) + 1; });
    left.forEach(function (x) { if ((x.kind === RLK.MERGE || x.kind === RLK.SPLIT) && inCnt[x.toCamp + '|' + x.toCode] === 1 && outCnt[x.fromCamp + '|' + x.fromCode] === 1) x.kind = x.fromCamp === x.toCamp ? RLK.RENAME : RLK.MOVE; });
    return { ok: true, suggestions: left };
  });
}

// ───────────────────────── 프레시백 가중요인 (쿠팡 Weekly·월간 '가중요인 해당여부' 파일 · route_fb) ─────────────────────────
// 가중요인1 = 누적 수행률(배송완료율) 95% 이상 → 공급가 14원/건 (부가세 포함 15원) · 가중요인2 = 누적 프레시백 회수율 75% 이상 → 공급가 9원/건 (10원)
// 둘 다 해당 = 23원(25원). 정산기간(전월 26일~당월 25일) 누적으로 정해지며 월간 파일이 확정값. 기준·단가는 설정(app_settings fbTh1/fbTh2/fbWon1/fbWon2)에서 바꿀 수 있다.
const FBK = { CUM: '누적', DAY: '일별', MONTH: '월간' };
function fbSettings_() {
  const a = appSet_();
  const n = function (k, d) { const v = Number(a[k]); return isNaN(v) || a[k] === '' || a[k] == null ? d : v; };
  return { th1: n('fbTh1', 95), th2: n('fbTh2', 75), won1: n('fbWon1', 14), won2: n('fbWon2', 9), drvOn: !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(a.fbDrvOn)) };
}
/** 날짜 → 그 날짜가 속한 정산기간의 끝(25일). 11/03 → 2026-11-25 · 10/25 → 2026-10-25 · 10/26 → 2026-11-25 */
function fbPeriodOf_(d) {
  const t = parseYmd_(d); if (!t) return '';
  const y = t.getFullYear(), m = t.getMonth(), day = t.getDate();
  const end = day <= 25 ? new Date(y, m, 25) : new Date(y, m + 1, 25);
  return ymd_(end);
}
function fbAll_() { let rows = []; try { rows = readAll_(SH.RFB).filter(function (o) { return o.key && o.code; }); } catch (e) { rows = []; } return rows; }
function fbYes_(v) { const s = str_(v).replace(/\s/g, ''); return s === '해당' || /^(y|yes|o|true)$/i.test(s) ? '해당' : s === '미해당' || /^(n|no|x|false)$/i.test(s) ? '미해당' : ''; }
function fbView_(o) {
  return { key: o.key, period: o.period, kind: o.kind, from: o.from, to: o.to, date: o.date, camp: o.camp, code: o.code,
    f1pct: o.f1pct === '' ? null : Number(o.f1pct), f1: o.f1, f2pct: o.f2pct === '' ? null : Number(o.f2pct), f2: o.f2, uploadedAt: o.uploadedAt };
}
/**
 * 관리자: 가중요인 파일 저장. p = { file, blocks: [{ kind: '누적'|'일별'|'월간', from, to, date, rows: [{ wave, camp, code, f1pct, f1, f2pct, f2 }] }] }
 *  누적: 정산기간마다 한 벌(기준일이 더 최신인 것만 덮어씀) · 일별: 날짜마다 · 월간: 정산기간마다 (확정)
 */
function adm_fbSave(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    if (!blocks.length) fail_('저장할 블록이 없습니다.');
    const file = str_(p.file).slice(0, 120), now = nowText_();
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const sh = sheet_(SH.RFB), c = cols_(SH.RFB, true);
      const cur = fbAll_(), byKey = {};
      cur.forEach(function (o) { byKey[o.key] = o; });
      const list = [];
      let cumTo = '', monthPeriod = '', skippedOld = 0;
      blocks.forEach(function (b) {
        const kind = b.kind === FBK.DAY ? FBK.DAY : b.kind === FBK.MONTH ? FBK.MONTH : FBK.CUM;
        const from = normDate_(b.from), to = normDate_(b.to), date = normDate_(b.date);
        const ref = kind === FBK.DAY ? date : to;
        if (!ref) return;
        const period = fbPeriodOf_(ref);
        if (kind === FBK.CUM) cumTo = cumTo < to ? to : cumTo;
        if (kind === FBK.MONTH) monthPeriod = period;
        (b.rows || []).forEach(function (r) {
          const camp = rpfCamp_(r.camp), code = rpfCode_(r.code || r.route); if (!camp || !code) return;
          const key = kind === FBK.DAY ? FBK.DAY + '|' + date + '|' + camp + '|' + code : period + '|' + kind + '|' + camp + '|' + code;
          list.push({ key: key, period: period, kind: kind, from: from || '', to: kind === FBK.DAY ? date : to, date: kind === FBK.DAY ? date : '', wave: str_(r.wave).slice(0, 10), camp: camp, code: code,
            f1pct: rpfPct_(r.f1pct), f1: fbYes_(r.f1), f2pct: rpfPct_(r.f2pct), f2: fbYes_(r.f2), file: file, uploadedAt: now, by: a.name });
        });
      });
      if (!list.length) fail_('저장할 줄이 없습니다. (캠프·라우트가 비어 있음)');
      const seen = {}, upd = [], add = []; let unchanged = 0;
      list.forEach(function (o) {
        if (seen[o.key]) return; seen[o.key] = 1;
        const old = byKey[o.key];
        if (old) {
          if (o.kind === FBK.CUM && str_(old.to) > o.to) { skippedOld++; return; } // 더 최신 기준일이 이미 있으면 옛 파일은 건너뜀
          if (['f1pct', 'f1', 'f2pct', 'f2', 'to', 'from'].every(function (k) { return str_(old[k]) === String(o[k]); })) { unchanged++; return; }
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
      let memo = null;
      if (perfMemoOn_()) {
        const main = list.filter(function (o) { return o.kind === (monthPeriod ? FBK.MONTH : FBK.CUM); });
        const none = main.filter(function (o) { return o.f1 === '미해당' && o.f2 === '미해당'; }).length, one = main.filter(function (o) { return (o.f1 === '미해당') !== (o.f2 === '미해당'); }).length;
        const title = monthPeriod ? Number(monthPeriod.slice(5, 7)) + '월 가중요인 확정 업로드' : '가중요인 업로드 (' + Number(cumTo.slice(5, 7)) + '/' + Number(cumTo.slice(8, 10)) + ' 기준)';
        memo = uploadMemo_(a, title, [none ? '둘 다 미해당 ' + none : '', one ? '하나 미해당 ' + one : ''].filter(Boolean).join(' · '), !!none);
      }
      logAdmin_(a, '가중요인 업로드', monthPeriod ? '월간 ~' + monthPeriod : '누적 ~' + cumTo, '새로 ' + add.length + ' · 바뀜 ' + upd.length + ' · 같음 ' + unchanged + (skippedOld ? ' · 옛 기준일 건너뜀 ' + skippedOld : '') + (file ? ' · ' + file : ''));
      return { ok: true, added: add.length, changed: upd.length, unchanged: unchanged, skippedOld: skippedOld, memo: memo };
    } finally { lock.releaseLock(); }
  });
}
/** 관리자: 가중요인 전체 — 누적(기간별 최신) · 최근 21일 일별 · 월간 확정 · 설정 · 라우트 물량 */
function adm_fbList(token) {
  return run_(function () {
    requireAdmin_(token);
    const ck = cache_(), key = 'fb:l:' + rpfVer_(), hit = ck.get(key);
    if (hit) { try { const o = JSON.parse(hit); o.set = fbSettings_(); return o; } catch (e) { /* 다시 */ } }
    const all = fbAll_().map(fbView_);
    const days = Object.keys(all.filter(function (o) { return o.kind === FBK.DAY; }).reduce(function (m, o) { m[o.date] = 1; return m; }, {})).sort().slice(-21);
    const dset = {}; days.forEach(function (d) { dset[d] = 1; });
    const periods = Object.keys(all.reduce(function (m, o) { m[o.period] = 1; return m; }, {})).sort();
    let vol = null; try { vol = routeVolumes_(); } catch (e) { vol = null; }
    const out = { ok: true, periods: periods, days: days, cum: all.filter(function (o) { return o.kind === FBK.CUM; }), day: all.filter(function (o) { return o.kind === FBK.DAY && dset[o.date]; }),
      month: all.filter(function (o) { return o.kind === FBK.MONTH; }), set: fbSettings_(), vol: vol && vol.vol ? vol.vol : {}, volMonths: vol ? vol.months : [], lineage: rlnEdges_() };
    try { const j = JSON.stringify(out); if (j.length < 95000) ck.put(key, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
/** 관리자: 가중요인 설정 (기준 % · 공급가 단가 · 기사 앱 표시) */
function adm_fbSet(token, f) {
  return run_(function () {
    const a = requireAdmin_(token);
    f = f || {};
    const num = function (k, label, lo, hi) { if (f[k] === undefined) return; const v = Number(f[k]); if (isNaN(v) || v < lo || v > hi) fail_(label + ' 값을 확인해 주세요. (' + lo + '~' + hi + ')'); appSetPut_('fb' + k.charAt(0).toUpperCase() + k.slice(1), String(v), '프레시백 가중요인 ' + label); logAdmin_(a, '가중요인 설정', label, String(v)); };
    num('th1', '요인1 기준 % (수행률)', 50, 120); num('th2', '요인2 기준 % (프레시백 회수율)', 10, 120);
    num('won1', '요인1 단가 (공급가, 원/건)', 0, 1000); num('won2', '요인2 단가 (공급가, 원/건)', 0, 1000);
    if (f.drvOn !== undefined) { appSetPut_('fbDrvOn', f.drvOn ? 'ON' : 'OFF', '기사 앱에 프레시백 가중요인 카드 (ON/OFF)'); logAdmin_(a, '가중요인 설정', '기사 앱 표시', f.drvOn ? 'ON' : 'OFF'); }
    rpfBump_();
    return { ok: true, set: fbSettings_() };
  });
}
/** 대시보드용 요약 (최신 누적 기간) */
function fbSummary_() {
  const all = fbAll_();
  const cum = all.filter(function (o) { return o.kind === FBK.CUM; });
  if (!cum.length) return null;
  const periods = Object.keys(cum.reduce(function (m, o) { m[o.period] = 1; return m; }, {})).sort(), lp = periods[periods.length - 1];
  const rows = cum.filter(function (o) { return o.period === lp; });
  return { period: lp, to: rows[0].to, routes: rows.length, both: rows.filter(function (o) { return o.f1 === '해당' && o.f2 === '해당'; }).length,
    none: rows.filter(function (o) { return o.f1 === '미해당' && o.f2 === '미해당'; }).length, f1: rows.filter(function (o) { return o.f1 === '해당'; }).length, f2: rows.filter(function (o) { return o.f2 === '해당'; }).length };
}
/**
 * 기사 앱: 내 라우트의 가중요인 (관리자가 켜 두었을 때만). 고정 = 기본노선 · 백업 = 최근 4주 뛴 라우트
 *  routes: [{ camp, code, cum:{to,f1pct,f1,f2pct,f2}, days:[{date,f1pct,f1,f2pct,f2}](최근 7일), month:{period,f1,f2}, won, est, vol }]
 */
function api_myFb(token) {
  return run_(function () {
    const u = pmUser_(token);
    const set = fbSettings_();
    if (!set.drvOn) return { ok: true, on: false, routes: [] };
    const ck = cache_(), key = 'myfb:' + u.id + ':' + rpfVer_(), hit = ck.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 */ } }
    const o = driverById_(u.id) || {};
    const camp = rpfCamp_(o.schCamp || ''), base = rpfBaseCodes_(o.baseRoute || '');
    const all = fbAll_().map(fbView_);
    const out = { ok: true, on: true, set: { th1: set.th1, th2: set.th2, won1: set.won1, won2: set.won2 }, routes: [] };
    if (!all.length) return out;
    const cum = all.filter(function (r) { return r.kind === FBK.CUM; }), periods = Object.keys(cum.reduce(function (m, r) { m[r.period] = 1; return m; }, {})).sort();
    const lp = periods[periods.length - 1] || '';
    const months = all.filter(function (r) { return r.kind === FBK.MONTH; }), mps = Object.keys(months.reduce(function (m, r) { m[r.period] = 1; return m; }, {})).sort();
    const dayList = Object.keys(all.filter(function (r) { return r.kind === FBK.DAY && (!lp || r.period === lp); }).reduce(function (m, r) { m[r.date] = 1; return m; }, {})).sort().slice(-7);
    let vol = {}, volMonths = []; try { const v = routeVolumes_(); vol = v.vol || {}; volMonths = v.months || []; } catch (e) { vol = {}; }
    const edges = rlnEdges_();
    const keysOf = function (cp, code) { return [cp + '|' + code].concat(rlnChain_(edges, cp, code).map(function (x) { return x.camp + '|' + x.code; })); };
    const pick = function (rows, keys) { return rows.filter(function (r) { return keys.indexOf(r.camp + '|' + r.code) >= 0; })[0] || null; };
    const mk = function (cp, code) {
      const keys = keysOf(cp, code);
      const c = lp ? pick(cum.filter(function (r) { return r.period === lp; }), keys) : null;
      if (!c) return null;
      const won = (c.f1 === '해당' ? set.won1 : 0) + (c.f2 === '해당' ? set.won2 : 0);
      const v = vol[cp + '|' + code], perMonthDays = v && volMonths.length ? Math.round(v.days / volMonths.length) : 0;
      const est = v ? Math.round(won * v.avg * perMonthDays) : null, estMax = v ? Math.round((set.won1 + set.won2) * v.avg * perMonthDays) : null;
      const mp = mps.filter(function (p) { return p < lp; }).pop() || '';
      const m = mp ? pick(months.filter(function (r) { return r.period === mp; }), keys) : null;
      return { camp: cp, code: code, period: lp, cum: { to: c.to, from: c.from, f1pct: c.f1pct, f1: c.f1, f2pct: c.f2pct, f2: c.f2 },
        days: dayList.map(function (d) { const r = pick(all.filter(function (x) { return x.kind === FBK.DAY && x.date === d; }), keys); return { date: d, f1: r ? r.f1 : '', f2: r ? r.f2 : '', f1pct: r ? r.f1pct : null, f2pct: r ? r.f2pct : null }; }),
        month: m ? { period: mp, f1: m.f1, f2: m.f2, won: (m.f1 === '해당' ? set.won1 : 0) + (m.f2 === '해당' ? set.won2 : 0) } : null,
        won: won, est: est, estMax: estMax, vol: v ? { avg: v.avg, days: perMonthDays } : null };
    };
    let codes = [];
    if (camp && base.length) codes = base.map(function (c) { return { camp: camp, code: c }; });
    else try {
      const today = parseYmd_(todayText_()), rec = {};
      const s = schRead_(sundayOf_(addDays_(today, -27)), today);
      const cells = s.cells[u.id] || {}, campShorts = (s.camps || []).map(function (c) { return rpfCamp_(c.name); });
      Object.keys(cells).forEach(function (d) {
        const v = String(cells[d] || '').toUpperCase();
        if (!v || /휴무|휴가|병가|미입차|비고/.test(v)) return;
        let cp = camp;
        campShorts.forEach(function (c) { if (c && v.indexOf(c.toUpperCase()) >= 0) cp = c; });
        rpfBaseCodes_(v.replace(/[^0-9A-Z가-힣,\s/]/g, ' ')).forEach(function (code) { if (!/^\d/.test(code)) return; const k = cp + '|' + code; rec[k] = rec[k] || { camp: cp, code: code, days: 0 }; rec[k].days++; });
      });
      codes = Object.keys(rec).map(function (k) { return rec[k]; }).sort(function (a, b) { return b.days - a.days; }).slice(0, 6);
    } catch (e) { codes = []; }
    out.routes = codes.map(function (x) { return mk(x.camp, x.code); }).filter(Boolean);
    out.backup = !base.length;
    try { const j = JSON.stringify(out); if (j.length < 90000) ck.put(key, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
