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
  eq('11/15: 담당 없음 902A 와 용차업체 919CD 가 따로, 출근한 901A 는 없음', day('2026-11-15'), ['2026-11-15 | 인천7 | 902A | 사유: 담당 없음', '2026-11-15 | 인천7 | 919C,919D | 사유: 용차업체 히어로 입차 · 어드민만 미입차']);
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

// 14) 기존 정산 이식 달: 일자별 '그날 노선' 되살리기 (금액은 그대로 · 한 번만)
scenario('이식 달 그날 노선 되살리기', null, function (r) {
  const out = vm.runInContext(`(function () {
    var res = stlCompute_('2026-11'), slips = JSON.parse(JSON.stringify(res.slips)), sum = JSON.parse(JSON.stringify(res.summary));
    var want = {}, had = 0;
    Object.keys(slips).forEach(function (k) { Object.keys(slips[k].daily || {}).forEach(function (d) { if (slips[k].daily[d].route) { want[k + d] = slips[k].daily[d].route; had++; delete slips[k].daily[d].route; } }); });
    sum.legacy = { at: 'x' };
    __M.stl.stl_closed = stlSnapRows_('2026-11', { summary: sum, slips: slips });
    var writes = 0;
    stlReplaceMonth_ = function (n, m, objs) { writes++; __M.stl[n] = (__M.stl[n] || []).filter(function (o) { return o.month !== m; }).concat(objs); };
    scriptLock_ = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
    stlBump_ = function () {};
    var net0 = Object.keys(slips).reduce(function (a, k) { return a + (Number(slips[k].row.net) || 0); }, 0);
    var n = stlLegacyRouteFix_('2026-11'), after = stlClosedLoad_('2026-11'), ok = 0, net1 = 0;
    Object.keys(after.slips).forEach(function (k) { net1 += Number(after.slips[k].row.net) || 0; Object.keys(after.slips[k].daily || {}).forEach(function (d) { if (want[k + d] && after.slips[k].daily[d].route === want[k + d]) ok++; }); });
    var again = stlLegacyRouteFix_('2026-11');
    return { had: had, n: n, ok: ok, sameNet: net0 === net1, slips: Object.keys(after.slips).length === Object.keys(slips).length, mark: !!after.summary.legacy.routeFix, again: again, writes: writes };
  })()`, r.ctx);
  eq('비어 있던 그날 노선을 모두 채움 (있던 만큼)', [out.had > 0, out.n === out.had, out.ok === out.had], [true, true, true]);
  eq('금액·정산서 수는 그대로 · 한 번 했다는 표시', [out.sameNet, out.slips, out.mark], [true, true, true]);
  eq('두 번째는 아무것도 안 함 (저장 1번뿐)', [out.again, out.writes], [-1, 1]);
});

// 15) 품앗이 확정 뒤 순서: 스케줄 칸 → 알림 · 칸 쓰기 실패는 오류 기록에
ops('확정 뒤 처리 순서·실패 기록', function (run) {
  eq('스케줄 칸을 알림보다 먼저 씀', run("var seq = []; var ps = pmSchApply_; pmSchApply_ = function (o, s) { seq.push('sch'); return ps(o, s); }; pmPushSend_ = function () { seq.push('push'); }; pmDecide_('d1', 'J3', 'A1', 'accept'); pmSchApply_ = ps; return seq;"), ['sch', 'push']);
  eq('칸 쓰기 실패 → 오류 기록 · 확정은 그대로', run("var logs = []; errLog_ = function (k, f, m) { logs.push(k + '|' + f); }; var sh = schSheet_; schSheet_ = function () { throw new Error('boom'); }; pmDecide_('d1', 'J3', 'A1', 'back'); pmDecide_('d1', 'J3', 'A2', 'accept'); schSheet_ = sh; return [__M.jobs[2].status, logs];"), ['배차 확정', ['서버 오류|pmSchApply_', '서버 오류|pmSchApply_']]);
});

// 16) 기사앱 메뉴 켜기·끄기: 끈 메뉴는 서버에서도 막고 · 예외 기사는 그대로 · 그 메뉴 알림은 빠짐
scenario('기사앱 메뉴 끄기', null, function (r) {
  const out = vm.runInContext(`(function () {
    appSet_ = function () { return { appMenu: '{"sched":1,"settle":0,"pm":0,"my":1}', appMenuEx: '["d3"]' }; };
    var gate = function (id, k) { try { menuGate_(id, k); return 'ok'; } catch (e) { return e.code + '|' + e.userMsg; } };
    var al = [{ driverId: 'd1', kind: 'slip', jobId: 'SL-2026-10' }, { driverId: 'd3', kind: 'slip', jobId: 'SL-2026-10' }, { driverId: 'd1', kind: 'new', jobId: 'PM-1' }, { driverId: 'd1', kind: 'bd', jobId: 'BD-1' }];
    return { off: appMenuOffFor_('d1'), ex: appMenuOffFor_('d3'), g: [gate('d1', 'pm'), gate('d1', 'sched'), gate('d3', 'pm'), gate('d1', '')],
      keep: menuAlertFilter_(al).map(function (a) { return a.driverId + ':' + a.jobId; }), fn: [APP_MENU_FN.api_mySlip, APP_MENU_FN.api_pmList, APP_MENU_FN.api_myPerf, APP_MENU_FN.api_mySchedule || ''] };
  })()`, r.ctx);
  eq('끈 메뉴 목록 (설정 없는 메뉴는 켬)', out.off, ['settle', 'pm']);
  eq('예외 기사는 끈 메뉴 없음', out.ex, []);
  eq('끈 메뉴 자료 요청은 막고 · 켠 메뉴와 예외 기사는 통과', out.g, ['MENU_OFF|해당 메뉴는 준비 중입니다.', 'ok', 'ok', 'ok']);
  eq('끈 메뉴 알림은 빼고 · 예외 기사와 게시판 알림은 보냄', out.keep, ['d3:SL-2026-10', 'd1:BD-1']);
  eq('서버 함수 → 메뉴 연결', out.fn, ['settle', 'pm', 'my', '']);
});

// 17) 노선 물량: 1일 평균 · 총물량 · 요일별 평균은 전월(가장 최근 정산서 달)만으로
scenario('노선 물량 전월 기준', function (M) { M.stl.stl_raw.push({ month: '2026-10', date: '2026-10-10', cid: 'rand1', camp: '시흥2', route: '708C', kind: '배송', qty: '999', ret: '0', total: '999000', fresh: '0', inc: '0' }); }, function (r) {
  const out = vm.runInContext(`(function () {
    var p0 = props_; props_ = function () { var o = p0(); o.STL_DB_ID = 'x'; return o; };
    stlMonths_ = function () { return { withData: ['2026-10', '2026-11'] }; };
    var v = routeVolumes_(), x = v.vol['시흥2|708C'];
    return { pm: v.pm, period: v.pmPeriod, avg: x.avg, days: x.days, qty: x.qty, wd: x.wd, wn: x.wn, m: x.m };
  })()`, r.ctx);
  eq('전월 = 가장 최근 정산서 달 · 정산기간', [out.pm, out.period], ['2026-11', { from: '2026-10-26', to: '2026-11-25' }]);
  eq('1일 평균 · 배송한 날 · 총물량은 전월만 (10월 999건은 안 섞임)', [out.avg, out.days, out.qty], [70, 3, 210]);
  eq('요일별 평균 (일~토 · 배송 없는 요일은 null)', [out.wd, out.wn], [[null, null, null, 120, 50, 40, null], [0, 0, 0, 1, 1, 1, 0]]);
  eq('정산월별 수량은 달마다 따로', out.m, { '2026-10': 999, '2026-11': 210 });
});

// 18) 대표 정산서: 기존 정산 이식 달에 '쿠팡 매출만' 줄로 들어간 달도 쿠팡 정산서로 계산해 확인용으로 (마감 기록은 그대로 · 대표가 아니면 숨김)
scenario('대표 이식 달 정산서', null, function (r) {
  const out = vm.runInContext(`(function () {
    var res = stlCompute_('2026-11'), slips = JSON.parse(JSON.stringify(res.slips)), sum = JSON.parse(JSON.stringify(res.summary));
    var bare = function (k) { var o = slips[k].row; slips[k] = { row: { id: o.id, cid: o.cid, name: o.name, ownerId: o.ownerId, vendor: '', ids: 1, qty: o.qty, sales: o.sales, legacyNote: '기존 정산서 없음 (쿠팡 매출만)', pay: 0, invoice: 0, net: 0 }, lines: [{ name: '(기존 정산서 없음 · 쿠팡 매출만)', side: '지급', method: '직접입력', amt: 0 }] }; };
    var kc = Object.keys(slips).filter(function (k) { return slips[k].row.ownerId === 'd4'; })[0], k1 = Object.keys(slips).filter(function (k) { return slips[k].row.ownerId === 'd1'; })[0];
    var liveCeo = !!res.slips[kc].row.ceo;
    bare(kc); if (k1) bare(k1);
    sum.legacy = { at: 'x', routeFix: 1 };
    __M.stl.stl_closed = stlSnapRows_('2026-11', { summary: sum, slips: slips });
    __M.stl.stl_close = [{ month: '2026-11', at: '2026-11-09 23:40:57', admin: '유정훈 (기존 정산 이식)' }];
    var writes = 0; stlReplaceMonth_ = function () { writes++; };
    driverById_ = function (id) { return readAll_('drivers').filter(function (o) { return o.id === id; })[0] || null; };
    var ceo = mySlipCore_({ id: 'd4' }, '2026-11'), drv = mySlipCore_({ id: 'd1' }, '2026-11');
    return { liveCeo: liveCeo, n: ceo.slips.length, ceo: ceo.slips[0] ? ceo.slips[0].row.ceo : null, lines: ceo.slips[0] ? ceo.slips[0].lines.length > 0 : false, drv: drv.slips.length, hadDrv: !!k1, writes: writes };
  })()`, r.ctx);
  eq('대표는 계산값으로 1장 (확인용 표시 · 줄 있음)', [out.liveCeo, out.n, out.ceo, out.lines], [true, 1, true, true]);
  eq('대표가 아닌 기사의 같은 줄은 그대로 숨김', out.drv, 0);
  eq('마감 기록은 건드리지 않음', out.writes, 0);
});
// 19) 퇴사자 기사앱 자동 정지: 퇴사월 다음 달 정산 지급일 + 7일 · 한 번만 · 퇴사일 없으면 그대로
scenario('퇴사자 자동 정지', null, function (r) {
  const out = vm.runInContext(`(function () {
    var prop = {}, stopped = [];
    PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return prop[k] || null; }, setProperty: function (k, v) { prop[k] = v; } }; } };
    scriptLock_ = function () { return { waitLock: function () {}, releaseLock: function () {} }; };
    var D = __M.main.drivers.filter(function (o) { return o.id; });
    updateDriverCore_ = function (a, id, ch) { D.filter(function (o) { return o.id === id; })[0].status = ch.status; stopped.push(id); };
    var cfg = stlCfg_(), pay = function (m) { return stlDates_(m, cfg).pay; }, plus7 = function (d) { return ymd_(addDays_(parseYmd_(d), 7)); };
    var a = D[0], b = D[1], c = D[2];
    a.status = b.status = c.status = '승인';
    a.workStatus = '퇴사'; a.leaveDate = '2026-11-10';   // 11월 정산 → 12월 정산서(1월 지급)까지
    b.workStatus = '퇴사'; b.leaveDate = '2026-11-26';   // 26일부터는 12월 정산 → 1월 정산서(2월 지급)까지
    c.workStatus = '퇴사'; c.leaveDate = '';             // 퇴사일 없음 → 건드리지 않음
    var at = [leaveStopAt_(a), leaveStopAt_(b), leaveStopAt_(c)], want = [plus7(pay('2026-12')), plus7(pay('2027-01')), ''];
    var day = function (d) { todayText_ = function () { return d; }; stopped = []; leaveAutoStop_(); return stopped.slice(); };
    var before = day(ymd_(addDays_(parseYmd_(at[0]), -1))), on = day(at[0]);
    a.status = '승인';                                    // 관리자가 다시 승인
    var again = day(ymd_(addDays_(parseYmd_(at[0]), 3)));
    var later = day(at[1]);
    return { at: at, want: want, before: before, on: on, again: again, later: later, aId: a.id, bId: b.id, cSt: c.status };
  })()`, r.ctx);
  eq('정지일 = 다음 달 정산 지급일 + 7일 (25일까지 / 26일부터 / 퇴사일 없음)', out.at, out.want);
  eq('정지일 전날은 그대로', out.before, []);
  eq('정지일에 정지', out.on, [out.aId]);
  eq('관리자가 다시 승인하면 또 정지하지 않음', out.again, []);
  eq('26일 이후 퇴사자는 한 달 뒤에 정지 · 퇴사일 없는 기사는 그대로', [out.later, out.cSt], [[out.bId], '승인']);
});

// 20) 자동 보류금 (스위치): 퇴사 처리한 기사 → 퇴사월 보류 · 다음 달 반환 · 시작일 전 퇴사자 제외 · 등록한 명의자는 등록한 대로
(function () {
  const AUTO = function (on, from) { return [{ label: '퇴사 보류금 자동 (Y/N)', value: on, desc: '' }, { label: '퇴사 보류금 자동 시작일 (퇴사일이 이 날부터인 기사만)', value: from, desc: '' }]; };
  const leave = function (M, id, d) { const o = M.main.drivers.filter(function (x) { return x.id === id; })[0]; o.workStatus = '퇴사'; o.leaveDate = d; };
  const base = run(null), d0 = base.drv['강준길'].depDed, a0 = base.drv['강준길'].depAdd, h0 = base.drv['이현모'].depDed;
  scenario('자동 보류금 켬', function (M) { M.stl.stl_config = AUTO('Y', '2026-11-02'); leave(M, 'd2', '2026-11-10'); leave(M, 'd1', '2026-11-01'); }, function (r) {
    eq('퇴사 처리한 기사 → 퇴사월 정산에 보류금 10만원', r.drv['강준길'].depDed - d0, 100000);
    eq('시작일 전에 퇴사한 기사는 걸지 않음', r.drv['이현모'].depDed - h0, 0);
  });
  scenario('자동 보류금 끔', function (M) { M.stl.stl_config = AUTO('N', '2026-11-02'); leave(M, 'd2', '2026-11-10'); }, function (r) {
    eq('스위치가 꺼져 있으면 걸지 않음', r.drv['강준길'].depDed - d0, 0);
  });
  scenario('자동 보류금 반환', function (M) { M.stl.stl_config = AUTO('Y', '2026-10-01'); leave(M, 'd2', '2026-10-20'); }, function (r) {
    eq('10월 퇴사 → 11월 정산에 보류금 반환 (차감 없음)', [r.drv['강준길'].depAdd - a0, r.drv['강준길'].depDed - d0], [100000, 0]);
  });
  scenario('자동 보류금 · 등록 우선', function (M) { M.stl.stl_config = AUTO('Y', '2026-11-02'); leave(M, 'd2', '2026-11-10'); M.stl.stl_leave = [{ name: '강준길', acct: 'kjg', month: '2026-11', amt: '50000', memo: '' }]; }, function (r) {
    eq('보류금 설정에 등록한 명의자는 등록한 금액만 (자동과 겹치지 않음)', r.drv['강준길'].depDed - d0, 50000);
  });
})();

// 21) 처음 가는 캠프·노선 전날 알림: 늘 가던 곳 X · 새 노선 글자 · 새 캠프 · 품앗이 줄 · 노선 변경 예약 · 미입차 X · 퇴사 X · 같은 날 두 번 X
scenario('처음 가는 노선 알림', null, function (r) {
  const out = vm.runInContext(`(function () {
    var dates = []; for (var i = 1; i <= 20; i++) dates.push('2026-11-' + ('0' + i).slice(-2));
    var head = ['행ID', '구분', '캠프', '이름', '기본노선'].concat(dates), T = '2026-11-17';
    var row = function (id, base, cells) { return [id, '', '', '', base].concat(dates.map(function (d) { return cells[d] || ''; })); };
    var c = {}; c['2026-11-10'] = '출근'; c[T] = '출근';
    var rows = [
      row('d1', '212CD', c),                                                                   // 늘 가던 곳
      row('d2', '백업', { '2026-11-10': '군포1 212C', '2026-11-12': '시흥2 708C' }),
      row('PMd2', '', { '2026-11-17': '군포1 212CD' }),                                          // 품앗이 줄: 212D 처음
      row('d3', '백업', { '2026-11-10': '군포1 212CD', '2026-11-17': '인천7 919C' }),            // 처음 캠프
      row('d4', '212CD', { '2026-11-05': '출근', '2026-11-17': '미입차' })                        // 근무 아님
    ];
    schSS_ = function () { return { getSheetByName: function () { return 1; } }; };
    props_ = function () { return { SCH_DB_ID: 'x' }; };
    schHeader_ = function () { var h = { fixed: {}, dates: {} }; head.forEach(function (t, i) { if (/^\\d{4}/.test(t)) h.dates[t] = i; else h.fixed[t] = i; }); return h; };
    schSheet_ = function () { return { getLastRow: function () { return rows.length + 1; }, getRange: function (a, b, n, w) { return { getValues: function () { return rows.map(function (x) { return x.slice(0, w); }); } }; } }; };
    master_ = function () { return { camps: __M.main.camps }; };
    rcByDriver_ = function () { return { d1: [{ date: T, status: RCS.WAIT, fromCamp: '군포1캠프', fromRoute: '212AB', toCamp: '군포1캠프', toCampId: 'C1', toRoute: '212CD' }] }; };
    todayText_ = function () { return '2026-11-16'; };
    var D = __M.main.drivers; D[0].baseRoute = '212CD';
    var found = frFind_(T).map(function (x) { return x.name + ':' + x.camp + ':' + frJoin_(x.units) + (x.newCamp ? ':새캠프' : ''); });
    var prop = {}, sent = [], memo = [];
    PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return prop[k] || null; }, setProperty: function (k, v) { prop[k] = v; } }; } };
    scriptLock_ = function () { return { waitLock: function () {}, releaseLock: function () {} }; };
    pmAlertAdd_ = function (l) { sent = sent.concat(l); }; pmPushSend_ = function () {};
    appendObj_ = function (n, o) { memo.push(o.content); }; writeFields_ = function () {};
    frRun_(false); var again = frRun_(false);
    return { found: found, sent: sent.map(function (a) { return a.driverId + ':' + a.jobId + ':' + a.kind; }), memo: memo, again: !!again.skipped };
  })()`, r.ctx);
  // d1 은 11/10 '출근' 이 212AB(변경 전) 이라 내일 212CD 가 처음 · d2 는 212C 만 가 봐서 212D 처음 · d3 은 인천7 처음 · d4 미입차는 제외
  eq('처음 가는 기사 고르기 (캠프 → 이름 순)', out.found, ['강준길:군포1:212D', '이현모:군포1:212CD', '유정근:인천7:919C:새캠프']);
  eq('기사 알림 3건 (누르면 내 스케줄)', out.sent, ['d2:SC-2026-11-17:first', 'd1:SC-2026-11-17:first', 'd3:SC-2026-11-17:first']);
  eq('업무스케줄 한 줄', out.memo.length === 1 && /^내일 11\/17\(화\) 처음 가는 기사 3명/.test(out.memo[0]), true);
  eq('같은 날 두 번 보내지 않음', out.again, true);
});
// 22) 공지 대상: 전체 · 캠프 · 기사 · 캠프+기사 / 알림 메뉴 구분 (처음 가는 노선 = 스케줄)
scenario('공지 대상 · 알림 메뉴', null, function (r) {
  const out = vm.runInContext(`(function () {
    var f = function (t, d, camp, id) { return noticeFor_({ target: t, targetDrv: d }, camp, id); };
    return [f('', '', '', 'D1'), f('군포1', '', '군포1캠프', 'D1'), f('군포1', '', '', 'D2'), f('', 'D2, D3', '', 'D2'), f('', 'D2', '군포1캠프', 'D1'), f('인천7', 'D2', '', 'D2'),
      alertMenuOf_({ kind: 'first' }), alertMenuOf_({ kind: 'slip' }), alertMenuOf_({ jobId: 'BD-1' }), alertMenuOf_({ jobId: 'J1', kind: 'newjob' })];
  })()`, r.ctx);
  eq('전체 · 캠프 · 캠프 없는 백업 · 기사 지정 · 다른 기사 · 캠프+기사', out.slice(0, 6), [true, true, false, true, false, true]);
  eq('알림 메뉴: 처음 가는 노선 → 스케줄 · 정산서 · 게시판 · 품앗이', out.slice(6), ['sched', 'settle', '', 'pm']);
});
// 23) 품앗이 관리 '일할 기사': 지난 날 · 배차 확정된 날 · 앱 정지 기사는 빼고, 날짜 → 이름 순
scenario('품앗이 일할 기사', null, function (r) {
  const out = vm.runInContext(`(function () {
    todayText_ = function () { return '2026-11-16'; };
    __M.main.drivers[2].status = '정지';
    var d = { jobs: [{ status: PST.DONE, acceptedId: 'd2', date: '2026-11-20' }], apps: [{ status: PAST.OFFER, driverId: 'd1', date: '2026-11-18' }], avail: [
      { id: 'V1', driverId: 'd2', name: '강준길', date: '2026-11-18', kind: '야간' }, { id: 'V2', driverId: 'd1', name: '이현모', date: '2026-11-18', kind: '주간', memo: '하이탑' },
      { id: 'V3', driverId: 'd2', name: '강준길', date: '2026-11-20', kind: '무관' }, { id: 'V4', driverId: 'd1', name: '이현모', date: '2026-11-10', kind: '무관' },
      { id: 'V5', driverId: 'd3', name: '유정근', date: '2026-11-19', kind: '무관' }] };
    return pmAvailAdmin_(d, '2026-11-16', '').map(function (x) { return x.id + ':' + x.name + ':' + x.offered; });
  })()`, r.ctx);
  eq('지난 날 · 확정된 날 · 정지 기사 빼고 날짜→이름 순 · 제안 수', out, ['V1:강준길:0', 'V2:이현모:1']);
});

// 24) 대시보드 '오늘 한눈에': 숫자 칸 · 확인할 것(건이 있을 때만 · 급한 것 먼저) · 다가오는 변경(날짜순) · 한 부분이 실패해도 나머지는 나옴
scenario('대시보드 오늘 한눈에', null, function (r) {
  const out = vm.runInContext(`(function () {
    var T = '2026-11-16', N = '2026-11-17';
    todayText_ = function () { return T; };
    var D = __M.main.drivers; D[0].docQual = 'u'; D[0].docLicense = 'u'; D[1].schCampId = ''; D[1].schCamp = '';
    D.push({ id: 'd9', name: '신청자', status: ST.PENDING }); D.push({ id: 'd8', name: '퇴사자', status: ST.ACTIVE, workStatus: '퇴사', leaveDate: '2026-11-25' });
    __M.main.app_seen = [{ kind: 'open', driverId: 'd1', ackAt: T + ' 08:00:00' }, { kind: 'sch', driverId: 'd1', name: '이현모', key: N, ackAt: '' }, { kind: 'sch', driverId: 'd3', name: '유정근', key: N, ackAt: '취소' }, { kind: 'notice', driverId: 'd1', key: 'N1' }];
    __M.main.push_tokens = [{ driverId: 'd1', token: 't' }];
    __M.main.board_reports = [{ id: 'R1', status: '' }, { id: 'R2', status: '처리' }];
    var drv = function (id, name, camp, base, extra) { return Object.assign({ id: id, name: name, status: ST.ACTIVE, workStatus: '', campId: camp ? 'C1' : '', camp: camp, baseRoute: base }, extra || {}); };
    schRead_ = function (a, b) {
      var dates = schDateRange_(a, b), cells = { d1: {}, d2: {}, d3: {} };
      cells.d1[T] = '출근'; cells.d1[N] = '';            // 내일 빈 칸
      cells.d2[T] = '군포1 212CD'; cells.d2[N] = '출근 [용차]';
      cells.d3[T] = '미입차'; cells.d3[N] = '병가';
      return { dates: dates, holidays: {}, cells: cells, drivers: [drv('d1', '이현모', '군포1캠프', '212CD'), drv('d2', '강준길', '', '백업'), drv('d3', '유정근', '군포1캠프', '212AB')] };
    };
    frFind_ = function () { return [{ name: '강준길', campName: '군포1캠프', all: ['212C', '212D'] }]; };
    dataCheckView_ = function () { return { at: T + ' 04:56:00', items: [{ k: 'err', n: 4, list: ['a'] }, { k: 'pmBoth', label: '품앗이로 맡긴 날인데 맡긴 기사도 출근', n: 3, list: ['x', 'y', 'z'] }] }; };
    onlineMap_ = function () { return { d1: Date.now() }; };
    master_ = function () { return { camps: __M.main.camps }; };
    noticeAll_ = function () { return [{ id: 'N1', title: '공지', status: NST.ON, start: '', end: '2026-11-20', important: true, target: '', targetDrv: [], createdAt: T }]; };
    pmData_ = function () { return { jobs: [{ id: 'J9', status: PST.OPEN, date: N, camp: '군포1캠프', route: '212CD', kind: '주간' }], apps: [{ jobId: 'J9', status: PAST.APPLY, name: '강준길' }], avail: [] }; };
    rcRows_ = function () { return [{ kind: RCK.DRV, status: RCS.WAIT, date: '2026-11-18', name: '이현모', fromCamp: '군포1캠프', fromRoute: '212AB', toCamp: '군포1캠프', toRoute: '212CD' }, { kind: RCK.DRV, status: RCS.DONE, date: '2026-11-19', name: 'x' }]; };
    pkAll_ = function () { throw new Error('피크 탭 없음'); };      // 한 부분이 실패해도
    rpfSummary_ = function () { return { wk: 46, bad: 4, improve: 1 }; }; slaSummary_ = function () { return { low: 2, warn: 3 }; };
    softFail_ = function () {};
    props_ = function () { return { SCH_DB_ID: 'x', STL_DB_ID: '' }; };
    schIssues_ = function () { return [
      { id: 'I1', date: '2026-11-15', end: T, name: '유정근', kind: '질병', result: '병가', reason: '질병', mi: true, subWho: '강준길' },   // 오늘까지 진행 중
      { id: 'I2', date: '2026-11-12', end: '2026-11-12', name: '이현모', kind: '고장', result: '미입차', reason: '', mi: true },          // 지난 것 · 사유 없음
      { id: 'I3', date: '2026-11-19', end: '2026-11-19', name: '이현모', kind: '물량조율', result: '물량조율', reason: '기타' },             // 예정
      { id: 'I4', date: T, name: '메모', kind: '지시' }]; };
    var o = homeMain_(); __M.issueOut = o.issue;
    return { tiles: o.tiles, todo: o.todo.map(function (x) { return x.lv + ':' + x.k + ':' + x.n; }), soon: o.soon.map(function (x) { return x.date.slice(5) + ' ' + x.label; }),
      iss: [o.issue.today, o.issue.week, o.issue.by, o.issue.list[0].text], week: o.week.length, wk: o.week.filter(function (x) { return x.date === T; })[0], notice: o.notice, perf: o.perf, sys: o.sys.err };
  })()`, r.ctx);
  eq('숫자 칸 (소속 없는 백업 기사도 근무로 셈 · 내일 용차는 근무 아님)', out.tiles, { work: 2, off: 0, sick: 0, miss: 1, mi: 1, empty: 0, workTom: 0, online: 1, opened: 1, pm: 1, pmNew: 1 });
  eq('확인할 것: 급한 것(r) 먼저 · 건이 있는 것만', out.todo, ['r:empty:1', 'r:issNow:1', 'r:first:1', 'r:ck:pmBoth:3', 'r:pmApply:1', 'r:pmOpen:1', 'b:yong:1', 'b:issReason:1', 'b:pending:1', 'b:doc:1', 'b:unseen:1', 'b:nopush:1', 'b:report:1']);
  eq('다가오는 변경: 날짜순 (적용 끝난 변경 · 범위 밖은 빼고)', out.soon.filter(function (x) { return !/정산|쿠팡|계산서/.test(x); }), ['11-18 노선 변경 · 이현모', '11-19 이슈 예정 · 이현모', '11-20 공지 게시 종료 · 공지', '11-25 퇴사 예정 · 퇴사자']);
  eq('이슈: 오늘 진행 중 1 · 최근 7일 2 · 결과별 · 지시는 뺌 (오늘 이슈가 있으면 미입차 칸 줄은 숨김)', out.iss, [1, 2, { '병가': 1, '미입차': 1 }, '유정근 병가(질병) → 강준길']);
  eq('이번 주 7일 · 오늘 근무 2 미입차 1', [out.week, out.wk.work, out.wk.mi], [7, 2, 1]);
  eq('공지 읽음 수 · 수행률 · 어제 오류', [out.notice[0].read + '/' + out.notice[0].total, out.perf.bad, out.perf.slaLow, out.sys], ['1/4', 4, 2, 4]);
});

// 25) 품앗이로 맡긴 날 = 맡긴 기사 휴무: 확정 때 휴무 · 풀리면 원래 값 · 일부 노선만 맡긴 날 · 이미 휴무 · 손으로 고친 칸은 그대로
scenario('품앗이 맡긴 날 휴무', null, function (r) {
  const out = vm.runInContext(`(function () {
    var st = {}, o = function (op, id, v) { return { op: op, jobId: id, posterId: 'd1', driverId: 'd2', date: '2026-11-24', value: v }; };
    var a = pmGiveOffNext_(o('set', 'J1', '군포1 212CD'), '군포1 212CD', '백업', st);      // 백업 기사: 칸에 적힌 노선을 맡김
    var a2 = pmGiveOffNext_(o('set', 'J1', '군포1 212CD'), '출근', '212CD', st);            // 같은 일감 두 번째는 건드리지 않음
    var b = pmGiveOffNext_(o('set', 'J2', '군포1 212CD'), '출근', '212CD', st);              // 고정 기사: 출근 = 기본노선
    var c = pmGiveOffNext_(o('set', 'J3', '군포1 212C'), '출근', '212CD', st);               // 일부만 맡김 → 그대로
    var d = pmGiveOffNext_(o('set', 'J4', '군포1 212CD'), '휴무', '212CD', st);              // 이미 휴무
    var e = pmGiveOffNext_(o('clear', 'J1', '군포1 212CD'), '휴무', '백업', st);              // 확정 풀림 → 원래 값
    var f = pmGiveOffNext_(o('clear', 'J2', '군포1 212CD'), '병가', '212CD', st);             // 그 사이 손으로 고친 칸은 그대로
    var g = pmGiveOffNext_(o('clear', 'J9', '군포1 212CD'), '휴무', '212CD', st);             // 우리가 바꾼 적 없는 휴무
    return [a, a2, b, c, d, e, f, g, Object.keys(st).length];
  })()`, r.ctx);
  eq('확정 → 휴무 · 풀림 → 원래 값 · 나머지는 건드리지 않음', out, ['휴무', null, '휴무', null, null, '군포1 212CD', null, null, 0]);
});

// 26) 저장 빠르게: 휴대폰 알림 미루기 (1분 작업이 살아 있을 때만 · 아니면 바로) · 미뤄 둔 것 보내기
scenario('푸시 미루기', null, function (r) {
  const out = vm.runInContext(`(function () {
    var prop = {}, c = {}, sent = [];
    PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return prop[k] || null; }, setProperty: function (k, v) { prop[k] = v; }, deleteProperty: function (k) { delete prop[k]; } }; } };
    cache_ = function () { return { get: function (k) { return c[k] || null; }, put: function (k, v) { c[k] = v; }, remove: function (k) { delete c[k]; } }; };
    scriptLock_ = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
    pmPushSend_ = function (l) { sent.push(l.map(function (a) { return a.driverId; }).join(',')); return l.length; };
    var A = function (id) { return { driverId: id, title: 't', text: 'x', jobId: 'J', kind: 'k' }; };
    pmPushLater_([A('d1')]);                       // 1분 작업 표시 없음 → 바로
    var s1 = sent.slice();
    pmPushFlush_();                                // 살아 있음 표시 (보낼 것 없음)
    pmPushLater_([A('d2')]); pmPushLater_([A('d3'), { title: '받는 사람 없음' }]);
    var s2 = sent.slice(), q = JSON.parse(prop.PUSH_Q).length;
    pmPushFlush_();
    return [s1, s2, q, sent, prop.PUSH_Q === undefined];
  })()`, r.ctx);
  eq('바로 보냄 → 미룸(2건 쌓임) → 1분 작업이 한 번에 보내고 비움', out, [['d1'], ['d1'], 2, ['d1', 'd2,d3'], true]);
});

// 27) 끈 메뉴: 예외 기사(꺼도 쓰는 사람)는 꺼진 메뉴 없음 · 로그인 응답에도 끈 메뉴가 들어감
scenario('끈 메뉴 예외 기사', null, function (r) {
  const out = vm.runInContext(`(function () {
    appSet_ = function () { return { appMenu: '{"settle":0}', appMenuEx: '["d3"]' }; };
    return [appMenuOffFor_('d1'), appMenuOffFor_('d3'), /menuOff:/.test(String(api_login))];
  })()`, r.ctx);
  eq('일반 기사는 정산서 꺼짐 · 예외 기사는 없음 · 로그인 응답에 포함', out, [['settle'], [], true]);
});

// 28) 기사앱 화면 쪽: 공지 팝업·읽음 기록은 계정별 (예전 기록은 처음 읽는 계정이 넘겨받음 · 다른 계정은 빈 상태에서 시작)
(function () {
  try {
    const html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8'), i = html.indexOf('  const ntUk = '), j = html.indexOf('  const ntKey = ');
    const L = {}, box = { localStorage: { getItem: function (k) { return k in L ? L[k] : null; }, setItem: function (k, v) { L[k] = v; }, removeItem: function (k) { delete L[k]; } },
      cur: '{"loginId":"AAA"}', USER: 'u', ntMem: {}, JSON: JSON, String: String };
    box.store = { get: function () { return box.cur; } };
    vm.createContext(box);
    vm.runInContext(html.slice(i, j).replace(/const nt/g, 'var nt'), box);
    L['runner.ntPop'] = '["N1|x"]';
    const a1 = vm.runInContext("ntGet('runner.ntPop')", box);
    vm.runInContext("ntPut('runner.ntPop', ['N1|x', 'N2|y'])", box);
    box.cur = '{"loginId":"bbb"}';
    const b1 = vm.runInContext("ntGet('runner.ntPop')", box);
    box.cur = '{"loginId":"aaa"}';
    eq('공지 팝업 기록 계정별', [a1, b1, vm.runInContext("ntGet('runner.ntPop')", box), Object.keys(L).sort()], [['N1|x'], [], ['N1|x', 'N2|y'], ['runner.ntPop.aaa']]);
  } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · 공지 팝업 기록 계정별 (실행 오류) ' + (e && e.message)); }
})();

// 29) 자료 점검 추가분: 이슈 중복 · 대신 뛴 기사 칸 미반영 · 미입차인데 이슈 없음 · 퇴사자 남은 근무 칸 · 같은 노선 두 명(참고)
scenario('자료 점검 추가', null, function (r) {
  const out = vm.runInContext(`(function () {
    var T = '2026-11-16', N = '2026-11-17', P = '2026-11-15';
    softFail_ = function (l, e) { throw e; };
    master_ = function () { return { camps: __M.main.camps }; };
    var D = __M.main.drivers, byId = {}; D.forEach(function (o) { byId[o.id] = o; });
    D[2].workStatus = '퇴사'; D[2].leaveDate = '2026-11-16';                 // d3 유정근: 11/16 퇴사
    var I = function (id, drv, name, date, result, cut, sub, who) { return { id: id, driverId: drv, name: name, date: date, end: date, kind: '기타', result: result, cut: cut || '', sub: sub || '', subWho: who || '', link: 'Y' }; };
    schIssues_ = function () { return [I('I1', 'd1', '이현모', T, '물량조율', '212C (D2)', '업체백업', '강준길'), I('I2', 'd1', '이현모', T, '물량조율', '212C (D2)', '업체백업', '강준길'),
      I('I3', 'd4', '유정훈', N, '미입차', '', '없음'), { id: 'I4', driverId: 'd1', date: T, kind: '지시' }]; };
    issSubDrv_ = function (x) { return x.subWho === '강준길' ? byId.d2 : null; };
    var cell = { d1: {}, d2: {}, d3: {}, d4: {} };
    cell.d1[P] = '미입차'; cell.d1[T] = '출근'; cell.d1[N] = '출근';            // 11/15 미입차인데 이슈 없음
    cell.d2[P] = ''; cell.d2[T] = '휴무'; cell.d2[N] = '군포1 212CD';            // 대신 뛴 기사 오늘 칸이 휴무 · 내일은 d1 과 같은 노선
    cell.d3[P] = '출근'; cell.d3[T] = '출근'; cell.d3[N] = '출근';              // 퇴사 다음 날 근무 칸
    cell.d4[P] = ''; cell.d4[T] = ''; cell.d4[N] = '미입차';                    // 이슈 있음 · 내일이라 ⑭ 대상 아님
    var o = [];
    dataCheckMore_(o, { cell: cell, byId: byId, dates: [P, T, N], today: T, day: function (d) { return d.slice(5).replace('-', '/'); }, from: P, to: N });
    return o.map(function (x) { return x.k + (x.lv ? '(' + x.lv + ')' : '') + ':' + x.list.join(' / '); });
  })()`, r.ctx);
  eq('어긋난 자료 5가지', out, ['issDup:11/16 이현모 물량조율 212C (D2) × 2줄', 'issSub:11/16 이현모 물량조율 → 강준길 (칸: 휴무) / 11/16 이현모 물량조율 → 강준길 (칸: 휴무)',
    'miNoIss:11/15 이현모 · 미입차', 'goneSch:유정근 (퇴사) · 11/17', 'sameRoute(b):11/17 군포1 212 · 이현모, 강준길']);
});

// 30) 관리자 휴대폰: 날짜별 업무스케줄 표시(🗒) — 그날 적은 업무 + 항상 보기의 마감일 · 끝낸 것 · 비고 글은 뺌
(function () {
  try {
    const html = fs.readFileSync(path.join(SRC, 'Admin.html'), 'utf8'), i = html.indexOf('  const MMO = '), j = html.indexOf('  const mmoMark = ');
    const box = { HM: { ym: '2026-11', memos: [{ id: 'a', date: '2026-11-18', content: 'x' }, { id: 'b', date: '2026-11-18', done: true }, { id: 'c', date: '2026-11-18', note: true },
      { id: 'p', date: '2026-11-15', pin: true, until: '2026-11-20' }], pinned: [{ id: 'p', date: '2026-11-15', pin: true, until: '2026-11-20' }, { id: 'q', date: '2026-11-18', pin: true, until: '' }] }, calls: [], api: function (fn, ym) { box.calls.push(ym); return { then: function () { return { catch: function () { return { finally: function () {} }; } }; } }; }, window: {},
      keepP: { get: function (k, ym) { return k === 'mmo' && ym === '2026-12' ? { memos: [{ id: 'k', date: '2026-12-01' }], pinned: [] } : null; }, set: function () {} } };
    vm.createContext(box);
    vm.runInContext(html.slice(i, j).replace('const MMO', 'var MMO'), box);
    const ids = function (d) { return vm.runInContext("mmoOf('" + d + "').map(function (m) { return m.id; })", box); };
    eq('날짜별 업무스케줄 표시', [ids('2026-11-18'), ids('2026-11-20'), ids('2026-11-15'), ids('2026-12-01')], [['a', 'q'], ['p'], [], ['k']]);
    eq('지난번 업무스케줄 먼저 보여 주고 새로 받으러 감 (받는 중엔 다시 안 부름)', [ids('2026-12-01'), box.calls], [['k'], ['2026-12']]);
  } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · 날짜별 업무스케줄 표시 (실행 오류) ' + (e && e.message)); }
})();

// 31) 기사앱 미리 보기: 읽기만 통과 · 저장은 거절 · 만료 · 관리자 함수에 못 씀 · 대표/운영자만 · 모든 api_ 함수가 읽기/막음 중 하나로 분류돼 있는지
scenario('기사앱 미리 보기', null, function (r) {
  const all = []; fs.readdirSync(SRC).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) { (fs.readFileSync(path.join(SRC, f), 'utf8').match(/^function api_[A-Za-z]+/gm) || []).forEach(function (x) { all.push(x.replace('function ', '')); }); });
  const out = vm.runInContext(`(function () {
    var c = {}, logs = [], now = Date.now();
    cache_ = function () { return { get: function (k) { return c[k] || null; }, put: function (k, v) { c[k] = v; }, remove: function (k) { delete c[k]; } }; };
    tokenHash_ = function (t) { return 'h' + t; };
    var D = __M.main.drivers; D[1].status = '정지';
    driverByLogin_ = function (id) { return D.filter(function (o) { return o.loginId === id; })[0] || null; };
    driverById_ = function (id) { return D.filter(function (o) { return o.id === id; })[0] || null; };
    normLoginId_ = function (v) { return String(v); };
    logAdmin_ = function (a, act, t) { logs.push(act + ':' + t); };
    var who = 'jrd'; requireAdmin0 = requireAdmin_; requireAdmin_ = function () { return { name: 'x', loginId: who }; };
    var st = function (id) { var x = adm_previewStart('adm', id); return x.ok ? 'ok' : x.msg; };
    var r1 = st('d1');                         // 운영자(d3 jrd) → 됨
    var tok = Object.keys(c)[0].slice(4);       // 'pv:h' + 열쇠
    who = 'lhm'; var r2 = st('d3');            // 직함 없는 계정 → 안 됨
    who = 'jrd'; var r3 = st('d2');            // 정지 기사 → 안 됨
    var ses = function (fn, t) { _curFn = fn; _pv = false; try { var s = getSession_(t || tok); return s ? s.d + ':' + (s.pv ? 'pv' : '') + ':' + _pv : 'null'; } catch (e) { return e.code || 'ERR'; } };
    var a = ses('api_mySchedule'), b = ses('api_pmApply'), b2 = ses('api_changePassword'), b3 = ses('adm_listDrivers'), b4 = ses('api_seen');
    requireAdmin_ = requireAdmin0; _curFn = 'adm_listDrivers'; var adm = 'ok'; try { requireAdmin_(tok); } catch (e) { adm = 'blocked'; }
    var none = ses('api_mySchedule', 'PVnope');
    c[Object.keys(c)[0]] = JSON.stringify({ d: 'd1', a: 'jrd', e: now - 1 }); var exp = ses('api_mySchedule');
    return { start: [r1, /대표 · 운영자만/.test(r2), /승인/.test(r3)], ses: [a, b, b2, b3, b4, adm, none, exp], logs: logs, read: PVW.READ, write: PVW.WRITE };
  })()`, r.ctx);
  eq('열쇠 발급: 운영자 O · 직함 없음 X · 정지 기사 X · 기록 남김', [out.start, out.logs], [['ok', true, true], ['기사앱 미리 보기:이현모 (d1)']]);
  eq('읽기 통과 · 저장/비밀번호/관리자 함수 거절 · 없는 열쇠 · 만료', out.ses, ['d1:pv:true', 'PREVIEW', 'PREVIEW', 'PREVIEW', 'd1:pv:true', 'blocked', 'null', 'null']);
  const both = out.read.filter(function (x) { return out.write.indexOf(x) >= 0; }), cls = out.read.concat(out.write);
  eq('모든 기사앱 함수가 읽기/막음 중 하나로 분류됨 (새 함수를 만들면 Preview.gs 에 적어야 함)', [all.filter(function (x) { return cls.indexOf(x) < 0; }), cls.filter(function (x) { return all.indexOf(x) < 0; }), both], [[], [], []]);
});

// 32) 스케줄 변경 알림 묶기: 오늘·내일은 바로 · 그 뒤 날짜는 마지막 수정 뒤 10분 지나야
scenario('스케줄 변경 알림 묶기', null, function (r) {
  const out = vm.runInContext(`(function () {
    toMs_ = function (v) { return v ? Number(v) : 0; };
    var now = 1000000000, f = function (key, ago) { return seenChangeDue_({ key: key, at: ago == null ? '' : String(now - ago) }, '2026-11-17', now); };
    return [f('2026-11-16', 0), f('2026-11-17', 1000), f('2026-11-18', 1000), f('2026-11-18', 599000), f('2026-11-18', 600000), f('2026-11-25', null)];
  })()`, r.ctx);
  eq('오늘 · 내일 바로 / 모레 이후는 10분 조용해야 / 시각 없는 옛 기록은 바로', out, [true, true, false, false, true, true]);
});

// 33) 기사앱 빈칸 '예정': 고정 기사 = 담당 노선 · 고정휴무 / 백업 = 미정 (+고정휴무 요일) / 패턴 스위치 = 최근 3주 같은 요일이 같을 때만 / 적힌 칸 · 지난 날 · 퇴사 뒤 · 직함자 제외
scenario('기사앱 빈칸 예정', null, function (r) {
  const out = vm.runInContext(`(function () {
    var today = '2026-11-16', dates = []; for (var i = 9; i <= 22; i++) dates.push('2026-11-' + (i < 10 ? '0' + i : i)); // 11/9(월) ~ 11/22(일)
    var mk = function (x) { return Object.assign({ status: ST.ACTIVE, driverType: '고정', baseRoute: '212CD', fixedOff: '화,수', title: '', workStatus: '', planPat: '' }, x); };
    var H = {}; // 지난 칸 (패턴용): 월 = 3주 같음 · 목 = 3주 휴무 · 금 = 한 주 다름 · 토 = 병가 끼임
    ['2026-11-09', '2026-11-02', '2026-10-26'].forEach(function (d) { H[d] = '강서1 527B [B01]'; });
    ['2026-11-12', '2026-11-05', '2026-10-29'].forEach(function (d, i) { H[d] = i ? '휴무' : '고정휴무'; });
    H['2026-11-13'] = '530AB'; H['2026-11-06'] = '530AB'; H['2026-10-30'] = '529B';
    H['2026-11-14'] = '527B'; H['2026-11-07'] = '병가'; H['2026-10-31'] = '527B';
    var valAt = function (d) { return H[d] || ''; };
    var show = function (o, cells) { var p = splPlan_(o, dates, cells || {}, today, valAt); return dates.filter(function (d) { return p[d]; }).map(function (d) { return d.slice(8) + ':' + (p[d].v || '미정') + '/' + p[d].k; }).join(' '); };
    return {
      fix: show(mk({}), { '2026-11-18': '휴가', '2026-11-19': '출근' }),
      noOff: show(mk({ fixedOff: '' })).split(' ').length + ':' + show(mk({ fixedOff: '조정 백업에 맞혀서' })).split(' ')[0],
      bk: show(mk({ driverType: '백업', baseRoute: '백업', fixedOff: '일' })),
      pat: show(mk({ driverType: '백업', baseRoute: '백업', fixedOff: '일', planPat: 'Y' })),
      none: [show(mk({ title: '운영자' })), show(mk({ status: '정지' })), show(mk({ driverType: '외부용차' })), show(mk({ baseRoute: '용차' }))],
      leave: show(mk({ workStatus: '퇴사', leaveDate: '2026-11-18' })),
      off: [splOffDows_('목,금'), splOffDows_('일요일'), splOffDows_('수.목'), splOffDows_('주5일'), splOffDows_('')]
    };
  })()`, r.ctx);
  eq('고정 기사: 오늘부터 빈칸만 · 화수 고정휴무 · 나머지 출근 · 적힌 칸(18 · 19)은 건드리지 않음', out.fix, '16:출근/fix 17:고정휴무/fix 20:출근/fix 21:출근/fix 22:출근/fix');
  eq('고정휴무 없음 = 전부 출근(7일) · 요일로 안 적었으면 미정', out.noOff, '7:16:미정/tbd');
  eq('백업: 고정휴무 요일만 예정 · 나머지 미정', out.bk, '16:미정/tbd 17:미정/tbd 18:미정/tbd 19:미정/tbd 20:미정/tbd 21:미정/tbd 22:고정휴무/fix');
  eq('패턴 스위치: 3주 같은 월(노선 · 대괄호 뺌) · 목(휴무)만 예정 / 다른 주 · 병가 낀 요일은 미정', out.pat, '16:강서1 527B/pat 17:미정/tbd 18:미정/tbd 19:휴무/pat 20:미정/tbd 21:미정/tbd 22:고정휴무/fix');
  eq('직함자 · 정지 · 외부용차 · 용차 노선은 예정 없음', out.none, ['', '', '', '']);
  eq('퇴사: 퇴사일 다음 날부터 예정 없음', out.leave, '16:출근/fix 17:고정휴무/fix 18:고정휴무/fix');
  eq('고정휴무일 읽기', out.off, [[4, 5], [0], [3, 4], null, []]);
});

// 34) 기사앱 달력: 내 칸 노선 = 확정 품앗이(수행) 노선이면 품앗이 칩은 그리지 않고 🤝 아이콘만 (같은 노선이 두 번 보이지 않게)
(function () {
  try {
    const html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8'), i = html.indexOf('  function pmOfDay('), j = html.indexOf('  function pmDoneRow(');
    const box = {}; vm.createContext(box);
    vm.runInContext('var escH = function (x) { return String(x); };' + html.slice(i, j), box);
    const f = function (pm, pc) { box.R = { pumasi: { d: pm } }; box.PC = pc; return vm.runInContext("pmSame(R, 'd', PC)", box); };
    const job = function (o) { return [Object.assign({ id: 'j', role: '수행', status: '확정', camp: '인천8캠프', route: '103AB' }, o)]; };
    eq('같은 노선 품앗이 합치기', [f(job({}), { routes: '103AB', camp: '' }), f(job({}), { routes: '103AB', camp: '인천8' }), f(job({}), { routes: '122CD', camp: '' }), f(job({}), { routes: '103AB', camp: '강서1' }),
      f(job({ status: '신청' }), { routes: '103AB' }), f(job({ role: '맡김' }), { routes: '103AB' }), f(job({}), null), f(job({}), { routes: '', raw: '휴무' })], [true, true, false, false, false, false, false, false]);
    const cell = function (pc) { box.R = { pumasi: { d: job({}) } }; box.PC = pc; return vm.runInContext("pmCell(R, 'd', PC).html", box); };
    eq('같은 노선이면 품앗이 칩을 또 그리지 않음 (아이콘만) · 다른 노선 · 휴무 칸이면 칩 표시', [cell({ routes: '103AB' }), /103AB/.test(cell({ routes: '122CD' })), /103AB/.test(cell(null))], ['', true, true]);
  } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · 같은 노선 품앗이 합치기 (실행 오류) ' + (e && e.message)); }
})();

// 35) 산재/고용 연간 표 체크: 잇달아 누른 칸을 모아 한 번에 저장 · 눌렀다 되돌린 칸은 안 보냄 · 실패하면 화면 되돌림 · 저장 중 누른 칸은 다음 묶음으로
(function () {
  try {
    const html = fs.readFileSync(path.join(SRC, 'Admin.html'), 'utf8'), i = html.indexOf('  function iyToggle('), j = html.indexOf("  /** 칸 상태 바꾸기: to = 'ex'");
    const cell = function () { return { st: 'no', date: '', bosu: 1, sanOn: true, goyOn: true, start: '', memo: '' }; };
    const box = { calls: [], timers: [], toasts: [], res: [], IR: { month: '2026-10', rows: [1] }, confirm: function () { return true; }, renderInsYear: function () {}, toast: function (m) { box.toasts.push(m); },
      dToday: function () { return '2026-11-16'; }, dMon: function (m) { return m; }, setTimeout: function (f) { box.timers.push(f); return box.timers.length; }, clearTimeout: function (n) { if (n) box.timers[n - 1] = null; },
      IY: { keep: new Set(), info: { from: '', today: '2026-11-16', dues: {}, drivers: [{ acct: 'a', driverId: 'd1', name: '가', cells: { '2026-09': cell(), '2026-10': cell() } }, { acct: 'b', driverId: 'd2', name: '나', cells: { '2026-10': cell() } }] } },
      api: function (fn, items) { box.calls.push(fn + ':' + items.map(function (it) { return it.month + '=' + it.list.map(function (x) { return x.name + (x.done ? '+' : '-'); }).join(''); }).join(' ')); var h = {}; box.res.push(function (v) { try { h.t && h.t(v); } catch (e) { h.c && h.c(e); } h.f && h.f(); }); return { then: function (f) { h.t = f; return this; }, catch: function (f) { h.c = f; return this; }, finally: function (f) { h.f = f; return this; } }; } };
    vm.createContext(box); vm.runInContext(html.slice(i, j), box);
    const run = function () { const t = box.timers; box.timers = []; t.forEach(function (f) { if (f) f(); }); }, st = function () { return box.IY.info.drivers.map(function (d) { return Object.keys(d.cells).map(function (m) { return d.cells[m].st; }).join(','); }).join('|'); };
    box.iyToggle('a', '2026-09'); box.iyToggle('a', '2026-10'); box.iyToggle('b', '2026-10'); box.iyToggle('b', '2026-10'); // 나 는 눌렀다 되돌림
    const shown = st(), before = box.calls.length; run();
    box.iyToggle('b', '2026-10'); run(); // 저장 중에 누름 → 아직 안 보냄
    const mid = box.calls.slice();
    box.res.shift()({ ok: true }); run();
    const second = box.calls.slice(); box.res.shift()({ ok: false, msg: 'x' });
    eq('연간 표 체크 묶어 저장', [shown, before, mid, second, st(), box.toasts], ['done,done|no', 0, ['adm_insRepSetMany:2026-09=가+ 2026-10=가+'], ['adm_insRepSetMany:2026-09=가+ 2026-10=가+', 'adm_insRepSetMany:2026-10=나+'], 'done,done|no', ['2칸을 저장했습니다.', 'x']]);
  } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · 연간 표 체크 묶어 저장 (실행 오류) ' + (e && e.message)); }
})();

// 저장 가볍게 (Later.gs): 작업 기록 · 기사 확인 기록을 1분 작업에 맡김 — 1분 작업이 살아 있을 때만 · 아니면 바로 · 미뤄 둔 것은 순서대로 한 번에
scenario('나중 처리', null, function (r) {
  const out = vm.runInContext(`(function () {
    var prop = {}, c = {}, app = [], sets = [], seen = [];
    PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return prop[k] || null; }, setProperty: function (k, v) { prop[k] = v; }, deleteProperty: function (k) { delete prop[k]; },
      getKeys: function () { return Object.keys(prop); }, getProperties: function () { return Object.assign({}, prop); } }; } };
    cache_ = function () { return { get: function (k) { return c[k] || null; }, put: function (k, v) { c[k] = v; }, remove: function (k) { delete c[k]; } }; };
    scriptLock_ = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
    sheet_ = function () { return { appendRow: function (row) { app.push(row[2]); }, getLastRow: function () { return 10; }, getMaxRows: function () { return 1000; }, insertRowsAfter: function () {},
      getRange: function (r0, c0, n, w) { return { setValues: function (v) { sets.push(r0 + ':' + n + 'x' + w + ':' + v.map(function (x) { return x[2]; }).join(',')); } }; } }; };
    seenSchChanges_ = function (a, list) { seen.push(a.loginId + ':' + list.map(function (x) { return x.row + x.date.slice(8) + x.value; }).join(',')); return list.length; };
    todayText_ = function () { return '2026-11-10'; };
    var A = { name: '관리자', loginId: 'adm' }, lq = function () { return Object.keys(prop).filter(function (k) { return k.indexOf('LQ_') === 0; }).length; };
    logAdmin_(A, '바로', 'x', '');                                   // 1분 작업 표시 없음 → 바로 씀
    var s1 = [app.slice(), lq()];
    c['pq:alive'] = '1';
    logAdmin_(A, '하나', 'x', ''); logAdmin_(A, '둘', 'y', 'z');
    seenSchLater_(A, [{ row: 'd1', date: '2026-11-12', value: '휴무', old: '출근' }, { row: 'd1', date: '2026-11-01', value: '휴무', old: '출근' }, { row: 'd2', date: '2026-11-13', value: '출근', old: '' }]); // 지난 날 · 빈칸이던 칸은 뺌
    seenSchLater_(A, [{ row: 'NOTE1', date: '2026-11-12', value: 'a', old: 'b' }]);  // 알릴 것 없음 → 적지 않음
    logAdmin_(A, '큰것', 'x', new Array(9000).join('가'));            // 너무 큼 → 바로
    var s2 = [app.slice(), sets.slice(), seen.slice(), lq(), !!c['lq:has']];
    var n = laterFlush_();
    var s3 = [n, app.slice(), sets.slice(), seen.slice(), lq(), !!c['lq:has']];
    var n2 = laterFlush_();                                         // 다시 불러도 두 번 쓰지 않음
    c['lq:has'] = '300'; logAdmin_(A, '넘침', 'x', '');               // 너무 많이 쌓였으면 바로
    return [s1, s2, s3, n2, sets.length, app.slice(-1)[0], lq()];
  })()`, r.ctx);
  eq('1분 작업이 안 돌면 바로 기록', out[0], [['바로'], 0]);
  eq('살아 있으면 미룸 (큰 것만 바로 · 알릴 변경 없는 저장은 적지 않음)', out[1], [['바로', '큰것'], [], [], 3, true]);
  eq('1분 작업: 작업 기록은 한 번에 · 확인 기록은 고른 칸만 · 비움', out[2], [3, ['바로', '큰것'], ['11:2x5:하나,둘'], ['adm:d112휴무'], 0, false]);
  eq('다시 처리해도 중복 없음 · 넘치면 바로', [out[3], out[4], out[5], out[6]], [0, 1, '넘침', 0]);
});

// 저장 가볍게: 이슈와 상관없는 칸(출근·휴무)만 고치면 이슈 시트를 다시 읽지 않음 (캐시해 둔 연동 이슈 기간표로 판단) · 걸친 이슈가 있으면 읽음
scenario('이슈 연동 건너뛰기', null, function (r) {
  const out = vm.runInContext(`(function () {
    var c = {}, big = {}, reads = 0;
    cache_ = function () { return { get: function (k) { return c[k] || null; }, put: function (k, v) { c[k] = v; }, remove: function (k) { delete c[k]; } }; };
    stlCGet_ = function (k) { return k in big ? JSON.parse(big[k]) : null; }; stlCPut_ = function (k, v) { big[k] = JSON.stringify(v); };
    RCV.dirty = {}; c['rcv:iss'] = 'v1';
    var ISS0 = [{ id: 'I1', row: 2, driverId: 'd1', date: '2026-11-20', end: '2026-11-21', result: '미입차', link: 'Y', kind: '미입차', orig: {} }, { id: 'I2', row: 3, driverId: 'd2', date: '2026-11-20', end: '2026-11-20', result: '', link: 'Y', kind: '지시', orig: {} }];
    schIssues_ = function () { reads++; return JSON.parse(JSON.stringify(ISS0)); };
    schIssueSheet_ = function () { throw new Error('이슈 시트를 열면 안 됨'); };
    var A = { name: '관리자', loginId: 'adm' };
    var r1 = issFromCells_(A, [{ row: 'd1', date: '2026-11-18', value: '휴무', old: '출근' }]); var n1 = reads;   // 기간표를 만드느라 1번
    var r2 = issFromCells_(A, [{ row: 'd2', date: '2026-11-20', value: '출근', old: '휴무' }, { row: 'd1', date: '2026-11-19', value: '', old: '출근' }]); var n2 = reads; // 캐시 → 0번 ('지시'는 걸친 이슈로 치지 않음)
    var opened = false; schIssueSheet_ = function () { opened = true; throw new Error('stop'); };
    try { issFromCells_(A, [{ row: 'd1', date: '2026-11-21', value: '출근', old: '미입차' }]); } catch (e) { /* 시트까지 갔는지만 봄 */ }
    return [r1.created.length + r1.changed.length + r1.removed.length, n1, r2.created.length + r2.changed.length + r2.removed.length, n2, reads > n2, opened];
  })()`, r.ctx);
  eq('상관없는 칸은 읽지 않고 끝 · 이슈에 걸친 칸은 지금처럼 처리', out, [0, 1, 0, 1, true, true]);
});

// 읽기 묶음 (adm_batch): 허용한 읽기만 · 보낸 순서대로 · 하나가 실패해도 나머지는 그대로 · 저장 함수는 묶지 않음
scenario('읽기 묶음', null, function (r) {
  const out = vm.runInContext(`(function () {
    var got = [];
    adm_uiText = function (t, x) { got.push('ui:' + t + ':' + x); return { ok: true, map: { a: 1 } }; };
    adm_pmList = function (t, q) { got.push('pm:' + q.q); throw new Error('터짐'); };
    adm_peakMap = function (t) { got.push('pk'); return { ok: false, msg: '없음' }; };
    adm_schSave = function () { got.push('저장됨'); return { ok: true }; };
    errLog_ = function () {};
    var r = adm_batch('T', [{ fn: 'adm_uiText', args: ['T', false] }, { fn: 'adm_pmList', args: ['T', { q: '홍' }] }, { fn: 'adm_schSave', args: ['T', []] }, { fn: 'adm_peakMap', args: ['T'] }, { fn: 'eval', args: [] }]);
    var g0 = got.slice(); var big = adm_batch('T', new Array(20).fill({ fn: 'adm_uiText', args: ['T', true] }));
    return [r.ok, r.res.map(function (x) { return x && (x.code || (x.ok ? 'ok' : x.msg)); }), g0, big.res.length, FS_READ_FNS.indexOf('adm_batch') >= 0];
  })()`, r.ctx);
  eq('순서 · 실패 따로 · 저장/모르는 함수는 거절', out, [true, ['ok', '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', 'NOBATCH', '없음', 'NOBATCH'], ['ui:T:false', 'pm:홍', 'pk'], 12, true]);
});

// 읽기 묶음 (관리자앱 gsCall0): 30ms 안의 읽기는 한 번에 · 저장은 따로 · 서버가 옛 버전(묶음 모름)이면 하나씩 · 연결 실패는 다시 보내지 않음
(function () {
  try {
    // 바로 끝나는 약속 (시험이 기다리지 않게)
    const SP = function (ex) { const me = this; me.s = 0; me.q = []; const fin = function (s, v) { if (me.s) return; me.s = s; me.v = v; me.q.forEach(function (f) { f(); }); }; ex(function (v) { fin(1, v); }, function (e) { fin(2, e); }); };
    SP.prototype.then = function (f, g) { const me = this; return new SP(function (res, rej) { const go = function () { try { const h = me.s === 1 ? f : g; if (!h) return (me.s === 1 ? res : rej)(me.v); const v = h(me.v); if (v && v.then) v.then(res, rej); else res(v); } catch (e) { rej(e); } }; if (me.s) go(); else me.q.push(go); }); };
    SP.ok = function (v) { return new SP(function (r) { r(v); }); }; SP.no = function (e) { return new SP(function (r, j) { j(e); }); };
    const html = fs.readFileSync(path.join(SRC, 'Admin.html'), 'utf8'), i = html.indexOf('  const BATCH_OK = new Set('), j = html.indexOf('  function gsCallOne(');
    const box = { sent: [], timers: [], setTimeout: function (f) { box.timers.push(f); return box.timers.length; }, clearTimeout: function (n) { if (n) box.timers[n - 1] = null; }, Promise: SP, Set: Set, Array: Array };
    box.gsCallOne = function (fn, args) { box.sent.push(fn === 'adm_batch' ? 'B:' + args[1].map(function (x) { return x.fn; }).join(',') : fn); return box.reply(fn, args); };
    vm.createContext(box);
    vm.runInContext(html.slice(i, j), box);
    const tick = function () { const t = box.timers.slice(); box.timers.length = 0; t.forEach(function (f) { if (f) f(); }); };
    const val = function (p) { let out; p.then(function (v) { out = v && v.who !== undefined ? v.who : v; }, function (e) { out = 'ERR:' + e.message; }); return out; };
    // 1) 묶음 · 결과 나눠 주기 · 저장은 따로 · 묶을 수 없다고 하면 하나씩
    box.reply = function (fn, args) { return SP.ok(fn === 'adm_batch' ? { ok: true, res: args[1].map(function (x) { return x.fn === 'adm_peakMap' ? { ok: false, code: 'NOBATCH' } : { ok: true, who: x.fn }; }) } : { ok: true, who: fn + '(1)' }); };
    const ps = ["gsCall0('adm_uiText', ['T', false])", "gsCall0('adm_schRange', ['T', 'a', 'b'])", "gsCall0('adm_peakMap', ['T'])", "gsCall0('adm_schSave', ['T', []])"].map(function (c) { return vm.runInContext(c, box); });
    tick(); tick();
    eq('읽기 3개 묶음 · 저장 따로 · 묶을 수 없다고 하면 하나씩', [box.sent, ps.map(val)], [['adm_schSave', 'B:adm_uiText,adm_schRange,adm_peakMap', 'adm_peakMap'], ['adm_uiText', 'adm_schRange', 'adm_peakMap(1)', 'adm_schSave(1)']]);
    // 2) 하나만이면 묶지 않음 · 서버가 옛 버전 → 하나씩 · 연결 실패 → 모두 실패 (다시 보내지 않음)
    box.sent.length = 0; box.reply = function (fn) { return SP.ok(fn === 'adm_batch' ? { ok: false, code: 'UNKNOWN_FN' } : { ok: true, who: fn }); };
    const p1 = vm.runInContext("gsCall0('adm_live', ['T'])", box); tick();
    const q2 = ["gsCall0('adm_uiText', ['T'])", "gsCall0('adm_pmList', ['T', {}])"].map(function (c) { return vm.runInContext(c, box); }); tick();
    const s2 = box.sent.slice();
    box.sent.length = 0; box.reply = function () { return SP.no(new Error('NET')); };
    const q3 = ["gsCall0('adm_uiText', ['T'])", "gsCall0('adm_pmList', ['T', {}])"].map(function (c) { return vm.runInContext(c, box); }); tick();
    eq('하나면 그대로 · 옛 서버면 하나씩 · 연결 실패는 한 번만 보냄', [val(p1), s2, q2.map(val), box.sent, q3.map(val)],
      ['adm_live', ['adm_live', 'B:adm_uiText,adm_pmList', 'adm_uiText', 'adm_pmList'], ['adm_uiText', 'adm_pmList'], ['B:adm_uiText,adm_pmList'], ['ERR:NET', 'ERR:NET']]);
  } catch (e) { count++; failed++; console.error('FAIL 자동 시험 · 읽기 묶음 화면 (실행 오류) ' + (e && e.stack || e)); }
})();

if (require.main === module) {
  if (failed) { console.error('\n자동 시험 실패 ' + failed + '건 / ' + count + '개'); process.exit(1); }
  console.log('OK   자동 시험 ' + count + '개');
}
module.exports = { failed: failed, count: count };
