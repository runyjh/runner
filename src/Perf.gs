/**
 * 속도 측정 (화면별 서버 호출 횟수 · 걸리는 시간)
 *  - 모든 서버 함수(run_)는 결과에 서버 처리 시간 _ms 를 붙인다.
 *  - 관리자 앱 · 기사 앱은 호출마다 [화면, 함수, 왕복 시간, 서버 시간]을 모아 1분마다 perf_log 탭에 한 줄씩(화면·함수별 합계) 보낸다.
 *  - 관리자 [⏱ 속도 측정 → 지금 측정]: 화면을 열 때 부르는 함수를 차례로 실제 호출해 왕복 시간을 잰다.
 *    기사 앱 함수는 관리자가 대신 부른다 (adm_perfDrv: 이 실행 안에서만 쓰는 임시 세션 · 결과 내용은 돌려주지 않음).
 */
// perf_log 탭 열 정의(PF)는 Code.gs (파일 읽는 순서와 상관없게)

/** 측정용 임시 세션: 이 실행 안에서만 (무작위 글자 · 화면에서 맞힐 수 없음) */
var PERF_BENCH_ = null;

/** 같은 묶음 번호를 10분 안에 또 받았으면 true (두 번 적지 않게) */
function perfSeen_(bid) {
  const b = str_(bid).replace(/[^\w]/g, '').slice(0, 24);
  if (!b) return false;
  try { const c = cache_(), k = 'pfb:' + b; if (c.get(k)) return true; c.put(k, '1', 600); } catch (e) { /* 캐시가 안 되면 그냥 적는다 */ }
  return false;
}
function perfRows_(rows, app, who) {
  if (!Array.isArray(rows)) return 0;
  const now = nowText_();
  const out = rows.slice(0, 120).map(function (r) {
    return { at: now, app: app, view: str_(r && r.v).slice(0, 40), fn: str_(r && r.f).replace(/[^\w]/g, '').slice(0, 40),
      n: Math.max(0, Math.min(9999, Math.round(+r.n || 0))), rt: Math.max(0, Math.round(+r.rt || 0)), rtMax: Math.max(0, Math.round(+r.mx || 0)),
      srv: Math.max(0, Math.round(+r.sv || 0)), who: str_(who).slice(0, 40), upd: str_(r && r.u).replace(/[^\d]/g, '').slice(0, 6) };
  }).filter(function (o) { return o.fn && o.n; });
  if (!out.length) return 0;
  const c = cols_(SH.PERF, true), sh = sheet_(SH.PERF);
  const r = sh.getLastRow() + 1;
  if (r > 30000) { console.warn('perf_log 가 3만 줄을 넘어 더 기록하지 않습니다 (지우면 다시 기록).'); return 0; } // 시트가 끝없이 커지지 않게
  // 글자는 글자 서식(@)으로 · '=' '+' 로 시작하면 앞에 공백 (시트 수식으로 실행되지 않게)
  const vals = out.map(function (o) { const a = new Array(c.__w).fill(''); Object.keys(o).forEach(function (k) { a[c[k]] = typeof o[k] === 'string' ? safeText_(o[k]) : o[k]; }); return a; });
  if (r + vals.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, vals.length));
  sh.getRange(r, 1, vals.length, c.__w).setNumberFormat('@').setValues(vals);
  return out.length;
}
/** 기사 앱: 측정값 보내기 (로그인한 기사만 · 기사 이름은 남기지 않음) */
/** 오류 내용 다듬기: 길이 300자 · 긴 숫자열(전화·주민·계좌일 수 있음)과 메일 주소는 가린다 */
function errClean_(m) { return str_(m).replace(/[\w.+-]+@[\w.-]+/g, '(메일)').replace(/\d[\d\s-]{5,}\d/g, '#').replace(/\s+/g, ' ').slice(0, 300); }
/**
 * 오류 기록 한 줄 (error_log 탭). 절대 예외를 내지 않는다 — 기록이 실패해도 원래 기능에는 영향이 없어야 한다.
 *  · 같은 (종류·함수·내용)은 10분에 한 번만 적는다 (같은 오류가 몰려도 탭이 불어나지 않게) · 5천 줄이 넘으면 더 적지 않는다
 *  kind: '서버 오류' · '저장 충돌' · '화면 오류' · '시간 초과' · '응답 오류'
 */
function errLog_(kind, fn, msg, x) {
  try {
    x = x || {};
    const m = errClean_(msg), f = str_(fn).replace(/[^\w]/g, '').slice(0, 40), k = str_(kind).slice(0, 10);
    if (!k || (!f && !m)) return;
    const c = cache_(), ck = 'el:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, k + '|' + f + '|' + m, Utilities.Charset.UTF_8)).slice(0, 20);
    if (c.get(ck)) return;
    c.put(ck, '1', 600);
    const cols = cols_(SH.ERR), sh = sheet_(SH.ERR);
    if (sh.getLastRow() > 5000) return;
    const o = { at: nowText_(), app: str_(x.app).slice(0, 10) || '서버', kind: k, view: str_(x.view).slice(0, 40), fn: f, msg: m, upd: str_(x.upd).replace(/[^\d]/g, '').slice(0, 6), who: str_(x.who).slice(0, 40) };
    const a = new Array(cols.__w).fill('');
    Object.keys(o).forEach(function (key) { if (cols[key] !== undefined) a[cols[key]] = safeText_(o[key]); });
    sh.appendRow(a); // 동시에 여러 실행이 적어도 줄이 겹치지 않는다
    try { if (!c.get('el:mir')) { c.put('el:mir', '1', 1800); maintMirror_(); } } catch (e2) { /* 사본은 다음 기회에 */ }
  } catch (e) { try { console.error('오류 기록 실패: ' + (e && e.message)); } catch (x2) { /* 무시 */ } }
}
/** 기능은 계속되지만 한 부분이 실패한 경우 (연동 · 알림 · 사본 복사 …): 실행 기록에 찍고 오류 기록(error_log)에도 '연동 실패'로 남긴다. 절대 예외를 내지 않는다 */
function softFail_(label, e) {
  const msg = String(e && e.message || e || '');
  try { console.error(label + ': ' + msg); } catch (x) { /* 무시 */ }
  try { errLog_('연동 실패', (typeof _curFn !== 'undefined' && _curFn) || '', label + ': ' + msg); } catch (x) { /* 무시 */ }
}
/**
 * 유지보수용 사본: 오류 기록(최근 14일 · 같은 오류는 한 줄로 묶음)과 자료 점검 결과를 스케줄 DB 의 maint_errors · maint_check 탭에 적는다.
 *  개발 쪽(Claude)이 읽을 수 있는 파일은 스케줄 DB 라서 여기로 복사한다. 사람 이름(누가)은 넣지 않는다 · 내용은 이미 메일·전화번호를 지운 글.
 *  절대 예외를 내지 않는다.
 */
function maintMirror_() {
  try {
    if (!props_().SCH_DB_ID) return 0;
    const book = schSS_(), now = nowText_();
    const put = function (name, head, rows) {
      let sh = book.getSheetByName(name);
      if (!sh) sh = book.insertSheet(name);
      sh.clearContents();
      const all = [head].concat(rows.length ? rows : [head.map(function () { return ''; })]);
      sh.getRange(1, 1, all.length, head.length).setValues(all);
    };
    const cut = Utilities.formatDate(new Date(Date.now() - 14 * 864e5), CFG.TZ, 'yyyy-MM-dd'), by = {};
    readAll_(SH.ERR).forEach(function (r) {
      const at = str_(r.at); if (!at || at.slice(0, 10) < cut) return;
      const k = [r.app, r.kind, r.view, r.fn, r.msg].join('|');
      const o = by[k] || (by[k] = { first: at, last: at, app: str_(r.app), kind: str_(r.kind), view: str_(r.view), fn: str_(r.fn), msg: str_(r.msg), n: 0, u0: str_(r.upd), u1: str_(r.upd) });
      o.n++; if (at < o.first) { o.first = at; o.u0 = str_(r.upd) || o.u0; } if (at >= o.last) { o.last = at; o.u1 = str_(r.upd) || o.u1; }
    });
    const list = Object.keys(by).map(function (k) { return by[k]; }).sort(function (p, q) { return p.last < q.last ? 1 : -1; }).slice(0, 400);
    put('maint_errors', ['마지막', '처음', '앱', '종류', '화면', '함수', '내용', '횟수(10분에 1번까지)', '처음 업데이트', '마지막 업데이트', '복사 시각'],
      list.map(function (o, i) { return [o.last, o.first, o.app, o.kind, o.view, o.fn, safeText_(o.msg), o.n, o.u0, o.u1, i ? '' : now]; }));
    let dc = {}; try { dc = JSON.parse(appSet_().dataCheck || '{}'); } catch (e) { dc = {}; }
    const rows = [];
    (dc.items || []).forEach(function (x) { (x.list && x.list.length ? x.list : ['']).forEach(function (t, i) { rows.push([i ? '' : str_(dc.at), i ? '' : x.k, i ? '' : x.label, i ? '' : x.n, safeText_(t), i ? '' : x.hint || '']); }); });
    if (!rows.length) rows.push([str_(dc.at), '', '이상 없음', 0, '', '']);
    put('maint_check', ['확인 시각', '열쇠', '항목', '건수', '내용', '안내'], rows);
    return list.length;
  } catch (e) { try { console.error('유지보수 사본 실패: ' + (e && e.message)); } catch (x) { /* 무시 */ } return -1; }
}
/** 관리자: 자료 점검을 지금 다시 하고 유지보수 사본도 새로 만든다 → { ok, check } */
function adm_maintSync(token) {
  return run_(function () {
    requireAdmin_(token);
    const res = dataCheck_();
    const n = maintMirror_();
    return { ok: true, check: res, mirrored: n };
  });
}

/**
 * 실제 자료 자체 검사 (읽기만 · 아무것도 고치지 않음). 범위: 7일 전 ~ 14일 뒤 (올인원 규칙 시작일 이후).
 *  ⑥ 배차 확정 품앗이가 기사스케줄 품앗이 줄 칸에 없음   ⑦ 연동 이슈가 있는 날인데 칸이 그 이슈와 다름   ⑧ 이번 달·지난달 정산 계산이 오류 없이 끝나고 금액에 숫자가 아닌 값이 없는지
 */
function dataCheckLive_(drivers, today) {
  const out = [], day = function (d) { return d.slice(5).replace('-', '/'); };
  const from0 = schAddDays_(today, -7), from = from0 < ISS.RULE_FROM ? ISS.RULE_FROM : from0, to = schAddDays_(today, 14);
  if (props_().SCH_DB_ID && from <= to) {
    const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
    const dates = issDates_(from, to).filter(function (d) { return h.dates[d] !== undefined; });
    if (dates.length && last >= 2) {
      const cs = dates.map(function (d) { return h.dates[d]; }), c0 = Math.min.apply(null, cs), c1 = Math.max.apply(null, cs);
      const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues(), block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
      const cells = {};
      ids.forEach(function (r, i) { const id = str_(r[0]); if (!id || cells[id]) return; const row = cells[id] = {}; dates.forEach(function (d) { row[d] = str_(block[i][h.dates[d] - c0]).replace(/\r\n?/g, '\n'); }); });
      // ⑥ 확정 품앗이 ↔ 칸
      const a6 = [], L = pmSchLocks_(dates);
      Object.keys(L).forEach(function (rid) { Object.keys(L[rid]).forEach(function (d) {
        const lines = String((cells[rid] || {})[d] || '').split('\n').map(function (v) { return v.trim(); });
        L[rid][d].forEach(function (o) { if (!lines.some(function (v) { return v.indexOf(o.text) === 0; })) a6.push(day(d) + ' ' + o.to + ' · ' + o.text); });
      }); });
      if (a6.length) out.push({ k: 'pmCell', label: '확정 품앗이가 기사스케줄 품앗이 줄에 없음', list: a6, hint: '기사스케줄에서 그 주를 한 번 열면 자동으로 다시 채워집니다. 계속 남으면 알려 주세요.' });
      // ⑦ 이슈 ↔ 칸 (칸 → 이슈 연동과 같은 기준: 칸이 이슈가 넣는 글자이거나, 칸 글자가 같은 결과로 읽히면 맞는 것)
      const byId = {}; drivers.forEach(function (o) { byId[o.id] = o; });
      const ctxOf = issCtxMaker_(), a7 = [];
      schIssues_(from, to).forEach(function (x) {
        const o = byId[x.driverId];
        if (!o || x.link === 'N' || !x.result || x.kind === '지시') return;
        issDates_(x.date < from ? from : x.date, (x.end || x.date) > to ? to : (x.end || x.date)).forEach(function (d) {
          if (!cells[o.id] || cells[o.id][d] === undefined) return;
          const cell = cells[o.id][d], ctx = ctxOf(o, d);
          const expect = issCellFor_(x, (x.orig || {}).hasOwnProperty(d) ? x.orig[d] : '', ctx);
          if (expect === null || expect === cell) return;
          const cls = issClassify_(cell, ctx.base, ctx.rots, ctx.camp);
          if (cls && cls.result === x.result && (cls.result !== '물량조율' || cls.cut === x.cut)) return;
          a7.push(day(d) + ' ' + o.name + ' · 이슈 ' + x.result + (x.cut ? ' ' + x.cut : '') + ' ↔ 칸 ' + (cell || '(빈칸)'));
        });
      });
      if (a7.length) out.push({ k: 'issCell', label: '이슈와 기사스케줄 칸이 다름', list: a7, hint: '이슈 관리와 기사스케줄 중 맞는 쪽을 기준으로 다른 쪽을 고쳐 주세요.' });
    }
  }
  // ⑧ 정산 계산 (이번 달 · 지난달)
  if (typeof stlCompute_ === 'function') {
    const a8 = [], lastM = Utilities.formatDate(new Date(parseYmd_(today.slice(0, 8) + '01').getTime() - 864e5), CFG.TZ, 'yyyy-MM');
    [today.slice(0, 7), lastM].forEach(function (m) {
      try {
        const s = stlCompute_(m).summary, bad = [];
        (s.drivers || []).forEach(function (d) { ['net', 'invoice', 'pay', 'supply'].forEach(function (k) { if (d[k] !== undefined && d[k] !== null && d[k] !== '' && !isFinite(Number(d[k]))) bad.push(d.name + ' ' + k); }); });
        Object.keys(s.total || {}).forEach(function (k) { if (typeof s.total[k] === 'number' && !isFinite(s.total[k])) bad.push('합계 ' + k); });
        if (bad.length) a8.push(m + ' 금액이 숫자가 아님: ' + bad.slice(0, 8).join(', '));
      } catch (e) { a8.push(m + ' 계산 오류: ' + String(e && e.message || e).slice(0, 160)); }
    });
    if (a8.length) out.push({ k: 'stlRun', label: '정산 계산이 정상으로 끝나지 않음', list: a8, hint: '프로그램 쪽 문제입니다. 개발 쪽에 알려 주세요.' });
  }
  const soft = function (k, fn) { try { fn(); } catch (e) { out.push({ k: k, label: '점검 항목을 끝내지 못함 (' + k + ')', list: [String(e && e.message || e).slice(0, 200)], hint: '프로그램 쪽 문제입니다. 개발 쪽에 알려 주세요.' }); } };
  // ⑨ 노선 이관 적용일 뒤에 옛 번호가 남음 (건너뛴 기사 · 칸에 적힌 옛 번호)
  soft('moveLeft', function () {
    if (typeof rcMoveFix_ !== 'function') return;
    const virt = { base: {}, cell: {} }, a9 = [], sc = function (n) { return str_(n).replace(/\s*캠프\s*$/, ''); };
    rcRows_().filter(function (c) { return c.kind === RCK.MOVE && c.date; }).sort(rcSort_).forEach(function (mv) {
      const r = rcMoveFix_(null, mv, true, false, virt), lab = sc(mv.fromCamp) + ' ' + mv.fromRoute + '→' + sc(mv.toCamp) + ' ' + mv.toRoute;
      r.drivers.forEach(function (d) { a9.push(lab + ' · 기사 ' + d.name + ' ' + d.from); });
      r.cells.slice(0, 20).forEach(function (c) { a9.push(lab + ' · ' + day(c.date) + ' ' + c.name + ' ' + c.old.replace(/\n/g, ' ')); });
      if (r.cells.length > 20) a9.push(lab + ' · 칸 ' + (r.cells.length - 20) + '개 더');
    });
    if (a9.length) out.push({ k: 'moveLeft', label: '노선 이관 뒤 옛 번호가 남아 있음', list: a9, hint: '기사스케줄 위쪽 [🔀 이관 뒤 옛 번호 … 맞추기]를 누르면 한 번에 맞춰집니다.' });
  });
  // ⑩⑪ 기사스케줄 칸으로 보는 것: 품앗이로 맡긴 날 맡긴 기사도 출근 · 예약 없이 칸에 '변경'만 적힘
  soft('cells2', function () {
    if (!props_().SCH_DB_ID || from > to) return;
    const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
    const dates = issDates_(from, to).filter(function (d) { return h.dates[d] !== undefined; });
    if (!dates.length || last < 2) return;
    const cs = dates.map(function (d) { return h.dates[d]; }), c0 = Math.min.apply(null, cs), c1 = Math.max.apply(null, cs);
    const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues(), block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
    const cell = {}, byId = {};
    drivers.forEach(function (o) { byId[o.id] = o; });
    ids.forEach(function (r, i) { const id = str_(r[0]); if (!id || cell[id]) return; const row = cell[id] = {}; dates.forEach(function (d) { row[d] = str_(block[i][h.dates[d] - c0]); }); });
    const a10 = [];
    pmData_().jobs.forEach(function (j) {
      if (j.status !== PST.DONE || !j.posterId || !j.acceptedId || !cell[j.posterId] || cell[j.posterId][j.date] === undefined) return;
      if (schWorkDay_(cell[j.posterId][j.date], [])) a10.push(day(j.date) + ' ' + (j.poster || '') + ' → ' + (j.accepted || '') + ' · ' + str_(j.camp).replace(/\s*캠프$/, '') + ' ' + str_(j.route) + ' (맡긴 기사 칸: ' + cell[j.posterId][j.date].replace(/\n/g, ' ') + ')');
    });
    if (a10.length) out.push({ k: 'pmBoth', label: '품앗이로 맡긴 날인데 맡긴 기사도 출근', list: a10, hint: '맡긴 기사가 직접 뛰면 그 칸을 눌러 [품앗이 취소하고 출근으로], 품앗이가 맞으면 맡긴 기사 칸을 휴무로 바꿔 주세요.' });
    const by = rcByDriver_(), a11 = [];
    Object.keys(cell).forEach(function (id) {
      const o = byId[id]; if (!o || !/^\d/.test(str_(o.baseRoute))) return; // 고정 노선 기사만 (백업은 그날 뛸 노선을 적은 것)
      dates.forEach(function (d) {
        const v = cell[id][d];
        if (!v || !/변경/.test(v) || !/\d{3,4}[A-Za-z]/.test(v)) return;
        if ((by[id] || []).some(function (c) { return Math.abs((parseYmd_(c.date) - parseYmd_(d)) / 864e5) <= 1; })) return;
        a11.push(day(d) + ' ' + o.name + ' · ' + v.replace(/\n/g, ' ') + ' (기본노선 ' + (o.baseRoute || '-') + ')');
      });
    });
    if (a11.length) out.push({ k: 'chgNoRc', label: "칸에 '변경'만 적혀 있고 노선 변경 예약이 없음", list: a11, hint: "그 날부터 기본노선이 바뀌는 것이면 칸을 눌러 [이 날부터 노선 이관] 또는 기사 설정의 노선 변경 예약으로 등록해 주세요. 안 하면 그 뒤 '출근'이 옛 노선으로 계산됩니다." });
  });
  return out;
}
/** 화면이 보낸 오류 목록 [{ k: 종류, v: 화면, f: 함수, m: 내용, u: 업데이트 }] (한 번에 10건까지) */
function errRows_(errs, app, who) {
  if (!Array.isArray(errs)) return;
  const KIND = { client: '화면 오류', timeout: '시간 초과', badresp: '응답 오류', pushdiag: '알림 상태' };
  errs.slice(0, 10).forEach(function (e) { if (e && KIND[e.k]) errLog_(KIND[e.k], e.f, e.m, { app: app, view: e.v, upd: e.u, who: who }); });
}
/**
 * 매일 새벽: 7일 지난 속도 기록(perf_log)을 날짜·앱·함수별 합계(perf_daily)로 줄여 남기고 상세 줄은 지운다 · 60일 지난 오류 기록도 지운다.
 * perf_log 는 시간순으로 쌓이므로 위에서부터 기준일 이전인 줄만 한 덩어리로 지운다 (요약을 먼저 적고 나서 지움 — 중간에 실패하면 상세가 남는다).
 */
function perfRollup_() {
  const lock = scriptLock_();
  if (!lock.tryLock(5000)) return;
  try {
    const cut = Utilities.formatDate(new Date(Date.now() - 7 * 864e5), CFG.TZ, 'yyyy-MM-dd') + ' 00:00:00';
    const rows = readAll_(SH.PERF);
    let n = 0;
    while (n < rows.length && rows[n].at && str_(rows[n].at) < cut) n++;
    if (n) {
      const by = {};
      rows.slice(0, n).forEach(function (r) {
        const k = str_(r.at).slice(0, 10) + '|' + r.app + '|' + r.fn, o = by[k] || (by[k] = { day: str_(r.at).slice(0, 10), app: r.app, fn: r.fn, n: 0, rt: 0, rtMax: 0, srv: 0 });
        o.n += +r.n || 0; o.rt += +r.rt || 0; o.srv += +r.srv || 0; o.rtMax = Math.max(o.rtMax, +r.rtMax || 0);
      });
      appendObjs_(SH.PDAY, Object.keys(by).sort().map(function (k) { return by[k]; }));
      SpreadsheetApp.flush();
      sheet_(SH.PERF).deleteRows(2, n);
    }
    const cut2 = Utilities.formatDate(new Date(Date.now() - 60 * 864e5), CFG.TZ, 'yyyy-MM-dd');
    const er = readAll_(SH.ERR);
    let m = 0;
    while (m < er.length && er[m].at && str_(er[m].at).slice(0, 10) < cut2) m++;
    if (m) sheet_(SH.ERR).deleteRows(2, m);
  } finally { lock.releaseLock(); }
}
/**
 * 매일 새벽 자료 점검 (읽기만 함 · 아무것도 고치지 않는다). 결과는 app_settings 의 dataCheck 에 적어 두고 관리자 앱 대시보드가 보여 준다.
 *  ① 기본노선이 노선관리에 없음  ② 사용 중 노선인데 단가 없음  ③ 승인 기사인데 쿠팡 아이디 없음  ④ 앞으로 할 확정 품앗이의 받은 기사가 퇴사·정지  ⑤ 어제 오류 기록
 */
function dataCheck_() {
  const items = [], add = function (k, label, list, hint) { if (list.length) items.push({ k: k, label: label, n: list.length, list: list.slice(0, 30), hint: hint || '' }); };
  const m = master_(), campName = {}, today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  m.camps.forEach(function (c) { campName[c.id] = String(c.name || '').replace(/\s*캠프$/, ''); });
  const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id; });
  const working = function (o) { return o.status === ST.ACTIVE && str_(o.workStatus) !== '퇴사' && str_(o.workStatus) !== '휴직'; };
  const on = {}, anyRoute = {}, priced = {};
  m.routes.forEach(function (r) { anyRoute[r.campId] = 1; if (r.status === RST.ON) on[r.campId + '|' + r.g1] = 1; });
  const money = function (v) { return Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')) || 0; };
  m.prices.forEach(function (p) { if (money(p.p2) > 0 || money(p.p3) > 0) priced[p.campId + '|' + p.num] = 1; });
  // ① 기본노선의 숫자가 그 캠프 노선관리(사용)에 없음 (노선을 하나도 등록하지 않은 캠프는 건너뜀)
  const a1 = [];
  drivers.forEach(function (o) {
    if (!working(o) || !o.schCampId || !anyRoute[o.schCampId] || !str_(o.baseRoute)) return;
    const u = rcUnits_(o.baseRoute); if (u.special) return;
    const miss = {};
    u.units.forEach(function (x) { if (!on[o.schCampId + '|' + x.num]) miss[x.num] = 1; });
    if (Object.keys(miss).length) a1.push(o.name + ' · ' + (campName[o.schCampId] || '') + ' ' + Object.keys(miss).join(', '));
  });
  add('base', '기본노선이 노선관리에 없음 (정지됐거나 없는 노선)', a1, '기사 정보관리에서 기본노선을 고치거나, 노선관리에 노선을 등록하세요.');
  // ② 사용 중 노선인데 고정·백업 단가가 하나도 없음 → 정산 때 0원으로 계산됨
  const a2 = [], seen = {};
  m.routes.forEach(function (r) { const k = r.campId + '|' + r.g1; if (r.status !== RST.ON || priced[k] || seen[k]) return; seen[k] = 1; a2.push((campName[r.campId] || '') + ' ' + r.g1); });
  add('price', '사용 중 노선인데 단가 없음', a2.sort(), '노선관리 → 노선 단가에서 고정·백업 단가를 넣으세요. 없으면 정산이 0원으로 계산됩니다.');
  // ③ 승인·재직 기사인데 쿠팡 아이디가 없음 (직원 제외) → 정산서에 실적이 붙지 않음
  add('login', '승인 기사인데 쿠팡 아이디 없음', drivers.filter(function (o) { return working(o) && !isStaff_(o) && !str_(o.loginId); }).map(function (o) { return o.name; }), '기사 정보관리에서 쿠팡플렉스 아이디를 넣으세요.');
  // ④ 오늘 이후 확정 품앗이인데 받은 기사가 퇴사·휴직·정지·삭제
  const byId = {}; drivers.forEach(function (o) { byId[o.id] = o; });
  const a4 = [];
  try { pmData_().jobs.forEach(function (j) { if (j.status !== PST.DONE || !j.acceptedId || !(j.date >= today)) return; const o = byId[j.acceptedId]; if (!o || !working(o)) a4.push(j.date.slice(5) + ' ' + str_(j.camp).replace(/\s*캠프$/, '') + ' ' + str_(j.route) + ' → ' + (j.accepted || '?')); }); } catch (e) { /* 품앗이 탭 없음 */ }
  add('pm', '확정 품앗이의 받은 기사가 퇴사·휴직·정지', a4, '품앗이 관리에서 그 일감을 다른 기사에게 다시 맡기세요.');
  // ⑤ 어제 0시부터 지금까지 오류 기록 (종류별 건수)
  try {
    const y = Utilities.formatDate(new Date(Date.now() - 864e5), CFG.TZ, 'yyyy-MM-dd'), cnt = {};
    readAll_(SH.ERR).forEach(function (r) { if (str_(r.at).slice(0, 10) >= y) { const k = r.kind + (r.fn ? ' · ' + r.fn : ''); cnt[k] = (cnt[k] || 0) + 1; } });
    add('err', '어제부터 기록된 오류', Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).map(function (k) { return k + ' ' + cnt[k] + '건'; }), '자세한 내용은 error_log 탭에 있습니다.');
  } catch (e) { /* 탭 없음 */ }
  // ⑥⑦⑧ 실제 자료로 하는 자체 검사 (운영 자료를 읽기만 함): 확정 품앗이 ↔ 칸 · 이슈 ↔ 칸 · 정산 계산이 끝까지 도는지
  try { dataCheckLive_(drivers, today).forEach(function (x) { add(x.k, x.label, x.list, x.hint); }); }
  catch (e) { add('live', '자체 검사를 끝내지 못함', [String(e && e.message || e).slice(0, 200)], '프로그램 쪽 문제입니다. 개발 쪽에 알려 주세요.'); }
  const res = { at: nowText_(), items: items };
  appSetPut_('dataCheck', JSON.stringify(res), '매일 새벽 자료 점검 결과 (자동 · 지워도 다음 날 다시 만들어짐)');
  return res;
}
function api_perf(token, rows, bid, errs) {
  return run_(function () {
    const s = getSession_(token);
    if (!s) return { ok: true, n: 0 };
    if (perfSeen_(bid)) return { ok: true, n: 0, dup: true };
    errRows_(errs, '기사앱', '');
    // 한 기기에서 1분에 3번까지만 (앱은 1분에 1번 보냄 · 마구 보내 시트를 키우지 못하게)
    const k = 'pf:' + s.th, c = cache_(), n = +(c.get(k) || 0);
    if (n >= 3) return { ok: true, n: 0 };
    c.put(k, String(n + 1), 60);
    return { ok: true, n: perfRows_(rows, '기사앱', '') };
  });
}
/** 관리자 앱: 측정값 보내기 */
function adm_perf(token, rows, bench, bid, errs) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (perfSeen_(bid)) return { ok: true, n: 0, dup: true };
    errRows_(errs, '관리자앱', a.name);
    return { ok: true, n: perfRows_(rows, bench ? '측정' : '관리자앱', a.name) };
  });
}
/** 측정용: 기사 앱 화면 함수를 관리자가 대신 부른다 (처리 시간만 돌려줌) */
const PERF_DRV_FNS = ['api_checkSession', 'api_notices', 'api_bdRecent', 'api_pmAlerts', 'api_mySchedule', 'api_campSchedule', 'api_mySettle', 'api_mySlip', 'api_pmList', 'api_pmAvailList', 'api_pmMine', 'api_myInfo', 'api_bdList'];
function adm_perfDrv(token, fn, args, driverId) {
  return run_(function () {
    requireAdmin_(token);
    if (PERF_DRV_FNS.indexOf(fn) < 0) fail_('측정할 수 없는 함수입니다.');
    let d = driverId ? driverById_(driverId) : null;
    if (!d) d = readAll_(SH.DRIVERS).filter(function (o) { return o.status === ST.ACTIVE && o.loginId && !mustChange_(o) && o.workStatus !== '퇴사'; })[0];
    if (!d) fail_('측정에 쓸 승인된 기사가 없습니다.');
    PERF_BENCH_ = { tok: Utilities.getUuid() + Utilities.getUuid(), s: { d: String(d.id), c: Date.now(), e: Date.now() + 60000, a: 0, th: 'bench' } };
    const t0 = Date.now();
    let r;
    const F = { api_checkSession: api_checkSession, api_notices: api_notices, api_bdRecent: api_bdRecent, api_pmAlerts: api_pmAlerts, api_mySchedule: api_mySchedule,
      api_campSchedule: api_campSchedule, api_mySettle: api_mySettle, api_mySlip: api_mySlip, api_pmList: api_pmList, api_pmAvailList: api_pmAvailList,
      api_pmMine: api_pmMine, api_myInfo: api_myInfo, api_bdList: api_bdList };
    try { r = F[fn].apply(null, [PERF_BENCH_.tok].concat(Array.isArray(args) ? args : [])); } finally { PERF_BENCH_ = null; }
    const ms = Date.now() - t0;
    let size = 0;
    try { size = JSON.stringify(r).length; } catch (e) { size = 0; }
    return { ok: true, fnOk: !!(r && r.ok), ms: ms, size: size, driver: d.name };
  });
}
/** 측정 결과 모아 보기: 최근 N일 화면·함수별 (횟수/일 · 평균 왕복 · 평균 서버) */
function adm_perfStats(token, days) {
  return run_(function () {
    requireAdmin_(token);
    days = Math.max(1, Math.min(30, +days || 7));
    const from = Utilities.formatDate(new Date(Date.now() - days * 864e5), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    let rows = [];
    try { rows = readAll_(SH.PERF); } catch (e) { rows = []; }
    const by = {}, dayset = {};
    rows.forEach(function (r) {
      const at = str_(r.at); if (!at || at < from || /^(st_|idb_)/.test(r.fn)) return; // st_ = 단계별 시간 · idb_ = 사진 보관함 진단 (분석용 줄이라 화면 목록에서는 뺌)
      dayset[at.slice(0, 10)] = 1;
      const k = r.app + '|' + r.view + '|' + r.fn, o = by[k] || (by[k] = { app: r.app, view: r.view, fn: r.fn, n: 0, rt: 0, mx: 0, srv: 0, last: '' });
      o.n += +r.n || 0; o.rt += +r.rt || 0; o.srv += +r.srv || 0; o.mx = Math.max(o.mx, +r.rtMax || 0); if (at > o.last) o.last = at;
    });
    const list = Object.keys(by).map(function (k) { const o = by[k]; return { app: o.app, view: o.view, fn: o.fn, n: o.n, avg: o.n ? Math.round(o.rt / o.n) : 0, srv: o.n ? Math.round(o.srv / o.n) : 0, max: o.mx, last: o.last }; });
    return { ok: true, days: Object.keys(dayset).length, list: list };
  });
}
