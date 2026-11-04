/**
 * 정산관리 (쿠팡 정산 → 기사 정산·명세서·입금목록)
 *
 * 데이터 위치
 *  - 기사 · 노선 · 단가 : 러너 올인원 DB (drivers / camps / routes / route_prices) 에서만 읽는다
 *  - 근무일수         : 러너 올인원 스케줄 DB (schedule) 에서만 읽는다
 *  - 쿠팡 정산서 원천·공제·가불·용차·설정 : 별도 파일 "러너 올인원 정산 DB" (스크립트 속성 STL_DB_ID)
 *    모든 탭은 1행 머리글 + 한 줄 = 기록 하나. 시트에서 직접 고쳐도 다음 조회 때 그대로 계산된다.
 *  - 올린 쿠팡 정산 엑셀 원본 : 드라이브 "러너 올인원 데이터/쿠팡 정산서" 폴더 (yyyy-MM_N차.xlsx)
 *
 * 정산 기간: 전월 26일 ~ 당월 25일 = 당월 정산 (예: 2026-10 = 2026-09-26 ~ 2026-10-25)
 * 금액: 쿠팡 정산서는 공급가, 기사 단가·지급은 모두 부가세 포함.
 */

// ───────────────────────── 탭 정의 (값 = 머리글, 이름 바꾸지 말 것) ─────────────────────────
const STL_TABS = {
  stl_raw: {
    month: '정산월', round: '차수', kind: '구분', cid: '쿠팡ID', route: '라우트', date: '배송일자', camp: '캠프명',
    dtype: '배송유형', vendor: '업체명', qty: '배송건수', ret: '반품건수', price: '단가', inc: '추가인센티브(건당)',
    base: '기본배송금액', incAmt: '추가인센티브금액', total: '총금액', fresh: '프레시백'
  },
  stl_loss: {
    month: '정산월', round: '차수', date: '날짜', camp: '캠프', cid: '쿠팡ID', type: '유형', detail: '상세', cnt: '개수',
    amt: '차감금액', vendor: '업체명', waybill: '운송장번호', item: '상품명'
  },
  stl_rounds: {
    month: '정산월', round: '차수', file: '파일명', url: '파일 링크', at: '불러온 시각', cid: '쿠팡ID',
    amt: '쿠팡 금액', prev: '직전 차수 금액', diff: '변동액', memo: '변경사유'
  },
  // 정산의 기준 = 쿠팡 아이디. 메인 아이디 + 서브 아이디 = 정산 묶음 하나, 정산금은 메인 아이디 명의자에게
  stl_ids: {
    cid: '쿠팡ID', role: '구분', main: '메인 아이디', owner: '명의자', ownerId: '명의자 기사ID', type: '단가 구분',
    mode: '정산 방식', insEx: '산재·고용 제외', fbCut: '프레시백 차감', status: '상태', memo: '메모'
  },
  // 한 아이디로 여러 기사가 일할 때: 그 기간 그 아이디로 일한 기사 (지급은 명의자, 일시단가·근무일 판단에 씀)
  stl_usage: { cid: '쿠팡ID', name: '일한 기사', driverId: '기사ID', from: '시작일', to: '종료일', memo: '메모' },
  // 기사 일시단가: 그 기사가 일한 날(아이디 사용 기록 기준)의 배송에만 적용
  stl_tmp: { name: '기사', driverId: '기사ID', from: '시작일', to: '종료일', price: '일시단가', routes: '적용 노선', memo: '메모' },
  stl_adjust: { month: '정산월', name: '명의자', acct: '정산 아이디', item: '항목', amt: '금액', memo: '메모' },
  stl_advance: { name: '명의자', acct: '정산 아이디', date: '지급일', amt: '가불금', due: '상계 예정일', paid: '상환금', memo: '메모' },
  stl_yongcha: {
    date: '날짜', who: '수행자', whoId: '수행 정산 아이디', route: '라우트', mode: '지급구분', price: '단가/금액', qty: '건수',
    payer: '차액부담', payerId: '차액부담 정산 아이디', payerPrice: '부담 기준단가', memo: '메모'
  },
  stl_regular: { name: '명의자', acct: '정산 아이디', item: '항목', amt: '월 금액', from: '시작월', to: '종료월', memo: '메모' },
  stl_target: { name: '명의자', acct: '정산 아이디', item: '항목', goal: '연 목표 계산서', unit: '단위' },
  stl_split: { from: '원 명의자', fromId: '원 정산 아이디', to: '받는 명의자', toId: '받는 정산 아이디', target: '목표 실수령', unit: '단위', repeat: '매달 반복', month: '적용월' },
  stl_leave: { name: '명의자', acct: '정산 아이디', month: '퇴사월', amt: '보류금' },
  stl_items: { order: '순서', side: '구분', name: '항목 이름', method: '계산 방식', show: '표시', taxCut: '계산서에서 빼기', desc: '설명' },
  stl_camps: { camp: '캠프명', expense: '경비공제율', san: '산재율', goy: '고용율', runner: '러너부담률' },
  stl_kinds: { raw: '쿠팡 구분 값', std: '표준 분류' },
  stl_config: { label: '항목', value: '값', desc: '설명' },
  stl_pay: { month: '정산월', acct: '정산 아이디', name: '명의자', checked: '입금체크', date: '입금일', memo: '메모' },
  stl_close: { month: '정산월', at: '마감일시', admin: '관리자' },
  stl_closed: { month: '정산월', acct: '정산 아이디', data: '결과(자동)' }
};
const STL_TAB_NOTES = {
  stl_ids: '정산의 기준. 쿠팡 아이디 한 줄 = 하나. 구분: 메인 / 서브(메인 아이디 칸에 메인 쿠팡ID). 명의자 = 정산금·세금계산서를 받는 기사(이름). 단가 구분: 고정 / 백업 / 품앗이 / 외부용차 (메인 아이디는 기사 정보관리의 기사구분이 우선, 서브 아이디는 이 칸이 우선). 정산 방식: 비우면 구분별 단가 / 원청단가 / 용차내역. 쿠팡 정산서를 올릴 때 처음 보는 아이디는 자동으로 추가됩니다.',
  stl_usage: '한 아이디로 여러 기사가 일할 때, 그 아이디로 일한 기사와 기간. 비우면 명의자가 일한 것으로 봅니다. 정산금은 항상 명의자에게 갑니다.',
  stl_tmp: '기사가 정해진 기간 동안 다른 단가로 일할 때. 적용 노선을 비우면 전체, 708C 또는 시흥2|708C 처럼 쉼표로 여러 개.',
  stl_raw: '쿠팡 정산 엑셀을 [정산관리 → 쿠팡 정산서 올리기]로 넣으면 자동으로 채워집니다. 한 정산월에는 마지막으로 올린 차수만 남습니다.',
  stl_adjust: '기사별 월 추가지급·차감. 항목은 stl_items 의 "항목 이름". 금액은 차감도 양수로.',
  stl_advance: '가불금 원장. 상환하면 상환금 칸에 금액. 그 달 정산에서 빼려면 stl_adjust 에 "가불금 상환" 줄을 넣으세요.',
  stl_yongcha: '지급구분: 건당 / 금액. 단가를 비우면 설정의 "용차 수행단가". 건수를 비우면 쿠팡 정산서에서 자동으로 셉니다.',
  stl_config: '값만 고치세요. % 는 10% 처럼 써도 됩니다.',
  stl_closed: '마감할 때 프로그램이 기록합니다. 손으로 고치지 마세요.'
};

const STL_KIND_DEFAULT = [
  ['배송', '배송'], ['수기반영', '수기반영'], ['재사용포장재 회수 인센티브', '프레시백'], ['미계약 라우트', '미계약'],
  ['시설 및 장비 사용료', '업체차감'], ['추가 인센티브 전월소급', '기타'], ['프로모션', '기타']
];
const STL_STD_KINDS = ['배송', '수기반영', '프레시백', '미계약', '업체차감', '기타'];

// 명세서 항목 기본값 (순서, 구분, 이름, 계산 방식, 표시, 계산서에서 빼기, 설명)
const STL_ITEM_DEFAULT = [
  ['1', '지급', '배송 기본', '배송기본', '항상', '', '노선 배송료 + 프백 가중치'],
  ['1.5', '지급', '용차(지급)', '용차수행', '금액 있을 때', '', '휴무자 대신 뛴 용차 추가지급 / 용차업체 지급액'],
  ['2', '지급', '프레시백', '프레시백', '항상', '', '프레시백 회수 인센티브'],
  ['2.5', '지급', '매출 분할 수령', '직접입력', '금액 있을 때', '', ''],
  ['2.8', '지급', '보류금 반환', '입금가산', '금액 있을 때', '', '계산서 제외 · 실입금에만 더함'],
  ['3', '지급', '미계약 라우트', '미계약', '금액 있을 때', '', ''],
  ['4', '지급', '기타 (프로모션)', '기타프로모션', '금액 있을 때', '', '프로모션·소급 등'],
  ['5', '지급', '팀장수당', '직접입력', '금액 있을 때', '', ''],
  ['5.5', '지급', '유류비지원', '직접입력', '금액 있을 때', '', ''],
  ['6', '차감', '분실파손 부담', '분실파손', '항상', 'Y', ''],
  ['7', '차감', '용차(지출)', '용차지출', '금액 있을 때', 'Y', '용차 단가 − 기사 단가 차액'],
  ['8', '차감', '계산서 차감', '직접입력', '금액 있을 때', 'Y', ''],
  ['8.5', '차감', '매출 분할 이전', '직접입력', '금액 있을 때', 'Y', ''],
  ['9', '차감', '산재보험', '산재보험', '항상', 'N', ''],
  ['10', '차감', '고용보험', '고용보험', '항상', 'N', ''],
  ['11', '차감', '가불금 상환', '직접입력', '금액 있을 때', 'N', '입금액에서만 차감'],
  ['11.5', '차감', '퇴사 보류금', '직접입력', '금액 있을 때', 'N', ''],
  ['12', '차감', '기타 공제', '직접입력', '금액 있을 때', 'N', '차량비·유류비 등']
];
const STL_METHODS = ['배송기본', '프레시백', '미계약', '기타프로모션', '분실파손', '용차지출', '용차수행', '산재보험', '고용보험', '직접입력', '입금가산'];

// 설정 (키, 항목 이름, 기본값, 설명)
const STL_CFG = [
  ['vat', '부가세율', '10%', '쿠팡 정산서 금액(공급가) → 부가세 포함 환산'],
  ['incRate', '프백 가중치(추가인센티브) 기사 지급률', '100%', ''],
  ['freshRate', '프레시백 회수 인센티브 기사 지급률', '100%', '100% = 전액 기사'],
  ['uncFee', '미계약 라우트 업체 수수료율', '10%', '기사 지급 = 미계약 금액 × (1 − 수수료율)'],
  ['etcRate', '기타(프로모션·소급) 기사 지급률', '0%', ''],
  ['lossRate', '분실파손 기사 부담률', '100%', ''],
  ['lossVat', '분실파손 부가세 포함 환산 (Y/N)', 'Y', 'Y = 차감금액 × 1.1 을 기사 부담'],
  ['yongPrice', '휴무 대신 용차 수행단가 (건당, VAT포함)', '1100', '용차표 단가를 비우면 이 단가'],
  ['expense', '필요경비 공제율 (경비율, 공단 기준)', '34.6%', '보수액 = 기준금액 × (1 − 경비율)'],
  ['san', '산재보험료율 (기사 부담분)', '1.76%', '10원 미만 버림'],
  ['commute', '출퇴근재해 요율 (기사 부담분)', '0%', ''],
  ['goy', '고용보험료율 (기사 부담분)', '1.6%', '10원 미만 버림'],
  ['goyMin', '고용보험 적용 최저 월 보수액', '800000', '미만이면 고용보험 제외'],
  ['runner', '러너 부담률 기본값', '50%', '50% = 러너가 기사와 같은 금액 부담'],
  ['insBasis', '보험 계산 기준 (공급가/부가세포함)', '공급가', ''],
  ['payDay', '기사 지급일 (익월, 일)', '20', ''],
  ['cpDay', '쿠팡 입금일 (익월, 일)', '15', '공휴일·주말이면 다음 영업일'],
  ['payShift', '기사 지급일이 휴일이면 다음 영업일 (Y/N)', 'N', ''],
  ['invDay', '세금계산서 발행기한 (익월, 일)', '10', ''],
  ['leaveAmt', '퇴사 보류금 기본 금액', '100000', ''],
  ['email', '세금계산서 수신 이메일', '', '기사 명세서의 공급받는자 이메일']
];

const STL_DRIVER_FIELDS = ['bizNo', 'bizName', 'bizEmail']; // 기사(사람) 정보: 명의자의 세금계산서용
const STL_ROLES = ['메인', '서브'];
const STL_ID_STATUS = ['사용', '중지'];
const STL_TYPES = ['고정', '백업', '품앗이', '외부용차'];
const STL_MODES = ['', '원청단가', '용차내역'];
const STL_TYPE_KEY = { '고정': 'p2', '백업': 'p3', '품앗이': 'p4', '외부용차': 'p5' };

// ───────────────────────── 정산 DB 파일 / 시트 (빠른 읽기·쓰기) ─────────────────────────
// 읽기: 탭 내용을 캐시(탭마다 버전)에 두고, 없으면 필요한 탭을 Sheets API 한 번(batchGet)으로 읽는다.
// 쓰기: 쓴 내용을 바로 캐시에 넣는다(다시 읽지 않음). 시트에서 손으로 고치면 편집 트리거가 그 탭 캐시만 버린다.
let _stlSS = null, _stlTv = null, _stlFresh = false;
const _stlSh = {}, _stlCols = {}, _stlTab = {}, _stlMon = {};
const STL_BIG = ['stl_raw', 'stl_loss', 'stl_closed']; // 정산월 묶음으로만 읽는 큰 탭
const STL_SMALL = ['stl_ids', 'stl_usage', 'stl_tmp', 'stl_config', 'stl_items', 'stl_kinds', 'stl_camps', 'stl_adjust', 'stl_advance', 'stl_yongcha', 'stl_regular', 'stl_target', 'stl_split', 'stl_leave', 'stl_pay', 'stl_rounds', 'stl_close'];
function stlSS_() {
  if (_stlSS) return _stlSS;
  const id = props_().STL_DB_ID;
  if (id) {
    try { _stlSS = SpreadsheetApp.openById(id); }
    catch (e) { fail_('정산 DB 파일을 열 수 없습니다. 드라이브 휴지통에 있는지 확인하거나, 스크립트 속성 STL_DB_ID 를 비우면 새로 만듭니다.'); }
    stlEnsureTrigger_(_stlSS);
    return _stlSS;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const p = PropertiesService.getScriptProperties();
    const again = p.getProperty('STL_DB_ID');
    if (again) { _props = null; return (_stlSS = SpreadsheetApp.openById(again)); }
    const book = SpreadsheetApp.create('러너 올인원 정산 DB');
    try { DriveApp.getFileById(book.getId()).moveTo(DriveApp.getFolderById(props_().ROOT_FOLDER_ID)); } catch (e) { /* 폴더 이동 실패해도 사용 가능 */ }
    try { book.setSpreadsheetTimeZone(CFG.TZ); } catch (e) { /* 무시 */ }
    p.setProperty('STL_DB_ID', book.getId());
    _props = null;
    try { installSheetTriggers_(book); } catch (e) { console.error('정산 DB 트리거 설치 실패: ' + e); }
    cache_().put('stl:trg', '1', CFG.CACHE_MAX);
    stlTouchAll_();
    return (_stlSS = book);
  } finally {
    lock.releaseLock();
  }
}
/** 정산 DB 에 편집 트리거가 있는지 6시간에 한 번만 확인 (손으로 고친 내용을 캐시에 반영하기 위해) */
function stlEnsureTrigger_(book) {
  if (cache_().get('stl:trg')) return;
  try { installSheetTriggers_(book); cache_().put('stl:trg', '1', CFG.CACHE_MAX); } catch (e) { console.error('정산 DB 트리거 확인 실패: ' + e); }
}
// ── 탭별 버전 (캐시 키). 버전이 바뀌면 그 탭의 예전 캐시는 쓰지 않는다 ──
function stlTv_() {
  if (_stlTv) return _stlTv;
  let v = null;
  try { v = JSON.parse(cache_().get('stl:tv') || 'null'); } catch (e) { v = null; }
  if (!v || !v._) v = { _: Date.now().toString(36) };
  return (_stlTv = v);
}
function stlVerOf_(name) { const v = stlTv_(); return v._ + '.' + (v[name] || 0); }
function stlTouch_(names) {
  const v = stlTv_();
  [].concat(names).forEach(function (n) { v[n] = (v[n] || 0) + 1; delete _stlTab[n]; Object.keys(_stlMon).forEach(function (k) { if (k.indexOf(n + '|') === 0) delete _stlMon[k]; }); });
  try { cache_().put('stl:tv', JSON.stringify(v), CFG.CACHE_MAX); } catch (e) { /* 무시 */ }
}
function stlTouchAll_() {
  _stlTv = { _: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) };
  Object.keys(_stlTab).forEach(function (k) { delete _stlTab[k]; });
  Object.keys(_stlMon).forEach(function (k) { delete _stlMon[k]; });
  Object.keys(_stlCols).forEach(function (k) { delete _stlCols[k]; });
  try { cache_().put('stl:tv', JSON.stringify(_stlTv), CFG.CACHE_MAX); } catch (e) { /* 무시 */ }
}
/** 시트에서 정산 DB 를 손으로 고쳤을 때 (Code.gs 의 편집·구조변경 트리거에서 부름) */
function stlOnEdit_(name) { if (STL_TABS[name]) stlTouch_(name); else stlTouchAll_(); }
// ── 캐시 (100KB 넘으면 나눠 담기) ──
function stlCGet_(key) {
  const ck = cache_(), head = ck.get(key);
  if (head === null || head === undefined) return null;
  if (head.charAt(0) !== '#') { try { return JSON.parse(head); } catch (e) { return null; } }
  const n = Number(head.slice(1)), keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = ck.getAll(keys);
  if (!keys.every(function (k) { return got[k] != null; })) return null;
  try { return JSON.parse(keys.map(function (k) { return got[k]; }).join('')); } catch (e) { return null; }
}
function stlCPut_(key, obj, sec) {
  const json = JSON.stringify(obj), CH = 90000;
  if (json.length > CH * 90) return;
  try {
    if (json.length <= CH) { cache_().put(key, json, sec); return; }
    const put = {};
    let i = 0;
    for (let p = 0; p < json.length; p += CH) put[key + ':' + (i++)] = json.slice(p, p + CH);
    put[key] = '#' + i;
    cache_().putAll(put, sec);
  } catch (e) { /* 캐시 실패해도 결과는 그대로 */ }
}
// ── 시트 핸들 ──
function stlSheet_(name) {
  if (_stlSh[name]) return _stlSh[name];
  const book = stlSS_();
  let sh = book.getSheetByName(name);
  if (!sh) sh = stlCreateTab_(name);
  return (_stlSh[name] = sh);
}
function stlCreateTab_(name) {
  const book = stlSS_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let sh = book.getSheetByName(name);
    if (sh) return sh;
    const blank = book.getSheets().filter(function (x) { return x.getLastRow() === 0 && x.getLastColumn() === 0 && /^(시트|Sheet)\d*$/.test(x.getName()); });
    sh = book.insertSheet(name);
    blank.forEach(function (x) { try { book.deleteSheet(x); } catch (e) { /* 마지막 시트는 못 지움 */ } });
    const head = Object.keys(STL_TABS[name]).map(function (k) { return STL_TABS[name][k]; });
    if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    if (STL_TAB_NOTES[name]) sh.getRange(1, 1).setNote(STL_TAB_NOTES[name]);
    const seed = stlSeed_(name);
    if (seed.length) sh.getRange(2, 1, seed.length, head.length).setValues(seed);
    stlTabSet_(name, head, seed);
    return sh;
  } finally {
    lock.releaseLock();
  }
}
function stlSeed_(name) {
  if (name === 'stl_items') return STL_ITEM_DEFAULT.map(function (r) { return r.slice(); });
  if (name === 'stl_kinds') return STL_KIND_DEFAULT.map(function (r) { return r.slice(); });
  if (name === 'stl_config') return STL_CFG.map(function (r) { return [r[1], r[2], r[3]]; });
  if (name === 'stl_camps') {
    try { return master_().camps.map(function (c) { return [stlShort_(c.name), '', '', '', '']; }); } catch (e) { return []; }
  }
  return [];
}
// ── 읽기 ──
/** 작은 탭 여러 개를 한 번에 준비 (캐시 → 없으면 Sheets API batchGet 한 번) */
function stlLoad_(names) {
  const need = names.filter(function (n) { return !_stlTab[n]; });
  if (!need.length) return;
  const keys = need.map(function (n) { return 'stl:t:' + n + ':' + stlVerOf_(n); });
  const miss = [];
  if (!_stlFresh) {
    need.forEach(function (n, i) { const hit = stlCGet_(keys[i]); if (hit) _stlTab[n] = hit; else miss.push(n); });
  } else need.forEach(function (n) { miss.push(n); });
  if (!miss.length) return;
  const got = stlBatchGet_(miss);
  miss.forEach(function (n) { stlTabSet_(n, got[n].head, got[n].rows); });
}
/** 탭 내용 읽기: Sheets API(advanced service) 가 있으면 한 번에, 없으면 탭마다 */
function stlBatchGet_(names) {
  const out = {};
  const book = stlSS_();
  // 없는 탭은 먼저 만든다 (만들면서 내용이 정해짐)
  const have = {};
  try { book.getSheets().forEach(function (s) { have[s.getName()] = 1; }); } catch (e) { /* 무시 */ }
  const want = [];
  names.forEach(function (n) {
    if (!have[n]) { stlCreateTab_(n); out[n] = _stlTab[n]; } else want.push(n);
  });
  if (!want.length) return out;
  let done = false;
  if (typeof Sheets !== 'undefined' && Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      const res = Sheets.Spreadsheets.Values.batchGet(book.getId(), {
        ranges: want.map(function (n) { return "'" + n + "'!A1:AZ"; }), valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING'
      });
      (res.valueRanges || []).forEach(function (vr, i) {
        const vals = vr.values || [];
        out[want[i]] = { head: (vals[0] || []).map(String), rows: vals.slice(1) };
      });
      done = want.every(function (n) { return out[n]; });
    } catch (e) { console.error('batchGet 실패, 탭마다 읽기로 바꿈: ' + e); }
  }
  if (!done) {
    want.forEach(function (n) {
      if (out[n]) return;
      const sh = stlSheet_(n), lr = sh.getLastRow(), lc = Math.max(sh.getLastColumn(), 1);
      const vals = lr >= 1 ? sh.getRange(1, 1, lr, lc).getValues() : [[]];
      out[n] = { head: vals[0].map(String), rows: vals.slice(1) };
    });
  }
  return out;
}
/** 메모리·캐시에 탭 내용 저장 */
function stlTabSet_(name, head, rows) {
  const t = { head: head.map(String), rows: rows.map(function (r) { return r.map(function (v) { return v instanceof Date ? str_(v) : v === null || v === undefined ? '' : v; }); }) };
  _stlTab[name] = t;
  delete _stlCols[name];
  stlCPut_('stl:t:' + name + ':' + stlVerOf_(name), t, CFG.CACHE_MAX);
}
function stlTab_(name) { stlLoad_([name]); return _stlTab[name]; }
/** 머리글 → 열 번호. 없는 머리글은 시트 오른쪽 끝에 만든다 */
function stlCols_(name) {
  if (_stlCols[name]) return _stlCols[name];
  const def = STL_TABS[name];
  let head;
  if (STL_BIG.indexOf(name) >= 0) {
    const hk = 'stl:h:' + name + ':' + stlTv_()._;
    head = _stlFresh ? null : stlCGet_(hk);
    if (!head) {
      const sh = stlSheet_(name);
      head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      stlCPut_(hk, head, CFG.CACHE_MAX);
    }
  } else head = stlTab_(name).head;
  const miss = Object.keys(def).filter(function (k) { return head.indexOf(def[k]) < 0; }).map(function (k) { return def[k]; });
  if (miss.length) {
    const sh = stlSheet_(name);
    const start = head.filter(function (x) { return x !== ''; }).length + 1;
    if (start + miss.length - 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), miss.length);
    sh.getRange(1, start, sh.getMaxRows(), miss.length).setNumberFormat('@');
    sh.getRange(1, start, 1, miss.length).setValues([miss]).setFontWeight('bold').setBackground('#f1f3f4');
    head = head.slice(0, start - 1).concat(miss);
    stlTouch_(name);
  }
  const c = { __w: head.length };
  Object.keys(def).forEach(function (k) { c[k] = head.indexOf(def[k]); });
  return (_stlCols[name] = c);
}
function stlObj_(name, c, v, row) {
  const o = { _row: row };
  let any = false;
  Object.keys(STL_TABS[name]).forEach(function (k) { o[k] = c[k] >= 0 ? str_(v[c[k]]) : ''; if (o[k]) any = true; });
  return any ? o : null;
}
/** 탭 전체 → 객체 목록 (_row = 시트 행 번호) */
function stlRead_(name) {
  const t = stlTab_(name), c = stlCols_(name), out = [];
  t.rows.forEach(function (v, i) { const o = stlObj_(name, c, v, i + 2); if (o) out.push(o); });
  return out;
}
function stlRow_(name, obj) {
  const c = stlCols_(name), arr = new Array(c.__w).fill('');
  Object.keys(STL_TABS[name]).forEach(function (k) { if (obj[k] !== undefined && obj[k] !== null) arr[c[k]] = safeText_(String(obj[k])); });
  return arr;
}
// ── 쓰기 (쓴 내용을 바로 캐시에 반영) ──
/** 잠금 안에서: 탭 전체를 objs 로 다시 쓴다 (작은 탭용). 정의되지 않은 열(사람이 추가한 열)은 그대로 둔다 */
function stlWriteAll_(name, objs) {
  const big = STL_BIG.indexOf(name) >= 0;
  const t = big ? stlBigAll_(name) : stlTab_(name), c = stlCols_(name), sh = stlSheet_(name);
  const keep = t.rows, keys = Object.keys(STL_TABS[name]);
  const rows = objs.map(function (o, i) {
    const arr = keep[i] ? keep[i].slice() : [];
    while (arr.length < c.__w) arr.push('');
    keys.forEach(function (k) { arr[c[k]] = o[k] === undefined || o[k] === null ? '' : safeText_(String(o[k])); });
    return arr;
  });
  const n = Math.max(rows.length, keep.length);
  if (n) {
    const all = [];
    for (let i = 0; i < n; i++) all.push(rows[i] || new Array(c.__w).fill(''));
    if (n + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), n + 100 - sh.getMaxRows());
    sh.getRange(2, 1, n, c.__w).setNumberFormat('@').setValues(all);
  }
  stlTouch_(name);
  if (!big) stlTabSet_(name, t.head.length >= c.__w ? t.head : stlHeadOf_(name, c), rows);
}
function stlHeadOf_(name, c) {
  const h = new Array(c.__w).fill('');
  Object.keys(STL_TABS[name]).forEach(function (k) { h[c[k]] = STL_TABS[name][k]; });
  return h;
}
/** 큰 탭 전체 (이관 때만) */
function stlBigAll_(name) {
  const sh = stlSheet_(name), lr = sh.getLastRow(), lc = Math.max(sh.getLastColumn(), 1);
  const vals = lr >= 1 ? sh.getRange(1, 1, lr, lc).getValues() : [[]];
  return { head: vals[0].map(String), rows: vals.slice(1) };
}
/** 잠금 안에서: 탭 끝에 줄 붙이기 */
function stlAppend_(name, objs) {
  if (!objs.length) return;
  const sh = stlSheet_(name), c = stlCols_(name);
  const rows = objs.map(function (o) { return stlRow_(name, o); });
  const big = STL_BIG.indexOf(name) >= 0;
  const r = big ? sh.getLastRow() + 1 : stlTab_(name).rows.length + 2;
  if (r + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 500);
  sh.getRange(r, 1, rows.length, c.__w).setNumberFormat('@').setValues(rows);
  if (big) { stlTouch_(name); return; }
  const t = _stlTab[name];
  stlTouch_(name);
  stlTabSet_(name, t.head, t.rows.concat(rows));
}
/** 잠금 안에서: 한 줄만 고치기 (row = 시트 행 번호) */
function stlSetRow_(name, row, obj) {
  const sh = stlSheet_(name), c = stlCols_(name), t = stlTab_(name);
  const cur = (t.rows[row - 2] || []).slice();
  while (cur.length < c.__w) cur.push('');
  Object.keys(obj).forEach(function (k) { if (c[k] >= 0) cur[c[k]] = safeText_(String(obj[k] == null ? '' : obj[k])); });
  sh.getRange(row, 1, 1, c.__w).setNumberFormat('@').setValues([cur]);
  const rows = t.rows.slice();
  while (rows.length < row - 1) rows.push([]);
  rows[row - 2] = cur;
  stlTouch_(name);
  stlTabSet_(name, t.head, rows);
}
// ── 큰 탭 (쿠팡 원천 · 분실 · 마감 결과): 정산월 묶음 위치를 기억해 그 달만 읽는다 ──
function stlIndex_(name) {
  const key = 'stl:ix:' + name + ':' + stlVerOf_(name);
  let ix = _stlFresh ? null : stlCGet_(key);
  if (ix) return ix;
  const sh = stlSheet_(name), c = stlCols_(name), last = sh.getLastRow();
  ix = { last: last, m: {} };
  if (last >= 2) {
    const col = sh.getRange(2, c.month + 1, last - 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      const m = str_(col[i][0]);
      if (!m) continue;
      const b = ix.m[m];
      if (!b) ix.m[m] = [i + 2, i + 2, 0];
      else { if (b[1] !== i + 1) b[2] = 1; b[1] = i + 2; } // [시작행, 끝행, 나뉨]
    }
  }
  stlCPut_(key, ix, CFG.CACHE_MAX);
  return ix;
}
function stlMonthBlock_(name, month) {
  const b = stlIndex_(name).m[month];
  return b ? { start: b[0], n: b[1] - b[0] + 1, split: !!b[2] } : null;
}
function stlReadMonth_(name, month) {
  const mk = name + '|' + month;
  if (_stlMon[mk]) return _stlMon[mk];
  const key = 'stl:m:' + name + ':' + month + ':' + stlVerOf_(name);
  let rows = _stlFresh ? null : stlCGet_(key);
  if (!rows) {
    const b = stlMonthBlock_(name, month);
    rows = [];
    if (b) {
      const sh = stlSheet_(name), c = stlCols_(name), keys = Object.keys(STL_TABS[name]);
      sh.getRange(b.start, 1, b.n, c.__w).getValues().forEach(function (v) {
        if (str_(v[c.month]) !== month) return;
        const o = {};
        keys.forEach(function (k) { o[k] = c[k] >= 0 ? str_(v[c[k]]) : ''; });
        rows.push(o);
      });
    }
    stlCPut_(key, rows, CFG.CACHE_MAX);
  }
  return (_stlMon[mk] = rows);
}
/** 잠금 안에서: 그 정산월 줄을 지우고 새 줄을 맨 끝에 붙인다 */
function stlReplaceMonth_(name, month, objs) {
  const sh = stlSheet_(name);
  const b = stlMonthBlock_(name, month);
  if (b) {
    if (b.split) {
      // 손으로 줄을 옮겨 묶음이 나뉜 경우: 아래에서부터 한 줄씩 지운다
      const c = stlCols_(name), col = sh.getRange(2, c.month + 1, sh.getLastRow() - 1, 1).getValues();
      for (let i = col.length - 1; i >= 0; i--) if (str_(col[i][0]) === month) sh.deleteRow(i + 2);
    } else sh.deleteRows(b.start, b.n);
  }
  stlTouch_(name);
  stlAppend_(name, objs);
  // 새 위치·내용을 바로 기억 (다음 조회 때 시트를 다시 읽지 않음)
  const ix = stlIndex_(name);
  const mk = name + '|' + month;
  _stlMon[mk] = objs.map(function (o) { const x = {}; Object.keys(STL_TABS[name]).forEach(function (k) { x[k] = o[k] === undefined || o[k] === null ? '' : String(o[k]); }); return x; });
  stlCPut_('stl:m:' + name + ':' + month + ':' + stlVerOf_(name), _stlMon[mk], CFG.CACHE_MAX);
  return ix;
}

// ───────────────────────── 값 정리 ─────────────────────────
function stlNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const s = str_(v).replace(/[,\s원₩]/g, '');
  if (!s || s === '-') return 0;
  const n = Number(s.replace(/%$/, ''));
  if (!isFinite(n)) return 0;
  return /%$/.test(s) ? n / 100 : n;
}
/** 비율: '10%' → 0.1, '0.1' → 0.1, '10' → 0.1 (1 보다 크면 % 로 본다) */
function stlRate_(v, dflt) {
  const s = str_(v);
  if (!s) return dflt;
  const n = stlNum_(s);
  if (/%$/.test(s.replace(/\s/g, ''))) return n;
  return n > 1 ? n / 100 : n;
}
function stlYes_(v) { return /^(y|yes|o|true|예|네|제외|1)$/i.test(str_(v)); }
function stlR0_(x) { return Math.round(x); }
function stlR10_(x) { return Math.round(x / 10) * 10; }
function stlR100_(x) { return Math.round(x / 100) * 100; }
function stlFloor10_(x) { return x > 0 ? Math.floor(x / 10 + 1e-9) * 10 : 0; }
/** 시트의 ROUNDUP(ROUND(x,1)-0.5,0): .5 는 내림 */
function stlHalfDown_(x) { return Math.max(0, Math.ceil(Math.round(x * 10) / 10 - 0.5)); }
function stlShort_(name) { return str_(name).replace(/\s+/g, '').replace(/캠프$/, '').toUpperCase(); }
function stlLogin_(cid) { return str_(cid).replace(/@.*$/, '').replace(/\s+/g, '').toLowerCase(); }
function stlYmd_(v) {
  if (v instanceof Date) return ymd_(v);
  const s = str_(v);
  const m = s.match(/^(\d{4})[-.\/년\s]*(\d{1,2})[-.\/월\s]*(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  if (/^\d{5}(\.\d+)?$/.test(s)) return ymd_(new Date(Math.round((Number(s) - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000));
  return s;
}
function stlMonthOk_(m) { return /^\d{4}-\d{2}$/.test(str_(m)); }
function stlAddMonth_(month, n) {
  const p = month.split('-').map(Number), d = new Date(p[0], p[1] - 1 + n, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}
/** 배송일 → 정산월 (26일부터는 다음 달) */
function stlMonthOfDate_(ymd) {
  const s = stlYmd_(ymd), m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const mon = m[1] + '-' + m[2];
  return Number(m[3]) >= 26 ? stlAddMonth_(mon, 1) : mon;
}
function stlPeriod_(month) {
  const prev = stlAddMonth_(month, -1);
  return { from: prev + '-26', to: month + '-25' };
}
function stlMonthNow_() { return stlMonthOfDate_(todayText_()); }

// ───────────────────────── 설정 · 항목 · 구분 ─────────────────────────
function stlCfg_() {
  const rows = stlRead_('stl_config'), map = {};
  rows.forEach(function (o) { map[o.label] = o.value; });
  const missing = STL_CFG.filter(function (d) { return !(d[1] in map); });
  if (missing.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { stlAppend_('stl_config', missing.map(function (d) { return { label: d[1], value: d[2], desc: d[3] }; })); } finally { lock.releaseLock(); }
    missing.forEach(function (d) { map[d[1]] = d[2]; });
  }
  const g = {};
  STL_CFG.forEach(function (d) { g[d[0]] = map[d[1]] !== undefined ? map[d[1]] : d[2]; });
  const rate = function (k) { return stlRate_(g[k], stlRate_(STL_CFG.filter(function (d) { return d[0] === k; })[0][2], 0)); };
  return {
    vat: rate('vat'), incRate: rate('incRate'), freshRate: rate('freshRate'), uncFee: rate('uncFee'), etcRate: rate('etcRate'),
    lossRate: rate('lossRate'), lossVat: !/^n/i.test(str_(g.lossVat)), yongPrice: stlNum_(g.yongPrice) || 1100,
    expense: rate('expense'), san: rate('san'), commute: rate('commute'), goy: rate('goy'), goyMin: stlNum_(g.goyMin),
    runner: rate('runner'), insBasis: str_(g.insBasis) === '부가세포함' ? '부가세포함' : '공급가',
    payDay: stlNum_(g.payDay) || 20, cpDay: stlNum_(g.cpDay) || 15, payShift: stlYes_(g.payShift), invDay: stlNum_(g.invDay) || 10,
    leaveAmt: stlNum_(g.leaveAmt) || 100000, email: str_(g.email)
  };
}
function stlItems_() {
  const rows = stlRead_('stl_items').filter(function (o) { return o.name; });
  const list = (rows.length ? rows : STL_ITEM_DEFAULT.map(function (r) {
    return { order: r[0], side: r[1], name: r[2], method: r[3], show: r[4], taxCut: r[5], desc: r[6] };
  })).map(function (o) {
    const side = o.side === '차감' ? '차감' : '지급';
    const method = STL_METHODS.indexOf(o.method) >= 0 ? o.method : '직접입력';
    return {
      order: stlNum_(o.order), side: side, name: o.name, method: method, show: o.show === '항상' ? '항상' : '금액 있을 때',
      taxCut: side === '차감' && method !== '산재보험' && method !== '고용보험' && stlYes_(o.taxCut), desc: o.desc
    };
  }).sort(function (a, b) { return a.order - b.order; });
  const by = {};
  list.forEach(function (it) { by[it.name] = it; });
  return { list: list, by: by };
}
function stlKinds_() {
  const map = {};
  STL_KIND_DEFAULT.forEach(function (r) { map[r[0]] = r[1]; });
  stlRead_('stl_kinds').forEach(function (o) { if (o.raw && STL_STD_KINDS.indexOf(o.std) >= 0) map[o.raw] = o.std; });
  return map;
}
function stlCampIns_(cfg) {
  const map = {};
  stlRead_('stl_camps').forEach(function (o) {
    if (!o.camp) return;
    map[stlShort_(o.camp)] = {
      expense: stlRate_(o.expense, cfg.expense), san: stlRate_(o.san, cfg.san), goy: stlRate_(o.goy, cfg.goy), runner: stlRate_(o.runner, cfg.runner)
    };
  });
  return map;
}

// ───────────────────────── 기사 (러너 올인원 DB drivers) ─────────────────────────
/**
 * 기사 목록 + 정산 대상(묶음).
 * 서브 ID 줄의 '정산 대상 기사ID'(기사ID 또는 이름)가 있으면 그 기사로 합친다.
 */
function stlDrivers_() {
  const all = readAll_(SH.DRIVERS).filter(function (o) { return o.id; });
  const byId = {}, byName = {}, byLogin = {};
  all.forEach(function (o) {
    byId[o.id] = o;
    (byName[o.name] = byName[o.name] || []).push(o);
    if (o.loginId) byLogin[stlLogin_(o.loginId)] = o;
  });
  return { all: all, byId: byId, byLogin: byLogin, byName: byName };
}
/** 이름 · 기사ID · "이름 (아이디)" → 기사(사람) ID. 못 찾으면 '' */
function stlPerson_(D, name, id) {
  if (id && D.byId[id]) return id;
  const n = str_(name);
  if (!n) return '';
  if (D.byId[n]) return n;
  const m = n.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const lg = D.byLogin[stlLogin_(m[2])];
    if (lg) return lg.id;
    const nm = D.byName[m[1]] || [];
    if (nm.length === 1) return nm[0].id;
  }
  const list = D.byName[n] || [];
  return list.length === 1 ? list[0].id : '';
}
/**
 * 아이디 목록(stl_ids) → { by: {아이디키: 정보}, groups: {메인키: {cids, ownerId}} }
 * 아이디키 = 쿠팡ID 에서 @ 뒤를 뗀 소문자. 서브 아이디는 '메인 아이디'의 묶음으로 들어간다.
 * stl_ids 가 비어 있으면 기사 정보(쿠팡플렉스 아이디)로 처음 한 번 채운다.
 */
function stlIds_(D) {
  let rows = stlRead_('stl_ids');
  if (!rows.length && D.all.some(function (o) { return o.loginId; })) { stlSeedIds_(D); rows = stlRead_('stl_ids'); }
  const by = {}, groups = {};
  rows.forEach(function (r) {
    const k = stlLogin_(r.cid);
    if (!k || by[k]) return;
    const ownerId = stlPerson_(D, r.owner, r.ownerId);
    by[k] = {
      key: k, cid: r.cid, role: r.role === '서브' ? '서브' : '메인', mainRaw: r.main, ownerId: ownerId, ownerName: ownerId ? D.byId[ownerId].name : r.owner,
      type: STL_TYPES.indexOf(r.type) >= 0 ? r.type : '', mode: STL_MODES.indexOf(r.mode) >= 0 ? r.mode : '', insEx: stlYes_(r.insEx), fbCut: r.fbCut,
      stopped: r.status === '중지', _row: r._row
    };
  });
  const bad = [];
  Object.keys(by).forEach(function (k) {
    const x = by[k];
    let m = x.role === '서브' ? stlLogin_(x.mainRaw) : k;
    if (x.role === '서브' && (!by[m] || by[m].role === '서브' || m === k)) { bad.push(x.cid); m = k; }
    x.mainKey = m;
  });
  Object.keys(by).forEach(function (k) {
    const x = by[k], g = groups[x.mainKey] || (groups[x.mainKey] = { key: x.mainKey, cids: [], main: by[x.mainKey] });
    g.cids.push(x.cid);
  });
  Object.keys(groups).forEach(function (k) { const g = groups[k]; g.cid = g.main.cid; g.ownerId = g.main.ownerId; });
  return { by: by, groups: groups, badSub: bad };
}
function stlSeedIds_(D) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (stlRead_('stl_ids').length) return;
    const rows = [], tmp = [], old = stlLegacyDrv_();
    D.all.forEach(function (o0) {
      const o = Object.assign({}, o0, old[o0.id] || {});
      if (!o.loginId) return;
      // 예전 방식(기사 정보의 '정산 대상 기사ID')을 아이디 기준으로 옮긴다
      const ow = o.stlOwner && D.byId[o.stlOwner] && D.byId[o.stlOwner].id !== o.id ? D.byId[o.stlOwner] : null;
      rows.push({
        cid: o.loginId, role: ow ? '서브' : '메인', main: ow ? ow.loginId : '', owner: (ow || o).name, ownerId: (ow || o).id,
        type: STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '', mode: STL_MODES.indexOf(o.stlMode) >= 0 ? o.stlMode : '',
        insEx: stlYes_(o.insEx) ? 'Y' : '', fbCut: ow ? '' : (o.fbCut || ''), status: o.status === ST.ACTIVE ? '사용' : '중지', memo: '기사 정보에서 자동 생성'
      });
      if (stlNum_(o.tmpPrice) > 0) tmp.push({ name: o.name, driverId: o.id, from: o.tmpFrom, to: o.tmpTo, price: o.tmpPrice, routes: o.tmpRoutes, memo: '기사 정보에서 옮김' });
    });
    stlWriteAll_('stl_ids', rows);
    if (tmp.length && !stlRead_('stl_tmp').length) stlWriteAll_('stl_tmp', tmp);
  } finally {
    lock.releaseLock();
  }
}
/** 예전 버전이 drivers 탭에 만든 정산 열(있으면)을 읽는다: 아이디 관리로 옮기기 위해 */
function stlLegacyDrv_() {
  const out = {};
  try {
    const sh = sheet_(SH.DRIVERS), last = sh.getLastRow();
    if (last < 2) return out;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const L = { stlOwner: '정산 대상 기사ID', stlMode: '정산 방식', insEx: '산재·고용 제외', fbCut: '프레시백 차감', tmpPrice: '기사 일시단가', tmpRoutes: '기사 일시단가 노선', tmpFrom: '기사 일시단가 시작일', tmpTo: '기사 일시단가 종료일' };
    const idc = head.indexOf(D.id), cs = {};
    Object.keys(L).forEach(function (k) { const i = head.indexOf(L[k]); if (i >= 0) cs[k] = i; });
    if (idc < 0 || !Object.keys(cs).length) return out;
    sh.getRange(2, 1, last - 1, head.length).getValues().forEach(function (v) {
      const id = str_(v[idc]);
      if (!id) return;
      const o = {};
      Object.keys(cs).forEach(function (k) { o[k] = str_(v[cs[k]]); });
      out[id] = o;
    });
  } catch (e) { /* 예전 열이 없으면 무시 */ }
  return out;
}
/** 정산 묶음(메인 아이디) 찾기: 쿠팡ID · "명의자 (아이디)" · 명의자 이름 → 메인 아이디키. 못 찾으면 '' */
function stlAcct_(X, D, name, acct) {
  const a = stlLogin_(acct);
  if (a && X.by[a]) return X.by[a].mainKey;
  const n = str_(name);
  if (!n) return '';
  if (X.by[stlLogin_(n)]) return X.by[stlLogin_(n)].mainKey;
  const m = n.match(/\(([^)]+)\)\s*$/);
  if (m && X.by[stlLogin_(m[1])]) return X.by[stlLogin_(m[1])].mainKey;
  const pid = stlPerson_(D, n, '');
  if (!pid) return '';
  const gs = Object.keys(X.groups).filter(function (k) { return X.groups[k].ownerId === pid; });
  if (gs.length === 1) return gs[0];
  const own = D.byId[pid].loginId ? stlLogin_(D.byId[pid].loginId) : '';
  return gs.indexOf(own) >= 0 ? own : '';
}
function stlAcctLabel_(X, D, key) {
  const g = X.groups[key];
  if (!g) return '';
  return (g.ownerId ? D.byId[g.ownerId].name : '명의자 없음') + ' (' + String(g.cid).replace(/@.*$/, '') + ')';
}
/** 그 아이디로 그 날 일한 기사 (사용 기록 → 없으면 명의자) */
function stlWorkerOf_(ctx, key, date) {
  const list = ctx.usage[key];
  if (list) for (let i = 0; i < list.length; i++) if (stlInRange_(date, list[i].from, list[i].to)) return list[i].driverId;
  const x = ctx.ids.by[key];
  return x ? x.ownerId : '';
}

// ───────────────────────── 단가 (러너 올인원 DB 노선관리) ─────────────────────────
function stlPriceIndex_() {
  const m = master_();
  const campByShort = {}, routesByCamp = {}, prices = {};
  m.camps.forEach(function (c) { campByShort[stlShort_(c.name)] = c; });
  m.routes.forEach(function (r) { (routesByCamp[r.campId] = routesByCamp[r.campId] || []).push(r); });
  m.prices.forEach(function (p) { prices[p.campId + '|' + p.num + '|' + p.level + '|' + p.value] = p; });
  const memo = {};
  /** 쿠팡 라우트(예: 529B) → { camp, row(단가 줄), routeKnown } */
  function find(campName, route) {
    const key = campName + '|' + route;
    if (memo[key]) return memo[key];
    const out = { camp: campByShort[stlShort_(campName)] || null, row: null, routeKnown: false };
    const mm = normCode_(route).match(/^(\d+)-?([A-Z가-힣]*)/);
    if (out.camp && mm) {
      const num = mm[1], letter = mm[2].charAt(0);
      let level = 0;
      (routesByCamp[out.camp.id] || []).forEach(function (r) {
        if (r.g1 !== num) return;
        const g = [r.g1, r.g2, r.g3, r.g4, r.g5];
        if (!letter) { out.routeKnown = true; return; }
        for (let k = 2; k <= 5 && !level; k++) if (g[k - 1] === letter) { level = k; out.routeKnown = true; }
      });
      if (letter) {
        if (level) out.row = prices[out.camp.id + '|' + num + '|' + level + '|' + letter] || null;
        if (!out.row) for (let k = 2; k <= 5 && !out.row; k++) out.row = prices[out.camp.id + '|' + num + '|' + k + '|' + letter] || null;
      }
    }
    return (memo[key] = out);
  }
  /** 라우트만 알 때 캠프 찾기 (그 숫자·글자를 가진 캠프가 하나뿐일 때) */
  function campOf(route) {
    const mm = normCode_(route).match(/^(\d+)-?([A-Z가-힣]*)/);
    if (!mm) return '';
    const hit = m.camps.filter(function (c) {
      return (routesByCamp[c.id] || []).some(function (r) { return r.g1 === mm[1] && (!mm[2] || [r.g2, r.g3, r.g4, r.g5].indexOf(mm[2].charAt(0)) >= 0); });
    });
    return hit.length === 1 ? hit[0].name : '';
  }
  return { find: find, campByShort: campByShort, campOf: campOf };
}
/**
 * 배송 한 줄의 기사 단가 (VAT포함). 기준은 아이디.
 * 1) 정산 방식 용차내역 → 0 (용차 표 금액으로 지급)
 * 2) 그 날 그 아이디로 일한 기사의 일시단가 (기간·노선이 맞을 때)
 * 3) 원청단가 → 쿠팡 단가 × 1.1 (10원 반올림)
 * 4) 노선관리 구분별 단가 (고정 = 기사단가, 백업 = 백업단가, 품앗이 = 품앗이단가, 외부용차 = 외부단가). 구분은
 *    메인 아이디: 기사 정보관리의 명의자 기사구분이 최우선 → 비어 있으면 아이디 관리의 단가 구분 → 고정
 *    서브 아이디: 아이디 관리의 단가 구분 → 비어 있으면 메인과 같은 규칙
 */
function stlUnit_(ctx, idx, r, worker) {
  const main = ctx.ids.by[idx.mainKey] || idx;
  const mode = idx.mode || main.mode;
  if (mode === '용차내역') return { u: 0, how: '용차내역' };
  const t = stlTmpFor_(ctx, worker, r);
  if (t) return { u: t, how: '일시' };
  if (mode === '원청단가') return { u: stlR10_(stlNum_(r.price) * (1 + ctx.cfg.vat)), how: '원청' };
  const f = ctx.price.find(r.camp, r.route);
  const ow = ctx.D.byId[main.ownerId];
  const drvType = ow && STL_TYPES.indexOf(ow.driverType) >= 0 ? ow.driverType : '';
  const type = (idx.role === '서브' && idx.type) || drvType || main.type || idx.type || '고정';
  if (!f.row) return { u: 0, missing: true, how: type, f: f };
  const v = stlNum_(f.row[STL_TYPE_KEY[type] || 'p2']);
  if (!v) return { u: 0, missing: true, how: type, f: f };
  return { u: v, how: type };
}
/** 기사 일시단가 (stl_tmp): 그 기사·날짜·노선에 맞는 단가, 없으면 0 */
function stlTmpFor_(ctx, driverId, r) {
  const list = driverId ? ctx.tmp[driverId] : null;
  if (!list) return 0;
  const rt = normCode_(r.route), cr = stlShort_(r.camp) + '|' + rt;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!stlInRange_(r.date, t.from, t.to)) continue;
    const rs = str_(t.routes).toUpperCase().replace(/\s+/g, '');
    if (!rs || (',' + rs + ',').indexOf(',' + rt + ',') >= 0 || (',' + rs + ',').indexOf(',' + cr + ',') >= 0) return stlNum_(t.price);
  }
  return 0;
}
function stlInRange_(date, from, to) {
  return (!from || date >= stlYmd_(from)) && (!to || date <= stlYmd_(to));
}

// ───────────────────────── 근무일수 (스케줄 DB) ─────────────────────────
function stlIsWorkDay_(v) {
  const s = str_(v);
  if (!s || s === '휴가') return false;
  return !['휴무', '용차', '병가', '퇴사', '미입차', '업무'].some(function (w) { return s.indexOf(w) >= 0; });
}
/** { 기사ID: { 날짜: 칸 글자 } } (정산 기간만) */
function stlSchedule_(from, to) {
  const out = {};
  try {
    if (!props_().SCH_DB_ID) return out;
    const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
    if (last < 2) return out;
    const dates = schDateRange_(parseYmd_(from), parseYmd_(to)).filter(function (d) { return h.dates[d] !== undefined; });
    if (!dates.length) return out;
    const cols = dates.map(function (d) { return h.dates[d]; });
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues();
    const block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
    ids.forEach(function (r, i) {
      const id = str_(r[0]);
      if (!id) return;
      const row = out[id] || (out[id] = {});
      dates.forEach(function (d, j) { const v = str_(block[i][cols[j] - c0]); if (v) row[d] = v; });
    });
  } catch (e) { console.error('스케줄 읽기 실패: ' + e); }
  return out;
}

// ───────────────────────── 계산 ─────────────────────────
/**
 * 한 달 정산 계산 → { summary, slips }.
 * 기사 한 명(정산 대상) = 그 기사 + '정산 대상 기사ID'로 묶인 서브 ID 들.
 */
function stlCompute_(month) {
  const P = stlPeriod_(month);
  stlLoad_(STL_SMALL);
  const cfg = stlCfg_();
  const kinds = stlKinds_(), items = stlItems_(), campIns = stlCampIns_(cfg);
  const D = stlDrivers_(), X = stlIds_(D);
  const ctx = { cfg: cfg, price: stlPriceIndex_(), D: D, ids: X, usage: {}, tmp: {} };
  stlRead_('stl_usage').forEach(function (u) {
    const k = stlLogin_(u.cid), pid = stlPerson_(D, u.name, u.driverId);
    if (k && pid) (ctx.usage[k] = ctx.usage[k] || []).push({ driverId: pid, from: u.from, to: u.to });
  });
  stlRead_('stl_tmp').forEach(function (t) {
    const pid = stlPerson_(D, t.name, t.driverId);
    if (pid && stlNum_(t.price) > 0) (ctx.tmp[pid] = ctx.tmp[pid] || []).push(t);
  });
  ctx.groupOf = stlGroupOfPerson_(X, D);
  const raw = stlReadMonth_('stl_raw', month);
  const loss = stlReadMonth_('stl_loss', month);
  const sched = stlSchedule_(P.from, P.to);
  const warn = { unreg: {}, kind: {}, noPrice: {}, noCamp: {}, noRoute: {}, stopped: {}, moveNo: {} };
  const S = {};
  /** 정산 묶음(메인 아이디) 하나의 합계. 정산금은 메인 아이디 명의자에게 */
  const sum = function (gkey) {
    if (S[gkey]) return S[gkey];
    const g = X.groups[gkey], main = g.main, o = D.byId[g.ownerId] || {};
    return (S[gkey] = {
      id: gkey, cid: g.cid, name: o.name || '(명의자 없음) ' + String(g.cid).replace(/@.*$/, ''), owner: o, ownerId: g.ownerId || '',
      type: main.type, mode: main.mode, insEx: main.insEx, fbCutTxt: main.fbCut, workers: {}, ids: {}, qty: 0, base: 0, inc: 0, freshRaw: 0, fresh: 0, fbCut: 0, unc: 0, etc: 0,
      loss: 0, lossCp: 0, sales: 0, supplyCp: 0, campPay: {}, routes: {}, daily: {}, lossLines: [], yong: [], yongPay: 0, yongCut: 0, yongLines: [],
      noPriceQty: 0, rows: 0, movedIn: {}, movedOut: {}
    });
  };
  const company = { sales: 0, supplyCp: 0, lossCp: 0, unregSales: 0, vendorCut: 0 };
  const byDateLogin = {};

  raw.forEach(function (r) {
    r.date = stlYmd_(r.date);
    const qty = stlNum_(r.qty) + stlNum_(r.ret), total = stlNum_(r.total), fresh = stlNum_(r.fresh);
    const sales = stlR0_((total + fresh) * (1 + cfg.vat));
    company.sales += sales; company.supplyCp += total + fresh;
    const kind = kinds[r.kind] || '미분류';
    const login = stlLogin_(r.cid);
    const idx = X.by[login];
    if (!idx) { const u = warn.unreg[r.cid] || (warn.unreg[r.cid] = { cid: r.cid, sales: 0, qty: 0 }); u.sales += sales; u.qty += qty; company.unregSales += sales; return; }
    if (idx.stopped) warn.stopped[r.cid] = 1;
    const worker = stlWorkerOf_(ctx, login, r.date);
    // 아이디 사용 기록: 그 날 다른 기사가 이 아이디로 일했으면 그 줄은 일한 기사 본인 정산으로 (단가도 그 기사 아이디 기준)
    const mv = stlMoveOf_(ctx, idx, worker, r, warn);
    const s = sum(mv ? mv.key : idx.mainKey), uIdx = mv ? X.groups[mv.key].main : idx;
    s.ids[r.cid] = 1; s.sales += sales; s.supplyCp += total + fresh; s.rows++;
    const camp = r.camp;
    if (camp && !ctx.price.campByShort[stlShort_(camp)]) warn.noCamp[camp] = 1;
    let pay = 0;
    if (kind === '배송' || kind === '수기반영') {
      const u = stlUnit_(ctx, uIdx, r, worker);
      const wk = s.workers[worker || '_'] || (s.workers[worker || '_'] = { qty: 0, amt: 0, dates: {}, cids: {} });
      if (u.missing && r.route) {
        const k = camp + '|' + r.route;
        const w = warn.noPrice[k] || (warn.noPrice[k] = { camp: camp, route: r.route, qty: 0, type: u.how, routeKnown: u.f ? u.f.routeKnown : false });
        w.qty += qty; s.noPriceQty += qty;
      }
      const incU = stlHalfDown_(stlHalfDown_(stlNum_(r.inc) * (1 + cfg.vat)) * cfg.incRate);
      const base = stlR0_(qty * u.u), inc = stlR0_(qty * incU);
      s.base += base; s.inc += inc; s.qty += qty; pay = base + inc;
      wk.qty += qty; wk.amt += pay; wk.dates[r.date] = 1; wk.cids[r.cid] = 1;
      const rk = camp + '|' + normCode_(r.route) + '|' + u.u + '|' + incU;
      const rl = s.routes[rk] || (s.routes[rk] = { camp: camp, route: normCode_(r.route), how: u.how, unit: u.u, inc: incU, qty: 0, amt: 0 });
      rl.qty += qty; rl.amt += pay;
      const dl = s.daily[r.date] || (s.daily[r.date] = { qty: 0, amt: 0 });
      dl.qty += qty; dl.amt += pay;
      // 그날 노선 (메인 아이디가 아닌 서브·다른 아이디로 잡힌 줄은 뒤에 (아이디) 를 붙여 따로)
      if (r.route) {
        const sub = login === s.id ? '' : String(r.cid).replace(/@.*$/, '');
        ((dl.rt = dl.rt || {})[sub] = dl.rt[sub] || {})[stlShort_(camp) + '|' + normCode_(r.route)] = 1;
      }
      const dk = r.date + '|' + login;
      (byDateLogin[dk] = byDateLogin[dk] || []).push({ route: normCode_(r.route), qty: qty, sales: sales, unit: u.u, camp: camp, cid: r.cid });
    } else if (kind === '프레시백') {
      pay = stlR0_(fresh * cfg.freshRate); s.freshRaw += fresh; s.fresh += pay;
    } else if (kind === '미계약') {
      pay = stlR0_(total * (1 + cfg.vat) * (1 - cfg.uncFee)); s.unc += pay;
    } else if (kind === '기타') {
      pay = stlR0_((total + fresh) * (1 + cfg.vat) * cfg.etcRate); s.etc += pay;
    } else if (kind === '업체차감') {
      company.vendorCut += total;
    } else {
      warn.kind[r.kind || '(빈칸)'] = (warn.kind[r.kind || '(빈칸)'] || 0) + 1;
    }
    if (pay) s.campPay[stlShort_(camp)] = (s.campPay[stlShort_(camp)] || 0) + pay;
    if (mv) stlMoveNote_(s, sum(idx.mainKey), r, worker, X, D, idx, pay, (kind === '배송' || kind === '수기반영') ? qty : 0, mv.key);
  });

  // 프레시백 차감 (메인 아이디의 '프레시백 차감': 13% 처럼 비율 → 100원 반올림 / 금액 → 그대로) → 러너 몫
  Object.keys(S).forEach(function (id) {
    const s = S[id], t = str_(s.fbCutTxt);
    if (!t || !s.fresh) return;
    const n = stlNum_(t);
    const cut = /%$/.test(t.replace(/\s/g, '')) || (n > 0 && n < 1) ? stlR100_(s.fresh * stlRate_(t, 0)) : Math.round(n);
    s.fbCut = Math.max(0, Math.min(cut, s.fresh)); s.fresh -= s.fbCut;
  });

  // 분실파손
  loss.forEach(function (r) {
    const amt = stlNum_(r.amt);
    company.lossCp += amt;
    const idx = X.by[stlLogin_(r.cid)];
    if (!idx) { const u = warn.unreg[r.cid] || (warn.unreg[r.cid] = { cid: r.cid, sales: 0, qty: 0 }); u.loss = (u.loss || 0) + amt; return; }
    const lr = { date: stlYmd_(r.date), cid: r.cid };
    const mv = stlMoveOf_(ctx, idx, stlWorkerOf_(ctx, stlLogin_(r.cid), lr.date), lr, warn);
    const s = sum(mv ? mv.key : idx.mainKey);
    const share = stlR10_(amt * (cfg.lossVat ? 1 + cfg.vat : 1) * cfg.lossRate);
    s.loss += share; s.lossCp += amt;
    if (mv) stlMoveNote_(s, sum(idx.mainKey), lr, mv.worker, X, D, idx, -share, 0, mv.key);
    s.lossLines.push({ date: stlYmd_(r.date), cid: r.cid, camp: r.camp, type: r.type, detail: r.detail, item: r.item, waybill: r.waybill, amt: share });
  });

  // 용차
  const yong = stlRead_('stl_yongcha').filter(function (y) { return y.date && stlMonthOfDate_(y.date) === month; });
  const yongOut = [];
  yong.forEach(function (y) {
    const date = stlYmd_(y.date), route = normCode_(y.route);
    const whoKey = stlAcct_(X, D, y.who, y.whoId);
    const wg = whoKey ? X.groups[whoKey] : null;
    let autoQty = 0, sales = 0, camp = '', perfUnitSum = 0, found = false;
    if (wg) {
      wg.cids.forEach(function (c) {
        (byDateLogin[date + '|' + stlLogin_(c)] || []).forEach(function (x) {
          if (route && x.route !== route) return;
          found = true; autoQty += x.qty; sales += x.sales; camp = camp || x.camp; perfUnitSum += x.qty * x.unit;
        });
      });
    }
    const qty = stlNum_(y.qty) || autoQty;
    const isAmt = str_(y.mode) === '금액';
    const payAmt = isAmt ? stlR0_(stlNum_(y.price)) : stlR0_((stlNum_(y.price) || cfg.yongPrice) * qty);
    let existing = 0;
    if (wg && wg.main.mode !== '용차내역') {
      if (route && (camp || y.route)) {
        const u = stlUnit_(ctx, wg.main, { date: date, route: route, camp: camp || stlYongCamp_(ctx, route), price: 0 }, stlWorkerOf_(ctx, whoKey, date));
        existing = stlR0_(u.u * qty);
      } else existing = stlR0_(perfUnitSum);
    }
    const extra = payAmt - existing;
    const payerOwner = stlAcct_(X, D, y.payer, y.payerId);
    let payerPrice = stlNum_(y.payerPrice), cut = 0;
    if (payerOwner && qty) {
      if (!payerPrice) {
        payerPrice = stlUnit_(ctx, X.groups[payerOwner].main, { date: date, route: route, camp: camp || stlYongCamp_(ctx, route), price: 0 }, stlWorkerOf_(ctx, payerOwner, date)).u;
      }
      cut = stlR0_(payAmt / qty - payerPrice) * qty;
    }
    const line = {
      date: date, who: wg ? stlAcctLabel_(X, D, whoKey) : y.who, whoId: whoKey, route: route, mode: isAmt ? '금액' : '건당', price: y.price, qty: qty, autoQty: found ? autoQty : '',
      payAmt: payAmt, sales: sales, profit: sales - payAmt, camp: camp, existing: existing, extra: extra,
      payer: payerOwner ? stlAcctLabel_(X, D, payerOwner) : y.payer, payerId: payerOwner, payerPrice: payerPrice, cut: cut, memo: y.memo, _row: y._row
    };
    yongOut.push(line);
    if (wg) { const s = sum(whoKey); s.yongPay += extra; s.yongLines.push(line); }
    if (payerOwner && cut) { const s = sum(payerOwner); s.yongCut += cut; s.yongLines.push(line); }
  });

  // 공제·가감 (수동) + 자동(정기·퇴사보류)
  const adj = {};
  const addAdj = function (ownerId, item, amt, memo, auto) {
    if (!ownerId || !amt) return;
    sum(ownerId);
    (adj[ownerId] = adj[ownerId] || []).push({ item: item, amt: amt, memo: memo || '', auto: !!auto });
  };
  const adjBad = [];
  stlRead_('stl_adjust').filter(function (a) { return a.month === month; }).forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct);
    if (!id) { adjBad.push(a.name || a.acct); return; }
    addAdj(id, a.item, stlNum_(a.amt), a.memo, false);
  });
  stlRead_('stl_regular').forEach(function (a) {
    if (a.from && month < a.from.slice(0, 7)) return;
    if (a.to && month > a.to.slice(0, 7)) return;
    addAdj(stlAcct_(X, D, a.name, a.acct), a.item, stlNum_(a.amt), '정기 (설정)', true);
  });
  stlRead_('stl_leave').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct), m = str_(a.month).slice(0, 7), amt = stlNum_(a.amt) || cfg.leaveAmt;
    if (!id || !stlMonthOk_(m)) return;
    if (m === month) addAdj(id, '퇴사 보류금', amt, m + ' 퇴사 보류 (자동)', true);
    if (stlAddMonth_(m, 1) === month) addAdj(id, '보류금 반환', amt, m + ' 퇴사 보류금 반환 (자동)', true);
  });

  // 기사별 마무리 계산
  Object.keys(S).forEach(function (id) { S[id].sched = stlGroupSched_(ctx, X.groups[id], sched, P); });
  const fin = function (id, extra) { return stlFinish_(S[id], (adj[id] || []).concat(extra || []), items, cfg, campIns); };

  // 동일인 매출 분할 → 목표 매출 자동 수당
  const extraAdj = {};
  const pushExtra = function (id, a) { (extraAdj[id] = extraAdj[id] || []).push(a); sum(id); };
  stlRead_('stl_split').forEach(function (a) {
    const repeat = !a.repeat || stlYes_(a.repeat);
    if (!repeat && str_(a.month).slice(0, 7) !== month) return;
    const from = stlAcct_(X, D, a.from, a.fromId), to = stlAcct_(X, D, a.to, a.toId);
    const target = stlNum_(a.target), unit = stlNum_(a.unit) || 10000;
    if (!from || !to || !target || !S[from]) return;
    const netAt = function (x) { return fin(from, (extraAdj[from] || []).concat([{ item: '매출 분할 이전', amt: x, auto: true }])).net; };
    let x = 0;
    const n0 = netAt(0);
    if (n0 > target) {
      x = Math.floor(((n0 - target) / 1.03) / unit) * unit;
      let guard = 0;
      while (x > 0 && netAt(x) < target && guard++ < 500) x -= unit;
      while (netAt(x + unit) >= target && guard++ < 1000) x += unit;
    }
    if (x > 0) {
      pushExtra(from, { item: '매출 분할 이전', amt: x, memo: '→ ' + stlAcctLabel_(X, D, to) + ' 발행분 (자동)', auto: true });
      pushExtra(to, { item: '매출 분할 수령', amt: x, memo: '← ' + stlAcctLabel_(X, D, from) + ' 분할분 (자동)', auto: true });
    }
  });
  stlRead_('stl_target').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct), goal = stlNum_(a.goal), unit = stlNum_(a.unit) || 10000;
    if (!id || !goal || !a.item) return;
    sum(id);
    const inv = fin(id, extraAdj[id]).invoice;
    const amt = Math.max(0, Math.floor((goal / 12 - inv) / unit) * unit);
    if (amt) pushExtra(id, { item: a.item, amt: amt, memo: '목표 매출 자동 (설정)', auto: true });
  });

  // 가불·입금 상태
  const adv = stlAdvances_(X, D);
  const payRows = {};
  stlRead_('stl_pay').filter(function (p) { return p.month === month; }).forEach(function (p) { payRows[stlLogin_(p.acct)] = p; });
  const rounds = stlRounds_(month);

  // 일자별 '그날 노선' (쿠팡 정산서 기준): 인천8 103AB 처럼 캠프·번호별로 묶음
  Object.keys(S).forEach(function (id) {
    const dd = S[id].daily;
    Object.keys(dd).forEach(function (d) {
      const rt = dd[d].rt || {};
      dd[d].route = Object.keys(rt).sort().map(function (sub) { return stlRouteLabel_(rt[sub]) + (sub ? ' (' + sub + ')' : ''); }).join(' / ');
      delete dd[d].rt;
    });
  });
  const drivers = [], slips = {};
  const tot = { qty: 0, pay: 0, invoice: 0, supply: 0, tax: 0, san: 0, goy: 0, depDed: 0, depAdd: 0, net: 0, loss: 0, profit: 0, runnerIns: 0, fbCut: 0, insGain: 0, sales: 0 };
  Object.keys(S).forEach(function (id) {
    const s = S[id], f = fin(id, extraAdj[id]);
    const o = s.owner;
    const p = payRows[id] || {};
    const workers = Object.keys(s.workers).map(function (w) {
      const x = s.workers[w];
      return { id: w === '_' ? '' : w, name: w === '_' ? '(명의자 없음)' : (D.byId[w] ? D.byId[w].name : w), qty: x.qty, amt: x.amt, days: Object.keys(x.dates).length, dates: Object.keys(x.dates).sort(), cids: Object.keys(x.cids), owner: w === s.ownerId };
    }).sort(function (a, b) { return b.qty - a.qty; });
    const row = {
      id: id, cid: s.cid, name: s.name, ownerId: s.ownerId, ids: X.groups[id].cids.length, cids: X.groups[id].cids.slice(), usedCids: Object.keys(s.ids), type: s.type || '', mode: s.mode || '',
      workers: workers.filter(function (w) { return !w.owner; }).map(function (w) { return w.name; }),
      workDays: s.sched.days, qty: s.qty, sales: s.sales,
      base: s.base, inc: s.inc, fresh: s.fresh, fbCut: s.fbCut, unc: s.unc, etc: s.etc, loss: s.loss, yongPay: s.yongPay, yongCut: s.yongCut,
      pay: f.pay, taxDed: f.taxDed, invoice: f.invoice, supply: f.supply, tax: f.tax, san: f.san, goy: f.goy, depDed: f.depDed, depAdd: f.depAdd, net: f.net,
      profit: Math.round(s.supplyCp - s.lossCp - f.supply), runnerIns: f.runnerIns, insGain: f.insGain,
      bank: o.bankName || '', holder: o.accountHolder || '', account: o.account || '', hasAccount: !!o.accountEnc, bizNo: o.bizNo || '',
      checked: stlYes_(p.checked), payDate: p.date || '', payMemo: p.memo || '',
      advLeft: adv[id] ? adv[id].left : 0, noPriceQty: s.noPriceQty,
      movedIn: Object.keys(s.movedIn).map(function (k) { return s.movedIn[k].label; }), movedOut: Object.keys(s.movedOut).map(function (k) { return s.movedOut[k].label; })
    };
    drivers.push(row);
    slips[id] = { row: row, lines: f.lines, ins: f.ins, routes: Object.keys(s.routes).map(function (k) { return s.routes[k]; }).sort(function (a, b) { return koCmp_(a.camp, b.camp) || koCmp_(a.route, b.route); }),
      daily: s.daily, sched: s.sched.cells, loss: s.lossLines, yong: s.yongLines, members: X.groups[id].cids.slice(), workers: workers,
      movedIn: stlMoveList_(s.movedIn), movedOut: stlMoveList_(s.movedOut) };
    ['qty', 'pay', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'loss', 'profit', 'runnerIns', 'fbCut', 'insGain', 'sales'].forEach(function (k) { tot[k] += row[k] || 0; });
  });
  drivers.sort(function (a, b) { return b.sales - a.sales || koCmp_(a.name, b.name); });

  // 확인 필요
  const warnings = [];
  // 쿠팡 ID 뒤에 (이름): 아이디 관리의 명의자 → 없으면 기사 정보의 쿠팡플렉스 아이디로 찾은 기사
  const cidNm = function (cid) {
    const c = str_(cid);
    if (!c || /[가-힣]/.test(c)) return c;
    const k = stlLogin_(c), x = X.by[k], d = D.byLogin[k];
    const nm = x && x.ownerName ? x.ownerName : d ? d.name : '';
    return c + ' (' + (nm || '이름 미확인') + ')';
  };
  const W = function (key, label, list, level) { if (list.length) warnings.push({ key: key, label: label, count: list.length, items: list.slice(0, 50), level: level || 'warn' }); };
  W('unreg', '아이디 관리에 없는 쿠팡 ID (지급 계산 안 됨 — 정산관리 → 아이디 관리에 추가)',
    Object.keys(warn.unreg).map(function (k) { const u = warn.unreg[k]; return cidNm(u.cid) + ' · ' + won_(u.sales) + '원' + (u.loss ? ' · 분실 ' + won_(u.loss) : ''); }), 'bad');
  W('noOwner', '명의자가 없는 아이디 (아이디 관리에서 명의자 지정)', drivers.filter(function (d) { return !d.ownerId; }).map(function (d) { return d.cids.map(cidNm).join(', ') + ' · ' + won_(d.sales) + '원'; }), 'bad');
  W('badSub', '서브인데 메인 아이디를 찾을 수 없음 (따로 정산됨)', X.badSub.map(cidNm));
  W('moveNo', '아이디 사용 기록의 기사에게 본인 정산 아이디가 없음 (명의자 정산에 남김 — 아이디 관리에 그 기사 아이디 추가)', Object.keys(warn.moveNo).map(function (k) { const w = warn.moveNo[k]; return w.name + ' · ' + cidNm(w.cid) + ' ' + w.dates.length + '일'; }));
  W('stopped', '중지된 아이디에 배송 기록', Object.keys(warn.stopped).map(cidNm), 'info');
  W('noCamp', '노선관리에 없는 캠프', Object.keys(warn.noCamp), 'bad');
  W('noPrice', '단가 미입력 (노선관리 → 구분별 단가)', Object.keys(warn.noPrice).map(function (k) {
    const w = warn.noPrice[k]; return w.camp + ' ' + w.route + (w.type ? ' · ' + w.type + '단가' : '') + ' · ' + won_(w.qty) + '건' + (w.routeKnown ? '' : ' (노선 미등록)');
  }), 'bad');
  W('kind', '분류 안 된 쿠팡 구분값 (stl_kinds 에 추가)', Object.keys(warn.kind).map(function (k) { return k + ' ' + warn.kind[k] + '줄'; }));
  W('adjBad', '공제·가감의 기사명을 찾을 수 없음', adjBad);
  W('noAcc', '계좌 미입력', drivers.filter(function (d) { return d.net > 0 && !d.hasAccount; }).map(function (d) { return d.name; }));
  W('noBiz', '사업자번호 미입력', drivers.filter(function (d) { return d.invoice > 0 && !d.bizNo && d.mode !== '용차내역'; }).map(function (d) { return d.name; }), 'info');
  W('minus', '실입금 마이너스', drivers.filter(function (d) { return d.net < 0; }).map(function (d) { return d.name + ' ' + won_(d.net); }), 'bad');
  W('round', '이번 차수 변동 ID', rounds.changed.map(function (x) { return cidNm(x.cid) + ' ' + (x.diff > 0 ? '+' : '') + won_(x.diff); }), 'info');
  W('yong', '용차내역 방식인데 이 달 용차 기록 없음', drivers.filter(function (d) { return d.mode === '용차내역' && !S[d.id].yongLines.length && S[d.id].qty; }).map(function (d) { return d.name + ' ' + won_(S[d.id].qty) + '건'; }));
  const today = todayText_();
  W('adv', '가불금 미상계 (상계일 지남)', Object.keys(adv).filter(function (id) { return adv[id].overdue > 0; }).map(function (id) { return adv[id].name + ' ' + won_(adv[id].overdue) + '원'; }));

  const summary = {
    month: month, period: P, today: today, round: rounds.latest, roundFile: rounds.file, roundAt: rounds.at,
    rawRows: raw.length, lossRows: loss.length, drivers: drivers, total: tot,
    company: {
      sales: company.sales, supplyCp: company.supplyCp, lossCp: company.lossCp, unregSales: company.unregSales, vendorCut: company.vendorCut,
      coupangNet: company.supplyCp - company.lossCp - company.vendorCut
    },
    dates: stlDates_(month, cfg), warnings: warnings, yong: yongOut
  };
  return { summary: summary, slips: slips };
}
/** { '인천8|103A': 1, '인천8|103B': 1 } → '인천8 103AB' (캠프가 여럿이면 ' / ', 번호가 여럿이면 ', ') */
function stlRouteLabel_(rt) {
  if (!rt) return '';
  const camps = {};
  Object.keys(rt).forEach(function (k) {
    const i = k.indexOf('|'), c = k.slice(0, i), route = k.slice(i + 1), m = route.match(/^(\d+)-?([A-Z가-힣]*)$/);
    const nums = camps[c] || (camps[c] = {});
    if (!m) { nums[route] = nums[route] || ''; return; }
    nums[m[1]] = (nums[m[1]] || '') + m[2];
  });
  return Object.keys(camps).sort().map(function (c) {
    const nums = camps[c];
    const list = Object.keys(nums).sort(function (a, b) { return (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b); })
      .map(function (n) { return n + nums[n].split('').filter(function (x, i, a) { return a.indexOf(x) === i; }).sort().join(''); });
    return (c ? c + ' ' : '') + list.join(', ');
  }).join(' / ');
}
function stlYongCamp_(ctx, route) { return route ? ctx.price.campOf(route) : ''; }
/** 기사(사람) → 그 기사 본인 정산 묶음(메인 아이디키). 본인 쿠팡플렉스 아이디의 묶음 → 없으면 명의자로 된 첫 묶음 */
function stlGroupOfPerson_(X, D) {
  const out = {};
  Object.keys(X.groups).sort().forEach(function (k) {
    const g = X.groups[k];
    if (!g.ownerId) return;
    const own = D.byId[g.ownerId] && D.byId[g.ownerId].loginId ? stlLogin_(D.byId[g.ownerId].loginId) : '';
    if (!out[g.ownerId] || own === k) out[g.ownerId] = k;
  });
  return out;
}
/** 이 줄을 일한 기사 정산으로 옮길지: { key: 일한 기사 묶음, worker } 또는 null (본인 아이디가 없으면 경고만) */
function stlMoveOf_(ctx, idx, worker, r, warn) {
  const g = ctx.ids.groups[idx.mainKey];
  if (!worker || !g || worker === g.ownerId) return null;
  const key = ctx.groupOf[worker];
  if (key && key !== idx.mainKey) return { key: key, worker: worker };
  if (!key) {
    const w = warn.moveNo[worker + '|' + r.cid] || (warn.moveNo[worker + '|' + r.cid] = { name: ctx.D.byId[worker] ? ctx.D.byId[worker].name : worker, cid: r.cid, dates: [] });
    if (w.dates.indexOf(r.date) < 0) w.dates.push(r.date);
  }
  return null;
}
/** 옮긴 줄 기록: 일한 기사 쪽 '+ 윤미경(정민녕) 아이디 사용' / 명의자 쪽 '- 타인 민경진이 사용' (아이디 칸 = 사용된 아이디) */
function stlMoveNote_(sIn, sOut, r, worker, X, D, idx, amt, qty, wkey) {
  const cid = String(r.cid).replace(/@.*$/, ''), ownerName = X.groups[idx.mainKey].ownerId && D.byId[X.groups[idx.mainKey].ownerId] ? D.byId[X.groups[idx.mainKey].ownerId].name : '명의자 없음';
  const wName = D.byId[worker] ? D.byId[worker].name : worker;
  const wCid = wkey && X.groups[wkey] ? String(X.groups[wkey].cid).replace(/@.*$/, '') : '';
  const a = sIn.movedIn[cid] || (sIn.movedIn[cid] = { label: '+ ' + ownerName + ' 아이디 사용', cid: cid, who: ownerName, qty: 0, amt: 0, dates: {} });
  const b = sOut.movedOut[worker + '|' + cid] || (sOut.movedOut[worker + '|' + cid] = { label: '- 타인 ' + wName + stlIga_(wName) + ' 사용', cid: cid, who: wName, wCid: wCid, qty: 0, amt: 0, dates: {} });
  [a, b].forEach(function (x) { x.qty += qty; x.amt += amt; if (qty) x.dates[r.date] = 1; });
}
/** 이름 뒤 조사: 받침 있으면 '이', 없으면 '가' (민경진 → 민경진이, 김도유 → 김도유가) */
function stlIga_(name) {
  const c = String(name || '').trim().slice(-1).charCodeAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 ? '이' : '가';
  return '(이)가';
}
function stlMoveList_(m) {
  return Object.keys(m).map(function (k) { const x = m[k], ds = Object.keys(x.dates).sort(); return { label: x.label, cid: x.cid, who: x.who, qty: x.qty, amt: x.amt, days: ds.length, from: ds[0] || '', to: ds[ds.length - 1] || '' }; });
}
function koCmp_(a, b) { return String(a || '').localeCompare(String(b || ''), 'ko'); }
function won_(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 근무일: 날짜마다 그 묶음 아이디로 일한 기사(사용 기록 → 명의자)의 기사스케줄 칸이 출근이면 1일 */
function stlGroupSched_(ctx, g, sched, P) {
  const cells = {};
  let days = 0;
  schDateRange_(parseYmd_(P.from), parseYmd_(P.to)).forEach(function (d) {
    const ws = {};
    g.cids.forEach(function (c) {
      const w = stlWorkerOf_(ctx, stlLogin_(c), d);
      if (!w) return;
      // 다른 기사가 이 아이디를 쓴 날은 그 기사 본인 정산으로 가므로 이 묶음 근무일에서 뺀다
      if (w !== g.ownerId && ctx.groupOf && ctx.groupOf[w] && ctx.groupOf[w] !== g.key) return;
      ws[w] = 1;
    });
    let cell = '', work = false;
    Object.keys(ws).forEach(function (w) {
      const v = (sched[w] || {})[d];
      if (!v) return;
      if (stlIsWorkDay_(v)) { if (!work) cell = v; work = true; } else if (!cell) cell = v;
    });
    if (cell) cells[d] = cell;
    if (work) days++;
  });
  return { days: days, cells: cells };
}

/**
 * 기사 한 명 마무리: 줄 항목 → 지급 합계 → 세금계산서 → 산재·고용 → 실입금
 * adjs = [{ item, amt }] (자동 항목 이름이면 그 줄 금액에 더함)
 */
function stlFinish_(s, adjs, items, cfg, campIns) {
  const lines = {};
  items.list.forEach(function (it) { lines[it.name] = { name: it.name, side: it.side, method: it.method, taxCut: it.taxCut, show: it.show, order: it.order, amt: 0, memo: [] }; });
  const autoName = {};
  items.list.forEach(function (it) { if (it.method !== '직접입력' && it.method !== '입금가산' && !autoName[it.method]) autoName[it.method] = it.name; });
  const put = function (method, amt) {
    const n = autoName[method];
    if (n) lines[n].amt += amt;
    else lines['(' + method + ')'] = { name: method, side: /분실|지출/.test(method) ? '차감' : '지급', method: method, taxCut: /분실|지출/.test(method), show: '금액 있을 때', order: 99, amt: amt, memo: [] };
  };
  put('배송기본', s.base + s.inc);
  put('프레시백', s.fresh);
  put('미계약', s.unc);
  put('기타프로모션', s.etc);
  put('분실파손', s.loss);
  put('용차수행', s.yongPay);
  put('용차지출', s.yongCut);
  adjs.forEach(function (a) {
    let L = lines[a.item];
    if (!L) L = lines[a.item] = { name: a.item, side: '차감', method: '직접입력', taxCut: false, show: '금액 있을 때', order: 98, amt: 0, memo: [], unknown: true };
    L.amt += a.amt;
    if (a.memo) L.memo.push(a.memo);
  });
  let pay = 0, taxDed = 0, depDed = 0, depAdd = 0, insAdjS = 0, insAdjG = 0;
  Object.keys(lines).forEach(function (k) {
    const L = lines[k];
    if (L.method === '산재보험') { insAdjS += L.amt; return; }
    if (L.method === '고용보험') { insAdjG += L.amt; return; }
    if (L.method === '입금가산') depAdd += L.amt;
    else if (L.side === '지급') pay += L.amt;
    else if (L.taxCut) taxDed += L.amt;
    else depDed += L.amt;
  });
  const invoice = pay - taxDed;
  const supply = Math.round(invoice / (1 + cfg.vat)), tax = invoice - supply;
  // 산재·고용: 캠프별 산식 (기사 지급액 비중으로 안분)
  const ins = { base: 0, bosu: 0, exp: cfg.expense, san: cfg.san, goy: cfg.goy, runner: cfg.runner, sanD: 0, goyD: 0, sanAct: 0, goyAct: 0 };
  const excluded = !!s.insEx || s.mode === '용차내역';
  let san = 0, goy = 0, runnerIns = 0, insGain = 0;
  if (!excluded && invoice > 0) {
    let tw = 0, we = 0, ws = 0, wg = 0, wr = 0;
    Object.keys(s.campPay).forEach(function (c) {
      const w = s.campPay[c]; if (w <= 0) return;
      const ci = campIns[c] || {};
      tw += w; we += w * (ci.expense != null ? ci.expense : cfg.expense); ws += w * (ci.san != null ? ci.san : cfg.san);
      wg += w * (ci.goy != null ? ci.goy : cfg.goy); wr += w * (ci.runner != null ? ci.runner : cfg.runner);
    });
    if (tw > 0) { ins.exp = we / tw; ins.san = ws / tw; ins.goy = wg / tw; ins.runner = wr / tw; }
    ins.base = cfg.insBasis === '부가세포함' ? invoice : supply;
    ins.bosu = ins.base * (1 - ins.exp);
    san = stlFloor10_(ins.bosu * (ins.san + cfg.commute));
    goy = ins.bosu < cfg.goyMin ? 0 : stlFloor10_(ins.bosu * ins.goy);
    // 공단 실제 납부 (항상 기본 경비율·요율)
    const bosu0 = ins.base * (1 - cfg.expense);
    const san0 = stlFloor10_(bosu0 * (cfg.san + cfg.commute)), goy0 = bosu0 < cfg.goyMin ? 0 : stlFloor10_(bosu0 * cfg.goy);
    const r = Math.min(0.95, Math.max(0, ins.runner));
    const totalAct = Math.round((san0 + goy0) / (1 - r));
    ins.sanAct = san0; ins.goyAct = goy0;
    runnerIns = totalAct - (san + goy);
    insGain = (san + goy) - (san0 + goy0); // 기사 공제가 공단 기사분보다 많은 만큼 = 러너 몫
  }
  ins.excluded = excluded;
  san += insAdjS; goy += insAdjG;
  lines[autoName['산재보험'] || '산재보험'] = Object.assign(lines[autoName['산재보험'] || '산재보험'] || { name: '산재보험', side: '차감', method: '산재보험', show: '항상', order: 9, memo: [] }, { amt: san });
  lines[autoName['고용보험'] || '고용보험'] = Object.assign(lines[autoName['고용보험'] || '고용보험'] || { name: '고용보험', side: '차감', method: '고용보험', show: '항상', order: 10, memo: [] }, { amt: goy });
  const net = invoice - san - goy - depDed + depAdd;
  const list = Object.keys(lines).map(function (k) { return lines[k]; }).filter(function (L) { return L.show === '항상' || L.amt; })
    .sort(function (a, b) { return a.order - b.order; })
    .map(function (L) { return { name: L.name, side: L.side, method: L.method, taxCut: !!L.taxCut, amt: L.amt, memo: L.memo.join(' · '), unknown: !!L.unknown }; });
  return { lines: list, pay: pay, taxDed: taxDed, invoice: invoice, supply: supply, tax: tax, san: san, goy: goy, depDed: depDed, depAdd: depAdd, net: net, ins: ins, runnerIns: runnerIns, insGain: insGain };
}

function stlAdvances_(X, D) {
  const out = {}, today = todayText_();
  stlRead_('stl_advance').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct);
    if (!id) return;
    const o = out[id] || (out[id] = { name: stlAcctLabel_(X, D, id), total: 0, paid: 0, left: 0, overdue: 0 });
    const amt = stlNum_(a.amt), paid = stlNum_(a.paid), left = Math.max(0, amt - paid);
    o.total += amt; o.paid += paid; o.left += left;
    if (left > 0 && a.due && stlYmd_(a.due) < today) o.overdue += left;
  });
  return out;
}
function stlRounds_(month) {
  const rows = stlRead_('stl_rounds').filter(function (r) { return r.month === month; });
  let latest = 0, file = '', at = '';
  rows.forEach(function (r) { const n = stlNum_(r.round); if (n >= latest) { latest = n; file = r.file; at = r.at; } });
  const changed = rows.filter(function (r) { return stlNum_(r.round) === latest && latest > 1 && stlNum_(r.diff); }).map(function (r) { return { cid: r.cid, diff: stlNum_(r.diff), memo: r.memo }; });
  if (!latest) { const r0 = stlReadMonth_('stl_raw', month)[0]; if (r0) latest = stlNum_(r0.round); }
  return { latest: latest, file: file, at: at, changed: changed };
}
/** 쿠팡 입금예정일 · 기사 지급일 · 계산서 발행기한 */
function stlDates_(month, cfg) {
  const next = stlAddMonth_(month, 1), p = next.split('-').map(Number);
  const isOff = function (d) { const w = d.getDay(); return w === 0 || w === 6 || !!HOLIDAYS[ymd_(d)]; };
  const mk = function (day, shift) {
    let d = new Date(p[0], p[1] - 1, Math.min(day, 28 + 3));
    if (d.getMonth() !== p[1] - 1) d = new Date(p[0], p[1], 0);
    if (shift) while (isOff(d)) d = addDays_(d, 1);
    return ymd_(d);
  };
  return { coupang: mk(cfg.cpDay, true), pay: mk(cfg.payDay, cfg.payShift), invoice: mk(cfg.invDay, false), writeDate: month + '-' + ('0' + new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).slice(-2) };
}

// ───────────────────────── 캐시 · 마감 ─────────────────────────
/** 계산 결과 캐시 키: 정산 DB 탭 버전(입금 탭 제외) + 기사 정보 버전 */
function stlVer_() {
  const v = stlTv_();
  const txt = v._ + ':' + Object.keys(v).filter(function (k) { return k !== '_' && k !== 'stl_pay'; }).sort().map(function (k) { return k + v[k]; }).join(',');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, txt, Utilities.Charset.UTF_8)).slice(0, 22);
}
/** 기사 정보·설정 등 정산 DB 밖의 데이터가 바뀌었을 때 계산 결과만 버린다 */
function stlBump_() { stlTouch_('_x'); }
function stlCacheGet_(key) { return stlCGet_(key); }
function stlCachePut_(key, obj, sec) { stlCPut_(key, obj, sec); }
function stlClosedInfo_(month) {
  const r = stlRead_('stl_close').filter(function (x) { return x.month === month; })[0];
  return r ? { at: r.at, admin: r.admin } : null;
}
/** 결과: 마감된 달은 마감 때 저장한 결과, 아니면 계산 (5분 캐시) */
function stlResult_(month, fresh) {
  const closed = stlClosedInfo_(month);
  if (closed) {
    const key = 'stl:cl:' + month + ':' + stlVer_();
    let hit = stlCacheGet_(key);
    if (hit) return hit;
    const rows = stlReadMonth_('stl_closed', month);
    let summary = null;
    const slips = {};
    rows.forEach(function (r) {
      try {
        const o = JSON.parse(r.data);
        if (r.acct === '_summary') summary = o; else slips[r.acct] = o;
      } catch (e) { /* 손상된 줄은 건너뜀 */ }
    });
    if (summary) {
      summary.closed = closed;
      hit = { summary: summary, slips: slips };
      stlCachePut_(key, hit, 600);
      return stlPayOverlay_(hit, month);
    }
  }
  if (fresh) _stlFresh = true;
  const key = 'stl:r:' + month + ':' + stlVer_() + ':' + masterVer_();
  if (!fresh) { const hit = stlCacheGet_(key); if (hit) return stlPayOverlay_(hit, month); }
  const res = stlCompute_(month);
  res.summary.closed = null;
  res.summary.computedAt = nowText_();
  stlCachePut_(key, res, 600);
  return stlPayOverlay_(res, month);
}
/** 입금체크·입금일·메모는 계산과 따로 (체크할 때마다 다시 계산하지 않게) */
function stlPayOverlay_(res, month) {
  const pay = {};
  stlRead_('stl_pay').forEach(function (p) { if (p.month === month) pay[stlLogin_(p.acct)] = p; });
  res.summary.drivers.forEach(function (d) { const p = pay[d.id] || {}; d.checked = stlYes_(p.checked); d.payDate = p.date || ''; d.payMemo = p.memo || ''; });
  return res;
}
function stlAssertOpen_(month) {
  if (stlClosedInfo_(month)) fail_(month + ' 정산은 마감되었습니다. 고치려면 먼저 마감을 풀어 주세요.');
}

// ───────────────────────── API ─────────────────────────
/** 조회월 정산 요약 (기사 목록·합계·확인 필요). month 비우면 최근 정산월 */
function adm_stlMonth(token, month, fresh) {
  return run_(function () {
    requireAdmin_(token);
    const months = stlMonths_();
    if (!stlMonthOk_(month)) month = months.withData.length ? months.withData[months.withData.length - 1] : stlAddMonth_(stlMonthNow_(), -1);
    const r = stlResult_(month, !!fresh);
    return { ok: true, month: month, months: months.slice(), summary: r.summary, items: stlItems_().list.map(function (i) { return { name: i.name, side: i.side, method: i.method, taxCut: i.taxCut }; }) };
  });
}
function stlMonths_() {
  const set = {};
  try { Object.keys(stlIndex_('stl_raw').m).forEach(function (m) { if (stlMonthOk_(m)) set[m] = 1; }); } catch (e) { /* 정산 DB 가 아직 없으면 빈 목록 */ }
  const withData = Object.keys(set).sort();
  const cur = stlMonthNow_();
  set[cur] = 1; set[stlAddMonth_(cur, -1)] = 1;
  const all = Object.keys(set).sort();
  all.withData = withData;
  return all;
}
/** 기사 한 명 명세서 */
function adm_stlSlip(token, month, id) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const r = stlResult_(month, false);
    const s = r.slips[id];
    if (!s) fail_('이 달 정산 기록이 없는 기사입니다.');
    let co = {};
    try { co = companyInfo_(); } catch (e) { /* 회사 정보 없음 */ }
    const cfg = stlCfg_();
    return { ok: true, month: month, period: r.summary.period, dates: r.summary.dates, slip: s, company: { name: co.branchName || '', ceo: co.branchCeo || '', bizNo: co.branchBizNo || '', addr: co.branchAddr || '', email: cfg.email } };
  });
}

/** 쿠팡 정산 엑셀 원본을 드라이브에 저장 → { url, name } */
function adm_stlSaveFile(token, month, round, name, b64) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    round = Math.max(1, Math.min(9, Number(round) || 1));
    if (!b64 || b64.length > 30 * 1024 * 1024) fail_('파일이 너무 크거나 비었습니다.');
    const folder = stlFileFolder_();
    const ext = (String(name || '').match(/\.(xlsx|xls|csv)$/i) || ['', 'xlsx'])[1].toLowerCase();
    let fname = month + '_' + round + '차.' + ext;
    if (folder.getFilesByName(fname).hasNext()) fname = month + '_' + round + '차_' + Utilities.formatDate(new Date(), CFG.TZ, 'MMdd_HHmm') + '.' + ext;
    const mime = ext === 'csv' ? 'text/csv' : ext === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, fname));
    try { file.setDescription('원래 파일명: ' + String(name || '').slice(0, 200)); } catch (e) { /* 무시 */ }
    logAdmin_(a, '쿠팡 정산서 파일 저장', fname, String(name || ''));
    return { ok: true, name: fname, url: file.getUrl() };
  });
}
function stlFileFolder_() {
  const p = props_();
  if (p.STL_FILE_FOLDER) { try { return DriveApp.getFolderById(p.STL_FILE_FOLDER); } catch (e) { /* 새로 만든다 */ } }
  const root = DriveApp.getFolderById(p.ROOT_FOLDER_ID), it = root.getFoldersByName('쿠팡 정산서');
  const f = it.hasNext() ? it.next() : root.createFolder('쿠팡 정산서');
  PropertiesService.getScriptProperties().setProperty('STL_FILE_FOLDER', f.getId());
  _props = null;
  return f;
}
const STL_RAW_IN = ['kind', 'cid', 'route', 'date', 'camp', 'dtype', 'vendor', 'qty', 'ret', 'price', 'inc', 'base', 'incAmt', 'total', 'fresh'];
const STL_LOSS_IN = ['date', 'camp', 'cid', 'type', 'detail', 'cnt', 'amt', 'vendor', 'waybill', 'item'];
/**
 * 쿠팡 정산서 반영. p = { month, round, file, url, raw: [[STL_RAW_IN 순서]], loss: [[STL_LOSS_IN 순서]] }
 * 그 정산월의 이전 차수는 지우고 이 차수로 바꾼다. ID별 금액 변동은 stl_rounds 에 남는다.
 */
function adm_stlImport(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const month = str_(p.month), round = Math.max(1, Math.min(9, Number(p.round) || 1));
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const raw = Array.isArray(p.raw) ? p.raw : [], loss = Array.isArray(p.loss) ? p.loss : [];
    if (!raw.length) fail_('정산 원천 줄이 없습니다. 쿠팡 정산 엑셀이 맞는지 확인해 주세요.');
    if (raw.length > 30000 || loss.length > 10000) fail_('줄이 너무 많습니다.');
    const clean = function (keys, arr) {
      const o = { month: month, round: String(round) };
      keys.forEach(function (k, i) {
        let v = arr[i];
        v = v === null || v === undefined ? '' : String(v).trim().slice(0, 300);
        if (k === 'date') v = stlYmd_(v);
        o[k] = v;
      });
      return o;
    };
    const rawObjs = raw.map(function (r) { return clean(STL_RAW_IN, r); }).filter(function (o) { return o.cid; });
    const lossObjs = loss.map(function (r) { return clean(STL_LOSS_IN, r); }).filter(function (o) { return o.cid; });
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      stlAssertOpen_(month);
      const idAmt = function (rs, ls) {
        const m = {};
        rs.forEach(function (o) { m[o.cid] = (m[o.cid] || 0) + stlNum_(o.total) + stlNum_(o.fresh); });
        ls.forEach(function (o) { m[o.cid] = (m[o.cid] || 0) - stlNum_(o.amt); });
        return m;
      };
      const before = idAmt(stlReadMonth_('stl_raw', month), stlReadMonth_('stl_loss', month));
      const after = idAmt(rawObjs, lossObjs);
      const had = Object.keys(before).length > 0;
      const at = nowText_();
      const hist = Object.keys(Object.assign({}, before, after)).sort().map(function (cid) {
        const nv = Math.round(after[cid] || 0), pv = had ? Math.round(before[cid] || 0) : '';
        return { month: month, round: round, file: p.file || '', url: p.url || '', at: at, cid: cid, amt: nv, prev: pv, diff: had ? nv - pv : 0 };
      });
      stlReplaceMonth_('stl_raw', month, rawObjs);
      stlReplaceMonth_('stl_loss', month, lossObjs);
      // 아이디 관리에 없는 쿠팡ID 는 자동 추가 (명의자는 쿠팡플렉스 아이디가 같은 기사)
      const D = stlDrivers_(), X = stlIds_(D), addIds = [], seen = {};
      rawObjs.concat(lossObjs).forEach(function (o) {
        const k = stlLogin_(o.cid);
        if (!k || X.by[k] || seen[k]) return;
        seen[k] = 1;
        const d = D.byLogin[k];
        addIds.push({ cid: o.cid, role: '메인', owner: d ? d.name : '', ownerId: d ? d.id : '', type: d && STL_TYPES.indexOf(d.driverType) >= 0 ? d.driverType : '', status: '사용', memo: month + ' 정산서에서 자동 추가' });
      });
      if (addIds.length) stlAppend_('stl_ids', addIds);
      stlAppend_('stl_rounds', hist);
      stlBump_();
      const changed = hist.filter(function (h) { return h.diff; }).length;
      const totalAmt = Object.keys(after).reduce(function (s, k) { return s + after[k]; }, 0);
      logAdmin_(a, '쿠팡 정산서 반영', month + ' ' + round + '차', rawObjs.length + '줄 · 분실 ' + lossObjs.length + '줄 · 변동 ID ' + changed);
      return { ok: true, month: month, round: round, rows: rawObjs.length, loss: lossObjs.length, ids: Object.keys(after).length, changed: changed, total: Math.round(totalAmt), newIds: addIds.map(function (x) { return x.cid + (x.owner ? ' → ' + x.owner : ' (명의자 없음)'); }) };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 마감 / 마감 해제 */
function adm_stlClose(token, month, close) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const rows = stlRead_('stl_close');
      const others = rows.filter(function (r) { return r.month !== month; });
      if (close) {
        if (rows.some(function (r) { return r.month === month; })) fail_('이미 마감된 달입니다.');
        const res = stlCompute_(month);
        res.summary.computedAt = nowText_();
        const snap = [{ month: month, acct: '_summary', data: JSON.stringify(res.summary) }];
        Object.keys(res.slips).forEach(function (id) { snap.push({ month: month, acct: id, data: JSON.stringify(res.slips[id]) }); });
        if (snap.some(function (s) { return s.data.length > 49000; })) fail_('결과가 너무 커서 마감 기록을 저장할 수 없습니다.');
        stlReplaceMonth_('stl_closed', month, snap);
        stlWriteAll_('stl_close', others.concat([{ month: month, at: nowText_(), admin: a.name }]));
        logAdmin_(a, '정산 마감', month, res.summary.drivers.length + '명');
      } else {
        stlWriteAll_('stl_close', others);
        stlReplaceMonth_('stl_closed', month, []);
        logAdmin_(a, '정산 마감 해제', month, '');
      }
      stlBump_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 입금체크 · 입금일 · 메모 (마감 뒤에도 가능) */
function adm_stlPaySet(token, month, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month) || !Array.isArray(list) || !list.length || list.length > 500) fail_('입금 정보를 확인해 주세요.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const D = stlDrivers_(), X = stlIds_(D);
      const rows = stlRead_('stl_pay');
      const by = {};
      rows.forEach(function (r) { if (r.month === month) by[stlLogin_(r.acct)] = r; });
      const today = todayText_(), add = [];
      list.forEach(function (x) {
        const id = stlLogin_(x.id);
        if (!X.groups[id]) fail_('정산 아이디를 찾을 수 없습니다. 새로고침해 주세요.');
        const cur = by[id], r = cur ? Object.assign({}, cur) : { month: month, acct: id };
        r.name = stlAcctLabel_(X, D, id);
        if (x.checked !== undefined) { r.checked = x.checked ? 'TRUE' : 'FALSE'; if (x.checked && !r.date) r.date = today; if (!x.checked) r.date = ''; }
        if (x.date !== undefined) r.date = x.date ? stlYmd_(x.date) : '';
        if (x.memo !== undefined) r.memo = str_(x.memo).slice(0, 200);
        if (cur) stlSetRow_('stl_pay', cur._row, r); else add.push(r);
      });
      if (add.length) stlAppend_('stl_pay', add);
      if (list.length > 3) logAdmin_(a, '입금체크', month, list.length + '명');
      return { ok: true, today: today };
    } finally {
      lock.releaseLock();
    }
  });
}
/** 입금목록 (계좌번호 전체 표시 — 관리자 기록에 남음) */
function adm_stlPayList(token, month) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const r = stlResult_(month, false);
    const D = stlDrivers_();
    const list = r.summary.drivers.filter(function (d) { return d.net !== 0; }).map(function (d) {
      const o = D.byId[d.ownerId] || {};
      let acc = '';
      try { acc = o.accountEnc ? fmtAccount_(decrypt_(o.accountEnc), o.bankName) : ''; } catch (e) { acc = ''; }
      return { id: d.id, cid: d.cid, cids: d.cids, workers: d.workers, name: d.name, bank: o.bankName || '', account: acc, holder: o.accountHolder || d.name, pay: d.invoice + d.depAdd, ded: d.san + d.goy + d.depDed, net: d.net, checked: d.checked, payDate: d.payDate, memo: d.payMemo, supply: d.supply, tax: d.tax, bizNo: o.bizNo || '', bizName: o.bizName || '' };
    });
    logAdmin_(a, '입금목록 조회 (계좌번호 표시)', month, list.length + '명');
    return { ok: true, month: month, list: list, dates: r.summary.dates };
  });
}
function fmtAccount_(d, bank) { return String(d || ''); }

// ── 표 편집 (공제·가불·용차·설정 등) ──
// 열: [키, 제목, 종류, (찾은 ID 를 넣을 키)]
//  acct = 정산 묶음(명의자 또는 쿠팡ID) / acctOrText = 정산 묶음 또는 용차업체 이름 / person = 기사(사람)
const STL_EDIT = {
  ids: { sheet: 'stl_ids', scope: 'all', cols: [['cid', '쿠팡ID', 'cid'], ['role', '구분', STL_ROLES], ['main', '메인 아이디 (서브일 때)', 'text'], ['owner', '명의자 (정산금 받는 기사)', 'person', 'ownerId'],
    ['type', '단가 구분', [''].concat(STL_TYPES)], ['mode', '정산 방식 (빈칸=구분별 단가)', STL_MODES], ['insEx', '산재·고용 제외', ['', 'Y']], ['fbCut', '프레시백 차감 (13% 또는 금액)', 'text'], ['status', '상태', STL_ID_STATUS], ['memo', '메모', 'text']] },
  usage: { sheet: 'stl_usage', scope: 'all', cols: [['cid', '쿠팡ID', 'cid'], ['name', '일한 기사', 'person', 'driverId'], ['from', '시작일', 'date'], ['to', '종료일 (비우면 계속)', 'date'], ['memo', '메모', 'text']] },
  tmp: { sheet: 'stl_tmp', scope: 'all', cols: [['name', '기사', 'person', 'driverId'], ['from', '시작일', 'date'], ['to', '종료일', 'date'], ['price', '일시단가 (VAT포함)', 'money'], ['routes', '적용 노선 (비우면 전체)', 'text'], ['memo', '메모', 'text']] },
  adjust: { sheet: 'stl_adjust', scope: 'month', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['amt', '금액', 'money'], ['memo', '메모', 'text']] },
  advance: { sheet: 'stl_advance', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['date', '지급일', 'date'], ['amt', '가불금', 'money'], ['due', '상계 예정일', 'date'], ['paid', '상환금', 'money'], ['memo', '메모', 'text']] },
  yongcha: { sheet: 'stl_yongcha', scope: 'date', cols: [['date', '날짜', 'date'], ['who', '수행자 (정산 아이디/용차업체)', 'acctOrText', 'whoId'], ['route', '라우트 (비우면 그날 전체)', 'text'], ['mode', '지급구분', ['건당', '금액']], ['price', '단가/금액 (비우면 기본단가)', 'money'], ['qty', '건수 (비우면 자동)', 'money'], ['payer', '차액부담 (정산 아이디)', 'acct', 'payerId'], ['payerPrice', '부담 기준단가 (비우면 자동)', 'money'], ['memo', '메모', 'text']] },
  regular: { sheet: 'stl_regular', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['amt', '월 금액', 'money'], ['from', '시작월', 'month'], ['to', '종료월', 'month'], ['memo', '메모', 'text']] },
  target: { sheet: 'stl_target', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['goal', '연 목표 계산서 (VAT포함)', 'money'], ['unit', '단위', 'money']] },
  split: { sheet: 'stl_split', scope: 'all', cols: [['from', '원 명의자 (발행 줄일 아이디)', 'acct', 'fromId'], ['to', '받는 명의자', 'acct', 'toId'], ['target', '목표 실수령', 'money'], ['unit', '단위', 'money'], ['repeat', '매달 반복', ['Y', 'N']], ['month', '적용월 (반복 N 일 때)', 'month']] },
  leave: { sheet: 'stl_leave', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['month', '퇴사월', 'month'], ['amt', '보류금 (비우면 기본)', 'money']] },
  items: { sheet: 'stl_items', scope: 'all', cols: [['order', '순서', 'text'], ['side', '구분', ['지급', '차감']], ['name', '항목 이름', 'text'], ['method', '계산 방식', STL_METHODS], ['show', '표시', ['항상', '금액 있을 때']], ['taxCut', '계산서에서 빼기 (차감만)', ['', 'Y', 'N']], ['desc', '설명', 'text']] },
  camps: { sheet: 'stl_camps', scope: 'all', cols: [['camp', '캠프명', 'camp'], ['expense', '경비공제율', 'text'], ['san', '산재율 (기사분)', 'text'], ['goy', '고용율 (기사분)', 'text'], ['runner', '러너부담률', 'text']] },
  kinds: { sheet: 'stl_kinds', scope: 'all', cols: [['raw', '쿠팡 구분 값', 'text'], ['std', '표준 분류', STL_STD_KINDS]] },
  config: { sheet: 'stl_config', scope: 'all', fixed: true, cols: [['label', '항목', 'readonly'], ['value', '값', 'text'], ['desc', '설명', 'readonly']] }
};
function stlEditRows_(name, month) {
  const E = STL_EDIT[name];
  let rows = stlRead_(E.sheet);
  if (E.scope === 'month') rows = rows.filter(function (r) { return r.month === month; });
  if (E.scope === 'date') rows = rows.filter(function (r) { return stlMonthOfDate_(r.date) === month; });
  return rows;
}
function stlRowsHash_(rows, cols) {
  const s = JSON.stringify(rows.map(function (r) { return cols.map(function (c) { return r[c[0]] || ''; }); }));
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}
function adm_stlTable(token, name, month) {
  return run_(function () {
    requireAdmin_(token);
    return stlTableView_(name, month);
  });
}
function stlTableView_(name, month) {
  {
    const E = STL_EDIT[name];
    if (!E) fail_('알 수 없는 표입니다.');
    if (E.scope !== 'all' && !stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    if (name === 'config') stlCfg_();
    const D = stlDrivers_(), X = stlIds_(D);
    const rows = stlEditRows_(name, month);
    const accts = Object.keys(X.groups).map(function (k) { return { id: k, label: stlAcctLabel_(X, D, k), stopped: X.groups[k].main.stopped }; })
      .sort(function (a, b) { return (a.stopped ? 1 : 0) - (b.stopped ? 1 : 0) || koCmp_(a.label, b.label); });
    const persons = D.all.map(function (o) { return { id: o.id, label: (D.byName[o.name] || []).length > 1 ? o.name + ' (' + (o.loginId || o.id) + ')' : o.name, status: o.status }; })
      .sort(function (a, b) { return (a.status === ST.ACTIVE ? 0 : 1) - (b.status === ST.ACTIVE ? 0 : 1) || koCmp_(a.label, b.label); });
    let calc = null;
    if (name === 'yongcha' || name === 'advance') {
      if (name === 'yongcha') { const r = stlResult_(month, false); calc = {}; (r.summary.yong || []).forEach(function (y) { calc[y._row] = y; }); }
      else calc = null;
    }
    return {
      ok: true, name: name, month: month, cols: E.cols.map(function (c) { return { k: c[0], label: c[1], type: Array.isArray(c[2]) ? 'select' : c[2], opts: Array.isArray(c[2]) ? c[2] : null, idk: c[3] || '' }; }),
      rows: rows.map(function (r) {
        const o = { _row: r._row };
        E.cols.forEach(function (c) {
          o[c[0]] = r[c[0]] || '';
          if (c[3]) {
            o[c[3]] = r[c[3]] || '';
            if ((c[2] === 'acct' || c[2] === 'acctOrText') && o[c[0]]) { const k = stlAcct_(X, D, r[c[0]], r[c[3]]); if (k) o[c[0]] = stlAcctLabel_(X, D, k); }
          }
        });
        if (calc && calc[r._row]) o._calc = calc[r._row];
        return o;
      }),
      seen: stlRowsHash_(rows, E.cols), fixed: !!E.fixed, closed: E.scope !== 'all' ? !!stlClosedInfo_(month) : false,
      accts: accts, persons: persons, items: stlItems_().list.map(function (i) { return i.name; }),
      camps: master_().camps.map(function (c) { return stlShort_(c.name); }).sort(koCmp_)
    };
  }
}
/** 표 저장: 보이는 범위(그 달 / 전체)의 줄을 rows 로 바꾼다. seen 이 다르면(다른 곳에서 먼저 고침) 거절 */
function adm_stlTableSave(token, name, month, rows, seen) {
  return run_(function () {
    const a = requireAdmin_(token);
    const E = STL_EDIT[name];
    if (!E) fail_('알 수 없는 표입니다.');
    if (E.scope !== 'all' && !stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    if (!Array.isArray(rows) || rows.length > 3000) fail_('줄이 너무 많습니다.');
    const D = stlDrivers_(), X = stlIds_(D);
    const seenCid = {};
    const clean = rows.map(function (r, i) {
      const o = {};
      E.cols.forEach(function (c) {
        let v = str_(r[c[0]]).slice(0, 300);
        const t = c[2];
        if (t === 'money' && v) { const n = stlNum_(v); if (!isFinite(n)) fail_((i + 1) + '번째 줄 ' + c[1] + ': 숫자만'); v = String(Math.round(n * 100) / 100); }
        if (t === 'date' && v) { v = stlYmd_(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail_((i + 1) + '번째 줄 ' + c[1] + ': 2026-10-01 형식'); }
        if (t === 'month' && v) { v = v.slice(0, 7); if (!stlMonthOk_(v)) fail_((i + 1) + '번째 줄 ' + c[1] + ': 2026-10 형식'); }
        if (Array.isArray(t) && v && t.indexOf(v) < 0) fail_((i + 1) + '번째 줄 ' + c[1] + ': ' + t.filter(Boolean).join('/') + ' 중에서');
        if ((t === 'acct' || t === 'acctOrText') && v) {
          const k = stlAcct_(X, D, v, str_(r[c[3]]));
          if (!k && t === 'acct') fail_((i + 1) + '번째 줄: "' + v + '" 정산 아이디를 찾을 수 없습니다 (아이디 관리에 있는 명의자 또는 쿠팡ID).');
          o[c[3]] = k ? X.groups[k].cid : '';
          if (k) v = X.groups[k].ownerId ? D.byId[X.groups[k].ownerId].name : v;
        } else if (t === 'acct' || t === 'acctOrText') o[c[3]] = '';
        if (t === 'person') {
          const pid = v ? stlPerson_(D, v, str_(r[c[3]])) : '';
          if (v && !pid) fail_((i + 1) + '번째 줄: 기사 "' + v + '"를 찾을 수 없습니다 (같은 이름이 여럿이면 "이름 (아이디)").');
          o[c[3]] = pid;
          if (pid) v = D.byId[pid].name;
        }
        if (t === 'cid' && v) {
          v = v.replace(/\s+/g, '');
          if (name === 'ids') { const k = stlLogin_(v); if (seenCid[k]) fail_((i + 1) + '번째 줄: 쿠팡ID ' + v + ' 가 두 번 있습니다.'); seenCid[k] = 1; }
        }
        o[c[0]] = v;
      });
      if (E.scope === 'month') o.month = month;
      if (E.scope === 'date' && o.date && stlMonthOfDate_(o.date) !== month) fail_((i + 1) + '번째 줄 날짜가 ' + month + ' 정산기간(' + stlPeriod_(month).from + ' ~ ' + stlPeriod_(month).to + ') 밖입니다.');
      return o;
    }).filter(function (o) { return E.cols.some(function (c) { return c[2] !== 'readonly' && o[c[0]]; }) || E.fixed; });
    if (name === 'ids') {
      clean.forEach(function (o, i) {
        if (!o.cid) fail_((i + 1) + '번째 줄: 쿠팡ID 를 넣어 주세요.');
        if (o.role === '서브') {
          const m = stlLogin_(o.main), hit = clean.filter(function (x) { return stlLogin_(x.cid) === m; })[0];
          if (!m || !hit) fail_(o.cid + ': 서브는 메인 아이디 칸에 아이디 목록에 있는 메인 쿠팡ID 를 넣어 주세요.');
          if (hit.role === '서브') fail_(o.cid + ': 메인 아이디 ' + o.main + ' 도 서브입니다. 메인을 골라 주세요.');
        }
        if (o.fbCut && !/^\d+(\.\d+)?%?$/.test(o.fbCut.replace(/[,\s원]/g, ''))) fail_(o.cid + ': 프레시백 차감은 13% 또는 금액');
        if (!o.status) o.status = '사용';
      });
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (E.scope !== 'all') stlAssertOpen_(month);
      const cur = stlEditRows_(name, month);
      if (seen && seen !== stlRowsHash_(cur, E.cols)) fail_('다른 곳(시트 또는 다른 관리자)에서 먼저 고쳤습니다. 새로고침 후 다시 저장해 주세요.');
      let out;
      if (E.fixed) {
        // 설정: 값만 바꾼다
        const by = {};
        clean.forEach(function (o) { by[o.label] = o.value; });
        out = stlRead_(E.sheet).map(function (r) { const o = Object.assign({}, r); if (o.label in by) o.value = by[o.label]; return o; });
      } else {
        const all = stlRead_(E.sheet);
        const keep = E.scope === 'all' ? [] : all.filter(function (r) { return E.scope === 'month' ? r.month !== month : stlMonthOfDate_(r.date) !== month; });
        out = keep.concat(clean);
      }
      stlWriteAll_(E.sheet, out);
      stlBump_();
      logAdmin_(a, '정산 표 저장', name + (E.scope !== 'all' ? ' ' + month : ''), clean.length + '줄');
    } finally {
      lock.releaseLock();
    }
    // 저장 직후 화면에 쓸 표 (다시 부르지 않아도 되게)
    let table = null;
    try { table = stlTableView_(name, month); } catch (e) { table = null; }
    return { ok: true, rows: clean.length, table: table };
  });
}

// ── 기사 정산 정보 (러너 올인원 DB drivers 의 정산 열) ──
function adm_stlDrivers(token) {
  return run_(function () {
    requireAdmin_(token);
    cols_(SH.DRIVERS, true); // 새 정산 열 자동 추가
    return stlDriverView_();
  });
}
function stlDriverView_() {
  {
    const D = stlDrivers_();
    const list = D.all.map(function (o) {
      const x = { id: o.id, name: o.name, loginId: o.loginId, status: o.status, type: o.driverType || '', bank: o.bankName || '', account: o.account || '', holder: o.accountHolder || '' };
      STL_DRIVER_FIELDS.forEach(function (k) { x[k] = o[k] || ''; });
      return x;
    }).sort(function (a, b) { return (a.status === ST.ACTIVE ? 0 : 1) - (b.status === ST.ACTIVE ? 0 : 1) || koCmp_(a.name, b.name); });
    return { ok: true, drivers: list, modes: STL_MODES };
  }
}
/** changes = [{ id, f: { bizNo, bizName, bizEmail } }] (명의자 세금계산서 정보) */
function adm_stlDriverSave(token, changes) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!Array.isArray(changes) || !changes.length || changes.length > 500) fail_('저장할 내용이 없습니다.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const D = stlDrivers_();
      let n = 0;
      changes.forEach(function (ch) {
        const o = D.byId[str_(ch.id)];
        if (!o) fail_('기사를 찾을 수 없습니다. 새로고침해 주세요.');
        const f = {};
        Object.keys(ch.f || {}).forEach(function (k) {
          if (STL_DRIVER_FIELDS.indexOf(k) < 0) return;
          let v = str_(ch.f[k]).slice(0, 200);
          if (k === 'bizNo' && v) { const d = v.replace(/\D/g, ''); if (d.length !== 10) fail_(o.name + ': 사업자등록번호 10자리'); v = d.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3'); }
          f[k] = v;
        });
        if (Object.keys(f).length) { f.updatedAt = nowText_(); writeFields_(SH.DRIVERS, o._row, f); forgetDriver_(o); n++; }
      });
      stlBump_();
      logAdmin_(a, '기사 정산정보 수정', n + '명', '');
    } finally {
      lock.releaseLock();
    }
    _cols[SH.DRIVERS] = null;
    const view = stlDriverView_();
    return { ok: true, saved: view ? changes.length : 0, drivers: view.drivers, modes: view.modes };
  });
}

/** 올리기 전 확인: 그 달 최신 차수 · 마감 여부 */
function adm_stlRoundInfo(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const r = stlRounds_(month);
    return { ok: true, month: month, latest: r.latest, closed: !!stlClosedInfo_(month), period: stlPeriod_(month) };
  });
}

/** (내부) 실행마다 새로 시작하는 메모리 상태를 비운다 — 다음 실행과 같은 상태로 시험할 때 */
function stlNewExec_() {
  _stlSS = null; _stlTv = null; _stlFresh = false;
  [_stlSh, _stlCols, _stlTab, _stlMon].forEach(function (o) { Object.keys(o).forEach(function (k) { delete o[k]; }); });
}

/**
 * 기사 정보관리에서 기사구분을 바꾸면 그 기사 본인 아이디(쿠팡플렉스 아이디 = 메인)의 단가 구분도 같이 바꾼다.
 * 아이디의 단가 구분이 예전 기사구분과 같았거나 비어 있을 때만 (따로 정해 둔 값은 그대로).
 */
function stlSyncIdType_(driverId, loginId, oldType, newType) {
  try {
    if (!loginId || STL_TYPES.indexOf(newType) < 0 || !props_().STL_DB_ID) return 0;
    const k = stlLogin_(loginId);
    let n = 0;
    stlRead_('stl_ids').forEach(function (r) {
      if (stlLogin_(r.cid) !== k || (r.ownerId && r.ownerId !== driverId)) return;
      if (r.type && r.type !== oldType) return;
      if (r.type === newType) return;
      stlSetRow_('stl_ids', r._row, { type: newType }); n++;
    });
    if (n) stlBump_();
    return n;
  } catch (e) { console.error('아이디 단가 구분 맞추기 실패: ' + (e && e.message)); return 0; }
}
