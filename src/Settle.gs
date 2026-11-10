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
    mode: '정산 방식', insEx: '산재·고용 제외', fbCut: '프레시백 차감', status: '상태', memo: '메모', vendor: '용차업체'
  },
  // 용차업체: 업체가 등록한 쿠팡 아이디는 아이디 관리에서 명의자 대신 '용차업체'를 고르면 업체별 정산서 1장으로 묶인다 (기사정보 등록 없음)
  stl_vendors: {
    name: '업체명', price: '건당 단가', ins: '산재·고용 공제', bizNo: '사업자번호', ceo: '대표자', phone: '연락처', addr: '사업장 주소', bizType: '업태', bizItem: '종목',
    bank: '은행', account: '계좌번호', holder: '예금주', email: '이메일', status: '상태', memo: '메모', ids: '쿠팡 아이디'
  },
  // 한 아이디로 여러 기사가 일할 때: 그 기간 그 아이디로 일한 기사 (지급은 명의자, 일시단가·근무일 판단에 씀)
  stl_usage: { cid: '쿠팡ID', name: '일한 기사', driverId: '기사ID', from: '시작일', to: '종료일', memo: '메모', settle: '정산' },
  // 기사 일시단가: 그 기사가 일한 날(아이디 사용 기록 기준)의 배송에만 적용
  stl_tmp: { name: '기사', driverId: '기사ID', from: '시작일', to: '종료일', price: '일시단가', routes: '적용 노선', memo: '메모' },
  stl_adjust: { month: '정산월', name: '명의자', acct: '정산 아이디', item: '항목', amt: '금액', memo: '메모', note: '관리자 메모' },
  stl_advance: { name: '명의자', acct: '정산 아이디', date: '지급일', amt: '가불금', due: '상계 예정일', paid: '상환금', memo: '메모' },
  stl_yongcha: {
    date: '날짜', who: '수행자', whoId: '수행 정산 아이디', route: '라우트', mode: '지급구분', price: '단가/금액', qty: '건수',
    payer: '차액부담', payerId: '차액부담 정산 아이디', payerPrice: '부담 기준단가', memo: '메모', gain: '차액 처리', vendorPay: '업체 실지급액'
  },
  stl_regular: { name: '명의자', acct: '정산 아이디', item: '항목', amt: '월 금액', from: '시작월', to: '종료월', memo: '메모' },
  stl_fbcut: { name: '명의자', acct: '정산 아이디', cut: '프백 차감 (금액 또는 %)', memo: '메모' },
  stl_target: { name: '명의자', acct: '정산 아이디', item: '항목', goal: '연 목표 계산서', unit: '단위' },
  stl_split: { from: '원 명의자', fromId: '원 정산 아이디', to: '받는 명의자', toId: '받는 정산 아이디', target: '목표 실수령', unit: '단위', repeat: '매달 반복', month: '적용월' },
  stl_leave: { name: '명의자', acct: '정산 아이디', month: '퇴사월', amt: '보류금', memo: '정산서 메모' },
  stl_items: { order: '순서', side: '구분', name: '항목 이름', method: '계산 방식', show: '표시', taxCut: '계산서에서 빼기', desc: '설명' },
  stl_camps: { kind: '구분', camp: '캠프명', name: '기사', acct: '정산 아이디', basis: '보험 기준', expense: '경비공제율', san: '산재율', goy: '고용율', runner: '러너 부담률', sanOn: '산재 ON/OFF', goyOn: '고용 ON/OFF', memo: '메모' },
  stl_kinds: { raw: '쿠팡 구분 값', std: '표준 분류' },
  stl_config: { label: '항목', value: '값', desc: '설명' },
  stl_pay: { month: '정산월', acct: '정산 아이디', name: '명의자', checked: '입금체크', date: '입금일', memo: '메모' },
  stl_close: { month: '정산월', at: '마감일시', admin: '관리자' },
  // 정산서 탭 확인 필요에서 [확인함]으로 그 달만 숨긴 항목
  stl_ack: { month: '정산월', kind: '구분', key: '대상', memo: '내용', at: '처리일시', admin: '관리자' },
  // 러너 손익·운영비: 고정 운영비(매달 자동) · 직원(급여·원천세) · 지출 기록(그 달 실제 지출)
  stl_cost: { cat: '분류', name: '항목', amt: '월 금액', proof: '증빙', bank: '결제 통장', day: '결제일', from: '시작월', to: '종료월', memo: '메모' },
  stl_staff: { name: '이름', pay: '월 급여', taxRate: '원천세율', day: '지급일', bank: '은행', account: '계좌번호', from: '시작월', to: '종료월', memo: '메모' },
  stl_expense: { month: '귀속월', date: '날짜', cat: '분류', name: '내용', vendor: '거래처', amt: '금액', proof: '증빙', bank: '통장', memo: '메모' },
  // 통장 · 자금배분: 통장 목록 / 배분 설정(항목마다 보낼 통장·금액 규칙) / 정산월별 배분 기록(이체 체크) / 직접 입·출금 기록
  stl_bank: { name: '통장명', role: '용도', bankName: '은행', account: '계좌번호', opening: '기초잔액', openDate: '기초일', memo: '메모' },
  stl_alloc: { label: '항목', bank: '보낼 통장', rule: '금액 규칙', desc: '설명' },
  stl_fund: { month: '정산월', item: '항목', bank: '통장', plan: '계산 금액', amt: '금액', done: '완료', date: '날짜', memo: '메모' },
  stl_banktx: { date: '날짜', kind: '구분', from: '출금 통장', to: '입금 통장', amt: '금액', memo: '내용', month: '정산월' },
  // 세금 일정: 세금마다 낸 금액 · 납부일 · 출금 통장 (키 = 세목|기간)
  stl_taxpay: { key: '키', kind: '세금', period: '기간', due: '납부기한', amt: '낸 금액', date: '납부일', bank: '출금 통장', memo: '메모' },
  stl_closed: { month: '정산월', acct: '정산 아이디', data: '결과(자동)' },
  // 통장 내역 올리기 (#291): 은행 거래내역(PDF·엑셀) 한 줄 = 한 줄. month = 거래 날짜의 달. cat = 분류, ref = 연결(기사 정산·쿠팡 입금·직원 급여 …)
  stl_bankrows: { month: '월', key: '키', bank: '은행', acct4: '계좌 끝4', bankName: '통장(올인원)', date: '날짜', time: '시각', io: '입출금', amt: '금액', bal: '잔액', memo: '거래내용', kind: '거래구분', cat: '분류', ref: '연결', refName: '연결 이름', status: '상태', note: '메모', at: '올린 시각' },
  stl_bankrules: { pattern: '거래내용 패턴', cat: '분류', refName: '연결 이름', at: '등록 시각' }
};
const STL_TAB_NOTES = {
  stl_ids: '정산의 기준. 쿠팡 아이디 한 줄 = 하나. 구분: 메인 / 서브(메인 아이디 칸에 메인 쿠팡ID). 명의자 = 정산금·세금계산서를 받는 기사(이름). 단가코드: 고정 / 백업 / 품앗이 / 외부용차 (메인 아이디는 기사 정보관리의 단가코드이 우선, 서브 아이디는 이 칸이 우선). 정산 방식: 비우면 구분별 단가 / 원청단가 / 용차내역. 쿠팡 정산서를 올릴 때 처음 보는 아이디는 자동으로 추가됩니다.',
  stl_vendors: '용차업체 목록. 건당 단가 = 러너가 업체에 주는 지급 단가 (VAT포함, 모든 노선 같은 단가 · 비우면 노선관리 외부용차단가). 기사에게 청구하는 기본 단가는 노선관리 외부용차단가. 산재·고용 공제: Y = 기사처럼 공제 / N = 공제 안 함. 아이디 관리의 용차업체 칸에 업체명을 넣으면 그 아이디는 이 업체 정산서로 묶입니다.',
  stl_usage: '한 아이디로 여러 기사가 일할 때, 그 아이디로 일한 기사와 기간. 기록이 없는 날은 명의자가 일한 것으로 봅니다. 정산: 비우면 일한 기사 본인 정산으로 옮김 / 명의자 = 서브 인원 (명의자 정산 그대로).',
  stl_tmp: '기사가 정해진 기간 동안 다른 단가로 일할 때. 적용 노선을 비우면 전체, 708C 또는 시흥2|708C 처럼 쉼표로 여러 개.',
  stl_raw: '쿠팡 정산 엑셀을 [정산관리 → 쿠팡 정산서 올리기]로 넣으면 자동으로 채워집니다. 한 정산월에는 마지막으로 올린 차수만 남습니다.',
  stl_adjust: '기사별 월 추가지급·차감. 항목은 stl_items 의 "항목 이름". 금액은 차감도 양수로.',
  stl_advance: '가불금 원장. 상계 예정일(상환일)을 적으면 그 날 이후 첫 지급 정산월에 남은 금액(가불금 − 상환금)이 "가불금 상환"으로 자동 공제되고, 그 달을 마감하면 상환금에 자동 기록됩니다. 정산 밖에서 현금으로 받으면 상환금 칸에 직접 적으세요.',
  stl_yongcha: '지급구분: 건당 / 금액. 단가를 비우면 품앗이 = 노선관리의 그 노선 품앗이단가, 용차업체 = 그 노선 외부용차단가(차액부담 기사 청구 단가). 건수를 비우면 쿠팡 정산서에서 자동으로 셉니다.',
  stl_camps: '캠프 및 기사별 산재·고용. 구분 = 캠프 / 기사. 빈 칸 = 세부정산 설정 기본값. 우선순위: 기사 > 캠프 > 기본값 (칸마다). 산재·고용 ON/OFF 는 기사 줄만 (OFF = 그 보험 공제 안 함). 보험 기준: 공급가 / 부가세포함. 산재율·고용율 = 전체 요율(기사+러너), 기사 공제 = 요율 × (1 − 러너 부담률).',
  stl_config: '값만 고치세요. % 는 10% 처럼 써도 됩니다.',
  stl_cost: '고정 운영비: 매달 똑같이 나가는 돈. 월 금액 = 실제 나가는 돈(VAT포함). 증빙이 세금계산서·카드·현금영수증이면 부가세를 나눠 매입세액 공제로 셉니다. 시작월·종료월(2026-11) 사이 달에 자동 반영.',
  stl_staff: '직원(기사 아님): 월 급여(세전) · 원천세율(비우면 3.3% = 소득세 3% + 지방소득세 0.3%).',
  stl_expense: '그 달 실제 지출. 귀속월 = 손익에 넣을 정산월. 금액 = VAT포함.',
  stl_closed: '마감할 때 프로그램이 기록합니다. 손으로 고치지 마세요.'
};

const STL_KIND_DEFAULT = [
  ['배송', '배송'], ['수기반영', '수기반영'], ['재사용포장재 회수 인센티브', '프레시백'], ['미계약 라우트', '미계약'],
  ['시설 및 장비 사용료', '업체차감'], ['추가 인센티브 전월소급', '기타'], ['프로모션', '기타']
];
const STL_STD_KINDS = ['배송', '수기반영', '프레시백', '미계약', '업체차감', '기타', '프로모션베이스', '프로모션일반'];
// 쿠팡 구분값에 이 글자가 들어 있으면(앞에 "2026년 추석" 같은 이름이 붙어도) 그 분류로 — stl_kinds 에 똑같은 값이 있으면 그쪽이 우선
const STL_KIND_PATTERNS = [['베이스 프로모션', '프로모션베이스'], ['일반 프로모션', '프로모션일반'], ['프로모션', '기타']];

// 명세서 항목 기본값 (순서, 구분, 이름, 계산 방식, 표시, 계산서에서 빼기, 설명)
const STL_ITEM_DEFAULT = [
  ['1', '지급', '배송 기본', '배송기본', '항상', '', '노선 배송료 + 프백 가중치'],
  ['1.5', '지급', '용차(지급)', '용차수행', '금액 있을 때', '', '휴무자 대신 뛴 용차 추가지급 / 용차업체 지급액'],
  ['2', '지급', '프레시백', '프레시백', '항상', '', '프레시백 회수 인센티브'],
  ['2.5', '지급', '매출 분할 수령', '직접입력', '금액 있을 때', '', ''],
  ['2.8', '지급', '보류금 반환', '입금가산', '금액 있을 때', '', '계산서 제외 · 실입금에만 더함'],
  ['3', '지급', '미계약 라우트', '미계약', '금액 있을 때', '', ''],
  ['3.5', '지급', '프로모션 (직접 신청)', '프로모션', '금액 있을 때', '', '기사가 쿠팡플렉스 앱에서 직접 신청한 프로모션 · 미계약과 같은 계산 (×1.1 · 수수료 제외)'],
  ['4', '지급', '기타 (프로모션)', '기타프로모션', '금액 있을 때', '', '프로모션·소급 등'],
  ['5', '지급', '팀장수당', '직접입력', '금액 있을 때', '', ''],
  ['5.5', '지급', '유류비지원', '직접입력', '금액 있을 때', '', ''],
  ['6', '차감', '분실파손 부담', '분실파손', '항상', 'N', '계산서 발행 후 공제 (정석) · 공제액은 러너 기타수익'],
  ['7', '차감', '용차(지출)', '용차지출', '금액 있을 때', 'N', '용차 단가 − 기사 단가 차액 · 계산서 발행 후 공제'],
  ['8', '차감', '계산서 차감', '직접입력', '금액 있을 때', 'Y', ''],
  ['8.5', '차감', '매출 분할 이전', '직접입력', '금액 있을 때', 'Y', ''],
  ['9', '차감', '산재보험', '산재보험', '항상', 'N', ''],
  ['10', '차감', '고용보험', '고용보험', '항상', 'N', ''],
  ['11', '차감', '가불금 상환', '직접입력', '금액 있을 때', 'N', '입금액에서만 차감'],
  ['11.5', '차감', '퇴사 보류금', '직접입력', '금액 있을 때', 'N', ''],
  ['12', '차감', '기타 공제', '직접입력', '금액 있을 때', 'N', '차량비·유류비 등']
];
const STL_METHODS = ['배송기본', '프레시백', '미계약', '프로모션', '기타프로모션', '분실파손', '용차지출', '용차수행', '산재보험', '고용보험', '직접입력', '입금가산'];

// 이름을 바꾼 설정 [예전 이름, 새 이름] — 2026-11-07 산재·고용 요율 = 전체 요율 (기사 공제 = 요율 × (1 − 러너 부담률))
const STL_CFG_RENAME = [
  ['산재보험료율 (기사 부담분)', '산재보험료율 (전체 요율 · 기사+러너)'],
  ['출퇴근재해 요율 (기사 부담분)', '출퇴근재해 요율 (전체 요율)'],
  ['고용보험료율 (기사 부담분)', '고용보험료율 (전체 요율 · 기사+러너)']
];
// 설정 (키, 항목 이름, 기본값, 설명, 묶음)
const STL_CFG = [
  ['vat', '부가세율', '10%', '쿠팡 정산서 금액(공급가) → 부가세 포함 환산', '금액 환산 · 기사 지급률'],
  ['incRate', '프백 가중치(추가인센티브) 기사 지급률', '100%', '', '금액 환산 · 기사 지급률'],
  ['freshRate', '프레시백 회수 인센티브 기사 지급률', '100%', '100% = 전액 기사. 나머지는 러너 프백 잉여. 기사 지급액은 100원 단위 올림', '금액 환산 · 기사 지급률'],
  ['uncFee', '미계약 라우트 업체 수수료율', '10%', '기사 지급 = 미계약 금액 × (1 − 수수료율), 10원 단위 반올림', '금액 환산 · 기사 지급률'],
  ['etcRate', '기타(프로모션·소급) 기사 지급률', '0%', '', '금액 환산 · 기사 지급률'],
  ['lossRate', '분실파손 기사 부담률', '100%', '', '분실파손'],
  ['lossVat', '분실파손 부가세 포함 환산 (Y/N)', 'Y', 'Y = 쿠팡 차감금액(소비자가) × 1.1 을 기사 부담 · 차이는 러너 잉여', '분실파손'],
  ['expense', '필요경비 공제율 (경비율, 공단 기준)', '34.6%', '보수액 = 기준금액 × (1 − 경비율)', '산재 · 고용보험'],
  ['san', '산재보험료율 (전체 요율 · 기사+러너)', '1.76%', '기사 공제 = 보수액 × 요율 × (1 − 러너 부담률) · 10원 미만 버림', '산재 · 고용보험'],
  ['commute', '출퇴근재해 요율 (전체 요율)', '0%', '', '산재 · 고용보험'],
  ['goy', '고용보험료율 (전체 요율 · 기사+러너)', '1.6%', '기사 공제 = 보수액 × 요율 × (1 − 러너 부담률) · 10원 미만 버림', '산재 · 고용보험'],
  ['goyMin', '고용보험 적용 최저 월 보수액', '800000', '미만이면 고용보험 제외', '산재 · 고용보험'],
  ['runner', '러너 부담률 기본값', '50%', '50% = 러너가 기사와 같은 금액 부담', '산재 · 고용보험'],
  ['insBasis', '보험 계산 기준 (공급가/부가세포함)', '공급가', '', '산재 · 고용보험'],
  ['payDay', '기사 지급일 (익월, 일)', '20', '', '지급일 · 입금일 · 세금계산서'],
  ['cpDay', '쿠팡 입금일 (익월, 일)', '15', '공휴일·주말이면 다음 영업일', '지급일 · 입금일 · 세금계산서'],
  ['payShift', '기사 지급일이 휴일이면 다음 영업일 (Y/N)', 'N', '', '지급일 · 입금일 · 세금계산서'],
  ['invDay', '세금계산서 발행기한 (익월, 일)', '10', '', '지급일 · 입금일 · 세금계산서'],
  ['email', '세금계산서 수신 이메일', '', '기사 명세서의 공급받는자 이메일', '지급일 · 입금일 · 세금계산서'],
  ['leaveAmt', '퇴사 보류금 기본 금액', '100000', '', '퇴사 보류금'],
  ['appShow', '기사 앱 정산서 공개 (마감한 달만 / 계산 중인 달도)', '마감한 달만', '계산 중인 달도 = 마감 전에도 기사 앱에 \'확정 전\' 으로 보임', '기사 앱'],
  ['appFrom', '기사 앱 정산서 공개 시작 월 (YYYY-MM · 비우면 전체)', '', '이 달부터 기사 앱에 보임. 예) 2026-11 → 1~10월(기존 정산 이식분)은 기사 앱에 안 보임', '기사 앱'],
  ['appHide', '기사 앱에서 숨길 정산월 (YYYY-MM, 쉼표로 여러 개)', '', '예) 2026-04, 2026-05 → 그 달만 기사 앱에서 숨김 (관리자 화면은 그대로)', '기사 앱']
];

const STL_DRIVER_EDIT = ['stlMode', 'insEx']; // 명의자 사업자 정보 표에서 고칠 수 있는 칸 (사업자 정보는 읽기만 · 기사 정보관리 DB 값)
const STL_DRIVER_FIELDS = ['stlMode', 'insEx', 'bizNo', 'bizName', 'bizEmail', 'bizCeo', 'bizAddr', 'bizType', 'bizItem']; // 기사(사람) 정보: 명의자의 세금계산서용
const STL_ROLES = ['메인', '서브'];
const STL_ID_STATUS = ['사용', '정지']; // 예전 값 '중지' 도 정지로 읽는다
const STL_TYPES = ['고정', '백업', '품앗이', '외부용차'];
const STL_MODES = ['', '원청단가', '용차내역'];
const STL_TYPE_KEY = { '고정': 'p2', '백업': 'p3', '품앗이': 'p4', '외부용차': 'p5' };

// ───────────────────────── 정산 DB 파일 / 시트 (빠른 읽기·쓰기) ─────────────────────────
// 읽기: 탭 내용을 캐시(탭마다 버전)에 두고, 없으면 필요한 탭을 Sheets API 한 번(batchGet)으로 읽는다.
// 쓰기: 쓴 내용을 바로 캐시에 넣는다(다시 읽지 않음). 시트에서 손으로 고치면 편집 트리거가 그 탭 캐시만 버린다.
let _stlSS = null, _stlTv = null, _stlFresh = false;
const _stlSh = {}, _stlCols = {}, _stlTab = {}, _stlMon = {};
// 계산 방식·표시가 바뀌면 올린다 → 배포하자마자 예전 계산 결과(10분 캐시) 대신 새로 계산
const STL_CALC_VER = '20261110a'; // 회사 합계에 러너 몫 프로모션(promoBase·promoRunner) 추가
const STL_BIG = ['stl_raw', 'stl_loss', 'stl_closed', 'stl_bankrows']; // 정산월 묶음으로만 읽는 큰 탭
const STL_SMALL = ['stl_ids', 'stl_vendors', 'stl_usage', 'stl_tmp', 'stl_config', 'stl_items', 'stl_kinds', 'stl_camps', 'stl_adjust', 'stl_advance', 'stl_yongcha', 'stl_regular', 'stl_fbcut', 'stl_target', 'stl_split', 'stl_leave', 'stl_pay', 'stl_rounds', 'stl_close', 'stl_ack', 'stl_cost', 'stl_staff', 'stl_expense', 'stl_bank', 'stl_alloc', 'stl_fund', 'stl_banktx', 'stl_taxpay', 'stl_bankrules'];
// 손익·운영비 탭: 고쳐도 기사 정산(계산 결과)은 다시 계산하지 않는다 (손익만 바로 다시 셈)
const STL_NO_RECALC = { stl_pay: 1, stl_cost: 1, stl_staff: 1, stl_expense: 1, stl_bank: 1, stl_alloc: 1, stl_fund: 1, stl_banktx: 1, stl_taxpay: 1, stl_bankrows: 1, stl_bankrules: 1 };
// 통장 용도 · 기본 통장 (기존 운영시트 통장 8개)
const STL_BANK_ROLES = ['쿠팡 입금', '기사정산', '부가세', '산재고용', '운영비', '인건비', '대표', '유보금', '기타'];
const STL_BANK_DEFAULT = [['운영 통장', '쿠팡 입금'], ['기사정산 통장', '기사정산'], ['부가세 통장', '부가세'], ['산재고용 통장', '산재고용'], ['운영고정비 통장', '운영비'], ['인건비 통장', '인건비'], ['대표 통장', '대표'], ['유보금 통장', '유보금']];
// 자금배분 항목: [키, 항목, 기본 통장 용도, 설명]
const STL_FUND_ITEMS = [
  ['driver', '기사정산금', '기사정산', '기사 실입금 합계 (입금확인에서 체크하면 이 통장에서 빠짐) · 지급일'],
  ['vat', '부가세', '부가세', '부가세 예상 = 매출세액 − 기사 매입세액 − 운영비 매입세액 · 1/25 · 7/25 납부'],
  ['ins', '산재·고용', '산재고용', '공단 실납부 전체 = 기사 공제분 + 러너 부담분 · 다음 달 10일'],
  ['staff', '인건비', '인건비', '직원 세전 급여 합계 (실지급 + 원천세)'],
  ['fixed', '운영 고정비', '운영비', '고정 운영비 (실제 나가는 돈, VAT포함)'],
  ['var', '변동 지출', '운영비', '지출 기록 (실제 나간 돈, VAT포함)'],
  ['tax', '종합소득세 적립', '유보금', '당기순이익 × 적립률 · 금액 규칙에 20% 처럼 (비우면 0) · 다음 해 5월'],
  ['owner', '대표 인출', '대표', '대표가 가져가는 돈 · 금액 규칙에 금액 또는 % (당기순이익 기준, 비우면 0)'],
  ['rest', '유보금 (나머지)', '유보금', '쿠팡 입금 − 위 항목 합계']
];
const STL_COST_CATS = ['사무실', '세무·회계', '법률·자문', '차량', '통신', '보험·공과', '이자·수수료', '소모품', '유류비', '수리·정비', '식대·접대', '기타', '세금 납부 (손익 제외)', '산재·고용 납부 (손익 제외)'];
// 지출 기록에 남기되 손익(운영비)에는 넣지 않는 분류: 부가세·소득세 납부(비용 아님 · 부가세는 따로 계산), 산재·고용 납부(보험료는 손익에서 따로 계산)
const STL_NOPNL_CATS = ['세금 납부 (손익 제외)', '산재·고용 납부 (손익 제외)'];
const STL_PROOFS = ['', '세금계산서', '카드', '현금영수증', '면세·없음'];
function stlSS_() {
  if (_stlSS) return _stlSS;
  const id = props_().STL_DB_ID;
  if (id) {
    try { _stlSS = SpreadsheetApp.openById(id); }
    catch (e) { fail_('정산 DB 파일을 열 수 없습니다. 드라이브 휴지통에 있는지 확인하거나, 스크립트 속성 STL_DB_ID 를 비우면 새로 만듭니다.'); }
    stlEnsureTrigger_(_stlSS);
    return _stlSS;
  }
  const lock = scriptLock_();
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
  if (!v || !v._) {
    v = { _: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) };
    try { cache_().put('stl:tv', JSON.stringify(v), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } // 다음 실행도 같은 묶음을 쓰게
  }
  return (_stlTv = v);
}
function stlVerOf_(name) { const v = stlTv_(); return v._ + '.' + (v[name] || 0); }
/** 잠금을 잡은 직후: 잠금을 기다리는 동안 다른 실행이 고친 탭을 다시 읽도록 이 실행의 탭 메모와 버전 메모를 비운다 */
function stlFreshIn_(names) { _stlTv = null; [].concat(names).forEach(function (n) { delete _stlTab[n]; Object.keys(_stlMon).forEach(function (k) { if (k.indexOf(n + '|') === 0) delete _stlMon[k]; }); }); }
function stlTouch_(names) {
  flushBeforeBump_(); // 시트 쓰기를 먼저 반영한 뒤 버전을 올린다
  // 다른 실행이 그 사이 올린 번호를 덮어써 옛 캐시가 되살아나지 않도록, 최신 번호를 다시 읽어 합친다
  let cur = null;
  try { cur = JSON.parse(cache_().get('stl:tv') || 'null'); } catch (e) { cur = null; }
  const mem = stlTv_();
  if (cur && cur._ === mem._) Object.keys(cur).forEach(function (k) { if (k !== '_' && (cur[k] || 0) > (mem[k] || 0)) mem[k] = cur[k]; });
  else if (cur && cur._) { Object.keys(mem).forEach(function (k) { delete mem[k]; }); Object.assign(mem, cur); }
  else if (!cur) mem._ = Date.now().toString(36) + Math.random().toString(36).slice(2, 5); // 캐시가 비었으면 새 묶음
  const v = mem;
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
  const lock = scriptLock_();
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
  if (name === 'stl_bank') return STL_BANK_DEFAULT.map(function (b) { return [b[0], b[1], '', '', '', '', '']; });
  if (name === 'stl_alloc') return STL_FUND_ITEMS.map(function (f) { const b = STL_BANK_DEFAULT.filter(function (x) { return x[1] === f[2]; })[0]; return [f[1], b ? b[0] : '', '', f[3]]; });
  if (name === 'stl_camps') {
    try { return master_().camps.map(function (c) { return ['캠프', stlShort_(c.name), '', '', '', '', '', '', '', '', '']; }); } catch (e) { return []; }
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
    // 잠금 안에서 실제 머리글을 다시 읽고(캐시가 옛것일 수 있음), 마지막 머리글 오른쪽에만 추가한다 (중간 빈 칸·사람이 추가한 열 보호)
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const sh = stlSheet_(name);
      head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      const need = miss.filter(function (l) { return head.indexOf(l) < 0; });
      if (need.length) {
        let last = head.length;
        while (last > 0 && head[last - 1] === '') last--;
        const start = last + 1;
        if (start + need.length - 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), start + need.length - 1 - sh.getMaxColumns());
        sh.getRange(1, start, sh.getMaxRows(), need.length).setNumberFormat('@');
        sh.getRange(1, start, 1, need.length).setValues([need]).setFontWeight('bold').setBackground('#f1f3f4');
        head = head.slice(0, last).concat(need);
      }
      if (STL_BIG.indexOf(name) >= 0) stlCPut_('stl:h:' + name + ':' + stlTv_()._, head, CFG.CACHE_MAX);
      stlTouch_(name);
    } finally { lock.releaseLock(); }
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
  // 항목 이름이 바뀐 설정: 예전 이름 줄을 새 이름으로 고쳐 쓴다 (값은 그대로)
  const ren = STL_CFG_RENAME.filter(function (x) { return !(x[1] in map) && (x[0] in map); });
  if (ren.length) {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      ren.forEach(function (x) {
        const r = rows.filter(function (o) { return o.label === x[0]; })[0];
        const d = STL_CFG.filter(function (c) { return c[1] === x[1]; })[0];
        stlSetRow_('stl_config', r._row, { label: x[1], desc: d ? d[3] : r.desc });
        map[x[1]] = map[x[0]];
      });
    } finally { lock.releaseLock(); }
  }
  const missing = STL_CFG.filter(function (d) { return !(d[1] in map); });
  if (missing.length) {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try { stlAppend_('stl_config', missing.map(function (d) { return { label: d[1], value: d[2], desc: d[3] }; })); } finally { lock.releaseLock(); }
    missing.forEach(function (d) { map[d[1]] = d[2]; });
  }
  const g = {};
  STL_CFG.forEach(function (d) { g[d[0]] = map[d[1]] !== undefined ? map[d[1]] : d[2]; });
  const rate = function (k) { return stlRate_(g[k], stlRate_(STL_CFG.filter(function (d) { return d[0] === k; })[0][2], 0)); };
  return {
    vat: rate('vat'), incRate: rate('incRate'), freshRate: rate('freshRate'), uncFee: rate('uncFee'), etcRate: rate('etcRate'),
    lossRate: rate('lossRate'), lossVat: !/^n/i.test(str_(g.lossVat)),
    expense: rate('expense'), san: rate('san'), commute: rate('commute'), goy: rate('goy'), goyMin: stlNum_(g.goyMin),
    runner: rate('runner'), insBasis: str_(g.insBasis) === '부가세포함' ? '부가세포함' : '공급가',
    payDay: stlNum_(g.payDay) || 20, cpDay: stlNum_(g.cpDay) || 15, payShift: stlYes_(g.payShift), invDay: stlNum_(g.invDay) || 10,
    leaveAmt: stlNum_(g.leaveAmt) || 100000, email: str_(g.email), appOpen: /계산|모두|전부|y/i.test(str_(g.appShow)),
    appFrom: (str_(g.appFrom).match(/\d{4}-\d{2}/) || [''])[0], appHide: (str_(g.appHide).match(/\d{4}-\d{2}/g) || [])
  };
}
function stlItems_() {
  stlItemsTaxCutV2_();
  const rows = stlRead_('stl_items').filter(function (o) { return o.name; });
  const defs = STL_ITEM_DEFAULT.map(function (r) { return { order: r[0], side: r[1], name: r[2], method: r[3], show: r[4], taxCut: r[5], desc: r[6] }; });
  // 탭에 줄이 있어도 새로 생긴 자동 계산 항목(예: 프로모션)이 빠져 있으면 기본값을 보탠다 → 명세서에 제자리(순서)로 보임
  const have = {}; rows.forEach(function (o) { have[o.method] = 1; });
  const src = rows.length ? rows.concat(defs.filter(function (d) { return d.method !== '직접입력' && d.method !== '입금가산' && !have[d.method]; })) : defs;
  const list = src.map(function (o) {
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
/** 2026-11-09 정석 전환 (한 번만): 분실파손 부담·용차(지출)을 계산서 발행 후 공제로 (시트에 저장된 설정도 N 으로) · 되돌리려면 항목 탭에서 Y */
function stlItemsTaxCutV2_() {
  try {
    const ps = PropertiesService.getScriptProperties();
    if (ps.getProperty('STL_TAXCUT_V2') === '1') return;
    const rows = stlRead_('stl_items');
    let changed = false;
    rows.forEach(function (o) { if ((o.method === '분실파손' || o.method === '용차지출') && stlYes_(o.taxCut)) { o.taxCut = 'N'; changed = true; } });
    if (changed && rows.length) {
      const lock = scriptLock_(); lock.waitLock(30000);
      try { stlWriteAll_('stl_items', rows.map(function (o) { const x = {}; Object.keys(STL_TABS.stl_items).forEach(function (k) { x[k] = o[k]; }); return x; })); } finally { lock.releaseLock(); }
    }
    ps.setProperty('STL_TAXCUT_V2', '1');
  } catch (e) { /* 다음 호출 때 다시 시도 */ }
}
function stlKinds_() {
  const map = {};
  STL_KIND_DEFAULT.forEach(function (r) { map[r[0]] = r[1]; });
  stlRead_('stl_kinds').forEach(function (o) { if (o.raw && STL_STD_KINDS.indexOf(o.std) >= 0) map[o.raw] = o.std; });
  return map;
}
/** 쿠팡 구분값 → 표준 분류 (정확히 같은 값 → 포함 글자 규칙 → 미분류) */
function stlKindOf_(kinds, raw) {
  const k = str_(raw);
  if (kinds[k]) return kinds[k];
  for (let i = 0; i < STL_KIND_PATTERNS.length; i++) if (k.indexOf(STL_KIND_PATTERNS[i][0]) >= 0) return STL_KIND_PATTERNS[i][1];
  return '미분류';
}
/** 캠프 및 기사별 산재·고용 설정 (stl_camps). 빈 칸 = 세부정산 설정 기본값
 *  camp[캠프] = { basis, expense, san, goy } (빈 칸은 기본값으로 채움)
 *  acct[정산 묶음] = { basis, expense, san, goy (빈 칸 null → 캠프값/기본값), sanOff, goyOff, row } */
function stlInsKind_(o) { return str_(o.kind) === '기사' || (!str_(o.kind) && str_(o.name) && !str_(o.camp)) ? '기사' : '캠프'; }
function stlInsBasis_(v) { const t = str_(v).replace(/\s/g, ''); return t === '부가세포함' || t === 'VAT포함' ? '부가세포함' : t === '공급가' ? '공급가' : ''; }
function stlOff_(v) { return /^(off|n|no|x|끔|안함|미적용|제외)$/i.test(str_(v).replace(/\s/g, '')); }
function stlCampIns_(cfg, X, D) {
  const out = { camp: {}, acct: {} };
  stlRead_('stl_camps').forEach(function (o) {
    if (stlInsKind_(o) === '기사') {
      if (!X || !D) return;
      const id = stlAcct_(X, D, o.name, o.acct);
      if (!id) return;
      const r = function (v) { return str_(v) ? stlRate_(v, null) : null; };
      out.acct[id] = { basis: stlInsBasis_(o.basis), expense: r(o.expense), san: r(o.san), goy: r(o.goy), runner: r(o.runner), sanOff: stlOff_(o.sanOn), goyOff: stlOff_(o.goyOn), row: o._row };
      return;
    }
    if (!o.camp) return;
    out.camp[stlShort_(o.camp)] = {
      basis: stlInsBasis_(o.basis) || cfg.insBasis, expense: stlRate_(o.expense, cfg.expense), san: stlRate_(o.san, cfg.san), goy: stlRate_(o.goy, cfg.goy), runner: stlRate_(o.runner, cfg.runner), row: o._row
    };
  });
  return out;
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
  let rows;
  if (stlIdsV2_()) rows = stlIdRows_(D); // 기사 정보관리 = 아이디의 기준 (아이디 관리 탭은 보기 전용)
  else {
    rows = stlRead_('stl_ids');
    if (!rows.length && D.all.some(function (o) { return o.loginId; })) { stlSeedIds_(D); rows = stlRead_('stl_ids'); }
  }
  const by = {}, groups = {};
  rows.forEach(function (r) {
    const k = stlLogin_(r.cid);
    if (!k || by[k]) return;
    const ownerId = stlPerson_(D, r.owner, r.ownerId);
    by[k] = {
      key: k, cid: r.cid, role: r.role === '서브' ? '서브' : '메인', mainRaw: r.main, ownerId: ownerId, ownerName: ownerId ? D.byId[ownerId].name : r.owner,
      type: STL_TYPES.indexOf(r.type) >= 0 ? r.type : '', mode: STL_MODES.indexOf(r.mode) >= 0 ? r.mode : '', insEx: stlYes_(r.insEx), fbCut: r.fbCut,
      stopped: r.status === '정지' || r.status === '중지', stopFrom: str_(r.stopFrom), _row: r._row, vendor: str_(r.vendor), drvId: str_(r.drvId)
    };
  });
  const V = stlVendors_();
  const bad = [];
  Object.keys(by).forEach(function (k) {
    const x = by[k];
    // 용차업체 아이디: 메인·서브 상관없이 업체 하나 = 정산 묶음 하나
    if (x.vendor) { x.mainKey = stlVendorKey_(x.vendor); x.ownerId = ''; x.ownerName = x.vendor; return; }
    let m = x.role === '서브' ? stlLogin_(x.mainRaw) : k;
    if (x.role === '서브' && (!by[m] || by[m].role === '서브' || m === k)) { bad.push(x.cid); m = k; }
    // 메인이 용차업체 아이디인 서브 → 그 업체 묶음
    if (x.role === '서브' && by[m] && by[m].vendor && m !== k) m = stlVendorKey_(by[m].vendor);
    x.mainKey = m;
  });
  Object.keys(by).forEach(function (k) {
    const x = by[k];
    let g = groups[x.mainKey];
    if (!g) {
      let main = by[x.mainKey];
      if (x.vendor) {
        const v = V.by[x.mainKey] || { name: x.vendor, price: 0, ins: true, missing: true };
        main = { key: x.mainKey, cid: v.name, role: '메인', ownerId: '', ownerName: v.name, type: '외부용차', mode: '', insEx: !v.ins, fbCut: '', stopped: !!v.stopped, vendor: v.name, vinfo: v };
      }
      g = groups[x.mainKey] = { key: x.mainKey, cids: [], main: main };
    }
    g.cids.push(x.cid);
  });
  Object.keys(groups).forEach(function (k) { const g = groups[k]; g.cid = g.main.cid; g.ownerId = g.main.ownerId; g.vendor = g.main.vendor || ''; });
  return { by: by, groups: groups, badSub: bad, vendors: V };
}
// ───────────────────────── 아이디 = 기사 정보관리 (중간 방식) ─────────────────────────
/** 기사 정보관리가 아이디의 기준인지 (한 번 옮긴 뒤부터) */
function stlIdsV2_() { return str_(props_().STL_IDS_V2) === '1'; }
/** 근무상태 → 아이디 정지 · 정지 시작일 (퇴사 = 퇴사일 다음 날부터, 휴직 = 바로) */
function stlDrvStop_(o) {
  if (o.workStatus === '퇴사') return { stopped: true, from: schLeaveFrom_(o) };
  if (o.workStatus === '휴직') return { stopped: true, from: '' };
  return { stopped: false, from: '' };
}
/**
 * 기사 정보(쿠팡플렉스 아이디 · 서브아이디1·2 · 서브 단가 · 정산 설정) + 용차업체 아이디 → stl_ids 와 같은 모양의 줄
 *  - 메인: 기사마다 쿠팡플렉스 아이디 (다른 기사의 서브아이디로 들어가 있으면 메인 아님)
 *  - 서브: 서브아이디1·2 → 명의자 = 그 기사, 단가 = 서브 단가(비우면 메인과 같음)
 *  - 용차업체: 용차업체 메뉴의 '쿠팡 아이디'
 */
function stlIdRows_(D) {
  const rows = [], vrows = [], subOf = {}, used = {};
  // 용차업체 아이디가 먼저 (기사 정보에 같은 아이디가 있어도 업체 정산)
  stlVendors_().list.forEach(function (v) {
    v.ids.forEach(function (c) {
      const k = stlLogin_(c);
      if (!k || used[k]) return;
      used[k] = 1;
      vrows.push({ cid: c, role: '메인', main: '', owner: '', ownerId: '', type: '외부용차', mode: '', insEx: '', fbCut: '', status: v.stopped ? '정지' : '사용', vendor: v.name });
    });
  });
  D.all.forEach(function (o) { [o.subId1, o.subId2].forEach(function (s) { const k = stlLogin_(s); if (k && !subOf[k]) subOf[k] = o; }); });
  const status = function (o) { const s = stlDrvStop_(o); return { status: s.stopped ? '정지' : '사용', stopFrom: s.stopped && s.from !== '0000-00-00' ? s.from : '' }; };
  D.all.forEach(function (o) {
    const k = stlLogin_(o.loginId);
    if (!k || used[k] || (subOf[k] && subOf[k] !== o)) return;
    used[k] = 1;
    const st = status(o);
    rows.push({ cid: str_(o.loginId), role: '메인', main: '', owner: o.name, ownerId: o.id, drvId: o.id, type: STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '',
      mode: STL_MODES.indexOf(str_(o.stlMode)) >= 0 ? str_(o.stlMode) : '', insEx: stlYes_(o.insEx) ? 'Y' : '', fbCut: str_(o.fbCut), status: st.status, stopFrom: st.stopFrom, vendor: '' });
  });
  D.all.forEach(function (o) {
    const mk = stlLogin_(o.loginId);
    if (!mk || !used[mk]) return; // 메인 아이디가 없는 기사의 서브는 묶을 곳이 없음 (기사 정보에 쿠팡플렉스 아이디부터)
    [['subId1', 'subType1'], ['subId2', 'subType2']].forEach(function (p) {
      const k = stlLogin_(o[p[0]]);
      if (!k || used[k]) return;
      used[k] = 1;
      const st = status(o), signed = D.byLogin[k];
      rows.push({ cid: str_(o[p[0]]), role: '서브', main: str_(o.loginId), owner: o.name, ownerId: o.id, drvId: o.id, signedId: signed && signed.id !== o.id ? signed.id : '',
        type: STL_TYPES.indexOf(str_(o[p[1]])) >= 0 ? str_(o[p[1]]) : '', mode: '', insEx: '', fbCut: '', status: st.status, stopFrom: st.stopFrom, vendor: '' });
    });
  });
  return vrows.concat(rows);
}
/** 쿠팡 아이디 → { drv, slot: 'main' | 'subId1' | 'subId2' } (기사 정보에서) */
function stlDriverOfCid_(D, cid) {
  const k = stlLogin_(cid);
  if (!k) return null;
  for (let i = 0; i < D.all.length; i++) {
    const o = D.all[i];
    if (stlLogin_(o.subId1) === k) return { drv: o, slot: 'subId1' };
    if (stlLogin_(o.subId2) === k) return { drv: o, slot: 'subId2' };
  }
  const m = D.all.filter(function (o) { return stlLogin_(o.loginId) === k; })[0];
  return m ? { drv: m, slot: 'main' } : null;
}
/** 기사 정보 고치기 (기사 정보관리 한 명 수정과 같은 검사·연동) */
function stlSetDrv_(a, o, changes) { return updateDriverCore_(a, o.id, changes); }
/** 쿠팡 아이디를 기사에 붙인다: 쿠팡플렉스 아이디가 비었으면 메인, 아니면 빈 서브아이디 칸 */
function stlLinkCid_(a, D0, o, cid) {
  const D = stlDrivers_(), me = D.byId[o.id] || o;
  cid = str_(cid).replace(/\s+/g, '');
  if (!cid) fail_('쿠팡 아이디가 비었습니다.');
  const h = stlDriverOfCid_(D, cid);
  if (h && h.drv.id === me.id) return h.slot;
  if (h && h.slot !== 'main') fail_(cid + ' 는 이미 ' + h.drv.name + ' 기사님의 서브아이디입니다.');
  if (h && h.slot === 'main' && !(h.drv.status === ST.STOPPED && !me.loginId)) fail_(cid + ' 는 ' + h.drv.name + ' 기사님의 쿠팡플렉스 아이디입니다.');
  const V = stlVendors_();
  const hv = V.list.filter(function (v) { return v.ids.some(function (y) { return stlLogin_(y) === stlLogin_(cid); }); })[0];
  if (hv) fail_(cid + ' 는 용차업체 ' + hv.name + ' 의 아이디입니다. 용차업체 메뉴에서 먼저 빼 주세요.');
  if (!str_(me.loginId) && !h) { stlSetDrv_(a, me, { loginId: cid }); return 'main'; }
  const slot = !str_(me.subId1) ? 'subId1' : !str_(me.subId2) ? 'subId2' : '';
  if (!slot) fail_(me.name + ' 기사님의 서브아이디 칸(2개)이 다 찼습니다. 기사 정보관리에서 정리해 주세요.');
  const ch = {}; ch[slot] = cid;
  stlSetDrv_(a, me, ch);
  return slot;
}

/** 처음 한 번: 예전 아이디 관리(stl_ids) → 기사 정보 · 용차업체로 옮기고, 열린 달 정산 금액이 같은지 대조 */
function stlEnsureIdsV2_() {
  if (stlIdsV2_()) return null;
  if (!props_().STL_DB_ID || str_(props_().STL_IDS_V2) === '0') return null; // STL_IDS_V2 = 0 → 예전 방식(아이디 관리 탭) 그대로 (되돌리기용)
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    const live = PropertiesService.getScriptProperties().getProperty('STL_IDS_V2');
    if (str_(live) === '1' || str_(live) === '0') { props_().STL_IDS_V2 = str_(live); return null; }
    return stlMigrateIdsV2_();
  } finally {
    lock.releaseLock();
  }
}
function stlMigrateIdsV2_() {
  const months = stlMonths_().withData.filter(function (m) { return !stlClosedInfo_(m); }).slice(-3);
  const snap = function (m) {
    try {
      const r = stlCompute_(m), by = {};
      r.summary.drivers.forEach(function (d) { by[d.id] = { name: d.name, qty: d.qty, sales: d.sales, invoice: d.invoice, net: d.net }; });
      return { by: by, tot: { qty: r.summary.total.qty, invoice: r.summary.total.invoice, net: r.summary.total.net, n: r.summary.drivers.length } };
    } catch (e) { return { err: String(e && e.message || e) }; }
  };
  const before = {};
  months.forEach(function (m) { before[m] = snap(m); });

  const notes = [], D = stlDrivers_(), rows = stlRead_('stl_ids'), V = stlVendors_();
  const set = {}, vIds = {}, taken = {};
  const ch = function (o) { return set[o.id] || (set[o.id] = {}); };
  const cur = function (o, k) { return set[o.id] && set[o.id][k] !== undefined ? set[o.id][k] : str_(o[k]); };
  const nm = function (c) { return String(c).replace(/@.*$/, ''); };
  // 예전 버전이 drivers 탭에 남긴 정산 열 값은 비운다 (기준은 아이디 관리였음)
  D.all.forEach(function (o) { ['stlMode', 'insEx', 'fbCut', 'subType1', 'subType2'].forEach(function (k) { if (str_(o[k])) ch(o)[k] = ''; }); });
  D.all.forEach(function (o) { [o.loginId, o.subId1, o.subId2].forEach(function (c) { const k = stlLogin_(c); if (k) taken[k] = taken[k] || o.id; }); });
  const addSub = function (o, cid, type) {
    const k = stlLogin_(cid);
    if ([cur(o, 'loginId'), cur(o, 'subId1'), cur(o, 'subId2')].some(function (x) { return stlLogin_(x) === k; })) {
      ['subId1', 'subId2'].forEach(function (s, i) { if (stlLogin_(cur(o, s)) === k && type && type !== cur(o, 'driverType')) ch(o)['subType' + (i + 1)] = type; });
      return true;
    }
    if (taken[k] && taken[k] !== o.id && (stlLogin_(D.byId[taken[k]].subId1) === k || stlLogin_(D.byId[taken[k]].subId2) === k)) { notes.push(nm(cid) + ': 이미 ' + D.byId[taken[k]].name + ' 기사님의 서브아이디 → 그대로 둠'); return false; }
    const slot = !cur(o, 'subId1') ? 'subId1' : !cur(o, 'subId2') ? 'subId2' : '';
    if (!slot) { notes.push(nm(cid) + ': ' + o.name + ' 기사님 서브아이디 칸이 다 차서 못 옮김 → 기사 정보관리에서 정리'); return false; }
    ch(o)[slot] = cid;
    if (type && type !== cur(o, 'driverType')) ch(o)[slot === 'subId1' ? 'subType1' : 'subType2'] = type;
    taken[k] = o.id;
    return true;
  };
  const byK = {};
  rows.forEach(function (r) { const k = stlLogin_(r.cid); if (k && !byK[k]) byK[k] = r; });
  const mains = [], subs = [];
  Object.keys(byK).forEach(function (k) {
    const r = byK[k];
    if (r.vendor) { (vIds[r.vendor] = vIds[r.vendor] || []).push(r.cid); return; }
    const mk = stlLogin_(r.main);
    if (r.role === '서브' && mk && mk !== k && byK[mk]) subs.push(r); else mains.push(r);
  });
  mains.forEach(function (r) {
    const k = stlLogin_(r.cid), pid = stlPerson_(D, r.owner, r.ownerId), o = D.byId[pid];
    if (!o) { notes.push(nm(r.cid) + ': 명의자 없는 아이디 → 뺌 (정산서에 나오면 [기사에 연결] · [용차업체로 지정])'); return; }
    const mine = stlLogin_(cur(o, 'loginId'));
    let asMain = false;
    if (mine === k) asMain = true;
    else if (!mine && !(taken[k] && taken[k] !== o.id)) { ch(o).loginId = r.cid; taken[k] = o.id; asMain = true; notes.push(o.name + ': 쿠팡플렉스 아이디 ' + nm(r.cid) + ' 채움'); }
    if (asMain) {
      if (STL_TYPES.indexOf(r.type) >= 0 && !str_(o.driverType)) ch(o).driverType = r.type;
      if (STL_MODES.indexOf(r.mode) >= 0 && r.mode) ch(o).stlMode = r.mode;
      if (stlYes_(r.insEx)) ch(o).insEx = 'Y';
      if (str_(r.fbCut)) ch(o).fbCut = str_(r.fbCut);
    } else {
      if (addSub(o, r.cid, STL_TYPES.indexOf(r.type) >= 0 ? r.type : '')) notes.push(o.name + ': ' + nm(r.cid) + ' (두 번째 메인) → 서브아이디로');
      if (r.mode || stlYes_(r.insEx) || str_(r.fbCut)) notes.push(nm(r.cid) + ': 정산 설정(' + [r.mode, stlYes_(r.insEx) ? '산재·고용 제외' : '', r.fbCut ? '프레시백 ' + r.fbCut : ''].filter(String).join(' · ') + ')은 메인 아이디 설정을 따름');
    }
    if (r.status === '정지' || r.status === '중지') {
      if (!asMain) notes.push(nm(r.cid) + ': 정지였음 → 이제 메인 기사 근무상태를 따름');
      else if (!str_(o.workStatus)) {
        const ws = o.status === ST.STOPPED ? '퇴사' : '휴직';
        ch(o).workStatus = ws;
        notes.push(o.name + ': 아이디 정지 → 근무상태 ' + ws + (ws === '퇴사' ? ' (퇴사일은 기사 정보관리에서 넣어 주세요)' : ''));
      }
    }
  });
  subs.forEach(function (r) {
    const mr = byK[stlLogin_(r.main)];
    if (mr.vendor) { (vIds[mr.vendor] = vIds[mr.vendor] || []).push(r.cid); return; }
    const mk = stlLogin_(r.main);
    const owner = D.all.filter(function (o) { return stlLogin_(cur(o, 'loginId')) === mk; })[0] || D.byId[stlPerson_(D, mr.owner, mr.ownerId)];
    if (!owner) { notes.push(nm(r.cid) + ': 메인 ' + nm(r.main) + ' 의 명의자가 없어 뺌'); return; }
    if (stlLogin_(cur(owner, 'loginId')) !== mk) { notes.push(nm(r.cid) + ': 메인 ' + nm(r.main) + ' 가 ' + owner.name + ' 기사님의 쿠팡플렉스 아이디가 아니어서 뺌'); return; }
    addSub(owner, r.cid, STL_TYPES.indexOf(r.type) >= 0 ? r.type : '');
    const pid = stlPerson_(D, r.owner, r.ownerId);
    if (pid && pid !== owner.id) notes.push(nm(r.cid) + ': 명의자가 ' + D.byId[pid].name + ' 였음 → ' + owner.name + ' 기사님 서브로 (다른 기사가 쓰면 아이디 사용 기록으로)');
    if (r.status === '정지' || r.status === '중지') notes.push(nm(r.cid) + ': 정지였던 서브 → 이제 ' + owner.name + ' 기사님 근무상태를 따름');
  });
  // 쓰기: 기사 정보 · 용차업체
  const now = nowText_();
  Object.keys(set).forEach(function (id) {
    const o = D.byId[id], f = set[id];
    Object.keys(f).forEach(function (k) { if (str_(o[k]) === str_(f[k])) delete f[k]; });
    if (!Object.keys(f).length) return;
    f.updatedAt = now;
    writeFields_(SH.DRIVERS, o._row, f);
    forgetDriver_(o);
  });
  const vNames = Object.keys(vIds);
  if (vNames.length) {
    stlAddVendors_(vNames);
    const V2 = stlVendors_();
    vNames.forEach(function (n) {
      const v = V2.by[stlVendorKey_(n)];
      if (!v) return;
      const ids = v.ids.slice();
      vIds[n].forEach(function (c) { if (!ids.some(function (y) { return stlLogin_(y) === stlLogin_(c); })) ids.push(c); });
      stlSetRow_('stl_vendors', v._row, { ids: ids.join(', ') });
    });
  }
  PropertiesService.getScriptProperties().setProperty('STL_IDS_V2', '1');
  props_().STL_IDS_V2 = '1';
  stlBump_();

  const diff = [];
  months.forEach(function (m) {
    const b = before[m], a = snap(m);
    const row = { month: m, before: b.tot || null, after: a.tot || null, err: b.err || a.err || '', changed: [] };
    if (b.by && a.by) {
      Object.keys(b.by).concat(Object.keys(a.by)).filter(function (k, i, arr) { return arr.indexOf(k) === i; }).forEach(function (k) {
        const x = b.by[k] || {}, y = a.by[k] || {};
        if ((x.net || 0) !== (y.net || 0) || (x.invoice || 0) !== (y.invoice || 0)) row.changed.push({ id: k, name: y.name || x.name, before: x.net || 0, after: y.net || 0, qb: x.qty || 0, qa: y.qty || 0 });
      });
    }
    diff.push(row);
  });
  const log = { at: now, notes: notes.slice(0, 60), diff: diff.map(function (d) { return Object.assign({}, d, { changed: d.changed.slice(0, 20) }); }) };
  try { PropertiesService.getScriptProperties().setProperty('STL_IDS_V2_LOG', JSON.stringify(log).slice(0, 8500)); } catch (e) { console.error('옮김 기록 저장 실패: ' + e); }
  try { logAdmin_({ name: '시스템' }, '아이디 관리 → 기사 정보관리 옮김', notes.length + '건', diff.map(function (d) { return d.month + ' 바뀐 정산서 ' + d.changed.length; }).join(', ')); } catch (e) { /* 무시 */ }
  return log;
}
/** 정산관리 아이디 관리 (보기 전용): 기사 정보관리 · 용차업체에서 만든 줄 + 정산서에만 있는 아이디 + 옮김 기록 */
function adm_stlIdsView(token, month) {
  return run_(function () {
    requireAdmin_(token);
    stlEnsureIdsV2_();
    if (!stlIdsV2_()) return { ok: true, legacy: true }; // STL_IDS_V2 = 0 (되돌림) → 예전 아이디 관리 편집 표
    const D = stlDrivers_(), rows = stlIdRows_(D), V = stlVendors_();
    const by = {};
    D.all.forEach(function (o) { by[o.id] = o; });
    const out = rows.filter(function (r) { return !r.vendor; }).map(function (r) {
      const o = by[r.drvId] || {}, mainType = STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '';
      return { cid: r.cid, role: r.role, main: r.main, owner: r.owner, drvId: r.drvId, type: r.role === '서브' ? (r.type || mainType) : r.type, subDiff: r.role === '서브' && !!r.type && r.type !== mainType,
        mode: r.role === '서브' ? str_(o.stlMode) : r.mode, insEx: r.role === '서브' ? (stlYes_(o.insEx) ? 'Y' : '') : r.insEx, fbCut: r.role === '서브' ? '' : r.fbCut,
        status: r.status, workStatus: o.workStatus || '', leaveDate: o.leaveDate || '', app: o.status || '', signed: r.signedId && by[r.signedId] ? by[r.signedId].name + (by[r.signedId].status === ST.STOPPED ? ' (가입 · 앱 정지)' : ' (가입)') : '' };
    });
    // 프레시백 차감은 [기사별 프레시백 설정] 표 값으로 보여 준다
    try {
      const X = stlIds_(D), fb = {};
      stlRead_('stl_fbcut').forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (id) fb[id] = str_(o.cut); });
      out.forEach(function (r) { if (r.role !== '메인') return; const b = X.by[stlLogin_(r.cid)]; if (b && b.mainKey in fb) r.fbCut = fb[b.mainKey]; });
    } catch (e) { /* 표 없음 */ }
    // 메인 아래 서브가 오게
    const mains = out.filter(function (r) { return r.role === '메인'; }).sort(function (a, b) { return koCmp_(a.owner, b.owner); });
    const list = [];
    mains.forEach(function (m) { list.push(m); out.forEach(function (s) { if (s.role === '서브' && stlLogin_(s.main) === stlLogin_(m.cid)) list.push(s); }); });
    const vendors = V.list.map(function (v) { return { name: v.name, ids: v.ids, stopped: v.stopped }; }).filter(function (v) { return v.ids.length; });
    let unknown = [];
    if (stlMonthOk_(month)) {
      try {
        const r = stlResult_(month, false), w = (r.summary.warnings || []).filter(function (x) { return x.key === 'unreg'; })[0];
        if (w) unknown = w.items.map(function (t, i) { return { cid: w.acts && w.acts[i] ? w.acts[i].cids[0] : String(t).split(/\s/)[0], label: t }; });
      } catch (e) { /* 무시 */ }
    }
    let log = null;
    try { log = JSON.parse(PropertiesService.getScriptProperties().getProperty('STL_IDS_V2_LOG') || 'null'); } catch (e) { log = null; }
    const vset = {}, clash = [];
    V.list.forEach(function (v) { v.ids.forEach(function (c) { vset[stlLogin_(c)] = v.name; }); });
    D.all.forEach(function (o) { [o.loginId, o.subId1, o.subId2].forEach(function (c) { const k = stlLogin_(c); if (k && vset[k]) clash.push({ drvId: o.id, name: o.name, cid: c, vendor: vset[k] }); }); });
    return { ok: true, rows: list, vendors: vendors, unknown: unknown, log: log, clash: clash, types: STL_TYPES, drivers: D.all.filter(function (o) { return o.status !== ST.REJECTED; }).map(function (o) { return { id: o.id, name: o.name, loginId: o.loginId || '' }; }).sort(function (a, b) { return koCmp_(a.name, b.name); }) };
  });
}
/** 용차업체 정산 묶음 키: 'v:업체명' (띄어쓰기 없이, 소문자) */
function stlVendorKey_(name) { return 'v:' + str_(name).replace(/\s+/g, '').toLowerCase(); }
/** 용차업체 목록 (stl_vendors) → { list, by: {묶음키: 업체} } */
function stlVendors_() {
  const list = [], by = {};
  stlRead_('stl_vendors').forEach(function (r) {
    const name = str_(r.name);
    if (!name) return;
    const k = stlVendorKey_(name);
    if (by[k]) return;
    const v = {
      key: k, name: name, price: stlNum_(r.price), ins: !/^n/i.test(str_(r.ins)), bizNo: str_(r.bizNo), ceo: str_(r.ceo), phone: str_(r.phone),
      bank: str_(r.bank), account: str_(r.account), holder: str_(r.holder), email: str_(r.email), addr: str_(r.addr), bizType: str_(r.bizType), bizItem: str_(r.bizItem), stopped: r.status === '정지' || r.status === '중지',
      ids: str_(r.ids).split(/[,\s]+/).map(function (x) { return x.trim(); }).filter(Boolean), _row: r._row
    };
    by[k] = v; list.push(v);
  });
  return { list: list, by: by };
}
/** 정산서·입금용 '명의자' 정보 (용차업체) */
function stlVendorOwner_(v) {
  return { name: v.name, bankName: v.bank, accountHolder: v.holder || v.name, account: v.account ? String(v.account).replace(/\d(?=\d{4})/g, '*') : '', accountRaw: v.account, bizNo: v.bizNo, bizName: v.name, bizEmail: v.email, phone: v.phone, vendor: true };
}
function stlSeedIds_(D) {
  const lock = scriptLock_();
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
        insEx: stlYes_(o.insEx) ? 'Y' : '', fbCut: ow ? '' : (o.fbCut || ''), status: o.status === ST.ACTIVE ? '사용' : '정지', memo: '기사 정보에서 자동 생성'
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
  if (a && X.groups[a]) return a;
  const n = str_(name);
  if (!n) return '';
  const vk = stlVendorKey_(n.replace(/\s*\((용차)?업체\)\s*$/, ''));
  if (X.groups[vk]) return vk;
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
  if (g.vendor) return g.vendor + ' (용차업체)';
  return (g.ownerId ? D.byId[g.ownerId].name : '명의자 없음') + ' (' + String(g.cid).replace(/@.*$/, '') + ')';
}
/** 그 아이디로 그 날 일한 기사 (사용 기록 → 없으면 명의자) */
/** 아이디 사용 기록에서 '정산: 명의자'(서브 인원)로 표시한 날인지 → 매출을 옮기지 않고 명의자 정산에 그대로 */
function stlUsageSub_(ctx, key, date) {
  const list = ctx.usage[key];
  if (list) for (let i = 0; i < list.length; i++) if (stlInRange_(date, list[i].from, list[i].to)) return !!list[i].sub;
  return false;
}
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
 * 4) 노선관리 구분별 단가 (고정 = 고정단가, 백업 = 백업단가, 품앗이 = 품앗이단가, 외부용차 = 외부용차단가). 구분은
 *    메인 아이디: 기사 정보관리의 명의자 단가코드이 최우선 → 비어 있으면 아이디 관리의 단가코드 → 고정
 *    서브 아이디: 아이디 관리의 단가코드 → 비어 있으면 메인과 같은 규칙
 */
function stlUnit_(ctx, idx, r, worker) {
  const g0 = ctx.ids.groups[idx.mainKey];
  const main = (g0 && g0.main) || ctx.ids.by[idx.mainKey] || idx;
  const mode = idx.mode || main.mode;
  if (mode === '용차내역') return { u: 0, how: '용차내역' };
  // 용차업체 아이디: 업체 건당 단가 (모든 노선 같은 단가). 비어 있으면 노선관리 외부용차단가
  if (main.vendor) {
    if (main.vinfo && main.vinfo.price > 0) return { u: main.vinfo.price, how: '업체단가' };
    const fv = ctx.price.find(r.camp, r.route), pv = fv.row ? stlNum_(fv.row.p5) : 0;
    return pv ? { u: pv, how: '외부용차' } : { u: 0, missing: true, how: '외부용차', f: fv };
  }
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
  const kinds = stlKinds_(), items = stlItems_();
  const D = stlDrivers_(), X = stlIds_(D);
  const campIns = stlCampIns_(cfg, X, D);
  const ctx = { cfg: cfg, price: stlPriceIndex_(), D: D, ids: X, usage: {}, tmp: {} };
  stlRead_('stl_usage').forEach(function (u) {
    const k = stlLogin_(u.cid), pid = stlPerson_(D, u.name, u.driverId);
    if (k && pid) (ctx.usage[k] = ctx.usage[k] || []).push({ driverId: pid, from: u.from, to: u.to, sub: str_(u.settle) === '명의자' });
  });
  stlRead_('stl_tmp').forEach(function (t) {
    const pid = stlPerson_(D, t.name, t.driverId);
    if (pid && stlNum_(t.price) > 0) (ctx.tmp[pid] = ctx.tmp[pid] || []).push(t);
  });
  ctx.groupOf = stlGroupOfPerson_(X, D);
  // 쿠팡 수기정산(수기반영): 전부 배송 기본에 넣는다 — 줄에 적힌 쿠팡 아이디 기준 (아이디 사용 기록·기사 일시단가 적용 안 함). 관리자가 '반영 안 함' 으로 뺀 줄만 제외 (stl_ack 구분 manual · 마지막 기록이 이김)
  const manualOff = {}, promoOv = {};
  stlRead_('stl_ack').forEach(function (k) {
    if (k.month !== month) return;
    if (k.kind === 'manual') manualOff[k.key] = k.memo === '미반영';
    else if (k.kind === 'promo') promoOv[k.key] = k.memo; // '기사' / '러너'
  });
  const raw = stlReadMonth_('stl_raw', month);
  const loss = stlReadMonth_('stl_loss', month);
  const sched = stlSchedule_(P.from, P.to);
  const warn = { unreg: {}, kind: {}, noPrice: {}, noCamp: {}, noRoute: {}, stopped: {}, stoppedSub: {}, moveNo: {}, manual: [], noRtPrice: [], promo: [] };
  const S = {};
  /** 정산 묶음(메인 아이디) 하나의 합계. 정산금은 메인 아이디 명의자에게 */
  const sum = function (gkey) {
    if (S[gkey]) return S[gkey];
    const g = X.groups[gkey], main = g.main, o = D.byId[g.ownerId] || (g.vendor ? stlVendorOwner_(main.vinfo) : {});
    return (S[gkey] = {
      id: gkey, cid: g.cid, name: o.name || '(명의자 없음) ' + String(g.cid).replace(/@.*$/, ''), owner: o, ownerId: g.ownerId || '', vendor: g.vendor || '',
      type: main.type, mode: main.mode, insEx: main.insEx, fbCutTxt: main.fbCut, workers: {}, ids: {}, qty: 0, base: 0, inc: 0, freshRaw: 0, fresh: 0, fbCut: 0, fbKeep: 0, unc: 0, etc: 0,
      loss: 0, lossCp: 0, lossSup: 0, sales: 0, supplyCp: 0, campPay: {}, routes: {}, daily: {}, lossLines: [], yong: [], yongPay: 0, yongCut: 0, yongLines: [],
      noPriceQty: 0, rows: 0, movedIn: {}, movedOut: {}, cidDays: {}
    });
  };
  const company = { sales: 0, supplyCp: 0, lossCp: 0, lossSup: 0, unregSales: 0, vendorCut: 0, progFee: 0, yongGain: 0, promoBase: 0, promoRunner: 0, promoDrv: 0 };
  const byDateLogin = {}, lastDel = {}, cutIds = {}; // lastDel[로그인] = 이 정산기간 마지막 배송일 · cutIds = 업체차감 줄의 쿠팡ID 칸(영업점 수수료 등, 아이디 아님)

  raw.forEach(function (r) {
    r.date = stlYmd_(r.date);
    const qty = stlNum_(r.qty) + stlNum_(r.ret), total = stlNum_(r.total), fresh = stlNum_(r.fresh);
    const sales = stlR0_((total + fresh) * (1 + cfg.vat));
    company.sales += sales; company.supplyCp += total + fresh;
    const kind = stlKindOf_(kinds, r.kind);
    // 업체차감(시설 및 장비 사용료 = 영업점 수수료 = 러너 벤더의 쿠팡 프로그램 사용료): 기사·아이디와 무관한 회사 비용
    if (kind === '업체차감') { cutIds[stlLogin_(r.cid)] = 1; company.vendorCut += total; company.progFee += stlR0_(total * (1 + cfg.vat)); return; }
    // 베이스 프로모션: 영업점 수수료 줄로 들어오는 업체 몫 → 전부 러너 수익 (기사·아이디 무관)
    if (kind === '프로모션베이스') {
      cutIds[stlLogin_(r.cid)] = 1; company.promoBase += total;
      warn.promo.push({ kind: 'base', key: '', label: '🏢 베이스 · ' + str_(r.kind) + ' · ' + won_(total) + '원 (공급가) → 러너 수익' });
      return;
    }
    // 일반 프로모션: 쿠팡이 지정한 노선(배송유형 심야)은 러너 수익 · 기사가 쿠팡플렉스 앱에서 직접 신청한 것(배송유형 주간)은 그 기사 지급 — 관리자가 줄마다 바꿀 수 있음(stl_ack 구분 promo)
    if (kind === '프로모션일반') {
      const pk = [stlLogin_(r.cid), r.date, stlShort_(r.camp), normCode_(r.route), qty, total].join('|');
      const ov = promoOv[pk], toDrv = ov ? ov === '기사' : /주간/.test(str_(r.dtype));
      const who = str_(r.cid).replace(/@.*$/, '');
      if (!toDrv) {
        company.promoRunner += total;
        warn.promo.push({ kind: 'run', key: pk, label: '📍 쿠팡 지정 · ' + who + ' · ' + String(r.date).slice(5) + ' · ' + (r.camp || '') + ' ' + (normCode_(r.route) || '') + ' · ' + won_(qty) + '건 · ' + won_(total) + '원 → 러너 수익' + (ov ? ' (직접 지정)' : '') });
        return;
      }
      // 기사 지급: 미계약 라우트와 같은 계산 (쿠팡 금액 ×1.1 · 러너 수수료 제외) → 아래 '프로모션일반' 분기로
      warn.promo.push({ kind: 'drv', key: pk, label: '🙋 기사 직접 신청 · ' + who + ' · ' + String(r.date).slice(5) + ' · ' + (r.camp || '') + ' ' + (normCode_(r.route) || '') + ' · ' + won_(qty) + '건 · ' + won_(total) + '원 → 기사 지급' + (ov ? ' (직접 지정)' : '') });
    }
    const login = stlLogin_(r.cid);
    const idx = X.by[login];
    if (!idx) { const u = warn.unreg[r.cid] || (warn.unreg[r.cid] = { cid: r.cid, sales: 0, qty: 0 }); u.sales += sales; u.qty += qty; company.unregSales += sales; return; }
    // 정지된 아이디: 서브로 등록된 아이디(메인 정산에 합산)는 따로, 메인(실제 정지)은 그대로
    if (idx.stopped && (!idx.stopFrom || r.date >= idx.stopFrom)) { if (idx.role === '서브' && idx.mainKey && idx.mainKey !== idx.key) warn.stoppedSub[r.cid] = idx.mainKey; else warn.stopped[r.cid] = idx.mainKey; }
    // 수기정산 줄은 아이디값이 우선: 그 아이디 명의자 정산 · 그 아이디 단가코드 (그날 누가 뛰었는지로 옮기지 않음)
    const worker = kind === '수기반영' ? '' : stlWorkerOf_(ctx, login, r.date);
    // 아이디 사용 기록: 그 날 다른 기사가 이 아이디로 일했으면 그 줄은 일한 기사 본인 정산으로 (단가도 그 기사 아이디 기준)
    const mv = kind === '수기반영' ? null : stlMoveOf_(ctx, idx, worker, r, warn);
    const s = sum(mv ? mv.key : idx.mainKey), uIdx = mv ? X.groups[mv.key].main : idx;
    s.ids[r.cid] = 1; s.sales += sales; s.supplyCp += total + fresh; s.rows++;
    const camp = r.camp;
    if (camp && !ctx.price.campByShort[stlShort_(camp)]) warn.noCamp[camp] = 1;
    let pay = 0;
    const mkey = kind === '수기반영' ? [stlLogin_(r.cid), r.date, stlShort_(camp), normCode_(r.route), qty, total].join('|') : '';
    if (kind === '수기반영' && manualOff[mkey]) {
      warn.manual.push({ on: false, key: mkey, sid: s.id, label: '⬜ 반영 안 함 · ' + s.name + ' · ' + String(r.date).slice(5) + ' · ' + (camp || '') + ' ' + (normCode_(r.route) || '노선 없음') + ' · ' + won_(qty) + '건 (쿠팡 ' + won_(sales) + '원)' });
    } else if (kind === '배송' || kind === '수기반영') {
      const u = stlUnit_(ctx, uIdx, r, worker);
      const wk = s.workers[worker || '_'] || (s.workers[worker || '_'] = { qty: 0, amt: 0, dates: {}, cids: {} });
      if (u.missing && r.route) {
        const k = camp + '|' + r.route;
        const w = warn.noPrice[k] || (warn.noPrice[k] = { camp: camp, route: r.route, qty: 0, type: u.how, routeKnown: u.f ? u.f.routeKnown : false, manual: 0 });
        w.qty += qty; s.noPriceQty += qty; if (kind === '수기반영') w.manual += qty;
      } else if (qty && !r.route && !(u.u > 0)) {
        // 노선이 비어 단가를 못 찾은 줄 (쿠팡 수기반영에 흔함) → 기사 지급 0원 · 경고
        (warn.noRtPriceL = warn.noRtPriceL || []).push({ t: 'slip', id: s.id });
        warn.noRtPrice.push(s.name + ' · ' + String(r.date).slice(5) + ' · ' + (camp || '캠프 없음') + ' · ' + kind + ' ' + won_(qty) + '건 (쿠팡 ' + won_(sales) + '원)');
        s.noPriceQty += qty;
      }
      // 용차업체 건당 고정단가면 프백 가중치(추가인센티브)는 더하지 않는다 (러너 몫)
      const incU = u.how === '업체단가' ? 0 : stlHalfDown_(stlHalfDown_(stlNum_(r.inc) * (1 + cfg.vat)) * cfg.incRate);
      const base = stlR0_(qty * u.u), inc = stlR0_(qty * incU);
      s.base += base; s.inc += inc; s.qty += qty; pay = base + inc;
      // 쿠팡 수기반영: 배송 기본에 그대로 합침 (정산서에 따로 안 보임) · 관리자 확인용 목록만
      if (kind === '수기반영') warn.manual.push({ on: true, key: mkey, sid: s.id, label: '✅ 반영 · ' + s.name + ' · ' + String(r.date).slice(5) + ' · ' + (camp || '') + ' ' + (normCode_(r.route) || '노선 없음') + ' · ' + won_(qty) + '건 × ' + won_(u.u + incU) + ' = ' + won_(pay) + '원 (쿠팡 ' + won_(sales) + '원)' });
      wk.qty += qty; wk.amt += pay; wk.dates[r.date] = 1; wk.cids[r.cid] = 1;
      if (qty && r.date >= P.from && r.date <= P.to) ((s.cidDays[login] = s.cidDays[login] || {}))[r.date] = 1;
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
      (byDateLogin[dk] = byDateLogin[dk] || []).push({ route: normCode_(r.route), qty: qty, sales: sales, unit: u.u, inc: incU, camp: camp, cid: r.cid });
      if (qty > 0 && (!lastDel[login] || r.date > lastDel[login])) lastDel[login] = r.date;
    } else if (kind === '프레시백') {
      pay = stlR0_(fresh * cfg.freshRate); s.freshRaw += fresh; s.fresh += pay;
      s.fbKeep += fresh - pay; // 프백 잉여: 쿠팡 회수 인센티브 중 기사 지급률(예 89%) 밖의 몫 → 러너
    } else if (kind === '프로모션일반') { // 기사 직접 신청 프로모션 (위에서 걸러진 것)
      pay = stlR0_(total * (1 + cfg.vat) * (1 - cfg.uncFee)); s.promo = (s.promo || 0) + pay; company.promoDrv += total;
    } else if (kind === '미계약') {
      pay = stlR0_(total * (1 + cfg.vat) * (1 - cfg.uncFee)); s.unc += pay;
    } else if (kind === '기타') {
      pay = stlR0_((total + fresh) * (1 + cfg.vat) * cfg.etcRate); s.etc += pay;
    } else {
      warn.kind[r.kind || '(빈칸)'] = (warn.kind[r.kind || '(빈칸)'] || 0) + 1;
    }
    if (pay) s.campPay[stlShort_(camp)] = (s.campPay[stlShort_(camp)] || 0) + pay;
    if (mv) stlMoveNote_(s, sum(idx.mainKey), r, worker, X, D, idx, pay, (kind === '배송' || kind === '수기반영') ? qty : 0, mv.key);
  });

  // 프레시백 차감 ([정산 설정 → 기사별 프레시백 설정] 표 · 없으면 예전 기사 정보 '프레시백 차감'): 13% 처럼 비율 → 100원 반올림 / 금액 → 그대로) → 러너 몫
  const fbMap = {};
  stlRead_('stl_fbcut').forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (id) fbMap[id] = str_(o.cut); });
  Object.keys(S).forEach(function (id) {
    const s = S[id], t = str_(id in fbMap ? fbMap[id] : s.fbCutTxt);
    s.fbCutTxt = t;
    if (!t || !s.fresh) return;
    const n = stlNum_(t);
    const cut = /%$/.test(t.replace(/\s/g, '')) || (n > 0 && n < 1) ? stlR100_(s.fresh * stlRate_(t, 0)) : Math.round(n);
    s.fbCut = Math.max(0, Math.min(cut, s.fresh)); s.fresh -= s.fbCut;
  });
  // 프레시백 기사 지급액은 지급률·차감을 적용한 뒤 항상 100원 단위로 올림 (97,811 → 97,900). 올린 만큼 러너 프백 잉여에서 뺀다
  Object.keys(S).forEach(function (id) {
    const s = S[id];
    if (s.fresh <= 0) return;
    const up = Math.ceil(s.fresh / 100 - 1e-9) * 100;
    s.fbKeep -= up - s.fresh; s.fresh = up;
  });
  // 미계약 라우트 기사 지급액은 수수료율 적용 뒤 10원 단위 반올림 (1원 자리 5 이상 올림, 4 이하 내림: 873 → 870)
  Object.keys(S).forEach(function (id) { const s = S[id]; if (s.unc) s.unc = stlR10_(s.unc); });

  // 분실파손
  loss.forEach(function (r) {
    const amt = stlNum_(r.amt);
    company.lossCp += amt; company.lossSup += stlLossSup_(amt, cfg);
    const idx = X.by[stlLogin_(r.cid)];
    if (!idx) { const u = warn.unreg[r.cid] || (warn.unreg[r.cid] = { cid: r.cid, sales: 0, qty: 0 }); u.loss = (u.loss || 0) + amt; return; }
    const lr = { date: stlYmd_(r.date), cid: r.cid };
    const mv = stlMoveOf_(ctx, idx, stlWorkerOf_(ctx, stlLogin_(r.cid), lr.date), lr, warn);
    const s = sum(mv ? mv.key : idx.mainKey);
    const share = stlR10_(amt * (cfg.lossVat ? 1 + cfg.vat : 1) * cfg.lossRate);
    s.loss += share; s.lossCp += amt; s.lossSup += stlLossSup_(amt, cfg);
    if (mv) stlMoveNote_(s, sum(idx.mainKey), lr, mv.worker, X, D, idx, -share, 0, mv.key);
    s.lossLines.push({ date: stlYmd_(r.date), cid: r.cid, camp: r.camp, type: r.type, detail: r.detail, item: r.item, waybill: r.waybill, amt: share, cp: amt });
  });

  // 용차
  const yong = stlRead_('stl_yongcha').filter(function (y) { return y.date && stlMonthOfDate_(y.date) === month; });
  const yongOut = [], yongNoP = [], yongNoP5 = [];
  yong.forEach(function (y) {
    const date = stlYmd_(y.date), routes = stlYongRoutes_(y.route);
    const route = routes.length === 1 ? routes[0] : '';                 // 라우트 하나
    const rset = routes.length > 1 ? routes.reduce(function (o, r) { o[r] = 1; return o; }, {}) : null; // 119AB · 119A,119B 처럼 여러 개
    const routeLabel = routes.length > 1 ? normCode_(y.route) : route;
    const whoKey = stlAcct_(X, D, y.who, y.whoId);
    const wg = whoKey ? X.groups[whoKey] : null;
    let autoQty = 0, sales = 0, camp = '', perfUnitSum = 0, found = false;
    const hits = [];
    if (wg) {
      wg.cids.forEach(function (c) {
        (byDateLogin[date + '|' + stlLogin_(c)] || []).forEach(function (x) {
          if (route && x.route !== route) return;
          if (rset && !rset[x.route]) return;
          hits.push(x);
          // 기존지급 = 그날 실제로 받은 단가 (기본단가 + 프백 가중치) → 용차 단가(예 1,100)가 프백 가중치까지 포함한 건당 금액이 된다
          found = true; autoQty += x.qty; sales += x.sales; camp = camp || x.camp; perfUnitSum += x.qty * (x.unit + (x.inc || 0));
        });
      });
    }
    const qty = stlNum_(y.qty) || autoQty;
    const isAmt = str_(y.mode) === '금액';
    let existing = 0;
    if (wg && wg.main.mode !== '용차내역') {
      // 쿠팡 정산서에 그날 수행 배송이 있으면 실제로 잡힌 단가 그대로 (원청단가·일시단가 기사도 정확하게)
      if (found && autoQty) existing = stlR0_(perfUnitSum / autoQty * qty);
      else if (route && (camp || y.route)) {
        const u = stlUnit_(ctx, wg.main, { date: date, route: route, camp: camp || stlYongCamp_(ctx, route), price: 0 }, stlWorkerOf_(ctx, whoKey, date));
        existing = stlR0_(u.u * qty);
      } else existing = stlR0_(perfUnitSum);
    }
    // 단가 칸 = 수행 단가. 입력하면 그 값, 비우면 노선관리 기본값
    //  - 우리 기사(품앗이) = 그 노선 '품앗이단가' (건당 · 프백 가중치까지 포함한 금액)
    //  - 용차업체(외부용차) = 그 노선 '외부용차단가' (차액부담 기사에게 청구하는 단가. 업체에 주는 돈은 용차업체 표의 지급 단가)
    //  기본값이 비어 있으면 원래 단가 그대로 (추가지급·러너 몫 없음) + 확인 필요
    const isVendor = !!(wg && wg.vendor);
    // 업체 실지급액: 용차업체가 일당 등으로 청구할 때 그 줄에 실제로 주는 총액 (예: 264,000 × 2명 = 528,000)
    //  → 업체 정산서에 (실지급액 − 지급 단가 × 건수) 자동 반영 · 단가 칸을 비우면 그 금액 그대로 차액부담 기사에게 청구
    const vPay = isVendor ? stlR0_(stlNum_(y.vendorPay)) : 0;
    let payAmt, defUnit = 0;
    if (isAmt) payAmt = stlR0_(stlNum_(y.price));
    else if (stlNum_(y.price)) payAmt = stlR0_(stlNum_(y.price) * qty);
    else if (vPay) { payAmt = vPay; defUnit = qty ? Math.round(vPay / qty) : 0; }
    else {
      const ext = isVendor || !wg; // 용차업체·외부(정산 아이디 없는 수행자) = 외부용차단가
      const pk = ext ? 'p5' : 'p4';
      const pmU = function (cp, rt) { const f = ctx.price.find(cp, rt); return f.row ? stlNum_(f.row[pk]) : 0; };
      let miss = false;
      if (hits.length) {
        let sp = 0, sq = 0;
        hits.forEach(function (x) { const pu = pmU(x.camp, x.route); if (!pu) miss = true; sp += x.qty * (pu || (x.unit + (x.inc || 0))); sq += x.qty; });
        payAmt = sq ? stlR0_(sp / sq * qty) : existing;
      } else {
        const pu = route ? pmU(camp || stlYongCamp_(ctx, route), route) : 0;
        if (!pu) miss = true;
        payAmt = pu ? stlR0_(pu * qty) : existing;
      }
      defUnit = qty ? Math.round(payAmt / qty) : 0;
      if (miss && qty) (ext ? yongNoP5 : yongNoP).push(Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)) + ' ' + (wg ? stlAcctLabel_(X, D, whoKey) : y.who) + ' ' + (routeLabel || '그날 전체'));
    }
    // 차액 처리
    //  - 러너 몫 (용차업체는 기본): 수행자에게는 원래 단가(쿠팡 정산서에 잡힌 단가 / 업체 지급 단가)만 지급, 추가지급 없음.
    //    차액부담 기사에게는 단가 칸(비우면 품앗이단가/외부용차단가)으로 청구 → 러너 몫 = 청구 금액 − 수행자 지급
    //    예: 외부용차단가 1,350 · 히어로 지급 1,320 → 러너 30원 / 단가 칸 1,400 → 러너 80원
    //  - 수행자 지급 (품앗이는 기본): 단가/금액만큼 수행자에게 지급 (원래 단가와의 차이 = 추가지급)
    const gainMode = str_(y.gain);
    const toRunner = isVendor ? gainMode !== '수행자 지급' : gainMode === '러너 몫';
    const charge = payAmt;                                    // 차액부담 계산에 쓰는 금액 (단가 칸 / 기본값)
    const paid = vPay ? vPay : toRunner ? existing : payAmt;  // 수행자에게 실제로 주는 금액 (업체 실지급액이 있으면 그 금액)
    const extra = paid - existing;
    const payerOwner = stlAcct_(X, D, y.payer, y.payerId);
    let payerPrice = stlNum_(y.payerPrice), cut = 0;
    if (payerOwner && qty && charge > 0) { // 청구할 금액이 0 이면(단가·기본값 모두 없음) 차감하지 않음
      // 부담 기준단가 (비우면)
      //  - 품앗이(우리 기사가 수행): 수행자의 단가코드(고정/백업/품앗이 …)로 본 그 라우트 단가 → 수행자가 더 받는 만큼 부담
      //  - 외부용차(용차업체·외부 수행자): 차액부담자 본인 단가 → (청구 단가 − 내 단가) × 건수를 부담
      //  - 러너 몫으로 고르면 품앗이도 차액부담자 본인 단가 기준
      if (!payerPrice && wg && !isVendor && !toRunner && wg.main.mode !== '용차내역' && existing) payerPrice = Math.round(existing / qty);
      let cutDone = false;
      if (!payerPrice) {
        const pm = X.groups[payerOwner].main, pw = stlWorkerOf_(ctx, payerOwner, date);
        if (!route && hits.length) {
          // 라우트가 여러 개(119AB)·그날 전체: 노선마다 차액부담자 본인 단가 × 그 노선 건수
          let base = 0, hq = 0;
          hits.forEach(function (x) { base += x.qty * stlUnit_(ctx, pm, { date: date, route: x.route, camp: x.camp, price: 0 }, pw).u; hq += x.qty; });
          if (hq && base) { base = base * qty / hq; payerPrice = Math.round(base / qty); cut = stlR0_(charge - base); cutDone = true; }
        }
        if (!payerPrice) payerPrice = stlUnit_(ctx, pm, { date: date, route: route, camp: camp || stlYongCamp_(ctx, route), price: 0 }, pw).u;
      }
      if (!cutDone) cut = stlR0_(charge / qty - payerPrice) * qty;
    }
    const line = {
      date: date, who: wg ? stlAcctLabel_(X, D, whoKey) : y.who, whoId: whoKey, route: routeLabel, mode: isAmt ? '금액' : '건당', price: y.price, vendorPay: vPay, qty: qty, autoQty: found ? autoQty : '',
      payAmt: paid, charge: charge, defUnit: defUnit, vendor: isVendor, whoStaff: !!(wg && !isVendor && isStaff_(D.byId[wg.ownerId])), toRunner: toRunner, gain: toRunner ? '러너 몫' : '수행자 지급', runnerGain: (toRunner || vPay) && payerOwner ? charge - paid : 0, sales: sales, profit: sales - paid, camp: camp, existing: existing, extra: extra,
      payer: payerOwner ? stlAcctLabel_(X, D, payerOwner) : y.payer, payerId: payerOwner, payerPrice: payerPrice, cut: cut, memo: y.memo, _row: y._row
    };
    yongOut.push(line);
    if (wg && !(toRunner && !extra)) { const s = sum(whoKey); s.yongPay += extra; s.yongLines.push(line); }
    if (payerOwner && cut) { const s = sum(payerOwner); s.yongCut += cut; s.yongLines.push(line); }
    company.yongGain += line.runnerGain;
  });

  // 공제·가감 (수동) + 자동(정기·퇴사보류)
  const adj = {};
  const addAdj = function (ownerId, item, amt, memo, auto) {
    if (!ownerId || !amt) return;
    sum(ownerId);
    (adj[ownerId] = adj[ownerId] || []).push({ item: item, amt: amt, memo: memo || '', auto: !!auto });
  };
  const adjBad = [], manualRepay = {};
  // 수기 가불 상환: 항목 이름에 '가불'이 들어간 차감 항목 (예: 가불금 상환, 가불 상환, 가불금). 지급 쪽 항목(예: 가불금 지급)은 제외
  const itemSide = {};
  try { stlItems_().list.forEach(function (it) { itemSide[it.name] = it.side; }); } catch (e) { /* 기본 */ }
  const isRepay = function (item) { const n = str_(item); return n === STL_ADV_ITEM || (/가불/.test(n) && itemSide[n] !== '지급'); };
  stlRead_('stl_adjust').filter(function (a) { return a.month === month; }).forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct);
    if (!id) { adjBad.push(a.name || a.acct); return; }
    if (isRepay(a.item) && stlNum_(a.amt) > 0) manualRepay[id] = (manualRepay[id] || 0) + stlNum_(a.amt);
    addAdj(id, a.item, stlNum_(a.amt), a.memo, false);
  });
  // 가불금: 상계 예정일(상환일)을 적으면 그 날 이후 첫 지급 정산월에 남은 금액을 '가불금 상환'으로 자동 공제
  //  그 달 공제·가감에 수기 가불 상환이 있으면 그 기사는 자동 공제를 건너뛰고, 수기 금액을 오래된 가불금부터 상환금에 기록한다.
  //  마감하면 가불금 표의 상환금에 기록 ([2026-10 정산 상계 300,000]), 마감 해제하면 되돌림
  const advAuto = [], advRows = [], advManualWarn = [], advPrepaid = [];
  stlRead_('stl_advance').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct), left = stlNum_(a.amt) - stlNum_(a.paid);
    // 상계 예정일이 이번 정산인데 상환금이 이미 다 적혀 있음 (마감 기록 없이) → 자동 공제 안 됨. 아직 안 받은 돈이면 상환금을 지워야 공제됨
    if (id && left <= 0 && stlNum_(a.amt) > 0 && a.due && stlAdvMonth_(a.due, cfg) === month && str_(a.memo).indexOf('[' + month + ' 정산 상계') < 0) {
      advPrepaid.push(stlAcctLabel_(X, D, id) + ' · ' + (a.date ? stlYmd_(a.date).slice(5).replace('-', '/') + ' ' : '') + '가불 ' + won_(stlNum_(a.amt)) + '원 · 상계 예정일 ' + stlYmd_(a.due) + ' · 상환금 ' + won_(stlNum_(a.paid)) + '원');
    }
    if (!id || left <= 0) return;
    advRows.push({ a: a, id: id, left: left });
    if (!a.due || stlAdvMonth_(a.due, cfg) !== month || manualRepay[id]) return;
    addAdj(id, STL_ADV_ITEM, left, (a.date ? stlYmd_(a.date).slice(5).replace('-', '/') + ' 가불 ' : '가불 ') + won_(stlNum_(a.amt)) + '원 · 상환일 ' + stlYmd_(a.due) + ' (자동)', true);
    advAuto.push({ row: a._row, id: id, amt: left });
  });
  Object.keys(manualRepay).forEach(function (id) {
    let rest = manualRepay[id];
    const mine = advRows.filter(function (x) { return x.id === id; })
      .sort(function (p, q) { return (stlYmd_(p.a.date) || '9') < (stlYmd_(q.a.date) || '9') ? -1 : (stlYmd_(p.a.date) || '9') > (stlYmd_(q.a.date) || '9') ? 1 : p.a._row - q.a._row; });
    mine.forEach(function (x) {
      if (rest <= 0) return;
      const amt = Math.min(rest, x.left);
      advAuto.push({ row: x.a._row, id: id, amt: amt, manual: true });
      rest -= amt;
    });
    const name = X.groups[id] && X.groups[id].ownerId && D.byId[X.groups[id].ownerId] ? D.byId[X.groups[id].ownerId].name : id;
    advManualWarn.push(name + ' 수기 ' + won_(manualRepay[id]) + '원' + (mine.length ? ' → 가불금 상환금에 기록' + (rest > 0 ? ' (남은 가불금보다 ' + won_(rest) + '원 많음)' : '') : ' (남은 가불금 없음)'));
  });
  stlRead_('stl_regular').forEach(function (a) {
    if (a.from && month < a.from.slice(0, 7)) return;
    if (a.to && month > a.to.slice(0, 7)) return;
    addAdj(stlAcct_(X, D, a.name, a.acct), a.item, stlNum_(a.amt), '정기 (설정)', true);
  });
  stlRead_('stl_leave').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct), m = str_(a.month).slice(0, 7), amt = stlNum_(a.amt) || cfg.leaveAmt;
    if (!id || !stlMonthOk_(m)) return;
    if (m === month) addAdj(id, '퇴사 보류금', amt, str_(a.memo) || stlLeaveMemo_(m, cfg), true);
    if (stlAddMonth_(m, 1) === month) addAdj(id, '보류금 반환', amt, Number(m.slice(5)) + '월 퇴사 보류금 반환 (분실파손·미차감분 정산 끝)', true);
  });

  // 기사별 마무리 계산
  Object.keys(S).forEach(function (id) { S[id].sched = stlGroupSched_(ctx, X.groups[id], sched, P, S[id].cidDays); });
  // 스케줄 칸에 다른 명의자 아이디로 뛴 날 (예: '723D,116C (dasom1125) 업무등록'): 그 아이디의 그날 배송을 참고로 보여 준다.
  //  매출·금액은 그 아이디 명의자 정산서에만 들어간다 (이 정산서 합계에는 안 들어감)
  Object.keys(S).forEach(function (id) {
    const cells = (S[id].sched && S[id].sched.cells) || {}, use = {};
    Object.keys(cells).forEach(function (d) {
      const re = /\(([A-Za-z][A-Za-z0-9_.-]{2,})\)/g;
      let m;
      while ((m = re.exec(String(cells[d] || '')))) {
        const lg = stlLogin_(m[1]), ix = X.by[lg];
        if (!ix || ix.mainKey === id) continue;
        const o = use[d] = use[d] || [];
        if (o.some(function (x) { return x.login === lg; })) continue;
        const g = X.groups[ix.mainKey], rows = byDateLogin[d + '|' + lg] || [];
        const routes = [];
        rows.forEach(function (x) { if (x.route && routes.indexOf(x.route) < 0) routes.push(x.route); });
        o.push({
          login: lg, cid: String(m[1]).replace(/@.*$/, ''), owner: g ? (g.vendor || (g.ownerId && D.byId[g.ownerId] ? D.byId[g.ownerId].name : '')) : '',
          routes: routes, qty: rows.reduce(function (a, x) { return a + x.qty; }, 0), amt: rows.reduce(function (a, x) { return a + stlR0_(x.qty * x.unit); }, 0)
        });
      }
    });
    S[id].idUse = use;
  });
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
  // 스케줄 계산 뒤에 생긴 묶음 (목표 매출·매출 분할 대상으로 처음 잡힌 달 등) — 출근일 정보 채움
  Object.keys(S).forEach(function (id) { if (!S[id].sched) S[id].sched = X.groups[id] ? stlGroupSched_(ctx, X.groups[id], sched, P, S[id].cidDays || {}) : { days: 0, byCid: [], src: '', cells: {} }; });
  const drivers = [], slips = {};
  const tot = { qty: 0, pay: 0, invoice: 0, supply: 0, tax: 0, san: 0, goy: 0, depDed: 0, depAdd: 0, net: 0, loss: 0, lossCp: 0, lossInc: 0, yongInc: 0, otherInc: 0, profit: 0, runnerIns: 0, fbCut: 0, fbKeep: 0, insGain: 0, sales: 0 };
  Object.keys(S).forEach(function (id) {
    const s = S[id], f = fin(id, extraAdj[id]);
    const o = s.owner;
    const p = payRows[id] || {};
    const workers = Object.keys(s.workers).map(function (w) {
      const x = s.workers[w];
      return { id: w === '_' ? '' : w, name: w === '_' ? (s.vendor ? s.vendor + ' (용차업체)' : '(명의자 없음)') : (D.byId[w] ? D.byId[w].name : w), qty: x.qty, amt: x.amt, days: Object.keys(x.dates).length, dates: Object.keys(x.dates).sort(), cids: Object.keys(x.cids), owner: w === s.ownerId };
    }).sort(function (a, b) { return b.qty - a.qty; });
    const row = {
      id: id, cid: s.cid, name: s.name, ownerId: s.ownerId, vendor: s.vendor, vendorPrice: s.vendor && X.groups[id].main.vinfo ? X.groups[id].main.vinfo.price : 0, ids: X.groups[id].cids.length, cids: X.groups[id].cids.slice(), usedCids: Object.keys(s.ids), type: s.type || '', mode: s.mode || '',
      workers: workers.filter(function (w) { return !w.owner && !(s.vendor && !w.id); }).map(function (w) { return w.name; }),
      workDays: s.sched.days, workDaysBy: s.sched.byCid, workDaysSrc: s.sched.src, qty: s.qty, sales: s.sales,
      base: s.base, inc: s.inc, fresh: s.fresh, freshRaw: s.freshRaw, fbCutTxt: s.fbCutTxt || '', fbCut: s.fbCut, fbKeep: s.fbKeep, unc: s.unc, etc: s.etc, loss: s.loss, lossCp: s.lossCp, yongPay: s.yongPay, yongCut: s.yongCut,
      pay: f.pay, taxDed: f.taxDed, invoice: f.invoice, supply: f.supply, tax: f.tax, san: f.san, goy: f.goy, depDed: f.depDed, depAdd: f.depAdd, net: f.net,
      lossInc: f.lossInc, yongInc: f.yongInc, otherInc: f.otherInc, // 계산서 발행 후 공제한 분실 변상금·용차 차액 = 러너 기타수익 (부가세 없음)
      profit: Math.round(s.supplyCp - s.lossSup - f.supply + f.otherInc), runnerIns: f.runnerIns, insGain: f.insGain,
      bank: o.bankName || '', holder: o.accountHolder || '', account: o.account || '', hasAccount: !!(o.accountEnc || (o.vendor && o.accountRaw)), bizNo: o.bizNo || '', bizName: o.vendor ? '' : o.bizName || '',
      checked: stlYes_(p.checked), payDate: p.date || '', payMemo: p.memo || '',
      advLeft: adv[id] ? adv[id].left : 0, noPriceQty: s.noPriceQty,
      movedIn: Object.keys(s.movedIn).map(function (k) { return s.movedIn[k].label; }), movedOut: Object.keys(s.movedOut).map(function (k) { return s.movedOut[k].label; })
    };
    // 대표(직함 '대표' 또는 원청단가): 지급하지 않는다 — 매출은 그대로 러너 수익. 명세서는 확인용으로 계산값(ceoView)만 남김
    if (normTitle_(o.title) === '대표' || s.mode === '원청단가') {
      row.ceo = true;
      row.ceoView = {};
      ['pay', 'taxDed', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'runnerIns', 'insGain', 'lossInc', 'yongInc', 'otherInc'].forEach(function (k) { row.ceoView[k] = row[k]; row[k] = 0; });
      row.profit = Math.round(s.supplyCp - s.lossSup);
    }
    drivers.push(row);
    slips[id] = { row: row, lines: f.lines, ins: f.ins, routes: Object.keys(s.routes).map(function (k) { return s.routes[k]; }).sort(function (a, b) { return koCmp_(a.camp, b.camp) || koCmp_(a.route, b.route); }),
      daily: s.daily, sched: s.sched.cells, idUse: s.idUse || {}, loss: s.lossLines, yong: s.yongLines, members: X.groups[id].cids.slice(), workers: workers,
      movedIn: stlMoveList_(s.movedIn), movedOut: stlMoveList_(s.movedOut) };
    ['qty', 'pay', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'loss', 'lossCp', 'lossInc', 'yongInc', 'otherInc', 'profit', 'runnerIns', 'fbCut', 'fbKeep', 'insGain', 'sales'].forEach(function (k) { tot[k] += row[k] || 0; });
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
  // links[i] = 그 줄 이름을 누르면 갈 곳 { t: 'drv'(기사 정보), id } · { t: 'vendor' } (용차업체) · { t: 'slip', id } (정산서) · { t: 'route' } (노선관리)
  const W = function (key, label, list, level, acts, links) { const n = key === 'manual' ? 1000 : 50; if (list.length) warnings.push({ key: key, label: label, count: list.length, items: list.slice(0, n), level: level || 'warn', acts: acts ? acts.slice(0, n) : null, links: links ? links.slice(0, n) : null }); };
  const lnk = function (d) { return d.vendor ? { t: 'vendor' } : d.ownerId ? { t: 'drv', id: d.ownerId } : { t: 'slip', id: d.id }; };
  W('yongNoP', '품앗이 단가 없음 (노선관리 품앗이단가가 비어 있어 원래 단가로만 지급 · 단가 칸에 직접 넣거나 노선관리에서 채워 주세요)', yongNoP, 'warn');
  W('yongNoP5', '외부용차단가 없음 (용차업체·외부 수행 노선의 노선관리 외부용차단가가 비어 있어 업체 단가로만 청구 · 러너 몫 0 · 단가 칸에 직접 넣거나 노선관리에서 채워 주세요)', yongNoP5, 'warn');
  W('advPrepaid', '이번 정산에 상계할 가불금인데 상환금이 이미 적혀 있어 자동 공제 안 됨 (아직 안 받은 돈이면 가불금 목록에서 상환금을 지우거나 받은 만큼만 남겨 주세요)', advPrepaid, 'warn');
  W('advManual', '수기 가불금 상환 있음 · 자동 공제 건너뜀 (마감하면 가불금 목록 상환금에 기록)', advManualWarn, 'info');
  W('unreg', stlIdsV2_() ? '기사 정보관리에 없는 쿠팡 ID (지급 계산 안 됨 — [기사에 연결] 또는 [용차업체로 지정])' : '아이디 관리에 없는 쿠팡 ID (지급 계산 안 됨 — 정산관리 → 아이디 관리에 추가)',
    Object.keys(warn.unreg).map(function (k) { const u = warn.unreg[k]; return cidNm(u.cid) + ' · ' + won_(u.sales) + '원' + (u.loss ? ' · 분실 ' + won_(u.loss) : ''); }), 'bad',
    Object.keys(warn.unreg).map(function (k) { return { cids: [warn.unreg[k].cid] }; }));
  const noOwn = drivers.filter(function (d) { return !d.ownerId && !d.vendor; });
  W('noOwner', '명의자가 없는 아이디 (아이디 관리에서 명의자 지정 · 용차업체 아이디면 [용차업체로 지정])', noOwn.map(function (d) { return d.cids.map(cidNm).join(', ') + ' · ' + won_(d.sales) + '원'; }), 'bad',
    noOwn.map(function (d) { return { cids: d.cids.slice() }; }));
  W('vendorNo', '용차업체 목록에 없는 업체 (아이디 관리 → 용차업체에 추가)', Object.keys(X.groups).filter(function (k) { return X.groups[k].vendor && X.groups[k].main.vinfo && X.groups[k].main.vinfo.missing; }).map(function (k) { return X.groups[k].vendor; }));
  W('badSub', '서브인데 메인 아이디를 찾을 수 없음 (따로 정산됨)', X.badSub.map(cidNm));
  // [확인함] 으로 이 달만 숨긴 항목 · 퇴사자 보류금에 등록된 명의자
  const acked = {};
  stlRead_('stl_ack').forEach(function (k) { if (k.month === month) acked[k.kind + '|' + k.key] = 1; });
  const leaveOf = {};
  stlRead_('stl_leave').forEach(function (l) { const id = stlAcct_(X, D, l.name, l.acct); if (id && stlMonthOk_(str_(l.month).slice(0, 7))) leaveOf[id] = str_(l.month).slice(0, 7); });
  const ownerNm = function (gk) { const g = X.groups[gk]; return g && g.ownerId && D.byId[g.ownerId] ? D.byId[g.ownerId].name : (g ? String(g.cid).replace(/@.*$/, '') : ''); };
  const mvKeys = Object.keys(warn.moveNo).filter(function (k) { return !acked['moveNo|' + k]; });
  W('moveNo', '아이디 사용 기록의 기사에게 본인 정산 아이디가 없음 (명의자 정산에 남김 — 서브 인원이면 [서브 인원], 따로 정산하면 [본인 정산 아이디 만들기])',
    mvKeys.map(function (k) { const w = warn.moveNo[k]; return w.name + ' · ' + cidNm(w.cid) + ' ' + w.dates.length + '일'; }), 'warn',
    mvKeys.map(function (k) { const w = warn.moveNo[k]; return { kind: 'moveNo', key: k, worker: k.split('|')[0], cid: w.cid, label: w.name + ' · ' + String(w.cid).replace(/@.*$/, ''), name: w.name, owner: ownerNm(X.by[stlLogin_(w.cid)] ? X.by[stlLogin_(w.cid)].mainKey : '') }; }));
  const stKeys = Object.keys(warn.stopped).filter(function (c) { return !acked['stopped|' + stlLogin_(c)]; });
  W('stopped', '정지된 아이디에 배송 기록 (퇴사자면 [퇴사 처리]로 퇴사 보류금 등록)', stKeys.map(function (c) {
    const lm = leaveOf[warn.stopped[c]];
    return cidNm(c) + (lm ? ' ✓ ' + Number(lm.slice(5)) + '월 퇴사 등록됨' : '');
  }), 'info', stKeys.map(function (c) {
    const gk = warn.stopped[c];
    return leaveOf[gk] ? null : { kind: 'stopped', key: stlLogin_(c), cid: c, acct: X.groups[gk] ? X.groups[gk].cid : '', label: cidNm(c), name: ownerNm(gk) };
  }));
  // 사용 중인 메인 아이디인데 정산기간 끝까지 10일 이상 배송이 없음 → 퇴사·정지 확인
  //   기준일 = 정산서에 있는 마지막 날짜 (진행 중인 달은 정산기간 끝이 아니라 올라온 데까지)
  const idle = [];
  let dataEnd = '';
  Object.keys(lastDel).forEach(function (k) { if (lastDel[k] > dataEnd) dataEnd = lastDel[k]; });
  const idleRef = dataEnd && dataEnd < P.to ? dataEnd : P.to;
  const dayGap = function (a, b) { return Math.round((parseYmd_(b) - parseYmd_(a)) / 86400000); };
  if (dataEnd) Object.keys(X.by).forEach(function (k) {
    const b = X.by[k], g = X.groups[b.mainKey];
    if (b.stopped || b.role === '서브' || b.vendor || !g || g.vendor || (g.main && g.main.mode === '용차내역') || cutIds[k] || acked['idle|' + k]) return;
    const last = lastDel[k], gap = last ? dayGap(last, idleRef) : dayGap(P.from, idleRef) + 1;
    if (gap < 10) return;
    idle.push({ k: k, cid: b.cid, last: last || '', gap: gap });
  });
  idle.sort(function (a, b) { return (a.last || '0') < (b.last || '0') ? -1 : 1; });
  W('idle', '사용 중인 아이디인데 10일 이상 배송 없음 (퇴사·휴직이면 [정지] · 퇴사면 [퇴사 처리])', idle.map(function (x) {
    const lm = leaveOf[X.by[x.k].mainKey];
    return cidNm(x.cid) + ' · ' + (x.last ? '마지막 배송 ' + Number(x.last.slice(5, 7)) + '/' + Number(x.last.slice(8, 10)) + ' (' + x.gap + '일 전)' : '이번 정산기간 배송 없음') + (lm ? ' ✓ ' + Number(lm.slice(5)) + '월 퇴사 등록됨' : '');
  }), 'info', idle.map(function (x) { return { kind: 'idle', key: x.k, cid: x.cid, last: x.last, label: cidNm(x.cid), name: ownerNm(X.by[x.k].mainKey), leave: !!leaveOf[X.by[x.k].mainKey] }; }));
  W('stoppedSub', '정지 상태인 서브 아이디에 배송 기록 (메인 아이디 정산에 합산됨 · 확인만)', Object.keys(warn.stoppedSub).map(function (c) {
    const g = X.groups[warn.stoppedSub[c]];
    return cidNm(c) + ' → 메인 ' + (g ? String(g.cid).replace(/@.*$/, '') + (g.ownerId && D.byId[g.ownerId] ? ' (' + D.byId[g.ownerId].name + ')' : '') : '');
  }), 'sub');
  W('noCamp', '노선관리에 없는 캠프', Object.keys(warn.noCamp), 'bad');
  W('noRtPrice', '단가 미반영 — 노선이 비어 있는 줄 (기사 지급 0원 · 쿠팡 정산 파일의 수기반영 등. 아이디 사용 기록·조정으로 처리해 주세요)', warn.noRtPrice, 'warn', null, warn.noRtPriceL);
  W('manual', '쿠팡 수기정산 ' + warn.manual.filter(function (x) { return x.on; }).length + '건 — 아이디 기준으로 배송 기본에 포함했습니다 (확인용 · 정산서에 따로 안 보임' + (warn.manual.some(function (x) { return !x.on; }) ? ' · 반영 안 함 ' + warn.manual.filter(function (x) { return !x.on; }).length + '건' : '') + ')',
    warn.manual.map(function (x) { return x.label; }), 'info',
    warn.manual.map(function (x) { return { kind: 'manual', key: x.key, on: x.on, label: x.label.replace(/^[✅⬜] /, '') }; }), warn.manual.map(function (x) { return { t: 'slip', id: x.sid }; }));
  if (warn.promo.length) {
    const pb = warn.promo.filter(function (x) { return x.kind === 'base'; }).length, pr = warn.promo.filter(function (x) { return x.kind === 'run'; }).length, pd = warn.promo.filter(function (x) { return x.kind === 'drv'; }).length;
    W('promo', '프로모션 — 베이스 ' + pb + '건 · 쿠팡 지정 ' + pr + '건 · 기사 직접 신청 ' + pd + '건 (배송유형 주간 = 기사가 쿠팡플렉스 앱에서 직접 신청 → 기사 지급 · 심야 = 쿠팡 지정 → 러너 수익 · 줄마다 바꿀 수 있음)',
      warn.promo.map(function (x) { return x.label; }), 'info',
      warn.promo.map(function (x) { return x.key ? { kind: 'promo', key: x.key, on: x.kind === 'drv', label: x.label } : null; }), null);
  }
  W('noPrice', '단가 미입력 (노선관리 → 구분별 단가)', Object.keys(warn.noPrice).map(function (k) {
    const w = warn.noPrice[k]; return w.camp + ' ' + w.route + (w.type ? ' · ' + w.type + '단가' : '') + ' · ' + won_(w.qty) + '건' + (w.manual ? ' (수기반영 ' + won_(w.manual) + '건)' : '') + (w.routeKnown ? '' : ' (노선 미등록)');
  }), 'bad', null, Object.keys(warn.noPrice).map(function (k) { return { t: 'route', camp: warn.noPrice[k].camp, route: warn.noPrice[k].route }; }));
  W('kind', '분류 안 된 쿠팡 구분값 (stl_kinds 에 추가)', Object.keys(warn.kind).map(function (k) { return k + ' ' + warn.kind[k] + '줄'; }));
  W('adjBad', '공제·가감의 기사명을 찾을 수 없음', adjBad);
  const noAcc = drivers.filter(function (d) { return d.net > 0 && !d.hasAccount; }), noBiz = drivers.filter(function (d) { return d.invoice > 0 && !d.bizNo && d.mode !== '용차내역'; });
  W('noAcc', '계좌 미입력', noAcc.map(function (d) { return d.name; }), 'warn', null, noAcc.map(lnk));
  W('noBiz', '사업자번호 미입력', noBiz.map(function (d) { return d.name; }), 'info', null, noBiz.map(lnk));
  W('minus', '실입금 마이너스', drivers.filter(function (d) { return d.net < 0; }).map(function (d) { return d.name + ' ' + won_(d.net); }), 'bad');
  W('round', '이번 차수 변동 ID', rounds.changed.map(function (x) { return cidNm(x.cid) + ' ' + (x.diff > 0 ? '+' : '') + won_(x.diff); }), 'info');
  W('yong', '용차내역 방식인데 이 달 용차 기록 없음', drivers.filter(function (d) { return d.mode === '용차내역' && !S[d.id].yongLines.length && S[d.id].qty; }).map(function (d) { return d.name + ' ' + won_(S[d.id].qty) + '건'; }));
  const today = todayText_();
  W('adv', '가불금 미상계 (상계일 지남)', Object.keys(adv).filter(function (id) { return adv[id].overdue > 0; }).map(function (id) { return adv[id].name + ' ' + won_(adv[id].overdue) + '원'; }));

  const summary = {
    month: month, period: P, today: today, round: rounds.latest, roundFile: rounds.file, roundAt: rounds.at,
    rawRows: raw.length, lossRows: loss.length, drivers: drivers, total: tot,
    company: {
      sales: company.sales, supplyCp: company.supplyCp, lossCp: company.lossCp, lossSup: company.lossSup, unregSales: company.unregSales, vendorCut: company.vendorCut, progFee: company.progFee, yongGain: company.yongGain,
      promoBase: company.promoBase, promoRunner: company.promoRunner, // 러너 몫 프로모션 (기사 줄에 없음 → 회사이익에 따로 더함)
      coupangNet: company.supplyCp - company.lossSup - company.vendorCut
    },
    dates: stlDates_(month, cfg), warnings: warnings, yong: yongOut, advAuto: advAuto, vendors: X.vendors.list.map(function (v) { return v.name; })
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
/** 품앗이/용차 지정 라우트 칸 → 라우트 목록. 119A · 119AB(→119A,119B) · 119A,119B · 530A/530B · 빈칸(그날 전체) */
function stlYongRoutes_(v) {
  const out = [];
  str_(v).toUpperCase().split(/[\s,·/|]+/).forEach(function (t) {
    if (!t) return;
    const m = t.match(/^(\d+)-?([A-Z]{2,})$/);
    if (m) m[2].split('').forEach(function (ch) { if (out.indexOf(m[1] + ch) < 0) out.push(m[1] + ch); });
    else if (out.indexOf(t) < 0) out.push(t);
  });
  return out;
}
/** 퇴사 보류금 기본 안내: 다음 달 정산까지 늦게 오는 분실파손·미차감분을 빼고, 없으면 반환 지급일에 돌려줌 */
function stlLeaveMemo_(m, cfg) {
  const pay = stlDates_(stlAddMonth_(m, 1), cfg || stlCfg_()).pay;
  return '퇴사 보류 · 익월·익익월 분실파손·미차감분 정산용 · 없으면 ' + Number(pay.slice(5, 7)) + '/' + Number(pay.slice(8, 10)) + ' 반환';
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
  if (stlUsageSub_(ctx, stlLogin_(r.cid), r.date)) return null; // 서브 인원: 명의자 정산 그대로
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
function stlGroupSched_(ctx, g, sched, P, cidDays) {
  const cells = {}, per = {}, cidW = {};
  let days = 0;
  schDateRange_(parseYmd_(P.from), parseYmd_(P.to)).forEach(function (d) {
    const ws = {};
    g.cids.forEach(function (c) {
      const w = stlWorkerOf_(ctx, stlLogin_(c), d);
      if (!w) return;
      // 다른 기사가 이 아이디를 쓴 날은 그 기사 본인 정산으로 가므로 이 묶음 근무일에서 뺀다
      if (w !== g.ownerId && ctx.groupOf && ctx.groupOf[w] && ctx.groupOf[w] !== g.key) return;
      ws[w] = 1;
      (cidW[c] = cidW[c] || {})[w] = 1;
      const v = (sched[w] || {})[d];
      if (v && stlIsWorkDay_(v)) per[c] = (per[c] || 0) + 1;
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
  // 아이디별 근무일: 그 아이디로 일한 기사의 스케줄 출근일. 같은 기사가 여러 아이디를 쓰면(스케줄로는 못 나눔)
  // 메인 아이디가 아닌 아이디는 쿠팡 배송이 있는 날 수, 스케줄 기록이 없는 아이디도 쿠팡 배송일 수
  const byCid = [], seenW = {};
  g.cids.forEach(function (c, i) {
    const ws = Object.keys(cidW[c] || {}), shared = ws.some(function (w) { return seenW[w]; });
    ws.forEach(function (w) { seenW[w] = 1; });
    const cp = Object.keys((cidDays || {})[stlLogin_(c)] || {}).length;
    let n = per[c] || 0;
    if ((i > 0 && shared) || !n) n = cp;
    byCid.push({ cid: String(c).replace(/@.*$/, ''), days: n });
  });
  // 기사스케줄에 이 기간 기록이 하나도 없으면(새로 등록한 기사 등) 쿠팡 배송이 잡힌 날 수로 센다
  let src = 'sched';
  if (!days && !Object.keys(cells).length) {
    const all = {};
    Object.keys(cidDays || {}).forEach(function (c) { Object.keys(cidDays[c]).forEach(function (d) { all[d] = 1; }); });
    if (Object.keys(all).length) { days = Object.keys(all).length; src = 'coupang'; }
  }
  // 아이디가 여럿이면 근무일수 = 아이디별 근무일의 합 (한 기사가 여러 아이디를 써도 합쳐서)
  if (byCid.length > 1) { const sumD = byCid.reduce(function (a, x) { return a + x.days; }, 0); if (sumD) { days = sumD; if (src !== 'coupang') src = 'sum'; } }
  return { days: days, cells: cells, byCid: byCid, src: src };
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
    else lines['(' + method + ')'] = { name: method, side: /분실|지출/.test(method) ? '차감' : '지급', method: method, taxCut: false, show: '금액 있을 때', order: 99, amt: amt, memo: [] };
  };
  put('배송기본', s.base + s.inc);
  put('프레시백', s.fresh);
  put('미계약', s.unc);
  put('프로모션', s.promo || 0);
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
  let lossInc = 0, yongInc = 0; // 계산서 발행 후 공제 (기타수익)
  Object.keys(lines).forEach(function (k) {
    const L = lines[k];
    if (L.method === '산재보험') { insAdjS += L.amt; return; }
    if (L.method === '고용보험') { insAdjG += L.amt; return; }
    if (L.method === '입금가산') depAdd += L.amt;
    else if (L.side === '지급') pay += L.amt;
    else if (L.taxCut) taxDed += L.amt;
    else { depDed += L.amt; if (L.method === '분실파손') lossInc += L.amt; else if (L.method === '용차지출') yongInc += L.amt; }
  });
  const invoice = pay - taxDed;
  const supply = Math.round(invoice / (1 + cfg.vat)), tax = invoice - supply;
  // 산재·고용: 기본값(세부정산 설정) → 캠프별 값(기사 지급액 비중으로 안분) → 기사별 값 순서로 덮어씀
  const ins = { base: 0, bosu: 0, exp: cfg.expense, san: cfg.san, goy: cfg.goy, runner: cfg.runner, sanD: 0, goyD: 0, sanAct: 0, goyAct: 0 };
  const dv = (campIns.acct || {})[s.id] || null;
  const excluded = !!s.insEx || s.mode === '용차내역' || !!(dv && dv.sanOff && dv.goyOff);
  let san = 0, goy = 0, runnerIns = 0, insGain = 0;
  if (!excluded && invoice > 0) {
    const baseOf = function (b) { return b === '부가세포함' ? invoice : supply; };
    let tw = 0, we = 0, ws = 0, wg = 0, wb = 0, wr = 0;
    const w = {};
    Object.keys(s.campPay).forEach(function (c) {
      const x = s.campPay[c]; if (x <= 0) return;
      const ci = (campIns.camp || {})[c] || {};
      tw += x; we += x * (ci.expense != null ? ci.expense : cfg.expense); ws += x * (ci.san != null ? ci.san : cfg.san);
      wg += x * (ci.goy != null ? ci.goy : cfg.goy); wb += x * baseOf(ci.basis || cfg.insBasis); wr += x * (ci.runner != null ? ci.runner : cfg.runner);
      w[c] = x;
    });
    ins.base = baseOf(cfg.insBasis);
    if (tw > 0) { ins.exp = we / tw; ins.san = ws / tw; ins.goy = wg / tw; ins.base = wb / tw; ins.runner = wr / tw; Object.keys(w).forEach(function (c) { w[c] = w[c] / tw; }); }
    if (dv) {
      if (dv.basis) ins.base = baseOf(dv.basis);
      if (dv.expense != null) ins.exp = dv.expense;
      if (dv.san != null) ins.san = dv.san;
      if (dv.goy != null) ins.goy = dv.goy;
      if (dv.runner != null) ins.runner = dv.runner;
    }
    const sanOff = !!(dv && dv.sanOff), goyOff = !!(dv && dv.goyOff);
    // 요율 = 전체 요율(기사+러너). 기사 공제 = 보수액 × 요율 × (1 − 러너 부담률). 예: 1.96% · 러너 50% → 기사 0.98%
    const r = Math.min(0.95, Math.max(0, ins.runner)), dr = 1 - r; // 기사 공제용 (캠프·기사별 러너 부담률)
    const r0 = Math.min(0.95, Math.max(0, cfg.runner)), dr0 = 1 - r0; // 공단 실제 납부 기준 (세부정산 설정 기본값)
    ins.bosu = ins.base * (1 - ins.exp);
    san = sanOff ? 0 : stlFloor10_(ins.bosu * (ins.san + cfg.commute) * dr);
    goy = goyOff || ins.bosu < cfg.goyMin ? 0 : stlFloor10_(ins.bosu * ins.goy * dr);
    // 공단 실제 납부 (항상 세부정산 설정 기본값: 보험 기준·경비율·요율). OFF 인 보험은 납부도 없음. san0·goy0 = 그중 기사분
    const bosu0 = baseOf(cfg.insBasis) * (1 - cfg.expense);
    const san0 = sanOff ? 0 : stlFloor10_(bosu0 * (cfg.san + cfg.commute) * dr0), goy0 = goyOff || bosu0 < cfg.goyMin ? 0 : stlFloor10_(bosu0 * cfg.goy * dr0);
    const totalAct = Math.round((san0 + goy0) / dr0);
    ins.sanAct = san0; ins.goyAct = goy0;
    runnerIns = totalAct - (san + goy);
    insGain = (san + goy) - (san0 + goy0); // 기사 공제가 공단 기사분보다 많은 만큼 = 러너 몫
    // 캠프 및 기사별 설정 화면의 차액 칸용
    ins.w = w; ins.drv = dv ? dv.row : 0; ins.sanD = san; ins.goyD = goy; ins.san0 = san0; ins.goy0 = goy0;
  }
  ins.excluded = excluded;
  san += insAdjS; goy += insAdjG;
  lines[autoName['산재보험'] || '산재보험'] = Object.assign(lines[autoName['산재보험'] || '산재보험'] || { name: '산재보험', side: '차감', method: '산재보험', show: '항상', order: 9, memo: [] }, { amt: san });
  lines[autoName['고용보험'] || '고용보험'] = Object.assign(lines[autoName['고용보험'] || '고용보험'] || { name: '고용보험', side: '차감', method: '고용보험', show: '항상', order: 10, memo: [] }, { amt: goy });
  const net = invoice - san - goy - depDed + depAdd;
  const list = Object.keys(lines).map(function (k) { return lines[k]; }).filter(function (L) { return L.show === '항상' || L.amt; })
    .sort(function (a, b) { return a.order - b.order; })
    .map(function (L) { return { name: L.name, side: L.side, method: L.method, taxCut: !!L.taxCut, amt: L.amt, memo: L.memo.join(' · '), unknown: !!L.unknown }; });
  return { lines: list, pay: pay, taxDed: taxDed, invoice: invoice, supply: supply, tax: tax, san: san, goy: goy, depDed: depDed, depAdd: depAdd, net: net, ins: ins, runnerIns: runnerIns, insGain: insGain, lossInc: lossInc, yongInc: yongInc, otherInc: lossInc + yongInc };
}

const STL_ADV_ITEM = '가불금 상환';
/** 상환일 → 그 날짜 이후(같은 날 포함) 첫 기사 지급이 있는 정산월. 예: 지급일 20일이면 11-20 → 2026-10 정산, 11-21 → 2026-11 정산 */
function stlAdvMonth_(due, cfg) {
  const d = stlYmd_(due);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const m = stlMonthOfDate_(d), prev = stlAddMonth_(m, -1);
  return stlDates_(prev, cfg).pay >= d ? prev : m;
}
function stlAdvances_(X, D) {
  const out = {}, today = todayText_(), cfg = stlCfg_();
  stlRead_('stl_advance').forEach(function (a) {
    const id = stlAcct_(X, D, a.name, a.acct);
    if (!id) return;
    const o = out[id] || (out[id] = { name: stlAcctLabel_(X, D, id), total: 0, paid: 0, left: 0, overdue: 0 });
    const amt = stlNum_(a.amt), paid = stlNum_(a.paid), left = Math.max(0, amt - paid);
    o.total += amt; o.paid += paid; o.left += left;
    // 상계 정산월이 아직 마감 전이면 그 달 정산에서 자동 공제되므로 미상계로 보지 않는다
    if (left > 0 && a.due && stlYmd_(a.due) < today) { const am = stlAdvMonth_(a.due, cfg); if (!am || stlClosedInfo_(am)) o.overdue += left; }
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
  const txt = v._ + ':' + Object.keys(v).filter(function (k) { return k !== '_' && !STL_NO_RECALC[k]; }).sort().map(function (k) { return k + v[k]; }).join(',');
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
/** 마감 기록 읽기 (나눠 저장된 줄 이어 붙임) → { summary, slips } */
function stlClosedLoad_(month) {
  const rows = stlReadMonth_('stl_closed', month);
  let summary = null;
  const slips = {};
  // 긴 결과는 여러 줄로 나눠 저장됨 (acct##1, acct##2 …) → 이어 붙여 읽음
  const parts = {}, order = [];
  rows.forEach(function (r) {
    const m = /^(.*)##(\d+)$/.exec(str_(r.acct)), base = m ? m[1] : str_(r.acct), n = m ? Number(m[2]) : 0;
    if (!parts[base]) { parts[base] = []; order.push(base); }
    parts[base][n] = r.data == null ? '' : String(r.data); // str_ 는 앞뒤 공백을 지움 → 나눠 저장한 경계의 공백이 사라지지 않게
  });
  order.forEach(function (acct) {
    try {
      const o = JSON.parse(parts[acct].join(''));
      if (acct === '_summary') summary = o; else slips[acct] = o;
    } catch (e) { /* 손상된 줄은 건너뜀 */ }
  });
  return { summary: summary, slips: slips };
}
/** 기존 정산 이식으로 마감한 달인지 */
function stlLegacyClosed_(month) {
  const c = stlClosedInfo_(month);
  return !!(c && /기존 정산 이식/.test(str_(c.admin)));
}
/**
 * 기존 정산 이식으로 마감한 달에 쿠팡 정산서를 넣은 뒤: 기사 금액(기존 그대로)은 두고 쿠팡 매출·분실(쿠팡)·회사이익만 채운다.
 * 짝: 마감 기록의 줄 id / 쿠팡 아이디 ↔ 올인원 계산 묶음. 마감 기록에 없는 묶음은 0원 줄로 매출만 더함.
 */
function stlLegacySales_(month) {
  const snap = stlClosedLoad_(month), sum = snap.summary, slips = snap.slips;
  if (!sum) fail_(month + ' 마감 기록을 읽을 수 없습니다.');
  // 전에 쿠팡 매출만 더했던 줄은 지우고 다시 (쿠팡 정산서를 다시 넣을 때)
  sum.drivers = sum.drivers.filter(function (r) { if (/쿠팡 매출만/.test(str_(r.legacyNote))) { delete slips[r.id]; return false; } return true; });
  const res = stlCompute_(month), byId = {}, byCid = {}, used = {};
  res.summary.drivers.forEach(function (c) { byId[c.id] = c; (c.cids || []).concat(c.usedCids || []).forEach(function (x) { byCid[stlLogin_(x)] = c; }); });
  const pick = function (row) {
    let c = byId[row.id] && !used[byId[row.id].id] ? byId[row.id] : null;
    if (!c) (row.cids || []).concat(row.usedCids || [], [row.cid, row.id]).some(function (x) { const y = byCid[stlLogin_(x)]; if (y && !used[y.id]) { c = y; return true; } return false; });
    return c;
  };
  sum.drivers.forEach(function (row) {
    const c = pick(row);
    row.sales = c ? c.sales || 0 : 0; row.lossCp = c ? c.lossCp || 0 : 0;
    if (c) used[c.id] = 1;
  });
  let extra = 0;
  res.summary.drivers.forEach(function (c) {
    if (used[c.id] || !(c.sales || c.lossCp)) return;
    const row = { id: c.id, cid: c.cid, name: c.name, ownerId: c.ownerId || '', vendor: c.vendor || '', cids: c.cids || [], usedCids: c.usedCids || [], ids: c.ids || 0, workers: c.workers || [], qty: c.qty || 0, sales: c.sales || 0, lossCp: c.lossCp || 0, legacyNote: '기존 정산서 없음 (쿠팡 매출만)' };
    ['pay', 'taxDed', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'loss', 'lossInc', 'yongInc', 'otherInc', 'runnerIns', 'insGain', 'fbCut', 'fbKeep'].forEach(function (k) { row[k] = 0; });
    if (slips[row.id]) row.id = row.id + '#cp';
    sum.drivers.push(row); extra++;
    slips[row.id] = { row: row, lines: [{ name: '(기존 정산서 없음 · 쿠팡 매출만)', side: '지급', method: '직접입력', taxCut: false, amt: 0, memo: '', unknown: false }], ins: {}, routes: [], daily: {}, sched: {}, idUse: {}, loss: [], yong: [], members: row.cids.slice(), workers: [], movedIn: [], movedOut: [] };
  });
  sum.drivers.forEach(function (row) {
    row.profit = Math.round(Math.round((row.sales || 0) / 1.1) - (row.lossCp ? Math.round(row.lossCp / 1.1) : 0) - (row.supply || 0) + (row.otherInc || 0));
    if (slips[row.id]) slips[row.id].row = row;
  });
  ['sales', 'lossCp', 'profit', 'qty'].forEach(function (k) { sum.total[k] = sum.drivers.reduce(function (a, r) { return a + (Number(r[k]) || 0); }, 0); });
  ['period', 'round', 'roundFile', 'roundAt', 'rawRows', 'lossRows', 'company'].forEach(function (k) { if (res.summary[k] !== undefined) sum[k] = res.summary[k]; }); // company = 쿠팡 매출·공급가·분실(쿠팡) 회사 합계 (화면 '쿠팡 매출'·'회사이익' 칸)
  sum.legacy = Object.assign({}, sum.legacy || {}, { salesAt: nowText_(), salesExtra: extra });
  delete sum.closed;
  stlReplaceMonth_('stl_closed', month, stlSnapRows_(month, { summary: sum, slips: slips }));
  stlBump_();
  return { sales: sum.total.sales, profit: sum.total.profit, extra: extra };
}
/** 결과: 마감된 달은 마감 때 저장한 결과, 아니면 계산 (5분 캐시) */
/** 마감 기록 줄: 칸 하나에 다 안 들어가면(5만 자 제한) acct##1, acct##2 … 로 나눠 저장 */
function stlSnapRows_(month, res) {
  const out = [], CH = 45000;
  const add = function (acct, obj) {
    const t = JSON.stringify(obj);
    for (let i = 0, n = 0; i < t.length || n === 0; i += CH, n++) out.push({ month: month, acct: n ? acct + '##' + n : acct, data: t.slice(i, i + CH) });
  };
  add('_summary', res.summary);
  Object.keys(res.slips).forEach(function (id) { add(id, res.slips[id]); });
  return out;
}
function stlResult_(month, fresh) {
  const closed = stlClosedInfo_(month);
  if (closed) {
    const key = 'stl:cl:' + month + ':' + stlVer_();
    let hit = stlCacheGet_(key);
    if (hit) return hit;
    const snap = stlClosedLoad_(month), summary = snap.summary, slips = snap.slips;
    if (summary) {
      summary.closed = closed;
      hit = { summary: summary, slips: slips };
      stlCachePut_(key, hit, 600);
      return stlPayOverlay_(hit, month);
    }
  }
  if (fresh) _stlFresh = true;
  const key = 'stl:r:' + month + ':' + stlVer_() + ':' + masterVer_() + ':' + STL_CALC_VER;
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
    stlEnsureIdsV2_(); // 처음 한 번: 아이디 관리 → 기사 정보관리
    const months = stlMonths_();
    if (!stlMonthOk_(month)) month = months.withData.length ? months.withData[months.withData.length - 1] : stlAddMonth_(stlMonthNow_(), -1);
    const r = stlResult_(month, !!fresh);
    let pnl = null;
    try { pnl = stlPnl_(month, r.summary); } catch (e) { pnl = null; }
    return { ok: true, month: month, months: months.slice(), summary: r.summary, pnl: pnl, items: stlItems_().list.map(function (i) { return { name: i.name, side: i.side, method: i.method, taxCut: i.taxCut }; }) };
  });
}
// ───────────────────────── 러너 손익 (당기순이익) ─────────────────────────
// 당기순이익(세전, 공급가) = 회사이익금 − 러너 산재·고용 50% + 보험 차액 − 직원 인건비(세전) − 고정 운영비 − 지출 기록
//  · 회사이익금 = 쿠팡 공급가 − 분실 − 기사 공급가 − 영업점 수수료 (프백·용차 잉여는 이미 안에 있음)
//  · 산재·고용 신고 기준 (기존 운영정산 시트와 같은 방식): 기사 매입 공급가 합계 × (1 − 경비율) = 월보수액
//    기사 산재 = 보수 × 산재율 × (1 − 러너 부담률) · 기사 고용 = 보수 × 고용율 × (1 − 러너 부담률) · 러너 = 기사분과 같은 비율
//    합계 = 공단 신고액 = 매달 빼둘 돈. 보험 차액 = 기사 정산서에서 실제 공제한 보험 − 신고 기준 기사분 (러너 잉여)
//  · 운영비 금액은 실제 나가는 돈(VAT포함). 증빙이 세금계산서·카드·현금영수증이면 ÷1.1 로 공급가·부가세(매입세액 공제)를 나눔
const STL_PROOF_VAT = { '세금계산서': 1, '카드': 1, '현금영수증': 1 };
function stlSplitVat_(amt, proof) {
  const a = stlR0_(stlNum_(amt));
  if (!STL_PROOF_VAT[str_(proof)]) return { supply: a, vat: 0 };
  const sp = Math.round(a / 1.1);
  return { supply: sp, vat: a - sp };
}
function stlActiveIn_(r, month) {
  const f = str_(r.from).slice(0, 7), t = str_(r.to).slice(0, 7);
  return (!f || f <= month) && (!t || t >= month);
}
/** 원천세: 3.3% = 소득세 3% + 지방소득세(소득세의 10%), 각각 10원 미만 버림. 다른 율이면 그 율로 10원 미만 버림 */
function stlWht_(pay, rate) {
  const r = str_(rate) ? stlRate_(rate, 0.033) : 0.033;
  if (Math.abs(r - 0.033) < 1e-9) { const inc = Math.floor(pay * 0.03 / 10) * 10; return inc + Math.floor(inc * 0.1 / 10) * 10; }
  return Math.floor(pay * r / 10) * 10;
}
/** 쿠팡 분실파손 차감금액은 소비자가(부가세 포함) → 공급가 환산 (손익·매출세액·역발행 계산서에 쓰는 값) */
function stlLossSup_(amt, cfg) { const v = cfg && typeof cfg.vat === 'number' ? cfg.vat : 0.1; return Math.round(stlNum_(amt) / (1 + v)); }
function stlPnl_(month, sum) {
  const t = (sum && sum.total) || {}, c = (sum && sum.company) || {};
  const o = {
    month: month, closed: !!(sum && sum.closed), hasData: !!(sum && (sum.drivers || []).length),
    qty: t.qty || 0, salesSupply: c.supplyCp || 0, salesVat: Math.round((c.supplyCp || 0) * 0.1 - ((c.lossCp || 0) - (c.lossSup || 0))), loss: c.lossCp || 0, lossSup: c.lossSup || 0, progFee: -(c.vendorCut || 0),
    drvSupply: t.supply || 0, drvVat: t.tax || 0, profit: (t.profit || 0) + (c.vendorCut || 0) + (c.promoBase || 0) + (c.promoRunner || 0),
    insDrv: (t.san || 0) + (t.goy || 0),
    staff: 0, staffWht: 0, staffNet: 0, staffN: 0, fixed: 0, fixedVat: 0, fixedN: 0, varCost: 0, varVat: 0, varN: 0, byCat: {}
  };
  // 산재·고용 신고 기준
  const cfg = stlCfg_(), rr = Math.min(0.95, Math.max(0, cfg.runner)), dr = 1 - rr;
  const ins = { base: o.drvSupply, exp: cfg.expense, san: cfg.san + cfg.commute, goy: cfg.goy, runner: rr };
  ins.bosu = Math.round(ins.base * (1 - cfg.expense));
  ins.sanD = Math.round(ins.bosu * ins.san * dr); ins.goyD = Math.round(ins.bosu * ins.goy * dr);
  ins.runnerAmt = dr > 0 ? Math.round((ins.sanD + ins.goyD) * rr / dr) : 0;
  ins.total = ins.sanD + ins.goyD + ins.runnerAmt;
  ins.gap = o.insDrv - (ins.sanD + ins.goyD); // 기사에게 실제 공제한 보험 − 신고 기준 기사분 → 러너 잉여
  o.ins = ins; o.runnerIns = ins.runnerAmt; o.insGap = ins.gap;
  // 기타수익 (세무사에게 넘길 기타수입 · 부가세 없음): 계산서 발행 후 기사에게서 공제한 분실 변상금 + 용차 차액 + 보험 차액
  //  분실·용차는 회사이익금(row.profit)에 이미 더해져 있고, 보험 차액은 당기순이익에서 더한다
  o.lossDrv = t.loss || 0; o.lossVat = !!cfg.lossVat;
  o.otherInc = { loss: t.lossInc || 0, yong: t.yongInc || 0, ins: ins.gap, total: (t.lossInc || 0) + (t.yongInc || 0) + ins.gap };
  // 참고 마진 (이미 매출−매입 안에 들어 있음 · 기타수입 아님): 프백 지급률 밖 + 프백 차감 + 용차 러너 몫
  o.margin = { fb: (t.fbKeep || 0) + (t.fbCut || 0), yong: c.yongGain || 0, total: (t.fbKeep || 0) + (t.fbCut || 0) + (c.yongGain || 0) };
  o.lossGain = 0; o.surplus = o.otherInc.total;
  const cat = function (k, v) { if (v) o.byCat[k || '기타'] = (o.byCat[k || '기타'] || 0) + v; };
  stlRead_('stl_staff').forEach(function (r) {
    const pay = stlR0_(stlNum_(r.pay));
    if (!r.name || !pay || !stlActiveIn_(r, month)) return;
    const w = stlWht_(pay, r.taxRate);
    o.staff += pay; o.staffWht += w; o.staffNet += pay - w; o.staffN++;
  });
  stlRead_('stl_cost').forEach(function (r) {
    if (!stlNum_(r.amt) || !stlActiveIn_(r, month)) return;
    const x = stlSplitVat_(r.amt, r.proof);
    o.fixed += x.supply; o.fixedVat += x.vat; o.fixedN++; cat(r.cat, x.supply);
  });
  o.taxPaid = 0;
  stlRead_('stl_expense').forEach(function (r) {
    if (r.month !== month || !stlNum_(r.amt)) return;
    if (STL_NOPNL_CATS.indexOf(r.cat) >= 0) { o.taxPaid += stlNum_(r.amt); return; } // 세금·보험 납부: 기록만 (손익 제외)
    const x = stlSplitVat_(r.amt, r.proof);
    o.varCost += x.supply; o.varVat += x.vat; o.varN++; cat(r.cat, x.supply);
  });
  o.cost = o.fixed + o.varCost;
  o.net = o.profit - o.runnerIns + o.insGap - o.staff - o.cost;
  o.rate = o.salesSupply ? o.net / o.salesSupply : 0;
  o.vatDue = o.salesVat - o.drvVat - o.fixedVat - o.varVat; // 부가세 예상 (매출세액 − 기사 매입세액 − 운영비 매입세액)
  return o;
}
/** 월별 손익 (조회월이 속한 해) */
function adm_stlPnl(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const y = month.slice(0, 4), ms = stlMonths_().withData.filter(function (m) { return m.slice(0, 4) === y; });
    if (ms.indexOf(month) < 0) { ms.push(month); ms.sort(); }
    const rows = ms.map(function (m) {
      let sum = null;
      try { sum = stlResult_(m, false).summary; } catch (e) { sum = null; }
      return stlPnl_(m, sum);
    });
    return { ok: true, year: y, rows: rows };
  });
}
/**
 * 최종 리포트 보조 자료 (정산 결과·손익은 화면이 이미 가진 것으로 그림): 세금계산서 발행 현황 · 통장 내역 미분류 · 쿠팡 입금(자금) · 마감 기록
 */
function adm_stlReportExtra(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const out = { ok: true, month: month, ti: { n: 0, total: 0, byDriver: {} }, bank: { rows: 0, none: 0, check: 0 }, deposit: null, closed: null };
    try {
      readAll_(SH.TAXINV).forEach(function (r) {
        if (!r.id || r.month !== month || r.pub === 'N') return;
        out.ti.n++; out.ti.total += stlNum_(r.total);
        const k = str_(r.supDriverId) || str_(r.supId); if (k) out.ti.byDriver[k] = (out.ti.byDriver[k] || 0) + stlNum_(r.total);
      });
    } catch (e) { /* 세금계산서 탭 없음 */ }
    try {
      // 통장 거래는 거래가 있던 달 기준으로 저장됨 → 정산월 다음 달(기사 지급·쿠팡 입금이 있는 달)까지 본다
      [month, stlAddMonth_(month, 1)].forEach(function (m) {
        stlReadMonth_('stl_bankrows', m).forEach(function (x) { out.bank.rows++; if (x.status === '미분류') out.bank.none++; else if (x.status === '확인') out.bank.check++; });
      });
    } catch (e) { /* 통장 내역 없음 */ }
    try {
      const f = stlRead_('stl_fund').filter(function (x) { return x.month === month && x.item === '쿠팡 입금'; })[0];
      if (f) out.deposit = { amt: stlNum_(f.amt), date: stlYmd_(f.date) || '', done: stlYes_(f.done) };
    } catch (e) { /* 자금 없음 */ }
    try { const c = stlClosedInfo_(month); if (c) out.closed = { at: c.at || '', admin: c.admin || '' }; } catch (e) { /* 무시 */ }
    return out;
  });
}
/**
 * 최종 리포트 연간 보기: 그 해 월별 추이 + 조회월의 캠프별·기사 TOP·일별 (옛 운영정산 시트의 표들)
 */
function adm_stlReportYear(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const y = month.slice(0, 4), ms = stlMonths_().withData.filter(function (m) { return m.slice(0, 4) === y; });
    if (ms.indexOf(month) < 0) { ms.push(month); ms.sort(); }
    const cfg = stlCfg_(), kinds = stlKinds_();
    const rows = ms.map(function (m) {
      let sum = null;
      try { sum = stlResult_(m, false).summary; } catch (e) { sum = null; }
      const p = stlPnl_(m, sum), t = (sum && sum.total) || {}, c = (sum && sum.company) || {};
      return { month: m, closed: p.closed, hasData: p.hasData, qty: p.qty, sales: c.sales || 0, salesSupply: p.salesSupply, loss: p.loss, drvInvoice: t.invoice || 0, drvSupply: p.drvSupply, drvNet: t.net || 0, drivers: (sum && sum.drivers || []).filter(function (d) { return d.invoice || d.net; }).length,
        profit: p.profit, otherInc: (p.otherInc || {}).total || 0, runnerIns: p.runnerIns, staff: p.staff, cost: p.cost, opex: (p.runnerIns || 0) + (p.staff || 0) + (p.cost || 0), net: p.net, rate: p.rate, vatDue: p.vatDue };
    });
    // 조회월: 캠프별 · 일별 (쿠팡 원천) · 기사 TOP (정산 결과)
    const camps = {}, daily = {}, short = function (v) { return str_(v).replace(/\s*캠프$/, ''); };
    stlReadMonth_('stl_raw', month).forEach(function (r) {
      const kind = stlKindOf_(kinds, r.kind);
      if (kind === '업체차감' || kind === '프로모션베이스') return;
      const qty = stlNum_(r.qty) + stlNum_(r.ret), total = stlNum_(r.total), fresh = stlNum_(r.fresh), sales = stlR0_((total + fresh) * (1 + cfg.vat));
      const cp = short(r.camp) || '(캠프 없음)', c = camps[cp] || (camps[cp] = { camp: cp, qty: 0, sales: 0, pay: 0 });
      c.qty += qty; c.sales += sales;
      const d = stlYmd_(r.date); if (d) { const x = daily[d] || (daily[d] = { date: d, qty: 0, sales: 0 }); x.qty += qty; x.sales += sales; }
    });
    let top = [], res = null;
    try { res = stlResult_(month, false); } catch (e) { res = null; }
    if (res) {
      const drivers = (res.summary.drivers || []).filter(function (d) { return !d.legacyNote && (d.sales || d.invoice); });
      top = drivers.slice().sort(function (a, b) { return (b.sales || 0) - (a.sales || 0); }).slice(0, 10).map(function (d) { return { name: d.name, sales: d.sales || 0, pay: d.pay || d.invoice || 0, profit: d.profit || 0, workDays: d.workDays || 0, qty: d.qty || 0 }; });
      // 캠프별 기사 지급: 노선별 줄은 그 캠프, 나머지(프레시백·수당 등)는 그 기사의 캠프 건수 비율로 나눔
      drivers.forEach(function (d) {
        const sl = res.slips[d.id]; if (!sl) return;
        const byCamp = {}, routeSum = (sl.routes || []).reduce(function (a, r) { const cp = short(r.camp) || '(캠프 없음)'; byCamp[cp] = (byCamp[cp] || 0) + (Number(r.qty) || 0); return a + (Number(r.amt) || 0); }, 0);
        const rest = (d.pay || 0) - routeSum, qsum = Object.keys(byCamp).reduce(function (a, k) { return a + byCamp[k]; }, 0) || 1;
        (sl.routes || []).forEach(function (r) { const cp = short(r.camp) || '(캠프 없음)', c = camps[cp] || (camps[cp] = { camp: cp, qty: 0, sales: 0, pay: 0 }); c.pay += Number(r.amt) || 0; });
        Object.keys(byCamp).forEach(function (cp) { const c = camps[cp] || (camps[cp] = { camp: cp, qty: 0, sales: 0, pay: 0 }); c.pay += Math.round(rest * byCamp[cp] / qsum); });
      });
    }
    const campList = Object.keys(camps).map(function (k) { const c = camps[k]; c.pay = Math.round(c.pay); c.margin = c.sales - c.pay; c.rate = c.sales ? c.margin / c.sales : 0; return c; }).sort(function (a, b) { return koCmp_(a.camp, b.camp); });
    const period = stlPeriod_(month), days = [];
    for (let d = parseYmd_(period.from); d && ymd_(d) <= period.to; d = addDays_(d, 1)) days.push(ymd_(d));
    const dailyList = (days.length ? days : Object.keys(daily).sort()).map(function (d) { return daily[d] || { date: d, qty: 0, sales: 0 }; });
    return { ok: true, year: y, month: month, rows: rows, camps: campList, top: top, daily: dailyList, period: period };
  });
}
// ───────────────────────── 통장 · 자금배분 ─────────────────────────
function stlBanks_() { return stlRead_('stl_bank').filter(function (b) { return b.name; }); }
/** 배분 설정 줄이 빠져 있으면 채운다 (새 항목이 생겨도) */
function stlAllocRows_() {
  const rows = stlRead_('stl_alloc'), have = {};
  rows.forEach(function (r) { have[r.label] = 1; });
  const banks = stlBanks_(), miss = STL_FUND_ITEMS.filter(function (f) { return !have[f[1]]; });
  if (miss.length) {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      stlAppend_('stl_alloc', miss.map(function (f) { const b = banks.filter(function (x) { return x.role === f[2]; })[0]; return { label: f[1], bank: b ? b.name : '', rule: '', desc: f[3] }; }));
    } finally { lock.releaseLock(); }
  }
  const by = {};
  stlRead_('stl_alloc').forEach(function (r) { by[r.label] = r; });
  return by;
}
/** 금액 규칙: 비우면 자동값, 3000000 = 그 금액, 20% = base × 20% (base 가 음수면 0) */
function stlRuleAmt_(rule, auto, base) {
  const r = str_(rule).replace(/[\s,원]/g, '');
  if (!r) return auto;
  if (/%$/.test(r)) return Math.max(0, Math.round(Math.max(0, base) * stlRate_(r, 0)));
  return stlR0_(stlNum_(r));
}
/** 그 정산월 자금배분: 쿠팡 입금 → 항목별 보낼 통장·계산 금액 · 이체 기록 */
function stlFund_(month) {
  const res = stlResult_(month, false), sum = res.summary, t = sum.total || {}, c = sum.company || {};
  const pnl = stlPnl_(month, sum), banks = stlBanks_(), alloc = stlAllocRows_();
  const roleBank = function (role) { const b = banks.filter(function (x) { return x.role === role; })[0]; return b ? b.name : ''; };
  const source = roleBank('쿠팡 입금') || (banks[0] ? banks[0].name : '');
  const rows = {};
  stlRead_('stl_fund').forEach(function (r) { if (r.month === month) rows[r.item] = r; });
  const dep = rows['쿠팡 입금'] || {};
  const depPlan = Math.round((c.supplyCp || 0) * 1.1 - (c.lossCp || 0)); // 분실파손 차감은 소비자가(부가세 포함)라 부가세 붙인 뒤 뺀다
  const deposit = { plan: depPlan, amt: stlNum_(dep.amt) || 0, done: stlYes_(dep.done), date: dep.date || '', memo: dep.memo || '', due: (sum.dates || {}).coupang || '', bank: source };
  const auto = {
    driver: t.net || 0, vat: Math.max(0, pnl.vatDue), ins: pnl.ins.total, staff: pnl.staff,
    fixed: pnl.fixed + pnl.fixedVat, var: pnl.varCost + pnl.varVat, tax: 0, owner: 0
  };
  const items = [];
  let used = 0;
  STL_FUND_ITEMS.forEach(function (f) {
    if (f[0] === 'rest') return;
    const a = alloc[f[1]] || {}, r = rows[f[1]] || {};
    const plan = stlRuleAmt_(a.rule, auto[f[0]], pnl.net);
    const amt = str_(r.amt) !== '' ? stlNum_(r.amt) : plan;
    used += amt;
    items.push({ key: f[0], label: f[1], bank: a.bank || roleBank(f[2]), plan: plan, amt: amt, adj: str_(r.amt) !== '', done: stlYes_(r.done), date: r.date || '', memo: r.memo || '', desc: f[3], rule: a.rule || '' });
  });
  const base = deposit.amt || deposit.plan, rr = rows['유보금 (나머지)'] || {}, ra = alloc['유보금 (나머지)'] || {};
  const restPlan = base - used;
  items.push({ key: 'rest', label: '유보금 (나머지)', bank: ra.bank || roleBank('유보금'), plan: restPlan, amt: str_(rr.amt) !== '' ? stlNum_(rr.amt) : restPlan, adj: str_(rr.amt) !== '', done: stlYes_(rr.done), date: rr.date || '', memo: rr.memo || '', desc: STL_FUND_ITEMS[STL_FUND_ITEMS.length - 1][3], rule: '' });
  return { month: month, closed: !!sum.closed, source: source, deposit: deposit, items: items, used: used, base: base, pnlNet: pnl.net, dates: sum.dates || {} };
}
/** 통장별 움직임: 기초잔액 · 직접 입출금 · 자금배분 완료 · 입금확인(기사 지급) */
function stlBankMoves_() {
  const banks = stlBanks_(), byName = {}, moves = [];
  banks.forEach(function (b) { byName[b.name] = b; });
  const openOk = function (bank, date) { const b = byName[bank]; return b && (!b.openDate || !date || stlYmd_(date) >= stlYmd_(b.openDate)); };
  const add = function (date, bank, amt, text, kind, month) { if (bank && amt && byName[bank] && openOk(bank, date)) moves.push({ date: stlYmd_(date) || '', bank: bank, amt: amt, text: text, kind: kind, month: month || '' }); };
  stlRead_('stl_banktx').forEach(function (x) {
    const a = stlNum_(x.amt), m = str_(x.memo) || x.kind;
    if (x.kind === '입금') add(x.date, x.to, a, m, '입금', x.month);
    else if (x.kind === '출금') add(x.date, x.from, -a, m, '출금', x.month);
    else { add(x.date, x.from, -a, m + ' → ' + x.to, '이체', x.month); add(x.date, x.to, a, m + ' ← ' + x.from, '이체', x.month); }
  });
  // 자금배분 완료 (쿠팡 입금 받음 · 항목 이체)
  const fundRows = stlRead_('stl_fund').filter(function (r) { return stlYes_(r.done) && stlNum_(r.amt); });
  const srcOf = function () { const b = banks.filter(function (x) { return x.role === '쿠팡 입금'; })[0]; return b ? b.name : (banks[0] ? banks[0].name : ''); };
  const src = srcOf();
  fundRows.forEach(function (r) {
    const a = stlNum_(r.amt), mt = Number(String(r.month).slice(5)) + '월 ';
    if (r.item === '쿠팡 입금') { add(r.date, r.bank || src, a, mt + '쿠팡 입금', '자금배분', r.month); return; }
    if (!r.bank || r.bank === src) return;
    add(r.date, src, -a, mt + r.item + ' → ' + r.bank, '자금배분', r.month);
    add(r.date, r.bank, a, mt + r.item + ' ← ' + src, '자금배분', r.month);
  });
  // 세금 일정에서 '낸 금액·납부일'을 넣은 세금 (출금 통장에서 빠짐)
  stlRead_('stl_taxpay').forEach(function (x) { if (x.date && stlNum_(x.amt) && !/^prior\|/.test(x.key)) add(x.date, x.bank, -stlNum_(x.amt), '세금 · ' + x.kind + ' ' + x.period, '세금', ''); });
  // 입금확인에서 체크한 기사 지급 (기사정산 통장에서 빠짐)
  const drvBank = (banks.filter(function (x) { return x.role === '기사정산'; })[0] || {}).name || src;
  const payByMonth = {};
  stlRead_('stl_pay').forEach(function (p) { if (stlYes_(p.checked)) (payByMonth[p.month] = payByMonth[p.month] || []).push(p); });
  Object.keys(payByMonth).forEach(function (m) {
    if (!stlMonthOk_(m)) return;
    let res = null;
    try { res = stlResult_(m, false); } catch (e) { res = null; }
    if (!res) return;
    const net = {};
    (res.summary.drivers || []).forEach(function (d) { net[d.id] = d.net; });
    const byDate = {};
    payByMonth[m].forEach(function (p) { const k = stlYmd_(p.date) || (res.summary.dates || {}).pay || ''; const v = net[stlLogin_(p.acct)] || 0; if (!v) return; const o = byDate[k] || (byDate[k] = { n: 0, amt: 0 }); o.n++; o.amt += v; });
    Object.keys(byDate).forEach(function (k) { add(k, drvBank, -byDate[k].amt, Number(m.slice(5)) + '월 기사 정산금 입금 ' + byDate[k].n + '명', '기사 지급', m); });
  });
  moves.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  const bal = {};
  banks.forEach(function (b) { bal[b.name] = { name: b.name, role: b.role, bankName: b.bankName, account: b.account, opening: stlNum_(b.opening), openDate: b.openDate || '', balance: stlNum_(b.opening), inSum: 0, outSum: 0 }; });
  moves.forEach(function (m) { const x = bal[m.bank]; x.balance += m.amt; if (m.amt > 0) x.inSum += m.amt; else x.outSum -= m.amt; m.after = x.balance; });
  return { banks: banks.map(function (b) { return bal[b.name]; }), moves: moves };
}
// ───────────────────────── 세금 일정 ─────────────────────────
// 종합소득세 세율 (2023년 귀속부터): [과세표준 상한, 세율, 누진공제]
const STL_INCOME_TAX = [[14000000, 0.06, 0], [50000000, 0.15, 1260000], [88000000, 0.24, 5760000], [150000000, 0.35, 15440000],
  [300000000, 0.38, 19940000], [500000000, 0.40, 25940000], [1000000000, 0.42, 35940000], [Infinity, 0.45, 65940000]];
function stlIncomeTax_(base) {
  if (base <= 0) return { rate: 0, tax: 0 };
  const b = STL_INCOME_TAX.filter(function (x) { return base <= x[0]; })[0];
  return { rate: b[1], tax: Math.max(0, Math.floor((base * b[1] - b[2]) / 10) * 10) };
}
/** 그 날이 주말·공휴일이면 다음 영업일 */
function stlBizDay_(ymd) {
  let d = parseYmd_(ymd);
  if (!d) return ymd;
  while (d.getDay() === 0 || d.getDay() === 6 || HOLIDAYS[ymd_(d)]) d = addDays_(d, 1);
  return ymd_(d);
}
const STL_TAX_BANK_ROLE = { '부가세': '부가세', '원천세': '인건비', '산재·고용': '산재고용', '종합소득세': '유보금', '지방소득세': '유보금' };
/** 조회월이 속한 해의 세금 일정 · 종합소득세 예상 */
function stlTax_(month) {
  const Y = month.slice(0, 4), Y1 = String(Number(Y) + 1);
  const ms = stlMonths_().withData.filter(function (m) { return m.slice(0, 4) === Y; });
  const per = {};
  ms.forEach(function (m) {
    let sum = null;
    try { sum = stlResult_(m, false).summary; } catch (e) { sum = null; }
    if (!sum) return;
    const t = sum.total || {}, p = stlPnl_(m, sum);
    per[m] = { wht: p.staffWht, ins: p.ins.total, vat: p.vatDue, net: p.net, payMonth: String(sum.dates && sum.dates.pay || stlAddMonth_(m, 1)).slice(0, 7) };
  });
  const paid = {};
  stlRead_('stl_taxpay').forEach(function (r) { if (r.key) paid[r.key] = r; });
  const banks = stlBanks_(), roleBank = function (role) { const b = banks.filter(function (x) { return x.role === role; })[0]; return b ? b.name : ''; };
  const items = [];
  const push = function (key, kind, period, due, est, note) {
    const r = paid[key] || {};
    items.push({ key: key, kind: kind, period: period, due: stlBizDay_(due), est: est == null ? null : Math.max(0, Math.round(est)), note: note || '',
      amt: str_(r.amt) !== '' ? stlNum_(r.amt) : null, date: r.date || '', bank: r.bank || roleBank(STL_TAX_BANK_ROLE[kind] || ''), memo: r.memo || '' });
  };
  const paidAmt = function (key) { return paid[key] && str_(paid[key].amt) !== '' ? stlNum_(paid[key].amt) : 0; };
  // 원천세 · 산재고용: 지급한 달의 다음 달 10일 (기사 지급월 = 직원 급여 지급월로 봄)
  Object.keys(per).sort().forEach(function (m) {
    const x = per[m], due = stlAddMonth_(x.payMonth, 1) + '-10', lab = Number(m.slice(5)) + '월 정산분';
    if (x.wht || paid['wht|' + m]) push('wht|' + m, '원천세', lab + ' (직원 급여)', due, x.wht, '소득세 3% + 지방소득세 0.3% · 홈택스·위택스');
    if (x.ins || paid['ins|' + m]) push('ins|' + m, '산재·고용', lab + ' (기사 보수)', due, x.ins, '기사 공제분 + 러너 부담분 · 근로복지공단 고지서');
  });
  // 부가세 (개인 일반과세자): 예정고지 4/25 · 10/25 (고지서 금액), 확정 7/25 · 다음 해 1/25 = 그 기 부가세 예상 − 예정고지 낸 금액
  const vatOf = function (a, b) { return Object.keys(per).filter(function (m) { const n = Number(m.slice(5)); return n >= a && n <= b; }).reduce(function (s0, m) { return s0 + per[m].vat; }, 0); };
  const v1 = vatOf(1, 6), v2 = vatOf(7, 12);
  push('vat1p|' + Y, '부가세', Y + '년 1기 예정고지', Y + '-04-25', null, '고지서 금액 (직전 기 납부세액의 1/2)');
  push('vat1|' + Y, '부가세', Y + '년 1기 확정 (1~6월)', Y + '-07-25', v1 - paidAmt('vat1p|' + Y), '1~6월 부가세 예상 ' + won_(v1) + ' − 예정고지 낸 금액');
  push('vat2p|' + Y, '부가세', Y + '년 2기 예정고지', Y + '-10-25', null, '고지서 금액 (직전 기 납부세액의 1/2)');
  push('vat2|' + Y, '부가세', Y + '년 2기 확정 (7~12월)', Y1 + '-01-25', v2 - paidAmt('vat2p|' + Y), '7~12월 부가세 예상 ' + won_(v2) + ' − 예정고지 낸 금액');
  // 종합소득세: 올해 당기순이익 → 연환산 → 기본공제 150만 → 과세표준 → 세율
  // 러너 올인원을 쓰기 전 올해 실적 (직접 입력: 당기순이익 합계 · 개월 수)
  const pr = paid['prior|' + Y] || {}, priorAmt = stlNum_(pr.amt), priorN = Math.max(0, Math.min(12, parseInt(str_(pr.period), 10) || 0));
  const sysN = Object.keys(per).length, sysNet = Object.keys(per).reduce(function (s0, m) { return s0 + per[m].net; }, 0);
  const n = sysN + priorN, netSum = sysNet + priorAmt;
  const annual = n ? Math.round(netSum / n * 12) : 0, ded = 1500000, base = Math.max(0, annual - ded), it = stlIncomeTax_(base);
  const local = Math.floor(it.tax * 0.1 / 10) * 10, mid = paidAmt('incm|' + Y);
  let reserve = 0;
  stlRead_('stl_fund').forEach(function (r) { if (String(r.month).slice(0, 4) === Y && r.item === '종합소득세 적립' && stlYes_(r.done)) reserve += stlNum_(r.amt); });
  push('incm|' + Y, '종합소득세', Y + '년 중간예납', Y + '-11-30', null, '고지서 금액 (작년 종합소득세의 1/2)');
  push('inc|' + Y, '종합소득세', Y + '년 귀속 확정신고', Y1 + '-05-31', it.tax - mid, '예상 세액 − 중간예납 낸 금액');
  push('loc|' + Y, '지방소득세', Y + '년 귀속', Y1 + '-05-31', local, '종합소득세의 10% · 위택스');
  items.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  return {
    year: Y, items: items,
    income: { months: n, sysMonths: sysN, sysNet: sysNet, priorAmt: priorAmt, priorMonths: priorN, netSum: netSum, annual: annual, deduction: ded, base: base, rate: it.rate, tax: it.tax, local: local, total: it.tax + local, mid: mid, due: Math.max(0, it.tax - mid) + local, reserve: reserve, short: Math.max(0, it.tax - mid) + local - reserve }
  };
}
function adm_stlTax(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    return Object.assign({ ok: true, today: todayText_(), banks: stlBanks_().map(function (b) { return b.name; }) }, stlTax_(month));
  });
}
/** 세금 한 줄 저장: f = { amt, date, bank, memo } (amt '' = 지움) */
function adm_stlTaxSave(token, month, key, f) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month) || !/^(wht|ins|vat1p|vat1|vat2p|vat2|incm|inc|loc|prior)\|\d{4}(-\d{2})?$/.test(str_(key))) fail_('세금 항목을 확인해 주세요.');
    f = f || {};
    if (/^prior\|/.test(key)) { // 올인원 쓰기 전 올해 실적
      const lock0 = scriptLock_();
      lock0.waitLock(20000);
      try {
        stlFreshIn_('stl_taxpay');
        const hit0 = stlRead_('stl_taxpay').filter(function (r) { return r.key === key; })[0], o0 = hit0 ? Object.assign({}, hit0) : { key: key, kind: '이전 실적', due: '' };
        if (f.amt !== undefined) { const v = str_(f.amt).replace(/[\s,원]/g, ''); if (v && !/^-?\d+$/.test(v)) fail_('금액은 숫자로 넣어 주세요.'); o0.amt = v; }
        if (f.months !== undefined) { const n0 = parseInt(str_(f.months), 10) || 0; if (n0 < 0 || n0 > 11) fail_('개월 수는 0~11'); o0.period = n0 ? n0 + '개월' : ''; }
        o0.memo = '러너 올인원 쓰기 전 올해 당기순이익 (종합소득세 예상용)';
        if (hit0) stlSetRow_('stl_taxpay', hit0._row, o0); else stlAppend_('stl_taxpay', [o0]);
      } finally { lock0.releaseLock(); }
      return { ok: true };
    }
    const it = stlTax_(month).items.filter(function (x) { return x.key === key; })[0];
    if (!it) fail_('이 해의 세금 일정에 없는 항목입니다.');
    if (f.bank && stlBanks_().map(function (b) { return b.name; }).indexOf(f.bank) < 0) fail_('통장 목록에 없는 통장입니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      stlFreshIn_('stl_taxpay');
      const hit = stlRead_('stl_taxpay').filter(function (r) { return r.key === key; })[0];
      const o = hit ? Object.assign({}, hit) : { key: key };
      o.kind = it.kind; o.period = it.period; o.due = it.due;
      if (f.amt !== undefined) { const v = str_(f.amt).replace(/[\s,원]/g, ''); if (v && !/^\d+$/.test(v)) fail_('금액은 숫자로 넣어 주세요.'); o.amt = v; if (v && !o.date && f.date === undefined) o.date = todayText_(); if (!v) o.date = ''; }
      if (f.date !== undefined) o.date = f.date ? stlYmd_(f.date) : '';
      if (f.bank !== undefined) o.bank = str_(f.bank);
      if (!o.bank) o.bank = it.bank;
      if (f.memo !== undefined) o.memo = str_(f.memo).slice(0, 200);
      if (hit) stlSetRow_('stl_taxpay', hit._row, o); else stlAppend_('stl_taxpay', [o]);
      if (f.amt !== undefined) logAdmin_(a, '세금 납부 기록', it.kind + ' ' + it.period, o.amt ? won_(stlNum_(o.amt)) + '원 · ' + o.date + ' · ' + o.bank : '지움');
    } finally { lock.releaseLock(); }
    return { ok: true };
  });
}
function adm_stlFund(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const f = stlFund_(month), b = stlBankMoves_();
    f.banks = b.banks;
    return Object.assign({ ok: true }, f);
  });
}
/** 자금배분 한 줄 저장: key = 'deposit' 또는 항목 키, f = { amt, done, date, memo } (amt '' = 계산 금액 그대로) */
function adm_stlFundSave(token, month, key, f) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    f = f || {};
    const it = key === 'deposit' ? ['deposit', '쿠팡 입금'] : STL_FUND_ITEMS.filter(function (x) { return x[0] === key; })[0];
    if (!it) fail_('알 수 없는 항목입니다.');
    const cur = stlFund_(month);
    const plan = key === 'deposit' ? cur.deposit.plan : cur.items.filter(function (x) { return x.key === key; })[0].plan;
    const bank = key === 'deposit' ? cur.source : cur.items.filter(function (x) { return x.key === key; })[0].bank;
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      stlFreshIn_('stl_fund');
      const rows = stlRead_('stl_fund'), hit = rows.filter(function (r) { return r.month === month && r.item === it[1]; })[0];
      const o = hit ? Object.assign({}, hit) : { month: month, item: it[1] };
      if (f.amt !== undefined) { const v = str_(f.amt).replace(/[\s,원]/g, ''); if (v && !/^-?\d+$/.test(v)) fail_('금액은 숫자로 넣어 주세요.'); o.amt = v; }
      if (f.memo !== undefined) o.memo = str_(f.memo).slice(0, 200);
      if (f.date !== undefined) o.date = f.date ? stlYmd_(f.date) : '';
      if (f.done !== undefined) {
        o.done = f.done ? 'Y' : '';
        if (f.done) { if (!str_(o.amt)) o.amt = String(plan); if (!o.date) o.date = todayText_(); if (!bank) fail_('보낼 통장이 없습니다. 배분 설정에서 통장을 골라 주세요.'); }
        else o.date = f.date ? stlYmd_(f.date) : '';
      }
      o.bank = bank; o.plan = String(plan);
      if (hit) stlSetRow_('stl_fund', hit._row, o); else stlAppend_('stl_fund', [o]);
      if (f.done !== undefined) logAdmin_(a, '자금배분 ' + (f.done ? '완료' : '취소'), month + ' ' + it[1], won_(stlNum_(o.amt)) + '원 → ' + bank);
    } finally { lock.releaseLock(); }
    return { ok: true };
  });
}
function adm_stlBank(token) {
  return run_(function () {
    requireAdmin_(token);
    const b = stlBankMoves_();
    return { ok: true, banks: b.banks, moves: b.moves.slice(-1000).reverse() };
  });
}
function stlMonths_() {
  const set = {};
  try { Object.keys(stlIndex_('stl_raw').m).forEach(function (m) { if (stlMonthOk_(m)) set[m] = 1; }); } catch (e) { /* 정산 DB 가 아직 없으면 빈 목록 */ }
  // 마감된 달 (쿠팡 정산서 없이 기존 정산 이식으로 마감한 달 포함)
  try { stlRead_('stl_close').forEach(function (r) { if (stlMonthOk_(r.month)) set[r.month] = 1; }); } catch (e) { /* 무시 */ }
  const withData = Object.keys(set).sort();
  const cur = stlMonthNow_();
  set[cur] = 1; set[stlAddMonth_(cur, -1)] = 1;
  const all = Object.keys(set).sort();
  all.withData = withData;
  return all;
}
/** 기사 한 명 명세서 */
/** 정산서 세금계산서 칸의 공급자 이름(상호): 지금 기사 정보의 상호가 있으면 그것 (마감한 달도 나중에 넣은 상호가 보이게) */
function stlLiveBizName_(row) {
  if (!row || row.vendor || !row.ownerId) return;
  try { const o = stlDrivers_().byId[row.ownerId]; if (o && str_(o.bizName)) row.bizName = str_(o.bizName); } catch (e) { /* 무시 */ }
}
function adm_stlSlip(token, month, id) {
  return run_(function () {
    requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const r = stlResult_(month, false);
    const s = r.slips[id];
    if (!s) fail_('이 달 정산 기록이 없는 기사입니다.');
    stlLiveBizName_(s.row);
    let co = {};
    try { co = companyInfo_(); } catch (e) { /* 회사 정보 없음 */ }
    const cfg = stlCfg_();
    return { ok: true, month: month, period: r.summary.period, dates: r.summary.dates, slip: s, company: { name: co.branchName || '', ceo: co.branchCeo || '', bizNo: co.branchBizNo || '', addr: co.branchAddr || '', email: cfg.email } };
  });
}

/** 쿠팡 정산 엑셀 원본을 드라이브에 저장 → { url, name } */
/** 드라이브 폴더의 쿠팡 정산서 엑셀 목록 (드라이브에서 가져오기). folderId 비우면 정산 파일 폴더 */
function adm_stlDriveList(token, folderId) {
  return run_(function () {
    requireAdmin_(token);
    let folder;
    try { folder = folderId ? DriveApp.getFolderById(str_(folderId).replace(/^.*folders\//, '').replace(/[?#].*$/, '')) : stlFileFolder_(); } catch (e) { fail_('폴더를 열 수 없습니다. 주소(ID)와 공유 권한을 확인해 주세요.'); }
    const out = [], it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next(), n = f.getName();
      if (!/\.(xlsx|csv)$/i.test(n)) continue;
      const m = n.match(/(20\d{2})\D{0,3}(\d{1,2})\s*월/);
      out.push({ id: f.getId(), name: n, size: f.getSize(), url: f.getUrl(), at: Utilities.formatDate(f.getLastUpdated(), CFG.TZ, 'yyyy-MM-dd HH:mm'), month: m ? m[1] + '-' + ('0' + m[2]).slice(-2) : '' });
    }
    out.sort(function (a, b) { return koCmp_(a.month + a.name, b.month + b.name); });
    return { ok: true, folder: folder.getName(), files: out };
  });
}
/** 드라이브 파일 내용 (base64) — 관리자 화면이 엑셀을 직접 읽는다 */
function adm_stlDriveGet(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const f = DriveApp.getFileById(str_(id));
    if (f.getSize() > 25 * 1024 * 1024) fail_('파일이 너무 큽니다.');
    return { ok: true, name: f.getName(), url: f.getUrl(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
  });
}
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
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const legacyM = !!p.legacy && stlLegacyClosed_(month); // 기존 정산 이식으로 마감한 달: 쿠팡 매출만 채움
      if (!legacyM) stlAssertOpen_(month);
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
      const D = stlDrivers_(), X = stlIds_(D), addIds = [], seen = {}, kmap = stlKinds_();
      rawObjs.concat(lossObjs).forEach(function (o) {
        const k = stlLogin_(o.cid);
        if (!k || X.by[k] || seen[k]) return;
        if (o.kind && kmap[o.kind] === '업체차감') return; // 영업점 수수료 등은 아이디가 아님
        seen[k] = 1;
        const d = D.byLogin[k];
        addIds.push({ cid: o.cid, role: '메인', owner: d ? d.name : '', ownerId: d ? d.id : '', type: d && STL_TYPES.indexOf(d.driverType) >= 0 ? d.driverType : '', status: '사용', memo: month + ' 정산서에서 자동 추가' });
      });
      if (addIds.length && !stlIdsV2_()) stlAppend_('stl_ids', addIds); // 기사 정보 기준이 된 뒤에는 모르는 아이디는 '등록 안 된 아이디' 경고로
      stlAppend_('stl_rounds', hist);
      stlBump_();
      const changed = hist.filter(function (h) { return h.diff; }).length;
      const totalAmt = Object.keys(after).reduce(function (s, k) { return s + after[k]; }, 0);
      logAdmin_(a, '쿠팡 정산서 반영', month + ' ' + round + '차', rawObjs.length + '줄 · 분실 ' + lossObjs.length + '줄 · 변동 ID ' + changed);
      let legSales = null;
      if (legacyM) legSales = stlLegacySales_(month);
      else try { uploadMemo_(a, Number(month.slice(5, 7)) + '월 정산서 업로드', round > 1 ? round + '차' : '', false); } catch (e) { /* 메모 실패는 무시 */ }
      return { ok: true, legacy: legSales, month: month, round: round, rows: rawObjs.length, loss: lossObjs.length, ids: Object.keys(after).length, changed: changed, total: Math.round(totalAmt), newIds: addIds.map(function (x) { return x.cid + (x.owner ? ' → ' + x.owner : ' (명의자 없음)'); }) };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 마감 / 마감 해제 */
// ───── 기사 앱 '정산서 마감' 팝업: 가장 최근 마감한 달 (스크립트 속성 STL_LAST_CLOSE = { month, at }) ─────
function stlLastCloseSet_(month, rows) {
  try {
    const p = PropertiesService.getScriptProperties();
    if (month) { p.setProperty('STL_LAST_CLOSE', JSON.stringify({ month: month, at: Date.now() })); return; }
    // 마감 해제: 남은 마감 중 가장 최근 달로 (팝업은 이미 본 기사에게 다시 뜨지 않음 — 기사 앱이 month+at 으로 기억)
    const cur = JSON.parse(p.getProperty('STL_LAST_CLOSE') || 'null');
    const left = (rows || []).map(function (r) { return r.month; }).sort();
    if (!left.length) p.deleteProperty('STL_LAST_CLOSE');
    else if (!cur || left.indexOf(cur.month) < 0) p.setProperty('STL_LAST_CLOSE', JSON.stringify({ month: left[left.length - 1], at: cur ? cur.at : Date.now(), old: true }));
  } catch (e) { console.error('STL_LAST_CLOSE: ' + (e && e.message)); }
}
/** 기사 앱용: 최근 20일 안에 마감한 달 (없으면 null) */
function stlLastClose_() {
  try {
    const x = JSON.parse(PropertiesService.getScriptProperties().getProperty('STL_LAST_CLOSE') || 'null');
    if (!x || x.old || !x.month || Date.now() - (+x.at || 0) > 20 * 86400000) return null;
    return { month: x.month, at: +x.at };
  } catch (e) { return null; }
}
function adm_stlClose(token, month, close) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const rows = stlRead_('stl_close');
      const others = rows.filter(function (r) { return r.month !== month; });
      if (close) {
        if (rows.some(function (r) { return r.month === month; })) fail_('이미 마감된 달입니다.');
        const res = stlCompute_(month);
        res.summary.computedAt = nowText_();
        const snap = stlSnapRows_(month, res);
        stlReplaceMonth_('stl_closed', month, snap);
        stlWriteAll_('stl_close', others.concat([{ month: month, at: nowText_(), admin: a.name }]));
        stlAdvMark_(month, res.summary.advAuto || [], true);
        stlLastCloseSet_(month);
        logAdmin_(a, '정산 마감', month, res.summary.drivers.length + '명');
        // 휴대폰 알림(앱 아이콘 숫자) — 기사 앱 사용 중인 기사 전원. 알림을 누르면 앱이 열리고 '정산서 마감' 안내 창이 뜸
        try {
          const mm = Number(month.slice(5, 7));
          pmPushSend_(readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.status === ST.ACTIVE; }).map(function (o) {
            return { driverId: String(o.id), title: mm + '월 정산서가 마감되었습니다', text: '정산서 보기에서 지급 금액과 내역을 확인해 주세요.', jobId: '', kind: 'slip' };
          }));
        } catch (e) { console.error('마감 알림 실패: ' + (e && e.message)); }
      } else {
        stlWriteAll_('stl_close', others);
        stlReplaceMonth_('stl_closed', month, []);
        stlAdvMark_(month, [], false);
        stlLastCloseSet_(null, others);
        logAdmin_(a, '정산 마감 해제', month, '');
      }
      stlBump_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 마감: 자동 상계한 가불금을 상환금에 더하고 메모에 [2026-10 정산 상계 300,000] 표시 / 마감 해제: 그 표시만큼 되돌림 */
function stlAdvMark_(month, list, close) {
  const tagRe = new RegExp('\\s*\\[' + month + ' 정산 상계 ([\\d,]+)\\]');
  if (close) {
    const rows = {};
    stlRead_('stl_advance').forEach(function (r) { rows[r._row] = r; });
    list.forEach(function (x) {
      const r = rows[x.row];
      if (!r || tagRe.test(r.memo)) return;
      stlSetRow_('stl_advance', x.row, { paid: String(stlNum_(r.paid) + x.amt), memo: (str_(r.memo) + ' [' + month + ' 정산 상계 ' + won_(x.amt) + ']').trim() });
    });
  } else {
    stlRead_('stl_advance').forEach(function (r) {
      const m = str_(r.memo).match(tagRe);
      if (!m) return;
      stlSetRow_('stl_advance', r._row, { paid: (function (v) { return v > 0 ? String(v) : ''; })(Math.max(0, stlNum_(r.paid) - stlNum_(m[1]))), memo: str_(r.memo).replace(tagRe, '').trim() });
    });
  }
}
/** 입금체크 · 입금일 · 메모 (마감 뒤에도 가능) */
function adm_stlPaySet(token, month, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month) || !Array.isArray(list) || !list.length || list.length > 500) fail_('입금 정보를 확인해 주세요.');
    const lock = scriptLock_();
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
    const D = stlDrivers_(), V = stlVendors_();
    const list = r.summary.drivers.filter(function (d) { return d.net !== 0; }).map(function (d) {
      const vv = d.vendor ? V.by[stlVendorKey_(d.vendor)] : null;
      const o = vv ? { bankName: vv.bank, accountHolder: vv.holder || vv.name, bizNo: vv.bizNo, bizName: vv.name } : (D.byId[d.ownerId] || {});
      let acc = '';
      try { acc = vv ? (vv.account ? fmtAccount_(vv.account, vv.bank) : '') : o.accountEnc ? fmtAccount_(decrypt_(o.accountEnc), o.bankName) : ''; } catch (e) { acc = ''; }
      return { id: d.id, cid: d.cid, cids: d.cids, workers: d.workers, name: d.name, bank: o.bankName || '', account: acc, holder: o.accountHolder || d.name, pay: d.invoice + d.depAdd, ded: d.san + d.goy + d.depDed, net: d.net, checked: d.checked, payDate: d.payDate, memo: d.payMemo, supply: d.supply, tax: d.tax, bizNo: o.bizNo || '', bizName: o.bizName || '' };
    });
    logAdmin_(a, '입금목록 조회 (계좌번호 표시)', month, list.length + '명');
    return { ok: true, month: month, list: list, dates: r.summary.dates };
  });
}
/**
 * 계좌번호를 은행 양식대로 하이픈으로 나눈다 (자리수가 양식과 맞을 때만, 아니면 숫자 그대로).
 * 대량이체 복사에는 숫자만 쓴다 (화면에서 하이픈을 뺌).
 */
const STL_ACC_FMT = [
  [/국민|kb/i, { 14: [6, 2, 6], 12: [3, 2, 4, 3] }],
  [/신한/, { 12: [3, 3, 6], 11: [3, 2, 6] }],
  [/우리/, { 13: [4, 3, 6], 14: [3, 6, 2, 3] }],
  [/하나|외환/, { 14: [3, 6, 5], 12: [3, 6, 3] }],
  [/농협|nh/i, { 13: [3, 4, 4, 2], 14: [6, 2, 6], 11: [3, 2, 6] }],
  [/기업|ibk/i, { 14: [3, 6, 2, 3], 12: [3, 6, 3] }],
  [/카카오/, { 13: [4, 2, 7] }],
  [/토스/, { 12: [4, 4, 4] }],
  [/케이뱅크|k뱅크/i, { 12: [3, 3, 6] }],
  [/sc|제일/i, { 11: [3, 2, 6] }],
  [/씨티|citi/i, { 12: [3, 6, 3], 10: [3, 5, 2] }],
  [/우체국/, { 14: [6, 2, 6] }],
  [/새마을/, { 13: [4, 2, 7], 14: [4, 3, 6, 1] }],
  [/신협/, { 13: [3, 3, 6, 1], 12: [3, 3, 6] }],
  [/수협/, { 12: [3, 2, 4, 3], 11: [3, 2, 6] }],
  [/산업|kdb/i, { 14: [3, 4, 4, 3] }],
  [/부산/, { 12: [3, 4, 4, 1], 13: [3, 4, 4, 2] }],
  [/대구|im뱅크/i, { 12: [3, 2, 6, 1], 14: [3, 2, 6, 3] }],
  [/경남/, { 13: [3, 2, 7, 1] }],
  [/광주/, { 12: [3, 3, 6], 13: [4, 3, 6] }],
  [/전북/, { 13: [3, 2, 7, 1] }],
  [/제주/, { 10: [2, 2, 6], 12: [3, 2, 7] }]
];
function fmtAccount_(d, bank) {
  const digits = String(d || '').replace(/\D/g, '');
  if (!digits) return String(d || '');
  const b = String(bank || '').replace(/\s+/g, '');
  for (let i = 0; i < STL_ACC_FMT.length; i++) {
    if (!STL_ACC_FMT[i][0].test(b)) continue;
    const g = STL_ACC_FMT[i][1][digits.length];
    if (!g) return digits;
    let at = 0;
    return g.map(function (n) { const part = digits.slice(at, at + n); at += n; return part; }).join('-');
  }
  return digits;
}

// ── 표 편집 (공제·가불·용차·설정 등) ──
// 열: [키, 제목, 종류, (찾은 ID 를 넣을 키)]
//  acct = 정산 묶음(명의자 또는 쿠팡ID) / acctOrText = 정산 묶음 또는 용차업체 이름 / person = 기사(사람)
const STL_EDIT = {
  ids: { sheet: 'stl_ids', scope: 'all', cols: [['owner', '명의자 (정산금 받는 기사)', 'person', 'ownerId'], ['vendor', '용차업체 (명의자 대신)', 'vendor'], ['cid', '쿠팡ID', 'cid'], ['role', '구분', STL_ROLES], ['main', '메인 아이디 (서브일 때)', 'text'],
    ['type', '단가코드', [''].concat(STL_TYPES)], ['mode', '정산 방식 (빈칸=단가코드별 노선 단가)', STL_MODES], ['insEx', '산재·고용 제외', ['', 'Y']], ['fbCut', '프레시백 차감 (13% 또는 금액)', 'text'], ['status', '상태', STL_ID_STATUS], ['memo', '메모', 'text']] },
  vendors: { sheet: 'stl_vendors', scope: 'all', cols: [['name', '업체명', 'text'], ['ids', '쿠팡 아이디 (쉼표로 여러 개)', 'text'], ['price', '지급 단가 (러너 → 업체 · VAT포함 · 비우면 외부용차단가)', 'money'], ['ins', '산재·고용 공제', ['Y', 'N']], ['bizNo', '사업자번호', 'text'], ['ceo', '대표자', 'text'], ['phone', '연락처', 'text'], ['addr', '사업장 주소', 'text'], ['bizType', '업태', 'text'], ['bizItem', '종목', 'text'],
    ['bank', '은행', 'text'], ['account', '계좌번호', 'text'], ['holder', '예금주', 'text'], ['email', '이메일 (계산서)', 'text'], ['status', '상태', STL_ID_STATUS], ['memo', '메모', 'text']] },
  usage: { sheet: 'stl_usage', scope: 'all', cols: [['cid', '쿠팡ID', 'cid'], ['name', '일한 기사', 'person', 'driverId'], ['from', '시작일', 'date'], ['to', '종료일 (비우면 계속)', 'date'], ['memo', '메모', 'text'], ['settle', '정산 (비우면 일한 기사 본인 정산 · 명의자 = 서브 인원)', ['', '명의자']]] },
  tmp: { sheet: 'stl_tmp', scope: 'all', cols: [['name', '기사', 'person', 'driverId'], ['from', '시작일', 'date'], ['to', '종료일', 'date'], ['price', '일시단가 (VAT포함)', 'money'], ['routes', '적용 노선 (비우면 전체)', 'text'], ['memo', '메모', 'text']] },
  adjust: { sheet: 'stl_adjust', scope: 'month', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['amt', '금액', 'money'], ['memo', '정산서 메모 (기사 정산서에 보임)', 'text'], ['note', '관리자 메모 (정산서에 안 보임)', 'text']] },
  advance: { sheet: 'stl_advance', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['date', '지급일', 'date'], ['amt', '가불금', 'money'], ['due', '상계 예정일', 'date'], ['paid', '상환금', 'money'], ['memo', '메모', 'text']] },
  yongcha: { sheet: 'stl_yongcha', scope: 'date', cols: [['date', '날짜', 'date'], ['who', '수행자 (정산 아이디/용차업체)', 'acctOrText', 'whoId'], ['route', '라우트 (비우면 그날 전체 · 119AB 처럼 여러 개)', 'text'], ['mode', '지급구분', ['건당', '금액']], ['price', '단가/금액 (비우면 기본: 품앗이단가 · 용차업체 외부용차단가)', 'money'], ['vendorPay', '업체 실지급액 (일당 등 · 용차업체만)', 'money'], ['qty', '건수 (비우면 자동)', 'money'], ['payer', '차액부담 (정산 아이디)', 'acct', 'payerId'], ['payerPrice', '부담 기준단가 (비우면: 품앗이 = 수행자 단가코드 · 용차업체·러너 몫 = 차액부담자 본인 단가)', 'money'], ['gain', '차액 처리 (비우면: 품앗이 = 수행자 지급 · 용차업체 = 러너 몫)', ['', '러너 몫', '수행자 지급']], ['memo', '메모', 'text']] },
  regular: { sheet: 'stl_regular', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['amt', '월 금액', 'money'], ['from', '시작월', 'month'], ['to', '종료월', 'month'], ['memo', '메모', 'text']] },
  target: { sheet: 'stl_target', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['item', '항목', 'item'], ['goal', '연 목표 계산서 (VAT포함)', 'money'], ['unit', '단위', 'money']] },
  split: { sheet: 'stl_split', scope: 'all', cols: [['from', '원 명의자 (발행 줄일 아이디)', 'acct', 'fromId'], ['to', '받는 명의자', 'acct', 'toId'], ['target', '목표 실수령', 'money'], ['unit', '단위', 'money'], ['repeat', '매달 반복', ['Y', 'N']], ['month', '적용월 (반복 N 일 때)', 'month']] },
  leave: { sheet: 'stl_leave', scope: 'all', cols: [['name', '명의자 (정산 아이디)', 'acct', 'acct'], ['month', '퇴사월', 'month'], ['amt', '보류금 (비우면 기본)', 'money'], ['memo', '정산서 메모 (비우면 기본 안내)', 'text']] },
  items: { sheet: 'stl_items', scope: 'all', cols: [['order', '순서', 'text'], ['side', '구분', ['지급', '차감']], ['name', '항목 이름', 'text'], ['method', '계산 방식', STL_METHODS], ['show', '표시', ['항상', '금액 있을 때']], ['taxCut', '계산서에서 빼기 (차감만)', ['', 'Y', 'N']], ['desc', '설명', 'text']] },
  // 캠프 및 기사별 산재·고용: when = 그 구분의 줄에만 쓰는 칸
  camps: { sheet: 'stl_camps', scope: 'all', cols: [['kind', '구분', ['캠프', '기사']], ['camp', '캠프', 'camp', '', '캠프'], ['name', '기사 (정산 아이디)', 'acct', 'acct', '기사'], ['basis', '보험 기준', ['', '공급가', '부가세포함']],
    ['expense', '경비공제율', 'text'], ['san', '산재율 (전체)', 'text'], ['goy', '고용율 (전체)', 'text'], ['runner', '러너 부담률', 'text'], ['sanOn', '산재', ['', 'OFF'], '', '기사'], ['goyOn', '고용', ['', 'OFF'], '', '기사'], ['memo', '메모', 'text']] },
  kinds: { sheet: 'stl_kinds', scope: 'all', cols: [['raw', '쿠팡 구분 값', 'text'], ['std', '표준 분류', STL_STD_KINDS]] },
  config: { sheet: 'stl_config', scope: 'all', fixed: true, cols: [['label', '항목', 'readonly'], ['value', '값', 'text'], ['desc', '설명', 'readonly']] },
  // 러너 손익·운영비
  cost: { sheet: 'stl_cost', scope: 'all', cols: [['cat', '분류', [''].concat(STL_COST_CATS)], ['name', '항목', 'text'], ['amt', '월 금액 (실제 나가는 돈 · VAT포함)', 'money'], ['proof', '증빙 (비우면 부가세 없음)', STL_PROOFS], ['bank', '결제 통장', 'text'], ['day', '결제일', 'text'], ['from', '시작월', 'month'], ['to', '종료월 (비우면 계속)', 'month'], ['memo', '메모', 'text']] },
  staff: { sheet: 'stl_staff', scope: 'all', cols: [['name', '이름', 'text'], ['pay', '월 급여 (세전)', 'money'], ['taxRate', '원천세율 (비우면 3.3%)', 'text'], ['day', '지급일', 'text'], ['bank', '은행', 'text'], ['account', '계좌번호', 'text'], ['from', '시작월', 'month'], ['to', '종료월 (비우면 계속)', 'month'], ['memo', '메모', 'text']] },
  banks: { sheet: 'stl_bank', scope: 'all', cols: [['name', '통장명', 'text'], ['role', '용도', [''].concat(STL_BANK_ROLES)], ['bankName', '은행', 'text'], ['account', '계좌번호', 'text'], ['opening', '기초잔액', 'money'], ['openDate', '기초일 (이 날 잔액)', 'date'], ['memo', '메모', 'text']] },
  alloc: { sheet: 'stl_alloc', scope: 'all', fixed: true, cols: [['label', '항목', 'readonly'], ['bank', '보낼 통장', 'bank'], ['rule', '금액 규칙 (비우면 자동)', 'text'], ['desc', '설명', 'readonly']] },
  banktx: { sheet: 'stl_banktx', scope: 'all', cols: [['date', '날짜', 'date'], ['kind', '구분', ['입금', '출금', '이체']], ['from', '출금 통장', 'bank'], ['to', '입금 통장', 'bank'], ['amt', '금액', 'money'], ['memo', '내용', 'text'], ['month', '정산월 (선택)', 'month']] },
  expense: { sheet: 'stl_expense', scope: 'month', cols: [['date', '날짜', 'date'], ['cat', '분류', [''].concat(STL_COST_CATS)], ['name', '내용', 'text'], ['vendor', '거래처', 'text'], ['amt', '금액 (VAT포함)', 'money'], ['proof', '증빙 (비우면 부가세 없음)', STL_PROOFS], ['bank', '통장', 'text'], ['memo', '메모', 'text']] }
};
/** 빈 칸에 흐리게 보여 줄 기본값 (예: 기본 34.6%) */
function stlColPh_(name, k) {
  if (name !== 'camps') return '';
  const cfg = stlCfg_(), pct = function (x) { return '기본 ' + (Math.round(x * 10000) / 100) + '%'; };
  if (k === 'basis') return '기본 (' + cfg.insBasis + ')';
  if (k === 'expense') return pct(cfg.expense);
  if (k === 'san') return pct(cfg.san);
  if (k === 'goy') return pct(cfg.goy);
  if (k === 'sanOn' || k === 'goyOn') return 'ON';
  return '';
}
function stlEditRows_(name, month) {
  const E = STL_EDIT[name];
  let rows = stlRead_(E.sheet);
  // 세부정산 설정: 지금 쓰는 항목만, 묶음 순서대로 (예전 항목 줄은 시트에 남아도 화면에 안 보임)
  if (name === 'config') {
    const ord = {};
    STL_CFG.forEach(function (d, i) { ord[d[1]] = i; });
    rows = rows.filter(function (r) { return r.label in ord; }).sort(function (a, b) { return ord[a.label] - ord[b.label]; });
  }
  if (name === 'alloc') {
    const ord = {};
    STL_FUND_ITEMS.forEach(function (f, i) { ord[f[1]] = i; });
    rows = rows.filter(function (r) { return r.label in ord; }).sort(function (a, b) { return ord[a.label] - ord[b.label]; });
  }
  // 캠프 및 기사별 산재·고용: 캠프 줄 먼저, 그다음 기사 줄 (각각 시트 순서)
  if (name === 'camps') rows = rows.map(function (r, i) { return { r: r, i: i, k: stlInsKind_(r) === '기사' ? 1 : 0 }; }).sort(function (a, b) { return a.k - b.k || a.i - b.i; }).map(function (x) { return x.r; });
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
    stlEnsureIdsV2_(); // 처음 한 번: 아이디 관리 → 기사 정보관리
    return stlTableView_(name, month);
  });
}
function stlTableView_(name, month) {
  {
    const E = STL_EDIT[name];
    if (!E) fail_('알 수 없는 표입니다.');
    if (E.scope !== 'all' && !stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    if (name === 'config') stlCfg_();
    if (name === 'alloc') stlAllocRows_();
    const D = stlDrivers_(), X = stlIds_(D);
    const rows = stlEditRows_(name, month);
    const accts = Object.keys(X.groups).map(function (k) { return { id: k, label: stlAcctLabel_(X, D, k), stopped: X.groups[k].main.stopped }; })
      .sort(function (a, b) { return (a.stopped ? 1 : 0) - (b.stopped ? 1 : 0) || koCmp_(a.label, b.label); });
    const persons = D.all.map(function (o) { return { id: o.id, label: (D.byName[o.name] || []).length > 1 ? o.name + ' (' + (o.loginId || o.id) + ')' : o.name, status: o.status }; })
      .sort(function (a, b) { return (a.status === ST.ACTIVE ? 0 : 1) - (b.status === ST.ACTIVE ? 0 : 1) || koCmp_(a.label, b.label); });
    let calc = null, calcSum = null;
    if (name === 'leave') {
      const cfg = stlCfg_();
      calc = {};
      rows.forEach(function (r) {
        const k = stlAcct_(X, D, r.name, r.acct), g = k ? X.groups[k] : null, m = str_(r.month).slice(0, 7);
        const back = stlMonthOk_(m) ? stlAddMonth_(m, 1) : '';
        calc[r._row] = { cidName: g ? String(g.cid).replace(/@.*$/, '') + ' (' + (g.ownerId && D.byId[g.ownerId] ? D.byId[g.ownerId].name : (g.vendor || '명의자 없음')) + ')' : '', back: back, pay: back ? stlDates_(back, cfg).pay : '', memo: stlMonthOk_(m) ? stlLeaveMemo_(m, cfg) : '' };
      });
    }
    if (name === 'camps' && stlMonthOk_(month)) {
      // 이번 정산월 차액: 기사 공제(산재+고용) − 기본값으로 계산했을 때. 기사 줄이 있으면 그 기사 줄에, 없으면 일한 캠프 비중대로 캠프 줄에
      calc = {}; calcSum = { n: 0, ded: 0, ded0: 0 };
      const campRow = {}, acctRow = {};
      rows.forEach(function (r) { if (stlInsKind_(r) === '기사') { const k = stlAcct_(X, D, r.name, r.acct); if (k) acctRow[k] = r._row; } else if (r.camp) campRow[stlShort_(r.camp)] = r._row; });
      const put = function (row, n, ded, ded0) { const o = calc[row] || (calc[row] = { n: 0, ded: 0, ded0: 0 }); o.n += n; o.ded += ded; o.ded0 += ded0; };
      let res = null;
      try { res = stlResult_(month, false); } catch (e) { res = null; }
      const slips = (res && res.slips) || {};
      Object.keys(slips).forEach(function (id) {
        const ins = slips[id] && slips[id].ins;
        if (!ins || ins.excluded || ins.san0 == null) return;
        const ded = (ins.sanD || 0) + (ins.goyD || 0), ded0 = (ins.san0 || 0) + (ins.goy0 || 0);
        calcSum.n++; calcSum.ded += ded; calcSum.ded0 += ded0;
        if (ins.drv && acctRow[id]) { put(acctRow[id], 1, ded, ded0); return; }
        Object.keys(ins.w || {}).forEach(function (c) { if (campRow[c] && ins.w[c] > 0) put(campRow[c], 1, ded * ins.w[c], ded0 * ins.w[c]); });
      });
      Object.keys(calc).forEach(function (k) { calc[k].ded = Math.round(calc[k].ded); calc[k].ded0 = Math.round(calc[k].ded0); calc[k].diff = calc[k].ded - calc[k].ded0; });
      calcSum.diff = calcSum.ded - calcSum.ded0;
      calcSum.closed = !!(res && res.summary && res.summary.closed) && !Object.keys(calc).length;
    }
    if (name === 'yongcha' || name === 'advance') {
      if (name === 'yongcha') { const r = stlResult_(month, false); calc = {}; (r.summary.yong || []).forEach(function (y) { calc[y._row] = y; }); }
      else {
        const cfg = stlCfg_(); calc = {};
        rows.forEach(function (r) { const am = r.due ? stlAdvMonth_(r.due, cfg) : ''; calc[r._row] = { left: stlNum_(r.amt) - stlNum_(r.paid), month: am, closed: am ? !!stlClosedInfo_(am) : false }; });
      }
    }
    return {
      ok: true, name: name, month: month, cols: E.cols.map(function (c) {
        if (c[2] === 'vendor') return { k: c[0], label: c[1], type: 'select', opts: [''].concat(X.vendors.list.map(function (v) { return v.name; })), idk: '' };
        if (c[2] === 'bank') return { k: c[0], label: c[1], type: 'select', opts: [''].concat(stlBanks_().map(function (b) { return b.name; })), idk: '' };
        return { k: c[0], label: c[1], type: Array.isArray(c[2]) ? 'select' : c[2], opts: Array.isArray(c[2]) ? c[2] : null, idk: c[3] || '', when: c[4] || '', ph: stlColPh_(name, c[0]) };
      }), calcSum: calcSum,
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
        if (name === 'config') { const d = STL_CFG.filter(function (x) { return x[1] === r.label; })[0]; o._group = d ? d[4] : ''; }
        if (name === 'camps') o.kind = stlInsKind_(r);
        return o;
      }),
      seen: stlRowsHash_(rows, E.cols), fixed: !!E.fixed, closed: E.scope !== 'all' ? !!stlClosedInfo_(month) : false,
      accts: accts, persons: persons, items: stlItems_().list.map(function (i) { return i.name; }),
      itemsInfo: stlItems_().list.map(function (i) { return { name: i.name, side: i.side, taxCut: i.taxCut, method: i.method }; }),
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
    if (name === 'ids' && stlIdsV2_()) fail_('아이디는 기사 정보관리(쿠팡 아이디 · 서브아이디)와 용차업체 메뉴에서 고칩니다.');
    if (E.scope !== 'all' && !stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    if (!Array.isArray(rows) || rows.length > 3000) fail_('줄이 너무 많습니다.');
    const D = stlDrivers_(), X = stlIds_(D);
    const seenCid = {};
    // 일시단가: 기사 칸에 '배만호,임동준,강준길' 처럼 쉼표로 여러 명 → 한 사람씩 같은 내용의 줄로 나눠 저장
    if (name === 'tmp') {
      rows = [].concat.apply([], rows.map(function (r) {
        const names = str_(r && r.name).split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (names.length < 2) return [r];
        return names.map(function (n) { return Object.assign({}, r, { name: n, driverId: '' }); });
      }));
      if (rows.length > 3000) fail_('줄이 너무 많습니다.');
    }
    let clean = rows.map(function (r, i) {
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
          // 아이디 관리의 명의자는 기사 정보에 없으면 저장한 뒤 기사로 자동 등록 (같은 이름이 여럿일 때만 막음)
          const many = (D.byName[v] || []).length > 1;
          if (v && !pid && (name !== 'ids' || many)) fail_((i + 1) + '번째 줄: 기사 "' + v + '"를 찾을 수 없습니다 (같은 이름이 여럿이면 "이름 (아이디)").');
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
    if (E.cols.some(function (c) { return c[2] === 'bank'; })) {
      const names = {};
      stlBanks_().forEach(function (b) { names[b.name] = 1; });
      clean.forEach(function (o, i) { E.cols.forEach(function (c) { if (c[2] === 'bank' && o[c[0]] && !names[o[c[0]]]) fail_((i + 1) + '번째 줄: 통장 "' + o[c[0]] + '" 이(가) 통장 목록에 없습니다.'); }); });
    }
    if (name === 'banks') {
      const seen = {};
      clean = clean.filter(function (o) { return o.name; });
      clean.forEach(function (o) { if (seen[o.name]) fail_('통장명 ' + o.name + ' 이(가) 두 번 있습니다.'); seen[o.name] = 1; });
      if (!clean.length) fail_('통장을 하나 이상 넣어 주세요.');
    }
    if (name === 'banktx') {
      clean.forEach(function (o, i) {
        const n = (i + 1) + '번째 줄: ';
        if (!o.date) fail_(n + '날짜를 넣어 주세요.');
        if (!(stlNum_(o.amt) > 0)) fail_(n + '금액을 넣어 주세요.');
        if (!o.kind) o.kind = o.from && o.to ? '이체' : o.from ? '출금' : '입금';
        if (o.kind === '입금') { if (!o.to) fail_(n + '입금은 입금 통장을 골라 주세요.'); o.from = ''; }
        if (o.kind === '출금') { if (!o.from) fail_(n + '출금은 출금 통장을 골라 주세요.'); o.to = ''; }
        if (o.kind === '이체' && (!o.from || !o.to || o.from === o.to)) fail_(n + '이체는 서로 다른 출금·입금 통장을 골라 주세요.');
      });
    }
    if (name === 'alloc') {
      clean.forEach(function (o) {
        const r = str_(o.rule).replace(/[\s,원]/g, '');
        if (r && !/^\d+(\.\d+)?%?$/.test(r)) fail_(o.label + ': 금액 규칙은 비우거나 3000000 · 20% 처럼 넣어 주세요.');
      });
    }
    if (name === 'yongcha') {
      clean.forEach(function (o, i) {
        if (!stlNum_(o.vendorPay)) return;
        const k = stlAcct_(X, D, o.who, o.whoId);
        if (!k || !X.groups[k].vendor) fail_((i + 1) + '번째 줄: 업체 실지급액은 수행자가 용차업체인 줄에만 넣을 수 있습니다.');
      });
    }
    if (name === 'camps') {
      const seenC = {}, seenA = {};
      clean = clean.filter(function (o) { return o.camp || o.name; });
      clean.forEach(function (o, i) {
        o.kind = o.kind || (o.name && !o.camp ? '기사' : '캠프');
        const who = o.kind === '기사' ? o.name : o.camp;
        if (o.kind === '기사') {
          if (!o.name) fail_((i + 1) + '번째 줄: 기사 줄은 기사(정산 아이디)를 넣어 주세요.');
          o.camp = '';
          const k = stlLogin_(o.acct || o.name);
          if (seenA[k]) fail_(o.name + ' 기사 줄이 두 번 있습니다.');
          seenA[k] = 1;
        } else {
          if (!o.camp) fail_((i + 1) + '번째 줄: 캠프 줄은 캠프를 골라 주세요.');
          o.name = ''; o.acct = ''; o.sanOn = ''; o.goyOn = '';
          const k = stlShort_(o.camp);
          if (seenC[k]) fail_(o.camp + ' 캠프 줄이 두 번 있습니다.');
          seenC[k] = 1;
        }
        ['expense', 'san', 'goy'].forEach(function (f) {
          const v = str_(o[f]).replace(/\s/g, '');
          if (!v) return;
          const n = /^\d+(\.\d+)?%?$/.test(v) ? stlRate_(v, NaN) : NaN;
          if (!isFinite(n) || n < 0 || n >= 1) fail_(who + ': ' + { expense: '경비공제율', san: '산재율', goy: '고용율' }[f] + ' 은(는) 20.5% 처럼 넣어 주세요.');
          o[f] = /%$/.test(v) ? v : (Math.round(n * 10000) / 100) + '%';
        });
      });
    }
    if (name === 'vendors') {
      const seenV = {};
      clean.forEach(function (o, i) {
        if (!o.name) fail_((i + 1) + '번째 줄: 업체명을 넣어 주세요.');
        const k = stlVendorKey_(o.name);
        if (seenV[k]) fail_('업체명 ' + o.name + ' 이(가) 두 번 있습니다.');
        seenV[k] = 1;
        if (!o.ins) o.ins = 'Y';
        if (!o.status) o.status = '사용';
        if (o.bizNo) { const d = o.bizNo.replace(/\D/g, ''); if (d.length !== 10) fail_(o.name + ': 사업자번호 10자리'); o.bizNo = d.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3'); }
      });
    }
    if (name === 'ids') {
      clean.forEach(function (o, i) {
        if (!o.cid) fail_((i + 1) + '번째 줄: 쿠팡ID 를 넣어 주세요.');
        if (o.role === '서브') {
          const m = stlLogin_(o.main), hit = clean.filter(function (x) { return stlLogin_(x.cid) === m; })[0];
          if (!m || !hit) fail_(o.cid + ': 서브는 메인 아이디 칸에 아이디 목록에 있는 메인 쿠팡ID 를 넣어 주세요.');
          if (hit.role === '서브') fail_(o.cid + ': 메인 아이디 ' + o.main + ' 도 서브입니다. 메인을 골라 주세요.');
        }
        if (o.fbCut && !/^\d+(\.\d+)?%?$/.test(o.fbCut.replace(/[,\s원]/g, ''))) fail_(o.cid + ': 프레시백 차감은 13% 또는 금액');
        if (o.vendor && o.owner) fail_(o.cid + ': 명의자와 용차업체 중 하나만 넣어 주세요 (용차업체 아이디면 명의자를 비움).');
        if (o.vendor) { o.ownerId = ''; if (!o.type) o.type = '외부용차'; }
        if (!o.status) o.status = '사용';
        if (o.status === '중지') o.status = '정지';
      });
    }
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      stlFreshIn_(E.sheet); // 잠금을 기다리는 사이 다른 관리자가 저장했으면 그 내용을 본다
      if (E.scope !== 'all') stlAssertOpen_(month);
      const cur = stlEditRows_(name, month);
      if (seen && seen !== stlRowsHash_(cur, E.cols)) fail_('다른 곳(시트 또는 다른 관리자)에서 먼저 고쳤습니다. 새로고침 후 다시 저장해 주세요.');
      let out;
      if (E.fixed) {
        // 설정: 값만 바꾼다
        const by = {}, ed = E.cols.filter(function (c) { return c[2] !== 'readonly' && c[0] !== 'label'; }).map(function (c) { return c[0]; });
        clean.forEach(function (o) { by[o.label] = o; });
        out = stlRead_(E.sheet).map(function (r) { const o = Object.assign({}, r); if (o.label in by) ed.forEach(function (k) { o[k] = by[o.label][k]; }); return o; });
      } else {
        const all = stlRead_(E.sheet);
        const keep = E.scope === 'all' ? [] : all.filter(function (r) { return E.scope === 'month' ? r.month !== month : stlMonthOfDate_(r.date) !== month; });
        out = keep.concat(clean);
      }
      if (name === 'vendors' && stlIdsV2_()) { // 업체 아이디가 기사 아이디와 겹치면 막는다
        const Dv = stlDrivers_(), seenV = {};
        clean.forEach(function (o) {
          str_(o.ids).split(/[,\s]+/).filter(Boolean).forEach(function (c) {
            const h = stlDriverOfCid_(Dv, c), k = stlLogin_(c);
            if (h) fail_(c + ' 는 ' + h.drv.name + ' 기사님 아이디입니다 (' + o.name + '). 기사 정보관리에서 먼저 빼 주세요.');
            if (seenV[k]) fail_(c + ' 가 ' + seenV[k] + ' 와 ' + o.name + ' 에 같이 있습니다.');
            seenV[k] = o.name;
          });
        });
      }
      stlWriteAll_(E.sheet, out);
      if (name === 'ids') stlAddVendors_(clean.map(function (o) { return o.vendor; }));
      if (!STL_NO_RECALC[E.sheet]) stlBump_();
      logAdmin_(a, '정산 표 저장', name + (E.scope !== 'all' ? ' ' + month : ''), clean.length + '줄');
    } finally {
      lock.releaseLock();
    }
    // 아이디 관리 → 기사 정보관리 연동 (없는 명의자는 기사로 등록, 메인 아이디는 쿠팡플렉스 아이디·단가코드 맞춤)
    let sync = null;
    if (name === 'ids') { try { sync = stlIdsToDrivers_(token); } catch (e) { console.error('기사 정보 연동 실패: ' + (e && e.message)); } }
    // 저장 직후 화면에 쓸 표 (다시 부르지 않아도 되게)
    let table = null;
    try { table = stlTableView_(name, month); } catch (e) { table = null; }
    return { ok: true, rows: clean.length, table: table, sync: sync };
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const D = stlDrivers_();
      let n = 0;
      changes.forEach(function (ch) {
        const o = D.byId[str_(ch.id)];
        if (!o) fail_('기사를 찾을 수 없습니다. 새로고침해 주세요.');
        const f = {};
        Object.keys(ch.f || {}).forEach(function (k) {
          if (STL_DRIVER_EDIT.indexOf(k) < 0) return; // 사업자 정보는 기사 정보관리에서만 고침
          let v = str_(ch.f[k]).slice(0, 200);
          if (k === 'stlMode') { if (STL_MODES.indexOf(v) < 0) fail_(o.name + ': 정산 방식은 기본 / 원청단가 / 용차내역'); }
          if (k === 'insEx') v = /^(y|yes|o|예|제외|true|1)$/i.test(v) ? 'Y' : '';
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
    const ci = stlClosedInfo_(month);
    return { ok: true, month: month, latest: r.latest, closed: !!ci, legacy: stlLegacyClosed_(month), period: stlPeriod_(month) };
  });
}

/** (내부) 실행마다 새로 시작하는 메모리 상태를 비운다 — 다음 실행과 같은 상태로 시험할 때 */
function stlNewExec_() {
  _stlSS = null; _stlTv = null; _stlFresh = false;
  [_stlSh, _stlCols, _stlTab, _stlMon].forEach(function (o) { Object.keys(o).forEach(function (k) { delete o[k]; }); });
}

/**
 * 기사 정보관리에서 단가코드을 바꾸면 그 기사 본인 아이디(쿠팡플렉스 아이디 = 메인)의 단가코드도 같이 바꾼다.
 * 아이디의 단가코드이 예전 단가코드과 같았거나 비어 있을 때만 (따로 정해 둔 값은 그대로).
 */
function stlSyncIdType_(driverId, loginId, oldType, newType) {
  if (stlIdsV2_()) { try { stlBump_(); } catch (e) { /* 무시 */ } return 0; }
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
  } catch (e) { console.error('아이디 단가코드 맞추기 실패: ' + (e && e.message)); return 0; }
}

// ───────────────────────── 아이디 관리 ↔ 기사 정보관리 연동 ─────────────────────────
/**
 * 기사 정보관리 → 아이디 관리: 기사의 쿠팡플렉스 아이디가 아이디 관리에 없으면 메인 아이디로 추가.
 * 있으면 명의자가 비었을 때 채우고, 이 기사가 명의자인 줄의 명의자 이름을 기사 정보의 이름에 맞춘다.
 */
function stlEnsureIdFor_(o) {
  try {
    if (!o || !o.id || !props_().STL_DB_ID) return;
    if (stlIdsV2_()) { stlBump_(); return; } // 기사 정보가 기준: 따로 맞출 것 없음
    const rows = stlRead_('stl_ids');
    const k = o.loginId ? stlLogin_(o.loginId) : '';
    let hit = null;
    rows.forEach(function (r) {
      if (k && stlLogin_(r.cid) === k) hit = r;
      if (r.ownerId === o.id && o.name && r.owner !== o.name) stlSetRow_('stl_ids', r._row, { owner: o.name });
    });
    if (!k) return;
    if (hit) {
      if (!hit.ownerId && !hit.vendor && (!hit.owner || stlPerson_(stlDrivers_(), hit.owner, '') === o.id || hit.owner === o.name)) stlSetRow_('stl_ids', hit._row, { owner: o.name, ownerId: o.id });
      return;
    }
    stlAppend_('stl_ids', [{
      cid: o.loginId, role: '메인', main: '', owner: o.name, ownerId: o.id, type: STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '',
      mode: '', insEx: '', fbCut: '', status: o.status === ST.STOPPED ? '정지' : '사용', memo: '기사 정보관리에서 자동 추가'
    }]);
    stlBump_();
  } catch (e) { console.error('아이디 관리 연동 실패: ' + (e && e.message)); }
}
/**
 * 아이디 관리 → 기사 정보관리: 저장한 뒤 한 번.
 *  - 명의자가 기사 정보에 없으면 기사로 등록 (이름·쿠팡플렉스 아이디(메인일 때)·단가코드·상태)
 *  - 명의자가 있고 메인 아이디인데 기사의 쿠팡플렉스 아이디가 비어 있으면 채운다
 *  - 메인 아이디의 단가코드을 바꾸면 그 기사의 단가코드도 바꾼다 (본인 쿠팡플렉스 아이디인 줄만)
 */
function stlIdsToDrivers_(token) {
  const out = { created: [], updated: [] };
  let D = stlDrivers_();
  const usedLogin = {};
  D.all.forEach(function (d) { if (d.loginId) usedLogin[stlLogin_(d.loginId)] = d.id; });

  stlRead_('stl_ids').forEach(function (r) {
    const owner = str_(r.owner), k = stlLogin_(r.cid), main = r.role !== '서브';
    if (!owner || !k || str_(r.vendor)) return;
    const pid = stlPerson_(D, owner, r.ownerId);
    const type = STL_TYPES.indexOf(r.type) >= 0 ? r.type : '';
    if (!pid) {
      const f = { name: owner, driverType: type || '고정', status: (r.status === '정지' || r.status === '중지') ? ST.STOPPED : ST.ACTIVE, memo: '정산관리 아이디 관리에서 자동 등록' };
      if (main && !usedLogin[k]) f.loginId = String(r.cid).replace(/@.*$/, '');
      let res = adm_createDriver(token, f);
      if (!res.ok && f.loginId) { delete f.loginId; res = adm_createDriver(token, f); }
      if (res.ok) {
        out.created.push(owner);
        if (f.loginId) usedLogin[k] = res.driver.id;
        if (r.ownerId !== res.driver.id) stlSetRow_('stl_ids', r._row, { ownerId: res.driver.id });
        D = stlDrivers_();
      }
      return;
    }
    const d = D.byId[pid], upd = {};
    if (main && !d.loginId && !usedLogin[k]) { upd.loginId = String(r.cid).replace(/@.*$/, ''); usedLogin[k] = pid; }
    const own = (upd.loginId || d.loginId) && stlLogin_(upd.loginId || d.loginId) === k;
    if (main && own && type && d.driverType !== type) upd.driverType = type;
    if (r.ownerId !== pid) stlSetRow_('stl_ids', r._row, { ownerId: pid });
    if (Object.keys(upd).length) {
      upd.updatedAt = nowText_();
      writeFields_(SH.DRIVERS, d._row, upd);
      forgetDriver_(d);
      out.updated.push(d.name + ' (' + Object.keys(upd).filter(function (x) { return x !== 'updatedAt'; }).map(function (x) { return x === 'loginId' ? '쿠팡플렉스 아이디' : '단가코드'; }).join('·') + ')');
    }
  });
  return out;
}

// ───────────────────────── 용차업체 아이디 ─────────────────────────
/** 용차업체 목록에 없는 업체명이면 줄 추가 (건당 단가는 비워 둠 → 관리자가 채움) */
function stlAddVendors_(names) {
  const have = {}, add = [];
  stlRead_('stl_vendors').forEach(function (r) { if (r.name) have[stlVendorKey_(r.name)] = 1; });
  (names || []).forEach(function (n) {
    n = str_(n);
    if (!n || have[stlVendorKey_(n)]) return;
    have[stlVendorKey_(n)] = 1;
    add.push({ name: n, price: '', ins: 'Y', status: '사용', memo: '아이디 관리에서 자동 추가 (건당 단가를 넣어 주세요)' });
  });
  if (add.length) stlAppend_('stl_vendors', add);
  return add.length;
}
/**
 * 경고창에서 한 번에: 쿠팡ID 들을 용차업체 아이디로 지정 (없는 아이디는 추가, 있으면 명의자를 비우고 업체로).
 * 업체가 목록에 없으면 같이 추가. 기사정보에는 등록하지 않는다.
 */
function adm_stlSetVendor(token, cids, vendor) {
  return run_(function () {
    const a = requireAdmin_(token);
    stlEnsureIdsV2_(); // 처음 한 번: 아이디 관리 → 기사 정보관리
    vendor = str_(vendor).slice(0, 60);
    if (!vendor) fail_('업체명을 넣어 주세요.');
    if (!Array.isArray(cids) || !cids.length || cids.length > 200) fail_('아이디를 골라 주세요.');
    const lock = scriptLock_();
    lock.waitLock(30000);
    let n = 0, added = 0, vAdd = 0;
    try {
      if (stlIdsV2_()) {
        const D = stlDrivers_();
        cids = cids.map(function (c) { return str_(c).replace(/\s+/g, ''); }).filter(Boolean);
        cids.forEach(function (c) { const h = stlDriverOfCid_(D, c); if (h) fail_(c + ' 는 ' + h.drv.name + ' 기사님의 ' + (h.slot === 'main' ? '쿠팡 아이디' : '서브아이디') + '입니다. 기사 정보관리에서 먼저 빼 주세요.'); });
        vAdd = stlAddVendors_([vendor]);
        const V = stlVendors_(), v = V.by[stlVendorKey_(vendor)];
        V.list.forEach(function (x) { if (x !== v && x.ids.some(function (y) { return cids.some(function (c) { return stlLogin_(c) === stlLogin_(y); }); })) stlSetRow_('stl_vendors', x._row, { ids: x.ids.filter(function (y) { return !cids.some(function (c) { return stlLogin_(c) === stlLogin_(y); }); }).join(', ') }); });
        const ids = v.ids.slice();
        cids.forEach(function (c) { if (!ids.some(function (y) { return stlLogin_(y) === stlLogin_(c); })) { ids.push(c); added++; } else n++; });
        stlSetRow_('stl_vendors', v._row, { ids: ids.join(', ') });
        stlBump_();
        logAdmin_(a, '용차업체 아이디 지정', vendor, cids.join(', '));
        return { ok: true, changed: n, added: added, vendorAdded: vAdd };
      }
      const rows = stlRead_('stl_ids'), by = {};
      rows.forEach(function (r) { by[stlLogin_(r.cid)] = r; });
      const app = [];
      cids.forEach(function (c) {
        c = str_(c).replace(/\s+/g, '');
        const k = stlLogin_(c);
        if (!k) return;
        const r = by[k];
        if (r) { stlSetRow_('stl_ids', r._row, { vendor: vendor, owner: '', ownerId: '', role: '메인', main: '', type: '외부용차' }); n++; }
        else { app.push({ cid: c, role: '메인', main: '', owner: '', ownerId: '', type: '외부용차', mode: '', insEx: '', fbCut: '', status: '사용', memo: '용차업체 아이디 (경고창에서 지정)', vendor: vendor }); by[k] = 1; added++; }
      });
      if (app.length) stlAppend_('stl_ids', app);
      vAdd = stlAddVendors_([vendor]);
      stlBump_();
      logAdmin_(a, '용차업체 아이디 지정', vendor, (n + added) + '개');
    } finally {
      lock.releaseLock();
    }
    return { ok: true, changed: n, added: added, vendorAdded: vAdd };
  });
}

/**
 * 정산서 탭 확인 필요 → 클릭 처리
 *  act = 'leave'  : 정지된 아이디 → 퇴사 처리 (퇴사자 보류금 설정에 명의자 · 퇴사월 = 이 정산월, opt.amt 비우면 기본 금액)
 *        'unstop' : 정지된 아이디 → 정지 풀기 (아이디 관리 상태 '사용')
 *        'sub'    : 아이디 사용 기록의 기사 → 서브 인원 (그 기록의 '정산' 칸 = 명의자, 매출은 명의자 정산 그대로)
 *        'ownId'  : 아이디 사용 기록의 기사 → 본인 정산 아이디 만들기 (opt.cid = 그 기사 쿠팡 ID, 비우면 기사 정보의 쿠팡플렉스 아이디)
 *        'ack'    : 확인함 (이 정산월만 그 경고 줄 숨김)
 *  list = 경고의 acts 항목들 [{ kind, key, cid, worker, … }]
 */
function adm_stlWarnAct(token, month, act, list, opt) {
  return run_(function () {
    const a = requireAdmin_(token);
    stlEnsureIdsV2_(); // 처음 한 번: 아이디 관리 → 기사 정보관리
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    if (['leave', 'unstop', 'stop', 'sub', 'ownId', 'ack', 'link', 'manualOn', 'manualOff', 'promoDrv', 'promoRun'].indexOf(act) < 0) fail_('알 수 없는 처리입니다.');
    if (!Array.isArray(list) || !list.length || list.length > (/^manual/.test(act) ? 1000 : 100)) fail_('대상을 골라 주세요.');
    opt = opt || {};
    const D = stlDrivers_(), X = stlIds_(D);
    const lock = scriptLock_();
    lock.waitLock(30000);
    const done = [];
    try {
      stlAssertOpen_(month);
      if (act === 'leave') {
        const amt = str_(opt.amt) ? stlNum_(opt.amt) : 0;
        if (str_(opt.amt) && !(amt > 0)) fail_('보류금은 숫자로 넣어 주세요.');
        const rows = stlRead_('stl_leave');
        list.forEach(function (x) {
          const b = X.by[stlLogin_(x.cid)], gk = b ? b.mainKey : '', g = X.groups[gk];
          if (!g) return;
          const nm = g.ownerId && D.byId[g.ownerId] ? D.byId[g.ownerId].name : String(g.cid).replace(/@.*$/, '');
          const hit = rows.filter(function (r) { return stlAcct_(X, D, r.name, r.acct) === gk; })[0];
          if (hit) stlSetRow_('stl_leave', hit._row, { month: month, amt: amt ? String(amt) : hit.amt });
          else stlAppend_('stl_leave', [{ name: nm, acct: String(g.cid).replace(/@.*$/, ''), month: month, amt: amt ? String(amt) : '', memo: '' }]);
          done.push(nm);
        });
        if (opt.stop && stlIdsV2_()) { // 퇴사 처리: 기사 근무상태 = 퇴사 (퇴사일 = 마지막 배송일, 없으면 정산기간 끝)
          const P = stlPeriod_(month);
          list.forEach(function (x) { const h = stlDriverOfCid_(D, x.cid); if (h && h.slot === 'main') stlSetDrv_(a, h.drv, { workStatus: '퇴사', leaveDate: str_(x.last) || P.to }); });
        } else if (opt.stop) { // 퇴사 처리하면서 아이디도 정지
          const ids = stlRead_('stl_ids');
          list.forEach(function (x) { const r = ids.filter(function (r) { return stlLogin_(r.cid) === stlLogin_(x.cid); })[0]; if (r && r.status !== '정지') stlSetRow_('stl_ids', r._row, { status: '정지' }); });
        }
      } else if ((act === 'stop' || act === 'unstop') && stlIdsV2_()) { // 정지 = 기사 근무상태 휴직 · 정지 풀기 = 재직
        list.forEach(function (x) {
          const h = stlDriverOfCid_(D, x.cid); if (!h || h.slot !== 'main') return;
          if (act === 'stop' && !h.drv.workStatus) { stlSetDrv_(a, h.drv, { workStatus: '휴직' }); done.push(h.drv.name); }
          if (act === 'unstop' && h.drv.workStatus) { stlSetDrv_(a, h.drv, { workStatus: '', leaveDate: '' }); done.push(h.drv.name); }
        });
      } else if (act === 'stop') {
        const rows = stlRead_('stl_ids');
        list.forEach(function (x) {
          const r = rows.filter(function (r) { return stlLogin_(r.cid) === stlLogin_(x.cid); })[0];
          if (r && r.status !== '정지') { stlSetRow_('stl_ids', r._row, { status: '정지' }); done.push(String(r.cid).replace(/@.*$/, '')); }
        });
      } else if (act === 'unstop') {
        const rows = stlRead_('stl_ids');
        list.forEach(function (x) {
          const r = rows.filter(function (r) { return stlLogin_(r.cid) === stlLogin_(x.cid); })[0];
          if (r && r.status !== '사용') { stlSetRow_('stl_ids', r._row, { status: '사용' }); done.push(String(r.cid).replace(/@.*$/, '')); }
        });
      } else if (act === 'sub') {
        const P = stlPeriod_(month), rows = stlRead_('stl_usage');
        list.forEach(function (x) {
          rows.forEach(function (r) {
            if (stlLogin_(r.cid) !== stlLogin_(x.cid) || stlPerson_(D, r.name, r.driverId) !== x.worker) return;
            if ((r.to && stlYmd_(r.to) < P.from) || (r.from && stlYmd_(r.from) > P.to)) return; // 이 정산기간과 겹치는 기록만
            if (str_(r.settle) !== '명의자') { stlSetRow_('stl_usage', r._row, { settle: '명의자' }); done.push(r.name + ' · ' + String(r.cid).replace(/@.*$/, '')); }
          });
        });
      } else if (act === 'link') { // 등록 안 된 쿠팡 아이디 → 기사에 연결 (쿠팡 아이디가 없으면 메인, 있으면 서브)
        const o = D.byId[stlPerson_(D, opt.name, opt.driverId)];
        if (!o) fail_('기사 정보관리에서 "' + str_(opt.name) + '" 기사를 찾을 수 없습니다.');
        list.forEach(function (x) { (x.cids || [x.cid]).forEach(function (c) { stlLinkCid_(a, D, o, c); done.push(o.name + ' ← ' + c); }); });
      } else if (act === 'ownId') {
        if (list.length !== 1) fail_('본인 정산 아이디는 한 명씩 만들어 주세요.');
        const o = D.byId[list[0].worker];
        if (!o) fail_('기사 정보에서 그 기사를 찾을 수 없습니다.');
        const cid = str_(opt.cid || o.loginId).replace(/\s+/g, '').replace(/@.*$/, '');
        if (!cid) fail_(o.name + ' 기사님의 쿠팡 ID 를 넣어 주세요.');
        if (stlIdsV2_()) { stlLinkCid_(a, D, o, cid); done.push(o.name + ' · ' + cid); stlBump_(); return { ok: true, done: done }; }
        const rows = stlRead_('stl_ids'), hit = rows.filter(function (r) { return stlLogin_(r.cid) === stlLogin_(cid); })[0];
        if (hit) {
          const pid = hit.ownerId || stlPerson_(D, hit.owner, '');
          if (hit.role === '서브' || hit.vendor || (pid && pid !== o.id)) fail_('아이디 관리에 ' + cid + ' 가 이미 ' + (hit.vendor ? '용차업체 ' + hit.vendor : (hit.owner || '다른 명의자')) + (hit.role === '서브' ? '의 서브 아이디' : '') + '로 있습니다. 아이디 관리에서 확인해 주세요.');
          stlSetRow_('stl_ids', hit._row, { owner: o.name, ownerId: o.id, status: '사용' });
        } else {
          stlAppend_('stl_ids', [{ cid: cid, role: '메인', main: '', owner: o.name, ownerId: o.id, type: STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '', mode: '', insEx: '', fbCut: '', status: '사용', memo: '아이디 사용 기록에서 본인 정산 아이디 만들기' }]);
        }
        done.push(o.name + ' · ' + cid);
      } else if (act === 'promoDrv' || act === 'promoRun') { // 일반 프로모션 줄: 기사 지급 / 러너 수익 (마지막 기록이 이김)
        stlAppend_('stl_ack', list.filter(function (x) { return str_(x.key); }).map(function (x) { return { month: month, kind: 'promo', key: str_(x.key), memo: act === 'promoDrv' ? '기사' : '러너', at: nowText_(), admin: a.name || a.loginId || '' }; }));
        list.forEach(function (x) { done.push(str_(x.label).split(' · ').slice(1, 3).join(' ')); });
      } else if (act === 'manualOn' || act === 'manualOff') { // 쿠팡 수기반영 줄: 반영 / 미반영 (마지막 기록이 이김)
        stlAppend_('stl_ack', list.map(function (x) { return { month: month, kind: 'manual', key: str_(x.key), memo: act === 'manualOn' ? '반영' : '미반영', at: nowText_(), admin: a.name || a.loginId || '' }; }));
        list.forEach(function (x) { done.push(str_(x.label).split(' · ').slice(0, 2).join(' ')); });
      } else {
        stlAppend_('stl_ack', list.map(function (x) { return { month: month, kind: str_(x.kind), key: str_(x.key), memo: str_(x.label).slice(0, 200), at: nowText_(), admin: a.name || a.loginId || '' }; }));
        list.forEach(function (x) { done.push(str_(x.label)); });
      }
      stlBump_();
      logAdmin_(a, '정산 확인 필요 처리', month + ' ' + act, done.join(', ').slice(0, 300));
    } finally {
      lock.releaseLock();
    }
    return { ok: true, done: done };
  });
}

// ───────────────────────── 기사 앱: 내 정산서 ─────────────────────────
/** 기사 본인이 명의자인 정산 묶음(메인 아이디키) 목록 */
function stlMyGroups_(driverId, X) {
  X = X || stlIds_(stlDrivers_());
  return Object.keys(X.groups).filter(function (k) { return X.groups[k].ownerId === driverId; });
}
/** 기사 앱: 볼 수 있는 정산월 목록 (마감한 달, 설정에 따라 계산 중인 달도) */
/** 기사 앱 공개 월 설정(공개 시작 월 · 숨길 달)에 맞는 달인지 */
function stlAppMonthOk_(cfg, month) {
  if (cfg.appFrom && month < cfg.appFrom) return false;
  if ((cfg.appHide || []).indexOf(month) >= 0) return false;
  return true;
}
function api_mySettle(token) {
  return run_(function () {
    const u = pmUser_(token);
    if (!props_().STL_DB_ID) return { ok: true, months: [] };
    stlLoad_(STL_SMALL);
    const cfg = stlCfg_(), groups = stlMyGroups_(u.id);
    if (!groups.length) return { ok: true, months: [], noId: true };
    const closed = {};
    stlRead_('stl_close').forEach(function (x) { if (stlMonthOk_(x.month)) closed[x.month] = 1; });
    const months = stlMonths_().withData.filter(function (m) { return (closed[m] || cfg.appOpen) && stlAppMonthOk_(cfg, m); }).sort().reverse()
      .map(function (m) { return { month: m, closed: !!closed[m] }; });
    return { ok: true, months: months };
  });
}
/** 기사 앱: 그 달 내 정산서 (명의자인 묶음 모두). 러너 내부 숫자(회사이익·러너 부담 등)는 빼고 보낸다 */
function api_mySlip(token, month) {
  return run_(function () {
    const u = pmUser_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const cfg = stlCfg_(), closed = stlClosedInfo_(month);
    if (!closed && !cfg.appOpen) fail_('아직 마감되지 않은 달입니다. 사무실에서 마감하면 볼 수 있습니다.');
    if (!stlAppMonthOk_(cfg, month)) fail_('이 달 정산서는 기사 앱에서 보여 주지 않습니다.');
    const r = stlResult_(month, false), XD = stlIds_(stlDrivers_()), groups = stlMyGroups_(u.id, XD); // 기사·아이디 표는 한 번만 읽음
    let co = {};
    try { co = companyInfo_(); } catch (e) { /* 회사 정보 없음 */ }
    // 내 묶음 키로 찾고, 없으면 내 아이디가 들어 있는 정산서 (기존 정산 이식 달은 정산서 키가 그때 아이디라 다를 수 있음)
    const X = XD, mine = {}, seen = {};
    groups.forEach(function (g) { ((X.groups[g] || {}).cids || []).forEach(function (c) { mine[stlLogin_(c)] = 1; }); });
    const found = groups.map(function (g) { return r.slips[g]; }).filter(Boolean);
    found.forEach(function (sl) { seen[sl.row.id] = 1; });
    Object.keys(r.slips).forEach(function (k) {
      const sl = r.slips[k], row = sl && sl.row;
      if (!row || seen[row.id] || row.legacyNote || row.vendor || !(r.summary && r.summary.legacy)) return; // 기존 정산 이식 달만 (아이디가 다른 사람에게 넘어간 보통 달의 정산서가 보이지 않게)
      if (row.ownerId ? row.ownerId === u.id : (row.cids || []).some(function (c) { return mine[stlLogin_(c)]; })) { found.push(sl); seen[row.id] = 1; } // 명의자가 있으면 명의자만
    });
    const slips = found.filter(function (sl) { return !sl.row.legacyNote; }).map(function (sl) {
      const d = sl.row.ceo ? Object.assign({}, sl.row, sl.row.ceoView) : sl.row;
      stlLiveBizName_(d);
      return {
        row: {
          name: d.name, cids: d.cids, workDays: d.workDays, workDaysSrc: d.workDaysSrc, qty: d.qty, pay: d.pay, taxDed: d.taxDed, invoice: d.invoice, supply: d.supply, tax: d.tax,
          san: d.san, goy: d.goy, depDed: d.depDed, depAdd: d.depAdd, net: d.net, bank: d.bank, holder: d.holder, account: d.account, bizNo: d.bizNo, bizName: d.bizName || '', ownerId: d.ownerId || '', movedIn: d.movedIn, movedOut: d.movedOut
        },
        lines: sl.lines, routes: sl.routes, daily: sl.daily, sched: sl.sched, idUse: sl.idUse || {}, loss: sl.loss,
        yong: (sl.yong || []).map(function (y) { return { date: y.date, route: y.route, camp: y.camp, qty: y.qty, extra: y.extra, cut: y.cut, mine: y.whoId === d.id, ours: !!y.whoId && String(y.whoId).indexOf('v:') !== 0, memo: y.memo }; }),
        movedIn: sl.movedIn, movedOut: sl.movedOut, ins: sl.ins ? { excluded: sl.ins.excluded, bosu: sl.ins.bosu } : null
      };
    });
    if (!slips.length) fail_('이 달 정산 기록이 없습니다.');
    let taxInv = [];
    try { taxInv = tiForDriver_(u.id, month); } catch (e) { taxInv = []; }
    return {
      ok: true, month: month, closed: !!closed, period: r.summary.period, dates: r.summary.dates, slips: slips, taxInv: taxInv,
      company: { name: co.branchName || '', ceo: co.branchCeo || '', bizNo: co.branchBizNo || '', email: cfg.email }
    };
  });
}

// ───────────────────────── 노선관리: 라우트별 1일 평균 물량 (쿠팡 정산서 기준) ─────────────────────────
/**
 * 최근 정산월 2개(쿠팡 정산서가 올라온 달)의 배송 줄로 캠프·라우트(예: 527B)별 1일 평균 물량.
 * 반환 { months: ['2026-10', …], vol: { '강서1|527B': { avg, days, qty } } } — 30분 캐시 (정산 DB 가 바뀌면 새로)
 */
function adm_routeVolumes(token) {
  return run_(function () {
    requireAdmin_(token);
    return routeVolumes_();
  });
}
/** (내부) 라우트별 1일 평균 물량 — 관리자 노선관리 · 기사 앱 가중요인 예상 공용 */
function routeVolumes_() {
  {
    if (!props_().STL_DB_ID) return { ok: true, months: [], vol: {} };
    const key = 'stl:vol:' + stlVer_();
    const hit = stlCacheGet_(key);
    if (hit) return hit;
    stlLoad_(STL_SMALL);
    const kinds = stlKinds_();
    const months = stlMonths_().withData.slice(-2);
    const acc = {};
    months.forEach(function (m) {
      stlReadMonth_('stl_raw', m).forEach(function (r) {
        const kind = kinds[r.kind] || '';
        if (kind !== '배송' || !r.route) return;
        const qty = stlNum_(r.qty) + stlNum_(r.ret);
        if (!qty) return;
        const k = stlShort_(r.camp) + '|' + normCode_(r.route);
        const a = acc[k] || (acc[k] = { qty: 0, dates: {}, m: {} });
        a.qty += qty; a.dates[stlYmd_(r.date)] = 1; a.m[m] = (a.m[m] || 0) + qty;
      });
    });
    const vol = {};
    Object.keys(acc).forEach(function (k) { const d = Object.keys(acc[k].dates).length; vol[k] = { avg: d ? Math.round(acc[k].qty / d) : 0, days: d, qty: acc[k].qty, m: acc[k].m }; }); // m = 정산월별 배송수량 (가중요인 예상 = 전월 수량 기준)
    const out = { ok: true, months: months, vol: vol };
    stlCachePut_(key, out, 1800);
    return out;
  }
}


// ───────────────────────── 기사별 프레시백 설정 ─────────────────────────
/** 처음 한 번: 기사 정보의 '프레시백 차감' → stl_fbcut 표로 옮기고 기사 정보 칸은 비운다 */
function stlFbMigrate_(a) {
  const D = stlDrivers_(), X = stlIds_(D);
  const has = D.all.filter(function (o) { return str_(o.fbCut); });
  if (!has.length) return 0;
  const cur = stlRead_('stl_fbcut'), seen = {};
  cur.forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (id) seen[id] = 1; });
  const add = [];
  has.forEach(function (o) {
    const b = o.loginId ? X.by[stlLogin_(o.loginId)] : null, id = b ? b.mainKey : '';
    if (id && !seen[id]) { add.push({ name: stlAcctLabel_(X, D, id), acct: String(X.groups[id].cid).replace(/@.*$/, ''), cut: str_(o.fbCut), memo: '기사 정보에서 옮김' }); seen[id] = 1; }
  });
  const lock = scriptLock_();
  lock.waitLock(30000);
  try { stlAppend_('stl_fbcut', add); } finally { lock.releaseLock(); }
  has.forEach(function (o) { try { stlSetDrv_(a, o, { fbCut: '' }); } catch (e) { /* 그 기사만 건너뜀 */ } });
  stlBump_();
  return add.length;
}
/** 관리자: 기사별 프레시백 (쿠팡 원래 금액 · 차감 설정 · 기사 지급 · 러너 몫 · 이익률) */
function adm_stlFbView(token, month) {
  return run_(function () {
    const a = requireAdmin_(token);
    stlEnsureIdsV2_();
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const moved = stlFbMigrate_(a);
    const r = stlResult_(month, !!moved);
    const set = {};
    const D = stlDrivers_(), X = stlIds_(D);
    stlRead_('stl_fbcut').forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (id) set[id] = { cut: str_(o.cut), memo: str_(o.memo) }; });
    const rows = (r.summary.drivers || []).map(function (d) {
      const raw = d.freshRaw != null ? d.freshRaw : d.fresh + d.fbCut + (d.fbKeep || 0);
      const runner = raw - d.fresh;
      return { id: d.id, name: d.name, cids: d.cids, vendor: d.vendor || '', raw: raw, cutTxt: set[d.id] ? set[d.id].cut : (d.fbCutTxt || ''), memo: set[d.id] ? set[d.id].memo : '',
        cut: d.fbCut, keep: d.fbKeep || 0, pay: d.fresh, runner: runner, rate: raw ? runner / raw : 0 };
    }).filter(function (x) { return x.raw || x.cutTxt; });
    return { ok: true, month: month, closed: !!r.summary.closed, moved: moved, rows: rows };
  });
}
/** 관리자: 기사별 프레시백 차감 저장. list = [{ id: 정산 묶음 키, cut: '31000' | '13%' | '', memo }] (보낸 줄만 바꿈 · 빈 cut 이면 그 줄 지움) */
function adm_stlFbSave(token, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!Array.isArray(list) || !list.length || list.length > 500) fail_('바꿀 줄이 없습니다.');
    const D = stlDrivers_(), X = stlIds_(D);
    list.forEach(function (x) {
      const t = str_(x && x.cut).replace(/[,\s원]/g, '');
      if (t && !/^\d+(\.\d+)?%?$/.test(t)) fail_((x.id || '') + ': 금액(31000) 또는 비율(13%)로 넣어 주세요.');
      if (t && /%$/.test(t) && parseFloat(t) > 100) fail_('비율은 100% 이하로 넣어 주세요.');
      if (!X.groups[x.id]) fail_('정산 아이디를 찾을 수 없습니다: ' + x.id);
    });
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const cur = stlRead_('stl_fbcut'), byId = {};
      cur.forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (id) byId[id] = o; });
      list.forEach(function (x) { byId[x.id] = { name: stlAcctLabel_(X, D, x.id), acct: String(X.groups[x.id].cid).replace(/@.*$/, ''), cut: str_(x.cut).replace(/[,\s원]/g, ''), memo: str_(x.memo).slice(0, 100) }; });
      cur.forEach(function (o) { const id = stlAcct_(X, D, o.name, o.acct); if (!id) byId['?' + o._row] = o; }); // 못 찾는 줄도 그대로 보관
      const out = Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (o) { return str_(o.cut) || str_(o.memo); })
        .map(function (o) { return { name: o.name, acct: o.acct, cut: o.cut, memo: o.memo }; });
      stlWriteAll_('stl_fbcut', out);
      stlBump_();
    } finally { lock.releaseLock(); }
    logAdmin_(a, '기사별 프레시백 차감 저장', list.length + '줄', list.slice(0, 20).map(function (x) { return x.id + '=' + (x.cut || '없음'); }).join(', '));
    return { ok: true };
  });
}

/**
 * 관리자: 지출 기록 여러 줄 한 번에 추가 (예전 납부 이력 옮겨 넣기)
 *  rows = [{ date:'yyyy-MM-dd', cat, name, vendor, amt, proof, bank, memo, month? }] · 귀속월을 비우면 날짜의 달
 *  같은 날짜·내용·금액 줄이 이미 있으면 건너뜀 (두 번 눌러도 중복 안 됨)
 */
function adm_stlExpenseAdd(token, rows) {
  return run_(function () {
    const a = requireAdmin_(token);
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length || rows.length > 500) fail_('넣을 줄을 확인해 주세요 (최대 500줄).');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      stlFreshIn_('stl_expense');
      const have = {};
      stlRead_('stl_expense').forEach(function (r) { have[stlYmd_(r.date) + '|' + str_(r.name) + '|' + stlNum_(r.amt)] = 1; });
      const add = [], skipped = [];
      rows.forEach(function (r) {
        const date = stlYmd_(r.date), amt = stlNum_(r.amt), name = str_(r.name).slice(0, 200);
        if (!date || !amt || !name) { skipped.push(name || '(빈 줄)'); return; }
        const month = stlMonthOk_(str_(r.month)) ? str_(r.month) : date.slice(0, 7);
        const k = date + '|' + name + '|' + amt;
        if (have[k]) { skipped.push(name); return; }
        have[k] = 1;
        add.push({ month: month, date: date, cat: STL_COST_CATS.indexOf(str_(r.cat)) >= 0 ? str_(r.cat) : '기타', name: name, vendor: str_(r.vendor).slice(0, 100),
          amt: String(amt), proof: STL_PROOFS.indexOf(str_(r.proof)) >= 0 ? str_(r.proof) : '', bank: str_(r.bank).slice(0, 60), memo: str_(r.memo).slice(0, 300) });
      });
      stlAppend_('stl_expense', add);
      stlTouch_(['stl_expense']);
      logAdmin_(a, '지출 기록 일괄 추가', '', add.length + '줄 추가 · ' + skipped.length + '줄 건너뜀');
      return { ok: true, added: add.length, skipped: skipped };
    } finally { lock.releaseLock(); }
  });
}

// ───────────────────────── 세무자료 내보내기 (#290) ─────────────────────────
/**
 * 세무소(기장) 전달용 자료 한 묶음. months = ['2026-09','2026-10'] · extraTo = '2026-11-07' (그 날까지의 지출 기록만 추가)
 *  시트: 요약 · 기사 세금계산서 · 기사 지급 명세 · 급여 · 고용산재 · 운영비지출 · 쿠팡 입금 · 가불 · 분실파손 · 쿠팡 정산서 원본 링크
 *  클라이언트(Admin.html)가 엑셀로 만든다. 계좌번호는 기사 지급 명세 대조용으로 넣는다 (세무소 전달 자료).
 */
function adm_stlTaxPack(token, months, extraTo) {
  return run_(function () {
    requireAdmin_(token);
    months = (Array.isArray(months) ? months : [months]).filter(stlMonthOk_).sort();
    if (!months.length) fail_('정산월을 골라 주세요.');
    let co0 = {}; try { co0 = companyInfo_(); } catch (e) { /* 회사 정보 없음 */ }
    const cfg = stlCfg_(), co = { name: co0.branchName || '', ceo: co0.branchCeo || '', bizNo: co0.branchBizNo || '', addr: co0.branchAddr || '', email: cfg.email || '' }, items = stlItems_().list;
    const dedNames = items.filter(function (i) { return i.side === '차감'; }).map(function (i) { return i.name; });
    const out = { ok: true, months: months, extraTo: extraTo || '', company: co, dedNames: dedNames, summary: [], invoices: [], pays: [], staff: [], ins: [], costs: [], deposits: [], advances: [], losses: [], files: [], noBiz: [] };
    months.forEach(function (m) {
      const res = stlResult_(m, false), sum = res.summary, t = sum.total || {}, c = sum.company || {};
      const pnl = stlPnl_(m, sum), fund = stlFund_(m), rd = stlRounds_(m), dates = sum.dates || {};
      out.summary.push({
        month: m, closed: !!sum.closed, qty: t.qty || 0, sales: c.sales || 0, supplyCp: c.supplyCp || 0, salesVat: pnl.salesVat, lossCp: c.lossCp || 0, lossSup: c.lossSup || 0, progFee: c.vendorCut || 0,
        drvInvoice: t.invoice || 0, drvSupply: t.supply || 0, drvVat: t.tax || 0, drvNet: t.net || 0, drvN: (sum.drivers || []).length,
        otherInc: pnl.otherInc, margin: pnl.margin, profit: pnl.profit, runnerIns: pnl.runnerIns, insGap: pnl.insGap, staff: pnl.staff, staffWht: pnl.staffWht, fixed: pnl.fixed, fixedVat: pnl.fixedVat, varCost: pnl.varCost, varVat: pnl.varVat, net: pnl.net, vatDue: pnl.vatDue,
        insTotal: pnl.ins ? pnl.ins.total : 0, insDrv: pnl.ins ? pnl.ins.sanD + pnl.ins.goyD : 0, insRunner: pnl.ins ? pnl.ins.runnerAmt : 0,
        payDate: dates.pay || '', coupangDate: dates.coupang || '', invoiceDue: dates.invoice || '', writeDate: dates.write || ''
      });
      (sum.drivers || []).forEach(function (d) {
        const slip = res.slips[d.id] || {}, lines = slip.lines || [], ins = slip.ins || {};
        const ded = {};
        lines.forEach(function (L) { if (L.side === '차감' && L.amt) ded[L.name] = (ded[L.name] || 0) + L.amt; });
        const base = { month: m, name: d.name, id: d.id, cids: (d.cids || []).map(function (x) { return String(x).replace(/@.*/, ''); }).join(', '), vendor: !!d.vendor, ceo: !!d.ceo, bizNo: d.bizNo || '', bizName: d.bizName || '' };
        if (!d.ceo) {
          out.invoices.push(Object.assign({}, base, { invoice: d.invoice, supply: d.supply, tax: d.tax, writeDate: dates.write || '' }));
          out.pays.push(Object.assign({}, base, { qty: d.qty, workDays: d.workDays, pay: d.pay + (d.depAdd || 0), ded: ded, dedSum: (d.san || 0) + (d.goy || 0) + (d.depDed || 0) + (d.taxDed || 0), net: d.net, bank: d.bank, holder: d.holder, account: d.account, payDate: d.payDate || '', checked: !!d.checked, planDate: dates.pay || '' }));
          out.ins.push(Object.assign({}, base, { base: ins.base || 0, bosu: ins.bosu || 0, san: d.san || 0, goy: d.goy || 0, runner: d.runnerIns || 0, total: (d.san || 0) + (d.goy || 0) + (d.runnerIns || 0), excluded: !!ins.excluded }));
          if (!d.bizNo && !d.vendor) out.noBiz.push({ month: m, name: d.name, invoice: d.invoice });
        }
        (slip.loss || []).forEach(function (x) { out.losses.push({ month: m, name: d.name, date: x.date || '', waybill: x.waybill || '', item: x.item || x.detail || '', type: x.type || '', cp: stlNum_(x.cp) || 0, share: stlNum_(x.amt) || 0 }); });
      });
      out.deposits.push({ month: m, plan: fund.deposit.plan, amt: fund.deposit.amt, done: fund.deposit.done, date: fund.deposit.date, due: fund.deposit.due, bank: fund.deposit.bank });
      // 고정 운영비 (그 달 유효) · 지출 기록 (귀속월)
      stlRead_('stl_cost').forEach(function (r) { if (!stlNum_(r.amt) || !stlActiveIn_(r, m)) return; const x = stlSplitVat_(r.amt, r.proof); out.costs.push({ month: m, date: r.day ? m + '-' + ('0' + String(r.day).replace(/\D/g, '').slice(-2)).slice(-2) : '', kind: '고정 운영비', cat: r.cat || '', name: r.name || '', vendor: '', amt: stlNum_(r.amt), supply: x.supply, vat: x.vat, proof: r.proof || '', bank: r.bank || '', pnl: true, memo: r.memo || '' }); });
      stlRead_('stl_expense').forEach(function (r) { if (r.month !== m || !stlNum_(r.amt)) return; const x = stlSplitVat_(r.amt, r.proof), noPnl = STL_NOPNL_CATS.indexOf(r.cat) >= 0; out.costs.push({ month: m, date: r.date || '', kind: noPnl ? '세금·보험 납부' : '지출 기록', cat: r.cat || '', name: r.name || '', vendor: r.vendor || '', amt: stlNum_(r.amt), supply: noPnl ? stlNum_(r.amt) : x.supply, vat: noPnl ? 0 : x.vat, proof: r.proof || '', bank: r.bank || '', pnl: !noPnl, memo: r.memo || '' }); });
      // 직원 급여 (그 달 유효)
      stlRead_('stl_staff').forEach(function (r) { const pay = stlR0_(stlNum_(r.pay)); if (!r.name || !pay || !stlActiveIn_(r, m)) return; const w = stlWht_(pay, r.taxRate); out.staff.push({ month: m, name: r.name, pay: pay, rate: str_(r.taxRate) || '3.3%', wht: w, net: pay - w, day: r.day || '', bank: r.bank || '', memo: r.memo || '' }); });
      // 쿠팡 정산서 원본
      stlRead_('stl_rounds').filter(function (r) { return r.month === m && r.file; }).forEach(function (r) { const k = m + '|' + r.round + '|' + r.file; if (!out.files.some(function (f) { return f.k === k; })) out.files.push({ k: k, month: m, round: stlNum_(r.round), file: r.file, url: r.url || '', at: r.at || '' }); });
    });
    // 추가 기간 지출 (예: 11월 1~7일) — 귀속월과 상관없이 날짜로
    if (extraTo && /^\d{4}-\d{2}-\d{2}$/.test(extraTo)) {
      const from = stlAddMonth_(months[months.length - 1], 1) + '-01';
      stlRead_('stl_expense').forEach(function (r) { const d = stlYmd_(r.date); if (!d || d < from || d > extraTo || !stlNum_(r.amt)) return; const x = stlSplitVat_(r.amt, r.proof), noPnl = STL_NOPNL_CATS.indexOf(r.cat) >= 0; out.costs.push({ month: r.month || from.slice(0, 7), date: d, kind: noPnl ? '세금·보험 납부' : '지출 기록 (추가 기간)', cat: r.cat || '', name: r.name || '', vendor: r.vendor || '', amt: stlNum_(r.amt), supply: noPnl ? stlNum_(r.amt) : x.supply, vat: noPnl ? 0 : x.vat, proof: r.proof || '', bank: r.bank || '', pnl: !noPnl, memo: r.memo || '' }); });
      out.extraFrom = from;
    }
    // 통장 내역 (분류 완료 · 거래 달 = 고른 정산월 + 추가 기간의 달)
    out.bankRows = [];
    const bm = {}; months.forEach(function (m) { bm[m] = 1; }); if (out.extraFrom) bm[out.extraFrom.slice(0, 7)] = 1;
    Object.keys(bm).sort().forEach(function (m) {
      stlReadMonth_('stl_bankrows', m).forEach(function (x) {
        if (extraTo && m === (out.extraFrom || '').slice(0, 7) && str_(x.date) > extraTo) return;
        out.bankRows.push({ bank: x.bankName || x.bank, acct4: x.acct4, date: x.date, time: x.time, io: x.io, amt: stlNum_(x.amt), bal: stlNum_(x.bal), memo: x.memo, kind: x.kind, cat: x.cat, refName: x.refName, note: x.note });
      });
    });
    // 가불 대장 (전체 · 지급일 순)
    stlRead_('stl_advance').forEach(function (a) { if (!stlNum_(a.amt)) return; out.advances.push({ name: a.name || '', acct: a.acct || '', date: stlYmd_(a.date) || '', amt: stlNum_(a.amt), due: stlYmd_(a.due) || '', paid: stlNum_(a.paid) || 0, left: Math.max(0, stlNum_(a.amt) - stlNum_(a.paid)), memo: a.memo || '' }); });
    out.advances.sort(function (a, b) { return koCmp_(a.date, b.date); });
    return out;
  });
}

// ───────────────────────── 기존 정산 결과 이식 (#300) ─────────────────────────
/**
 * 기존 급여정산서(PDF)에서 읽은 기사별 결과를 그 달 올인원 계산 위에 덮어써서 마감한다 (1~10월 이식용).
 *  - 금액은 기존 정산서 그대로: 지급 항목·노선별·일자별·분실·공제·산재·고용·세금계산서·실지급액
 *  - 기존 숫자끼리 합이 안 맞으면 '기타공제(기존 정산 차액)' 줄로 맞춘다
 *  - 짝: 기존 정산서의 쿠팡 아이디(메인·서브)가 겹치는 올인원 정산 묶음. 없으면 새 줄 (아이디 = 첫 아이디)
 *  - 올인원 계산에만 있고 기존 정산서에 없는 묶음은 0원 (메모: 기존 정산서 없음 / 다른 정산서에 합침)
 * 자료: 화면에서 고른 JSON 파일의 그 달 몫(객체) 또는 드라이브 JSON 파일(fileId) — { months: { 'YYYY-MM': { drivers: [ {name, ids[], pay, invoice, supply, tax, san, goy, workDays, net, items[{name,qty,amt}], routes[{camp,route,qty,inc,base,unit,amt,worker}], daily[{date,camp,qty,ret,worker}], loss[{qty,amt,note}], deds[{name,qty,amt,note}], file} ] } } }
 */
function stlLegacyLoad_(fileId) {
  if (fileId && typeof fileId === 'object') return fileId; // 화면에서 읽은 자료 (그 달 몫)
  const f = DriveApp.getFileById(str_(fileId).replace(/^.*\/d\//, '').replace(/[/?#].*$/, ''));
  return JSON.parse(f.getBlob().getDataAsString('UTF-8'));
}
const STL_LEG_ITEM = [
  [/프레시백/, '프레시백', '프레시백'], [/미계약/, '미계약 라우트', '미계약'], [/직접.*프로모션|프로모션.*직접/, '프로모션 (직접 신청)', '프로모션'],
  [/프로모션|소급/, '기타 (프로모션)', '기타프로모션'], [/용차/, '용차(지급)', '용차수행']
];
const STL_LEG_DED = [[/가불/, '가불금 상환'], [/용차/, '용차(지출)'], [/보류/, '퇴사 보류금'], [/분할/, '매출 분할 이전']];
function stlLegacyMerge_(month, leg) {
  const res = stlCompute_(month), sum = res.summary, slips = res.slips;
  const legs = (leg && leg.drivers) || [];
  const byCid = {};
  sum.drivers.forEach(function (d) { (d.cids || []).concat(d.usedCids || []).forEach(function (c) { byCid[stlLogin_(c)] = d.id; }); byCid[stlLogin_(d.id)] = d.id; });
  const used = {}, rep = { matched: 0, added: 0, zeroed: 0, adj: [], legTotal: { invoice: 0, net: 0 } };
  const D = stlDrivers_();
  legs.forEach(function (L) {
    const ids = (L.ids || []).map(stlLogin_).filter(Boolean);
    let gid = ''; ids.some(function (c) { if (byCid[c] && !used[byCid[c]]) { gid = byCid[c]; return true; } return false; });
    let row, slip;
    if (gid) { slip = slips[gid]; row = slip.row; rep.matched++; }
    else {
      gid = ids[0] || ('legacy:' + L.name); rep.added++;
      if (slips[gid] || used[gid]) gid += '#leg' + rep.added; // 이미 다른 줄이 쓰는 키면 겹치지 않게 (덮어쓰거나 두 번 세지 않게)
      const oid = stlPerson_(D, L.name), owner = oid ? D.byId[oid] : null; // 같은 이름이 둘이면 명의자 없음 (엉뚱한 사람 기사앱에 보이지 않게)
      row = { id: gid, cid: ids[0] || '', name: L.name, ownerId: owner ? owner.id : '', cids: ids.slice(), usedCids: ids.slice(), ids: ids.length, workers: [], qty: 0, sales: 0, bank: '', holder: '', account: '', bizNo: '', bizName: '', movedIn: [], movedOut: [] };
      slip = { row: row, lines: [], ins: {}, routes: [], daily: {}, sched: {}, idUse: {}, loss: [], yong: [], members: ids.slice(), workers: [], movedIn: [], movedOut: [] };
      slips[gid] = slip; sum.drivers.push(row);
    }
    used[gid] = 1;
    // 이 기존 정산서에 같이 들어 있는 다른 올인원 묶음 → 0원 (합침)
    ids.forEach(function (c) { const g = byCid[c]; if (g && g !== gid && !used[g]) { used[g] = 'merged:' + L.name; } });
    // 지급 항목
    const lines = [];
    const routeAmt = L.routeAmt != null ? Number(L.routeAmt) || 0 : (L.routes || []).reduce(function (a, r) { return a + (Number(r.amt) || 0); }, 0);
    lines.push({ name: '배송 기본', side: '지급', method: '배송기본', taxCut: false, amt: routeAmt, memo: '기존 정산서', unknown: false });
    (L.items || []).forEach(function (it) {
      if (!Number(it.amt)) return;
      const m = STL_LEG_ITEM.filter(function (x) { return x[0].test(it.name); })[0];
      lines.push({ name: m ? m[1] : it.name, side: '지급', method: m ? m[2] : '직접입력', taxCut: false, amt: Number(it.amt), memo: (it.qty ? it.qty + '건' : '') + (m && m[1] !== it.name ? ' (' + it.name + ')' : ''), unknown: false });
    });
    const pay = lines.reduce(function (a, l) { return a + l.amt; }, 0);
    // 세금계산서: 기존 매출 합계와 지급 합계 차이 = 계산서 차감(또는 지급 차액)
    const invoice = Number(L.invoice) || (Number(L.supply) || 0) + (Number(L.tax) || 0);
    if (Number(L.pay) && Number(L.pay) !== pay) lines.push({ name: '기타 (기존 정산 차액)', side: '지급', method: '직접입력', taxCut: false, amt: Number(L.pay) - pay, memo: '기존 정산서 매출 합계에 맞춤', unknown: false });
    const pay2 = Number(L.pay) || pay;
    // 기존 정산서의 세금계산서가 매출 합계와 다르면 (예: 소급분만 있어 계산서 0원) 계산서 금액만 기존 그대로 두고, 지급·공제 줄은 매출 합계 기준
    // 공제: 분실 · 공제 내역
    let ded = 0;
    const lossAmt = (L.loss || []).reduce(function (a, x) { return a + (Number(x.amt) || 0); }, 0);
    if (lossAmt) { lines.push({ name: '분실파손 부담', side: '차감', method: '분실파손', taxCut: false, amt: lossAmt, memo: (L.loss || []).length + '건', unknown: false }); ded += lossAmt; }
    (L.deds || []).forEach(function (x) {
      if (!Number(x.amt)) return;
      const m = STL_LEG_DED.filter(function (y) { return y[0].test(x.name); })[0];
      lines.push({ name: m ? m[1] : (x.name || '기타 공제'), side: '차감', method: m && m[1] === '용차(지출)' ? '용차지출' : '직접입력', taxCut: false, amt: Number(x.amt), memo: [x.name !== (m && m[1]) ? x.name : '', x.qty ? x.qty + '건' : '', x.note || ''].filter(Boolean).join(' · '), unknown: false });
      ded += Number(x.amt);
    });
    const san = Number(L.san) || 0, goy = Number(L.goy) || 0, net = Number(L.net) || 0;
    const gap = pay2 - san - goy - ded - net;
    if (gap) { lines.push({ name: '기타 공제', side: '차감', method: '직접입력', taxCut: false, amt: gap, memo: '기존 정산 차액', unknown: false }); ded += gap; rep.adj.push({ name: L.name, amt: gap }); }
    lines.push({ name: '산재보험', side: '차감', method: '산재보험', taxCut: false, amt: san, memo: '', unknown: false });
    lines.push({ name: '고용보험', side: '차감', method: '고용보험', taxCut: false, amt: goy, memo: '', unknown: false });
    slip.lines = lines;
    const supply = Number(L.supply) || Math.round(invoice / 1.1);
    Object.assign(row, {
      name: row.name || L.name, pay: pay2, taxDed: 0, invoice: invoice, supply: supply, tax: invoice - supply, san: san, goy: goy, depDed: ded, depAdd: pay2 - invoice, net: net,
      loss: lossAmt, lossInc: lossAmt, yongInc: (L.deds || []).filter(function (x) { return /용차/.test(x.name); }).reduce(function (a, x) { return a + (Number(x.amt) || 0); }, 0),
      workDays: Number(L.workDays) || row.workDays || 0, workDaysSrc: '기존 정산서', ceo: false, ceoView: null, legacy: L.file || true,
      qty: (L.routes || []).reduce(function (a, r) { return a + (Number(r.qty) || 0); }, 0) || row.qty
    });
    row.otherInc = row.lossInc + row.yongInc;
    row.profit = Math.round((row.supplyCpRaw || 0)); // 아래에서 다시 계산
    // 노선별 · 일자별 (기존 정산서 그대로)
    if ((L.routes || []).length) slip.routes = L.routes.map(function (r) { return { camp: r.camp || '', route: r.route || '', how: '기존', unit: Number(r.unit) || 0, inc: Number(r.inc) || 0, base: Number(r.base) || 0, qty: Number(r.qty) || 0, amt: Number(r.amt) || 0, worker: r.worker || '' }; });
    if ((L.daily || []).length) {
      const old = slip.daily || {}, nd = {};
      L.daily.forEach(function (x) { const o = nd[x.date] || (nd[x.date] = { qty: 0, amt: (old[x.date] || {}).amt || 0, rt: (old[x.date] || {}).rt }); o.qty += Number(x.qty) || 0; if (x.worker) o.who = x.worker; });
      slip.daily = nd;
    }
    slip.loss = (L.loss || []).map(function (x) { return { date: x.date || '', type: '분실파손', item: x.note || '', waybill: x.waybill || '', amt: Number(x.amt) || 0, qty: Number(x.qty) || 0 }; });
    slip.ins = Object.assign({}, slip.ins || {}, { legacy: true, workDays: Number(L.workDays) || 0 });
    rep.legTotal.invoice += invoice; rep.legTotal.net += net;
  });
  // 기존 정산서에 없는 묶음 → 0원
  sum.drivers.forEach(function (row) {
    if (used[row.id] === 1) return;
    const why = typeof used[row.id] === 'string' ? used[row.id].replace(/^merged:/, '') + ' 정산서에 합침' : '기존 정산서 없음';
    ['pay', 'taxDed', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'lossInc', 'yongInc', 'otherInc', 'runnerIns', 'insGain'].forEach(function (k) { row[k] = 0; });
    row.legacyNote = why; rep.zeroed++;
    if (slips[row.id]) slips[row.id].lines = [{ name: '(' + why + ')', side: '지급', method: '직접입력', taxCut: false, amt: 0, memo: '', unknown: false }];
  });
  // 회사이익금 (기사별) · 합계 다시
  sum.drivers.forEach(function (row) {
    const s = slips[row.id];
    const cpSup = Math.round((row.sales || 0) / 1.1);
    row.profit = Math.round(cpSup - (row.lossCp ? Math.round(row.lossCp / 1.1) : 0) - (row.supply || 0) + (row.otherInc || 0));
    if (s) s.row = row;
  });
  const keys = ['qty', 'pay', 'invoice', 'supply', 'tax', 'san', 'goy', 'depDed', 'depAdd', 'net', 'loss', 'lossCp', 'lossInc', 'yongInc', 'otherInc', 'profit', 'runnerIns', 'fbCut', 'fbKeep', 'insGain', 'sales', 'taxDed'];
  const tot = {}; keys.forEach(function (k) { tot[k] = 0; });
  sum.drivers.forEach(function (row) { keys.forEach(function (k) { tot[k] += Number(row[k]) || 0; }); });
  sum.total = Object.assign({}, sum.total, tot);
  sum.legacy = { at: nowText_(), matched: rep.matched, added: rep.added, zeroed: rep.zeroed, adj: rep.adj };
  sum.drivers.sort(function (a, b) { return (b.net || 0) - (a.net || 0) || koCmp_(a.name, b.name); });
  return { res: res, rep: rep };
}
/** 미리보기: 달마다 기존 합계 · 올인원 계산 합계 · 짝 맞춘 수 · 차액 줄 */
function adm_stlLegacyPreview(token, fileId, months) {
  return run_(function () {
    requireAdmin_(token);
    const data = stlLegacyLoad_(fileId), all = Object.keys(data.months || {}).sort();
    if (months === 'list') return { ok: true, months: [], all: all };
    const pick = (Array.isArray(months) && months.length ? months : all).filter(function (m) { return data.months[m]; });
    const out = pick.map(function (m) {
      const closed = !!stlClosedInfo_(m);
      let calc = null, merged = null, err = '';
      try {
        if (!closed) { const r0 = stlResult_(m, false); calc = { invoice: r0.summary.total.invoice || 0, net: r0.summary.total.net || 0, n: r0.summary.drivers.length }; }
        const mg = stlLegacyMerge_(m, data.months[m]);
        merged = { invoice: mg.res.summary.total.invoice, net: mg.res.summary.total.net, n: mg.res.summary.drivers.filter(function (d) { return d.net; }).length, matched: mg.rep.matched, added: mg.rep.added, zeroed: mg.rep.zeroed, adj: mg.rep.adj, legInvoice: mg.rep.legTotal.invoice, legNet: mg.rep.legTotal.net };
      } catch (e) { err = String(e && e.message || e); }
      return { month: m, closed: closed, legN: (data.months[m].drivers || []).length, calc: calc, merged: merged, err: err };
    });
    return { ok: true, months: out, all: all };
  });
}
/** 실행: 달마다 (마감돼 있으면 풀고) 기존 결과로 덮어써서 마감 */
function adm_stlLegacyClose(token, fileId, month) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!stlMonthOk_(month)) fail_('정산월을 확인해 주세요.');
    const data = stlLegacyLoad_(fileId), leg = (data.months || {})[month];
    if (!leg) fail_(month + ' 기존 정산 자료가 파일에 없습니다.');
    const lock = scriptLock_(); lock.waitLock(30000);
    try {
      const rows = stlRead_('stl_close'), others = rows.filter(function (r) { return r.month !== month; });
      const mg = stlLegacyMerge_(month, leg), res = mg.res;
      res.summary.computedAt = nowText_();
      const snap = stlSnapRows_(month, res);
      stlReplaceMonth_('stl_closed', month, snap);
      stlWriteAll_('stl_close', others.concat([{ month: month, at: nowText_(), admin: a.name + ' (기존 정산 이식)' }]));
      stlLastCloseSet_(month);
      stlBump_();
      logAdmin_(a, '기존 정산 이식·마감', month, '짝 ' + mg.rep.matched + ' · 새 줄 ' + mg.rep.added + ' · 0원 ' + mg.rep.zeroed + ' · 차액 ' + mg.rep.adj.length);
      return { ok: true, month: month, total: { invoice: res.summary.total.invoice, net: res.summary.total.net }, rep: mg.rep };
    } finally { lock.releaseLock(); }
  });
}
