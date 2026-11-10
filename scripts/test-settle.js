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
  failed++; console.error('FAIL 정산 시험 · ' + label + '\n     기대 ' + JSON.stringify(want) + '\n     실제 ' + JSON.stringify(got));
}
function scenario(name, change, check) {
  try { check(run(change)); } catch (e) { count++; failed++; console.error('FAIL 정산 시험 · ' + name + ' (실행 오류)\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
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

if (require.main === module) {
  if (failed) { console.error('\n정산 시험 실패 ' + failed + '건 / ' + count + '개'); process.exit(1); }
  console.log('OK   정산 시험 ' + count + '개');
}
module.exports = { failed: failed, count: count };
