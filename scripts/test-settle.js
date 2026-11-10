/**
 * 정산 계산 시험 (배포 전 검사 scripts/check.js 가 부른다)
 *  - src/*.gs 전체를 node 에 올리고 구글 서비스·시트 읽기를 가짜 자료로 바꿔 stlCompute_ 를 끝까지 돌린다.
 *  - 금액이 기대값과 다르면 종료 코드 1 → 배포가 멈춘다. 계산 규칙을 일부러 바꿨으면 아래 기대값도 같이 고친다.
 *  - 가짜 자료: 기사 4명(고정·백업·운영자·대표) · 용차업체 1곳(맡은 노선 인천7 919CD) · 쿠팡 배송 6줄 · 품앗이 일감 3건
 * 사용: node scripts/test-settle.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'src');

function mock() {
  const D = function (id, name, login, extra) { return Object.assign({ id: id, name: name, loginId: login, status: '승인', driverType: '고정', schCampId: 'C1', schCamp: '군포1캠프', baseRoute: '212CD', title: '' }, extra || {}); };
  const raw = function (date, cid, camp, route, qty) { return { month: '2026-11', date: date, cid: cid, camp: camp, route: route, kind: '배송', qty: String(qty), ret: '0', total: String(qty * 1000), fresh: '0', inc: '0' }; };
  const price = function (id, campId, num, value) { return { id: id, campId: campId, num: num, level: '2', value: value, p2: '1000', p3: '1100', p4: '1300', p5: '1350' }; };
  return {
    main: {
      drivers: [D('d1', '이현모', 'lhm'), D('d2', '강준길', 'kjg', { driverType: '백업', baseRoute: '백업' }), D('d3', '유정근', 'jrd', { title: '운영자' }), D('d4', '유정훈', 'corp', { title: '대표' })],
      camps: [{ id: 'C1', name: '군포1캠프', rot: '' }, { id: 'C2', name: '인천7캠프', rot: '' }, { id: 'C3', name: '시흥2캠프', rot: '' }],
      routes: [{ id: 'R1', campId: 'C1', code: '212C', g1: '212', g2: 'C', status: '사용' }, { id: 'R2', campId: 'C1', code: '212D', g1: '212', g2: 'D', status: '사용' },
        { id: 'R3', campId: 'C3', code: '708C', g1: '708', g2: 'C', status: '사용' }, { id: 'R4', campId: 'C2', code: '919C', g1: '919', g2: 'C', status: '사용' }],
      route_prices: [price('P1', 'C1', '212', 'C'), price('P2', 'C1', '212', 'D'), price('P3', 'C3', '708', 'C'), price('P4', 'C2', '919', 'C')]
    },
    stl: {
      stl_ids: [{ cid: 'lhm', role: '메인', owner: '이현모', ownerId: 'd1', type: '고정' }, { cid: 'kjg', role: '메인', owner: '강준길', ownerId: 'd2', type: '백업' },
        { cid: 'jrd', role: '메인', owner: '유정근', ownerId: 'd3', type: '백업' }, { cid: 'corp', role: '메인', owner: '유정훈', ownerId: 'd4', type: '백업' }],
      stl_vendors: [{ name: '히어로', price: '1320', ins: 'N', routes: '인천7 919CD', rFrom: '2026-11-01', rTo: '' }],
      stl_raw: [raw('2026-11-15', 'kjg', '군포1', '212C', 200), raw('2026-11-15', 'kjg', '군포1', '212D', 100),
        raw('2026-11-05', 'rand1', '시흥2', '708C', 50), raw('2026-11-05', 'rand1', '인천7', '919C', 150), raw('2026-11-06', 'rand1', '시흥2', '708C', 40),
        raw('2026-11-11', 'jrd', '시흥2', '708C', 120)],
      stl_usage: [{ cid: 'jrd', name: '유정훈', driverId: 'd4', from: '2026-11-11', to: '2026-11-11', memo: '품앗이 자동 J2' }]
    },
    jobs: [
      { id: 'J1', status: '배차 확정', posterId: 'd1', poster: '이현모', acceptedId: 'd2', accepted: '강준길', date: '2026-11-15', route: '212CD', camp: '군포1캠프', campId: 'C1', price: '1500', useId: '받는 기사 아이디' },
      { id: 'J2', status: '배차 확정', posterId: 'd3', poster: '유정근', acceptedId: 'd4', accepted: '유정훈', date: '2026-11-11', route: '708C', camp: '시흥2캠프', campId: 'C3', price: '1500', useId: '주는 기사 아이디' },
      { id: 'J3', status: '배차 확정', posterId: 'd1', poster: '이현모', acceptedId: 'd2', accepted: '강준길', date: '2026-11-20', route: '212CD', camp: '군포1캠프', campId: 'C1', price: '', useId: '받는 기사 아이디' }
    ]
  };
}

/** src/*.gs 를 새 실행 환경에 올리고 가짜 자료를 꽂는다 */
function load(M) {
  const any = function () { return new Proxy(function () {}, { get: function (t, k) { return k === Symbol.toPrimitive ? function () { return ''; } : any(); }, apply: function () { return any(); } }); };
  const p2 = function (n) { return ('0' + n).slice(-2); };
  const ctx = { console: { log: function () {}, warn: function () {}, error: console.error }, __M: M,
    SpreadsheetApp: any(), CacheService: any(), PropertiesService: any(), LockService: any(), ScriptApp: any(), UrlFetchApp: any(), DriveApp: any(), HtmlService: any(), ContentService: any(), Session: any(), MailApp: any(),
    Utilities: { getUuid: function () { return 'u'; }, formatDate: function (d, tz, f) { return f.replace('yyyy', d.getFullYear()).replace('MM', p2(d.getMonth() + 1)).replace('dd', p2(d.getDate())).replace('HH', p2(d.getHours())).replace('mm', p2(d.getMinutes())).replace('ss', p2(d.getSeconds())); } } };
  vm.createContext(ctx);
  fs.readdirSync(SRC).filter(function (f) { return /\.gs$/.test(f); }).sort().forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }); });
  vm.runInContext([
    'var _c = {}; cache_ = function () { return { get: function (k) { return _c[k] || null; }, put: function (k, v) { _c[k] = v; }, remove: function (k) { delete _c[k]; } }; };',
    "props_ = function () { return { STL_IDS_V2: '', SCH_DB_ID: '' }; };",
    'stlLoad_ = function () {};',
    "stlTab_ = function (n) { if (!_stlTab[n]) { var ks = Object.keys(STL_TABS[n]); _stlTab[n] = { head: ks.map(function (k) { return STL_TABS[n][k]; }), rows: (__M.stl[n] || []).map(function (o) { return ks.map(function (k) { return o[k] == null ? '' : String(o[k]); }); }) }; } return _stlTab[n]; };",
    'stlReadMonth_ = function (n, m) { return (__M.stl[n] || []).filter(function (o) { return o.month === m; }).map(function (o) { return Object.assign({}, o); }); };',
    'readAll_ = function (n) { return (__M.main[n] || []).map(function (o, i) { return Object.assign({ _row: i + 2 }, o); }); };',
    'pmData_ = function () { return { jobs: __M.jobs, apps: [] }; };',
    "stlCGet_ = function () { return null; }; stlCPut_ = function () {}; stlVerOf_ = function () { return '1'; }; stlTv_ = function () { return { _: '1' }; }; stlVer_ = function () { return '1'; }; masterVer_ = function () { return '1'; };",
    'stlSchedule_ = function () { return { cells: {}, rows: {} }; };'
  ].join('\n'), ctx);
  return ctx;
}
function run(change) {
  const M = mock();
  if (change) change(M);
  const ctx = load(M);
  const s = vm.runInContext("stlCompute_('2026-11')", ctx).summary;
  const drv = {}; (s.drivers || []).forEach(function (d) { drv[d.name] = d; });
  const warn = {}; (s.warnings || []).forEach(function (w) { warn[w.key] = w.items; });
  return { s: s, drv: drv, warn: warn, yong: s.yong || [], ctx: ctx };
}

let failed = 0, count = 0;
function eq(label, got, want) {
  count++;
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++; console.error('FAIL 자동 시험 · ' + label + '\n     기대 ' + JSON.stringify(want) + '\n     실제 ' + JSON.stringify(got));
}
function scenario(name, change, check) {
  try { check(run(change)); } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · ' + name + ' (실행 오류)\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
}

// 1) 기본: 품앗이 자동(받는 기사 아이디 · 주는 기사 아이디+운영자) · 용차업체 맡은 노선 줄만 묶음
scenario('기본', null, function (r) {
  eq('강준길 기본 지급 (300건 × 백업단가 1,100)', r.drv['강준길'].base, 330000);
  eq('강준길 품앗이 추가지급 (300 × 1,500 − 330,000)', r.drv['강준길'].yongPay, 120000);
  eq('이현모 차액 공제', r.drv['이현모'].yongCut, 120000);
  eq('유정훈 추가지급 (주는 기사 아이디 120건 × 1,500 − 120,000)', r.drv['유정훈'].yongPay, 60000);
  eq('맡긴 쪽이 운영자 → 기사 공제 없음(러너 부담)', (r.drv['유정근'] || {}).yongCut || 0, 0);
  eq('히어로: 맡은 노선 919C 150건만 (다른 노선 줄은 묶지 않음)', [r.drv['히어로'].qty, r.drv['히어로'].base], [150, 198000]);
  eq('같은 아이디의 다른 노선 2줄은 등록 안 된 아이디 (줄 순서 무관)', (r.warn.unreg || []).length === 1 && /99,000원/.test(r.warn.unreg[0]), true);
  eq('자동 품앗이 줄 2건 (11/20 은 배송 기록 없어 제외)', r.yong.filter(function (y) { return y.auto; }).length, 2);
  eq('배송 기록 없는 확정 품앗이 경고 없음 (정산서가 그 날짜까지 안 들어옴)', (r.warn.pmNoPerf || []).length, 0);
});
// 2) 수행자의 노선 단가가 비어 있으면 자동 반영 보류 (전액 청구 방지)
scenario('단가 없음', function (M) { M.main.route_prices = M.main.route_prices.filter(function (p) { return !(p.num === '212' && p.value === 'D'); }); }, function (r) {
  eq('강준길 추가지급 없음', r.drv['강준길'].yongPay, 0);
  eq('이현모 공제 없음', (r.drv['이현모'] || {}).yongCut || 0, 0);
  eq('보류 경고 1건', (r.warn.pmNoPrice || []).length, 1);
});
// 3) 일감 단가가 평소 단가보다 낮으면 평소 단가로만 (추가지급·공제 0)
scenario('낮은 단가', function (M) { M.jobs[0].price = '1000'; }, function (r) {
  eq('강준길 지급 = 평소 단가 그대로', [r.drv['강준길'].base, r.drv['강준길'].yongPay], [330000, 0]);
  eq('이현모 공제 0', (r.drv['이현모'] || {}).yongCut || 0, 0);
  eq('낮은 단가 경고 1건', (r.warn.pmLow || []).length, 1);
});
// 4) 직접 적은 품앗이 줄이 있으면 자동 줄을 만들지 않는다
scenario('직접 적은 줄 우선', function (M) { M.stl.stl_yongcha = [{ date: '2026-11-15', who: '강준길', whoId: 'kjg', route: '212CD', mode: '건당', price: '1400', payer: '이현모', payerId: 'lhm' }]; }, function (r) {
  eq('11/15 자동 줄 없음', r.yong.filter(function (y) { return y.auto && y.date === '2026-11-15'; }).length, 0);
  eq('직접 적은 단가 1,400 으로 추가지급', r.drv['강준길'].yongPay, 90000);
});
// 5) 자동으로 묶인 아이디의 분실파손은 그 업체로
scenario('자동 묶음 분실', function (M) { M.stl.stl_loss = [{ month: '2026-11', date: '2026-11-05', cid: 'rand1', camp: '인천7', amt: '10000', type: '분실' }]; }, function (r) {
  eq('히어로 분실 변상 반영', r.drv['히어로'].loss > 0, true);
});
// 6) 등록 때 낮은 단가 안내
scenario('등록 안내', null, function (r) {
  eq('낮으면 안내 글', !!vm.runInContext("pmLowPriceNote_('C1','212CD','1000')", r.ctx), true);
  eq('같거나 높으면 없음', vm.runInContext("pmLowPriceNote_('C1','212CD','1100')", r.ctx), '');
  eq('단가를 모르는 노선은 묻지 않음', vm.runInContext("pmLowPriceNote_('C1','999A','500')", r.ctx), '');
});

// 7) 쿠팡 업로드 표: 담당 없음 노선 · 용차업체 맡은 노선은 아무도 안 뛰면 미입차 줄로 (사유 따로) · 이관 예약으로 떠나는 노선은 제외
scenario('업로드 표', null, function (r) {
  const out = vm.runInContext(`(function () {
    var dates = ['2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21'];
    var data = { dates: dates, camps: [{ id: 'c1', name: '인천7캠프', rot: 'D1,D2' }, { id: 'c2', name: '안양1캠프', rot: 'D1,D2' }], routes: { c1: ['919CD', '901A', '902A'], c2: ['110AB'] },
      drivers: [{ id: 'd1', name: '김', loginId: 'kim1', campId: 'c1', status: '승인', baseRoute: '901A' }],
      cells: { d1: { '2026-11-15': '출근', '2026-11-16': '인천7 919CD' } }, issues: [],
      rcMoves: [{ fromCampId: 'c2', fromRoute: '110', date: '2026-11-11' }],
      vendorRoutes: [{ name: '히어로', camp: '인천7', code: '919CD', units: ['919C', '919D'], from: '2026-11-01', to: '' }] };
    return schBuildUpload_(data, { bizNo: 'x', wave: 'W', target: '2026-11-15', maxDays: 6 }).missing.map(function (x) { return [x[0], x[2], x[7], x[8]].join(' | '); });
  })()`, r.ctx);
  const day = function (d) { return out.filter(function (x) { return x.indexOf(d) === 0; }).sort(); };
  eq('11/15: 담당 없음 902A 와 용차업체 919CD 가 따로, 출근한 901A 는 없음', day('2026-11-15'), ['2026-11-15 | 인천7 | 902A | 사유: 담당 없음', '2026-11-15 | 인천7 | 919C,919D | 사유: 용차업체 히어로']);
  eq('11/16: 우리 기사가 919CD 를 뛰면 용차업체 줄 없음 · 기본노선 901A 는 미입차', day('2026-11-16'), ['2026-11-16 | 인천7 | 901A | ', '2026-11-16 | 인천7 | 902A | 사유: 담당 없음']);
  eq('이관 예약으로 떠난 안양1 110 은 올리지 않음', out.filter(function (x) { return /안양1/.test(x); }).length, 0);
});

// 8) 새벽 자료 점검 · 오류 기록 · 속도 기록 요약 (읽기만 하는지 · 중복 억제 · 요약 뒤에만 지우는지)
scenario('자료 점검·오류 기록·속도 요약', function (M) {
  M.main.drivers.push({ id: 'd9', name: '신입', loginId: '', status: '승인', driverType: '고정', schCampId: 'C1', schCamp: '군포1캠프', baseRoute: '555A' });
  M.main.drivers.push({ id: 'd8', name: '퇴사자', loginId: 'gone', status: '승인', workStatus: '퇴사', driverType: '고정', schCampId: 'C1', baseRoute: '777A' });
  M.main.routes.push({ id: 'R9', campId: 'C1', code: '300A', g1: '300', g2: 'A', status: '사용' });
  M.jobs.push({ id: 'J9', status: '배차 확정', posterId: 'd1', poster: '이현모', acceptedId: 'd8', accepted: '퇴사자', date: '2099-01-02', route: '212C', camp: '군포1캠프', campId: 'C1', price: '1300' });
  const old = function (d, fn, n, rt) { return { at: d + ' 10:00:00', app: '관리자앱', view: 'sched', fn: fn, n: String(n), rt: String(rt), rtMax: String(rt), srv: '100', who: 'x' }; };
  M.main.perf_log = [old('2020-01-01', 'adm_a', 2, 500), old('2020-01-01', 'adm_a', 3, 700), old('2020-01-02', 'adm_b', 1, 100), old('2099-01-01', 'adm_a', 1, 50)];
  M.main.error_log = [{ at: '2020-01-01 00:00:00', kind: '서버 오류', fn: 'x', msg: 'old' }, { at: '2099-01-01 00:00:00', kind: '화면 오류', fn: '', msg: 'new' }];
}, function (r) {
  const out = vm.runInContext(`(function () {
    var put = {}, app = [], del = {}, rows = [];
    appSetPut_ = function (k, v) { put[k] = v; };
    appendObjs_ = function (n, o) { app.push([n, o]); };
    scriptLock_ = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
    cols_ = function (n) { var c = { __w: 0 }; Object.keys(SCHEMA[n]).forEach(function (k) { c[k] = c.__w++; }); return c; };
    sheet_ = function (n) { return { getLastRow: function () { return 1; }, appendRow: function (a) { rows.push(a); }, deleteRows: function (a, b) { del[n] = [a, b]; } }; };
    Utilities.base64Encode = function (x) { return String(x); }; Utilities.computeDigest = function (a, s) { return s; }; Utilities.DigestAlgorithm = {}; Utilities.Charset = {};
    var res = dataCheck_(); perfRollup_();
    errLog_('서버 오류', 'adm_x', '전화 010-1234-5678 a@b.co 실패'); errLog_('서버 오류', 'adm_x', '전화 010-1234-5678 a@b.co 실패'); errLog_('', '', '');
    errRows_([{ k: 'client', f: '', m: 'boom', v: 'sched', u: '424' }, { k: 'nope', m: 'x' }], '관리자앱', '유');
    var by = {}; res.items.forEach(function (x) { by[x.k] = x.list; });
    return { by: by, saved: !!put.dataCheck, day: app.map(function (a) { return a[0] + ':' + a[1].map(function (o) { return [o.day, o.fn, o.n, o.rt, o.rtMax].join('/'); }).join(','); }), del: del, rows: rows.map(function (a) { return a.slice(1).join('|'); }) };
  })()`, r.ctx);
  eq('기본노선이 노선관리에 없음 (퇴사자는 제외)', out.by.base, ['신입 · 군포1 555']);
  eq('사용 중 노선인데 단가 없음', out.by.price, ['군포1 300']);
  eq('쿠팡 아이디 없는 승인 기사', out.by.login, ['신입']);
  eq('확정 품앗이의 받은 기사가 퇴사', out.by.pm, ['01-02 군포1 212C → 퇴사자']);
  eq('어제부터의 오류만 셈', out.by.err, ['화면 오류 1건']);
  eq('점검 결과 저장', out.saved, true);
  eq('7일 지난 속도 기록 3줄을 날짜·함수별로 요약', out.day, ['perf_daily:2020-01-01/adm_a/5/1200/700,2020-01-02/adm_b/1/100/100']);
  eq('요약한 3줄 · 60일 지난 오류 1줄만 지움', out.del, { perf_log: [2, 3], error_log: [2, 1] });
  eq('오류 기록: 같은 내용은 한 번 · 번호·메일 가림 · 모르는 종류는 버림', out.rows, ['서버|서버 오류||adm_x|전화 # (메일) 실패||', '관리자앱|화면 오류|sched||boom|424|유']);
});

// ───── 기사스케줄 저장 · 이슈 연동 · 품앗이 확정/취소 (가짜 스케줄 시트로 끝까지 실행) ─────
/** 가짜 스케줄 시트(1행 머리글 · 열: 행ID 구분 캠프 이름 기본노선 + 날짜) 와 주변 함수 */
const OPS = `
  var __dates = ['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20'];
  var __grid = [['행ID','구분','캠프','이름','기본노선'].concat(__dates),
    ['d1','기사','군포1캠프','이현모','212CD','','','','',''], ['d2','기사','군포1캠프','강준길','백업','','','','',''], ['NOTE1','비고','','업무 관련','','','','','','']];
  var __w = { set: 0, reads: {} }, __ISS = [], __seq = 0;
  var __rng = function (r, c, nr, nc) { nr = nr || 1; nc = nc || 1; var self = {
    getValues: function () { var o = []; for (var i = 0; i < nr; i++) { var row = []; for (var j = 0; j < nc; j++) row.push((__grid[r - 1 + i] || [])[c - 1 + j] === undefined ? '' : __grid[r - 1 + i][c - 1 + j]); o.push(row); } return o; },
    getValue: function () { return self.getValues()[0][0]; },
    setValues: function (v) { __w.set++; for (var i = 0; i < nr; i++) for (var j = 0; j < nc; j++) { while (__grid.length < r + i) __grid.push([]); __grid[r - 1 + i][c - 1 + j] = v[i][j]; } return self; },
    setValue: function (v) { return self.setValues([[v]]); }, setNumberFormat: function () { return self; } }; return self; };
  var __sh = { getLastRow: function () { return __grid.length; }, getMaxRows: function () { return 1000; }, getLastColumn: function () { return __grid[0].length; }, getRange: __rng,
    insertRowBefore: function (r) { __grid.splice(r - 1, 0, []); }, insertRowsAfter: function () {}, deleteRow: function (r) { __ISS.splice(r - 2, 1); } };
  var __h = { fixed: { '행ID': 0, '구분': 1, '캠프': 2, '이름': 3, '기본노선': 4 }, dates: {} }; __dates.forEach(function (d, i) { __h.dates[d] = 5 + i; });
  schSheet_ = function () { return __sh; }; schHeader_ = function () { return __h; }; schEnsureDates_ = function () { return __h; };
  props_ = function () { return { STL_IDS_V2: '', SCH_DB_ID: 'x' }; };
  scriptLock_ = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
  requireAdmin_ = function () { return { name: '관리자', loginId: 'adm' }; }; fsMark_ = function () {}; logAdmin_ = function () {}; stlBump_ = function () {}; flushBeforeBump_ = function () {};
  var __readAll = readAll_; readAll_ = function (n) { __w.reads[n] = (__w.reads[n] || 0) + 1; return __readAll(n); };
  driverById_ = function (id) { return __M.main.drivers.filter(function (o) { return o.id === id; })[0] || null; };
  rcByDriver_ = function () { __w.reads.rc = (__w.reads.rc || 0) + 1; return {}; };
  schIssueSheet_ = function () { return __sh; }; schIssueHeadFix_ = function () { __w.reads.head = (__w.reads.head || 0) + 1; };
  schIssues_ = function () { return __ISS.map(function (x, i) { return Object.assign(JSON.parse(JSON.stringify(x)), { row: i + 2 }); }); };
  issWriteRow_ = function (sh, x) { var c = JSON.parse(JSON.stringify(x)); if (!x.row) { __ISS.push(c); x.row = __ISS.length + 1; } else __ISS[x.row - 2] = c; };
  issNewId_ = function () { return 'I' + (++__seq); };
  var __cell = function (id, d) { for (var i = 1; i < __grid.length; i++) if (__grid[i][0] === id) return __grid[i][__h.dates[d]] || ''; return null; };
  var __save = function (list) { var r = adm_schSave('t', list); return r; };
  var __iss = function () { return __ISS.map(function (x) { return [x.driverId, x.date, x.end, x.result, x.cut || '-', x.kind].join(' '); }); };
  // 품앗이
  var __apps = [{ id: 'A1', jobId: 'J3', driverId: 'd2', name: '강준길', status: '지원', _row: 2 }, { id: 'A2', jobId: 'J3', driverId: 'd3', name: '유정근', status: '지원', _row: 3 }];
  var __usage = [];
  pmJobById_ = function (id) { var j = __M.jobs.filter(function (x) { return x.id === id; })[0]; if (!j) fail_('일감을 찾을 수 없습니다.'); return Object.assign({}, j); };
  findRow_ = function (n, k, v) { var L = n === SH.PJOB ? __M.jobs : n === SH.PAPP ? __apps : []; for (var i = 0; i < L.length; i++) if (L[i][k] === v) return i + 2; return 0; };
  writeFields_ = function (n, row, f) { var L = n === SH.PJOB ? __M.jobs : n === SH.PAPP ? __apps : null; if (L && L[row - 2]) Object.assign(L[row - 2], f); };
  __M.main[SH.PAPP] = __apps;
  pmAlertAdd_ = function () {}; pmTouch_ = function () {}; pmPushSend_ = function () {}; pmPast_ = function () { return false; };
  stlRead_ = function (n) { return n === 'stl_usage' ? __usage.map(function (x, i) { return Object.assign({ _row: i + 2 }, x); }) : []; };
  stlWriteAll_ = function (n, rows) { if (n === 'stl_usage') __usage = rows; };
`;
function ops(name, check) {
  scenario(name, function (M) { M.jobs[2].date = '2026-11-20'; M.jobs[2].status = '모집 중'; M.jobs[2].acceptedId = ''; M.jobs[2].accepted = ''; M.jobs[2].useId = '주는 기사 아이디'; }, function (r) {
    vm.runInContext(OPS, r.ctx);
    check(function (code) { return vm.runInContext('(function () { ' + code + ' })()', r.ctx); });
  });
}

// 9) 스케줄 저장: 칸 쓰기 · 충돌 · 비고 줄 제외 · 확정 품앗이 칸 잠금
ops('스케줄 저장', function (run) {
  const a = run("var r = __save([{ row: 'd1', date: '2026-11-16', value: '휴무', old: '' }, { row: 'd1', date: '2026-11-17', value: '휴무', old: '' }, { row: 'd1', date: '2026-11-18', value: '휴무', old: '' }, { row: 'd2', date: '2026-11-16', value: '군포1 212C', old: '' }]); return [r.ok, r.saved, r.conflicts.length, __cell('d1', '2026-11-17'), __cell('d2', '2026-11-16'), __iss().length];");
  eq('4칸 저장 · 이슈 없음', a, [true, 4, 0, '휴무', '군포1 212C', 0]);
  eq('이슈가 될 수 있는 글자(노선)는 그 기사 줄만 읽음 · 기사 전체 목록은 안 읽음', run("return [__w.reads.drivers || 0, __w.reads.rc || 0];"), [0, 1]);
  eq('한 줄에서 이어진 3칸은 한 번에 씀 (쓰기 2번)', run("return __w.set;"), 2);
  eq('휴무만 고치면 이슈 연동이 아무것도 더 읽지 않음', run("__w.reads = {}; __save([{ row: 'd1', date: '2026-11-19', value: '휴무', old: '' }]); return [__w.reads.drivers || 0, __w.reads.rc || 0, __w.reads.head || 0];"), [0, 0, 0]);
  eq('남이 먼저 고친 칸은 충돌로 돌려주고 쓰지 않음', run("var r = __save([{ row: 'd1', date: '2026-11-16', value: '출근', old: '' }]); return [r.saved, r.conflicts[0].current, __cell('d1', '2026-11-16')];"), [0, '휴무', '휴무']);
  eq('같은 값이면 저장 0', run("return __save([{ row: 'd1', date: '2026-11-16', value: '휴무', old: '휴무' }]).saved;"), 0);
  eq('없는 기사 줄은 무시', run("return __save([{ row: 'zz', date: '2026-11-16', value: '휴무', old: '' }]).saved;"), 0);
});

// 10) 칸 → 이슈: 미입차 생성 · 다음 날 이어 붙임 · 정상으로 고치면 뺌 · 회전 줄임 = 물량조율
ops('칸 → 이슈 연동', function (run) {
  eq('미입차 칸 → 사유 미정 이슈 1건', run("var r = __save([{ row: 'd1', date: '2026-11-16', value: '미입차', old: '' }]); return [r.issueSync.created.length, __iss()];"), [1, ['d1 2026-11-16 2026-11-16 미입차 - 사유 미정']]);
  eq('다음 날도 미입차 → 기간을 늘림 (새 이슈 아님)', run("var r = __save([{ row: 'd1', date: '2026-11-17', value: '미입차', old: '' }]); return [r.issueSync.changed.length, __iss()];"), [1, ['d1 2026-11-16 2026-11-17 미입차 - 사유 미정']]);
  eq('끝 날을 출근으로 → 기간을 줄임', run("var r = __save([{ row: 'd1', date: '2026-11-17', value: '출근', old: '미입차' }]); return __iss();"), ['d1 2026-11-16 2026-11-16 미입차 - 사유 미정']);
  eq('하루짜리를 출근으로 → 이슈 삭제', run("var r = __save([{ row: 'd1', date: '2026-11-16', value: '출근', old: '미입차' }]); return [r.issueSync.removed.length, __iss()];"), [1, []]);
  eq('기본노선 212CD 중 212C 만 → 물량조율 (뺀 것 212D)', run("__save([{ row: 'd1', date: '2026-11-19', value: '212C', old: '' }]); return __iss().map(function (x) { return x.replace(/\\s*\\(.*?\\)/g, ''); });"), ['d1 2026-11-19 2026-11-19 물량조율 212D 사유 미정']);
  eq('백업 기사는 노선을 적어도 이슈 아님', run("__save([{ row: 'd2', date: '2026-11-19', value: '212C', old: '' }]); return __iss().length;"), 1);
  eq('4명 넘게 한꺼번에 고치면 기사 목록을 한 번만 읽음', run("__w.reads = {}; __M.main.drivers.forEach(function (o, i) { if (i > 1) __grid.splice(3, 0, [o.id, '기사', '군포1캠프', o.name, '212CD', '', '', '', '', '']); }); __save(__M.main.drivers.map(function (o) { return { row: o.id, date: '2026-11-18', value: '미입차', old: '' }; })); return [__w.reads.drivers, __iss().length];"), [1, 5]);
});

// 11) 품앗이 확정 → 품앗이 줄 칸 + 아이디 사용 기록 · 확정 칸은 스케줄에서 못 지움 · 확정 풀기/취소 → 칸·기록 지움
ops('품앗이 확정·취소', function (run) {
  eq('확정: 일감·지원 상태 · 품앗이 줄 칸 · 아이디 사용 기록', run("pmDecide_('d1', 'J3', 'A1', 'accept'); var j = __M.jobs[2]; return [j.status, j.accepted, __apps[0].status, __apps[1].status, __cell('PMd2', '2026-11-20'), __usage.map(function (u) { return [u.cid, u.name, u.from].join(' '); })];"),
    ['배차 확정', '강준길', '확정', '미선정', '군포1 212CD', ['lhm 강준길 2026-11-20']]);
  eq('품앗이 줄은 비고 줄 위에 생김', run("return __grid.map(function (r) { return r[0]; });"), ['행ID', 'd1', 'd2', 'PMd2', 'NOTE1']);
  eq('확정된 칸은 스케줄 저장으로 못 지움', run("var r = __save([{ row: 'PMd2', date: '2026-11-20', value: '', old: '군포1 212CD' }]); return [r.saved, r.pmLocked.length, __cell('PMd2', '2026-11-20')];"), [0, 1, '군포1 212CD']);
  eq('확정 글자 뒤에 덧붙이는 것은 됨', run("var r = __save([{ row: 'PMd2', date: '2026-11-20', value: '군포1 212CD 07시', old: '군포1 212CD' }]); return [r.saved, __cell('PMd2', '2026-11-20')];"), [1, '군포1 212CD 07시']);
  eq('남이 올린 일감은 못 정함', run("try { pmDecide_('d3', 'J3', 'A1', 'back'); return 'ok'; } catch (e) { return e.userMsg || String(e); }"), '내가 올린 일감만 정할 수 있습니다.');
  run("__save([{ row: 'PMd2', date: '2026-11-20', value: '군포1 212CD', old: '군포1 212CD 07시' }]);");
  eq('확정 풀기: 다시 모집 · 칸·기록 지움 · 미선정이던 지원 되살림', run("pmDecide_('d1', 'J3', 'A1', 'back'); var j = __M.jobs[2]; return [j.status, j.acceptedId, __apps[0].status, __apps[1].status, __cell('PMd2', '2026-11-20'), __usage.length];"), ['모집 중', '', '지원', '지원', '', 0]);
  eq('다시 확정 뒤 일감 취소: 칸·기록 지움', run("pmDecide_('d1', 'J3', 'A2', 'accept'); var mid = [__cell('PMd3', '2026-11-20'), __usage.length]; pmClose_('d1', 'J3', 'cancel'); return [mid, __M.jobs[2].status, __cell('PMd3', '2026-11-20'), __usage.length, __apps[1].status];"), [['군포1 212CD', 1], '취소', '', 0, '미선정']);
});

// 12) 실제 자료 자체 검사: 확정 품앗이 ↔ 칸 · 이슈 ↔ 칸 · 정산 계산
ops('자체 검사 (품앗이·이슈 ↔ 칸 · 정산 계산)', function (run) {
  run("todayText_ = function () { return '2026-11-18'; }; __drv = __M.main.drivers.filter(function (o) { return o.id; });");
  eq('맞는 상태에서는 아무것도 없음', run("pmDecide_('d1', 'J3', 'A1', 'accept'); __save([{ row: 'd1', date: '2026-11-17', value: '미입차', old: '' }]); return dataCheckLive_(__drv, '2026-11-18').map(function (x) { return x.k; });"), []);
  eq('품앗이 줄 칸이 지워지면 잡음', run("__grid.forEach(function (r) { if (r[0] === 'PMd2') r[__h.dates['2026-11-20']] = ''; }); var r = dataCheckLive_(__drv, '2026-11-18'); return r.map(function (x) { return x.k + ':' + x.list.join(';'); });"), ['pmCell:11/20 강준길 · 군포1 212CD']);
  eq('이슈가 있는 날 칸이 출근이면 잡음 · 같은 결과로 읽히는 글자는 맞는 것', run("__grid.forEach(function (r) { if (r[0] === 'PMd2') r[__h.dates['2026-11-20']] = '군포1 212CD'; if (r[0] === 'd1') r[__h.dates['2026-11-17']] = '출근'; }); var a = dataCheckLive_(__drv, '2026-11-18').map(function (x) { return x.k + ':' + x.list.join(';'); }); __grid.forEach(function (r) { if (r[0] === 'd1') r[__h.dates['2026-11-17']] = '미입차 (차량고장)'; }); return [a, dataCheckLive_(__drv, '2026-11-18').length];"),
    [['issCell:11/17 이현모 · 이슈 미입차 ↔ 칸 출근'], 0]);
  eq('정산 계산이 오류를 내면 잡음', run("var keep = stlCompute_; stlCompute_ = function (m) { if (m === '2026-11') throw new Error('boom'); return keep(m); }; var r = dataCheckLive_(__drv, '2026-11-18'); stlCompute_ = keep; return r.map(function (x) { return x.k + ':' + x.list.join(';'); });"), ['stlRun:2026-11 계산 오류: boom']);
});

// 13) 기사앱 정산서: 달 목록과 첫 달 정산서를 한 번에 — 따로 받은 것과 내용이 같아야 한다
scenario('기사앱 정산서 한 번에', null, function (r) {
  const out = vm.runInContext(`(function () {
    pmUser_ = function () { return { id: 'd1', name: '이현모' }; };
    var p0 = props_; props_ = function () { var o = p0(); o.STL_DB_ID = 'x'; return o; };
    companyInfo_ = function () { return {}; }; tiForDriver_ = function () { return []; };
    stlAppMonths_ = function () { return [{ month: '2026-11', closed: false }]; }; var c0 = stlCfg_; stlCfg_ = function () { var c = c0(); c.appOpen = true; return c; };
    var a = api_mySettle('t', true), b = a.months && a.months.length ? api_mySlip('t', a.months[0].month) : null, old = api_mySettle('t');
    var strip = function (o) { return JSON.stringify(o, function (k, v) { return k === '_ms' || k === '_st' ? undefined : v; }); };
    return { ok: a.ok, months: (a.months || []).length, err: a.firstErr || a.msg || '', same: !!a.first && !!b && strip(a.first) === strip(b), slips: a.first ? a.first.slips.length : 0, oldHasFirst: 'first' in old, st: Object.keys(a._st || {}).join(',') };
  })()`, r.ctx);
  eq('달 목록 + 첫 달 정산서가 같이 오고, 따로 받은 것과 같음', [out.ok, out.months > 0, out.err, out.same, out.slips > 0], [true, true, '', true, true]);
  eq('예전 화면(인자 없이 부름)에는 달 목록만', out.oldHasFirst, false);
  eq('단계별 시간이 같이 옴', out.st, 'auth,load,groups,slip');
});

if (require.main === module) {
  if (failed) { console.error('\n자동 시험 실패 ' + failed + '건 / ' + count + '개'); process.exit(1); }
  console.log('OK   자동 시험 ' + count + '개');
}
module.exports = { failed: failed, count: count };
