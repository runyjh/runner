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
    const out = { ok: true, weeks: weeks.reverse(), rows: rows, totalWeeks: Object.keys(all.reduce(function (m, o) { m[o.week] = 1; return m; }, {})).length, drvOn: perfDrvOn_(), memoOn: perfMemoOn_() };
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

/** 기사 앱: 내 기본노선 라우트의 최근 8주 등급 (관리자가 켜 두었을 때만) */
function api_myPerf(token) {
  return run_(function () {
    const u = pmUser_(token);
    if (!perfDrvOn_()) return { ok: true, on: false, routes: [] };
    const o = driverById_(u.id) || {};
    const camp = rpfCamp_(o.schCamp || '');
    const codes = rpfBaseCodes_(o.baseRoute || '');
    if (!camp || !codes.length) return { ok: true, on: true, camp: camp, routes: [], weeks: [] };
    const all = rpfAll_().filter(function (r) { return r.camp === camp && codes.indexOf(r.code) >= 0; });
    const weeks = Object.keys(all.reduce(function (m, r) { m[r.week] = 1; return m; }, {})).sort().slice(-8);
    const routes = codes.map(function (code) {
      const mine = all.filter(function (r) { return r.code === code && weeks.indexOf(r.week) >= 0; });
      return { code: code, weeks: weeks.map(function (w) { const r = mine.filter(function (x) { return x.week === w; })[0]; return r ? { wk: r.wk, from: r.from, to: r.to, perf: r.perf === '' ? null : Number(r.perf), grade: r.grade ? Number(r.grade) : null, improve: r.improve === 'Y' } : { wk: 'WK' + Number(w.slice(6)), perf: null, grade: null }; }) };
    }).filter(function (r) { return r.weeks.some(function (w) { return w.grade; }); });
    return { ok: true, on: true, camp: camp, routes: routes, weeks: weeks };
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
