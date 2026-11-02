/**
 * 러너 올인원 - 1단계 : 로그인 / 자동 로그인 / 회원가입 / 비밀번호 찾기
 *
 * 백엔드 : 구글 드라이브
 *   - 데이터 : 구글 스프레드시트 "러너 올인원 DB" (drivers, sessions 시트)
 *   - 파일   : 구글 드라이브 폴더 "러너 올인원 데이터/기사 서류"
 *
 * 수동 수정 원칙 (시트를 직접 고쳐도 앱이 그대로 따라온다)
 *   1. 열은 위치가 아니라 "머리글 이름"으로 찾는다. 열 순서를 바꾸거나 열을 끼워 넣어도 된다.
 *   2. 날짜·시각은 사람이 읽고 고칠 수 있는 "yyyy-MM-dd HH:mm:ss" 글자로 저장한다.
 *   3. 주민등록번호·운전면허번호·계좌번호 칸에 새 번호를 그대로 입력하면
 *      자동으로 암호화되고 칸에는 가린 번호(예: 900101-1******)가 남는다.
 *   4. "비밀번호 재설정" 칸에 새 비밀번호를 입력하면 자동 적용되고 칸은 비워진다.
 *   5. 시트를 고치는 즉시 관련 캐시를 지워 앱에 바로 반영된다.
 *
 * 속도 최적화 원칙
 *   1. 시트 전체를 읽지 않는다. TextFinder 로 한 행만 찾고, 그 행만 한 번에 읽는다.
 *   2. 머리글 위치, 아이디→행 번호, 세션, 기사 요약은 CacheService 에 둔다.
 *   3. 새 행은 한 번의 setValues 로 쓴다.
 *   4. 스프레드시트·시트·설정값 핸들은 실행 1회 동안 재사용한다.
 *   5. 이미지는 브라우저에서 압축한 뒤 한 번의 호출로 올린다.
 *   6. 중복 검사·업로드는 잠금 밖에서, 최종 저장만 짧게 잠근다.
 */

// ───────────────────────── 설정 ─────────────────────────
const CFG = {
  TZ: 'Asia/Seoul',
  SESSION_AUTO_DAYS: 30,         // 자동 로그인 유지 기간
  SESSION_HOURS: 12,             // 자동 로그인 미선택 시 유지 시간
  LOGIN_MAX_FAIL: 10,            // 연속 실패 허용 횟수 (초과 시 15분 잠금)
  RESET_MAX_TRY: 5,              // 비밀번호 찾기 본인확인 시도 횟수 (초과 시 30분 잠금)
  RESET_TOKEN_SEC: 600,          // 비밀번호 재설정 허용 시간(초)
  PW_ITER: 200,                  // 비밀번호 해시 반복 횟수
  MAX_FILE_B64: 7 * 1024 * 1024, // 이미지 1장 최대 크기(base64 기준 약 5MB)
  CACHE_MAX: 21600,              // CacheService 최대 6시간
  SESS_CACHE: 1800,              // 세션 캐시 30분 (시트에서 지운 세션도 30분 안에 끊김)
  HEAD_CACHE: 600                // 머리글 위치 캐시 10분 (구조 변경 시 즉시 삭제)
};

const ST = { PENDING: '승인대기', ACTIVE: '승인', REJECTED: '반려', STOPPED: '정지' };
const SH = { DRIVERS: 'drivers', SESSIONS: 'sessions', ADMINS: 'admins', ALOG: 'admin_log', MEMO: 'work_memo', BIB: 'bib_applications',
  CAMPS: 'camps', CIMG: 'camp_images', ROUTES: 'routes', CADDR: 'camp_addresses', PRICES: 'route_prices' };

// drivers 시트 열 정의. 값 = 시트 머리글 (머리글 이름은 바꾸지 말 것, 순서는 자유)
const D = {
  id: '기사ID', loginId: '쿠팡플렉스 아이디', name: '이름', phone: '연락처', status: '상태',
  driverType: '기사구분', driverCode: '기사코드',
  birthDate: '생년월일', rrn: '주민등록번호', address: '주소(주민등록상)',
  qualDate: '화물운송 종사자격 취득일', qualNo: '화물운송 종사자격증 번호',
  licenseNo: '운전면허번호', licenseType: '운전면허 종류',
  carNo: '차량번호', carName: '차명', carYear: '연식', maxLoad: '최대적재량(kg)',
  bankName: '은행명', account: '계좌번호', accountHolder: '예금주',
  docQual: '서류_화물운송 종사자격증', docLicense: '서류_운전면허증', docBiz: '서류_사업자등록증', docCar: '서류_자동차등록증',
  docFolder: '서류 폴더',
  createdAt: '가입일시', approvedAt: '승인일시', updatedAt: '수정일시', pwChangedAt: '비밀번호 변경일시',
  memo: '관리자 메모',
  pwReset: '비밀번호 재설정', pwMustChange: '비밀번호 변경 필요',
  // ↓ 앱 내부용 (숨김). 사람이 직접 고치지 않고, 위 칸을 고치면 자동으로 갱신된다.
  rrnEnc: '주민등록번호(암호화)', rrnIndex: '주민번호 중복검사키',
  licenseNoEnc: '운전면허번호(암호화)', accountEnc: '계좌번호(암호화)',
  pwHash: '비밀번호 해시', pwSalt: '비밀번호 솔트'
};
// 코드 업데이트로 새로 생긴 열 중, 비어 있어도 안전한 열은 setup 없이 자동으로 추가한다
const D_AUTO_ADD = ['pwMustChange', 'carNo', 'driverType', 'driverCode'];
const DTYPES = ['고정', '백업', '품앗이', '외부용차'];
const D_HIDDEN = ['rrnEnc', 'rrnIndex', 'licenseNoEnc', 'accountEnc', 'pwHash', 'pwSalt'];
const D_NOTES = {
  driverType: '고정 / 백업 / 품앗이 / 외부용차',
  driverCode: '기사마다 겹치지 않는 코드 (영문은 자동 대문자)',
  status: '승인대기 / 승인 / 반려 / 정지 중 선택.\n승인으로 바꾸면 승인일시가 자동 기록됩니다.',
  rrn: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.\n생년월일도 자동 갱신됩니다.',
  licenseNo: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.',
  account: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.',
  pwReset: '새 비밀번호(영문+숫자 8~30자)를 입력하면 바로 적용되고 이 칸은 비워집니다.\n' +
    '임시 비밀번호로 취급되어, 기사가 다음 로그인 때 새 비밀번호를 직접 정하게 됩니다.\n' +
    '여러 명에게 같은 임시 비밀번호를 줄 때: 첫 칸에 입력 → 칸 오른쪽 아래 네모를 아래로 끌어 채우기.',
  pwMustChange: 'Y 이면 다음 로그인 때 기사가 새 비밀번호를 정해야 합니다.\n' +
    '비밀번호 재설정 칸으로 지정하면 자동으로 Y, 기사가 바꾸면 자동으로 비워집니다.',
  loginId: '직접 새 줄을 추가할 때는 아이디·이름을 먼저 입력하면 기사ID와 가입일시가 자동으로 채워집니다.'
};

// sessions 시트 열 정의 (로그인 기록). 만료일시를 지금보다 이전으로 고치면 그 기기는 로그아웃됩니다.
const S = { tokenHash: '토큰 해시', driverId: '기사ID', createdAt: '생성일시', expiresAt: '만료일시', auto: '자동로그인' };

// admins 시트 (관리자 계정). 관리자는 시트에서 직접 추가하고 비밀번호 재설정 칸으로 비밀번호를 정한다.
const AST = { ACTIVE: '사용', STOPPED: '정지' };
const A = {
  id: '관리자ID', loginId: '아이디', name: '이름', status: '상태', pwReset: '비밀번호 재설정',
  createdAt: '생성일시', pwChangedAt: '비밀번호 변경일시', lastLoginAt: '마지막 로그인', memo: '메모',
  pwHash: '비밀번호 해시', pwSalt: '비밀번호 솔트'
};
const A_NOTES = {
  loginId: '관리자 로그인 아이디. 새 줄에 아이디·이름·비밀번호 재설정을 입력하면 관리자가 추가됩니다.',
  status: '사용 / 정지. 정지하면 바로 로그인할 수 없습니다.',
  pwReset: '비밀번호(영문+숫자 8~30자)를 입력하면 바로 적용되고 이 칸은 비워집니다.'
};
// admin_log 시트 (관리자 작업 기록: 개인정보 열람·수정 등). 자동으로 쌓이며 지우지 않는 것을 권장
const L = { at: '시각', admin: '관리자', action: '작업', target: '대상', detail: '내용' };

// work_memo 시트 (업무스케줄: 관리자 전용 날짜별 메모). 시트에서 직접 줄을 추가해도 된다.
const M = {
  id: '메모ID', date: '날짜', time: '시간', content: '내용', done: '완료',
  author: '작성자', createdAt: '작성일시', updatedAt: '수정일시'
};
const M_NOTES = {
  date: '2026-11-03 형식. 2026.11.3, 2026/11/3 처럼 입력해도 자동으로 맞춰집니다.',
  time: '선택. 09:30 형식 (24시간)',
  done: '완료하면 Y',
  content: '새 줄에 날짜와 내용을 입력하면 메모ID와 작성일시가 자동으로 채워집니다.'
};

// bib_applications 시트 (배번호 신청: '배' 번호판 허가 신청 서류 4종)
const BST = { DRAFT: '작성', PRINTED: '출력', SUBMITTED: '제출', APPROVED: '허가', REJECTED: '반려' };
const FUELS = ['LPG', '경유', '전기', '휘발유', '기타'];
const BODY_TYPES = ['탑형', '밴형'];
const MANAGE = ['자동 증명', '직접 증명'];
const B = {
  id: '신청ID', driverId: '기사ID', name: '이름', status: '진행상태', applyDate: '신청일',
  contractStart: '계약 시작일', contractEnd: '계약 종료일', contractYears: '계약기간(년)',
  careerStart: '경력 시작(년월)', careerEnd: '경력 종료(년월)', careerYears: '경력기간(년)',
  carNo: '신청 시 차량번호', fuel: '연료', fuelEtc: '연료(기타)', bodyType: '형태',
  manageMethod: '허가 후 관리 방법', optConsent: '제3자 제공 선택 동의',
  printedAt: '출력일시', submittedAt: '제출일', approvedAt: '허가일', plateNo: '허가 차량번호',
  rejectedAt: '반려일', rejectReason: '반려 사유', memo: '메모', admin: '담당 관리자',
  createdAt: '작성일시', updatedAt: '수정일시',
  snapshotEnc: '마지막 출력 내용(암호화)'
};
const B_NOTES = {
  status: '작성 / 출력 / 제출 / 허가 / 반려',
  careerStart: '2025-05 형식 (년-월)',
  fuel: 'LPG / 경유 / 전기 / 휘발유 / 기타',
  manageMethod: '자동 증명 / 직접 증명',
  optConsent: '동의하면 Y',
  plateNo: "허가받은 '배' 번호판 차량번호"
};
// company 시트 (서류에 들어가는 회사 고정 정보: 항목 | 값)
const COMPANY = [
  ['courierName', '택배서비스사업자명', '쿠팡로지스틱스서비스 유한회사'],
  ['courierCeo', '택배서비스사업자 대표이사', '강현오'],
  ['courierAddr', '택배서비스사업자 주소', '서울특별시 강남구 광평로 280 7층 (수서동, 로즈데일빌딩)'],
  ['branchName', '영업점명', '러너'],
  ['branchCeo', '영업점 대표자', '유정훈'],
  ['branchAddr', '영업점 주소', '경기도 부천시 소사구 양지로237, 9층 972호(옥길동, 광양프런티어밸리 5차)'],
  ['branchPhone', '영업점 연락처', '010-9599-0808'],
  ['branchBizNo', '영업점 사업자번호', '654-37-01141'],
  ['court', '관할법원 (OO지방법원의 OO)', '서울중앙']
];
const COMPANY_SHEET = 'company';

// ── 노선관리 (2단계 기준 데이터). 캠프명 > 노선코드 ──
// camps 시트: 캠프 기본 정보
const CP = { id: '캠프ID', name: '캠프명', address: '주소', memo: '메모', createdAt: '등록일시', updatedAt: '수정일시' };
const CP_NOTES = {
  name: '새 줄에 캠프명만 입력해도 캠프ID가 자동으로 채워집니다. 캠프명을 바꾸면 routes·camp_images 탭의 캠프명도 자동으로 바뀝니다.'
};
// camp_images 시트: 캠프 참고 이미지 (파일은 드라이브 "캠프 참고 이미지" 폴더)
const CI = {
  id: '이미지ID', campId: '캠프ID', campName: '캠프명', file: '이미지 링크', desc: '설명', order: '순서',
  createdAt: '등록일시', updatedAt: '수정일시'
};
const CI_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다.',
  file: '드라이브 이미지 파일 링크. 드라이브에서 "링크 복사"한 주소를 붙여 넣어도 됩니다.',
  order: '작은 숫자가 앞에 표시됩니다.'
};
// routes 시트: 노선 (구분1~5는 노선코드에서 자동으로 나뉜다)
const RST = { ON: '사용', OFF: '중지' };
const R = {
  id: '노선ID', campId: '캠프ID', campName: '캠프명', code: '노선코드',
  g1: '구분1', g2: '구분2', g3: '구분3', g4: '구분4', g5: '구분5',
  status: '사용여부', memo: '메모', createdAt: '등록일시', updatedAt: '수정일시'
};
const R_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다. 다른 캠프명으로 바꾸면 그 캠프로 옮겨집니다.',
  code: '예: 110ABCD → 구분1 110 / 구분2 A / 구분3 B / 구분4 C / 구분5 D (자동). 110-A-B-C-D 처럼 - 로 나눠 써도 됩니다.',
  g1: '노선코드에서 자동으로 채워집니다. 노선코드를 고치세요.',
  status: '사용 / 중지'
};
// camp_addresses 시트: 캠프 주소와 다른 곳 (상차지 등). 캠프 하나에 여러 개 가능
const CAD = {
  id: '주소ID', campId: '캠프ID', campName: '캠프명', label: '이름', address: '주소', order: '순서',
  createdAt: '등록일시', updatedAt: '수정일시'
};
const CAD_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다.',
  label: '예: 상차지, 2상차지, 회차지. 비워 두면 "상차지"',
  order: '작은 숫자가 앞에 표시됩니다.'
};
const CAD_MAX = 10;
// route_prices 시트: 구분별 단가. 노선코드 앞자리부터의 경로(110-A, 110-A-B …) 하나에 한 줄
// route_prices 시트: 구분별 단가. 숫자(구분1) + 구분(2~5) + 글자 하나에 한 줄. 예: 110 / 구분3 / B
const RP = {
  id: '단가ID', campId: '캠프ID', campName: '캠프명', num: '숫자(구분1)', level: '구분', value: '글자',
  p1: '원청단가', p2: '기사단가', p3: '백업단가', p4: '품앗이단가', p5: '외부단가',
  tmp: '일시단가', tmpStart: '일시단가 시작일', tmpEnd: '일시단가 종료일',
  createdAt: '등록일시', updatedAt: '수정일시'
};
const RP_PRICE_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5', 'tmp'];
const RP_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다.',
  num: '노선코드 앞 숫자. 예: 110ABCD 이면 110',
  level: '구분2 / 구분3 / 구분4 / 구분5 (2 처럼 숫자만 써도 됨)',
  value: '그 구분 자리의 글자. 예: 110ABCD 의 구분3 은 B',
  p1: '숫자만 (원). 1,200 처럼 써도 됩니다.',
  tmp: '정해진 기간에만 쓰는 단가. 시작일·종료일을 같이 입력하세요.',
  tmpStart: '2026-11-01 형식'
};
// 시트가 없으면 처음 쓸 때 자동으로 만든다 (setup 을 다시 실행하지 않아도 됨)
const AUTO_SHEETS = ['camps', 'camp_images', 'routes', 'camp_addresses', 'route_prices'];

const SCHEMA = {};
SCHEMA[SH.DRIVERS] = D;
SCHEMA[SH.SESSIONS] = S;
SCHEMA[SH.ADMINS] = A;
SCHEMA[SH.ALOG] = L;
SCHEMA[SH.MEMO] = M;
SCHEMA[SH.BIB] = B;
SCHEMA[SH.CAMPS] = CP;
SCHEMA[SH.CIMG] = CI;
SCHEMA[SH.CADDR] = CAD;
SCHEMA[SH.PRICES] = RP;
SCHEMA[SH.ROUTES] = R;
const HIDDEN = {};
HIDDEN[SH.DRIVERS] = D_HIDDEN;
HIDDEN[SH.ADMINS] = ['pwHash', 'pwSalt'];
HIDDEN[SH.BIB] = ['snapshotEnc'];

const DOCS = {
  qual: { col: 'docQual', label: '화물운송종사자격증' },
  license: { col: 'docLicense', label: '운전면허증' },
  biz: { col: 'docBiz', label: '사업자등록증' },
  car: { col: 'docCar', label: '자동차등록증' }
};

// ───────────────────────── 웹앱 진입점 ─────────────────────────
function doGet(e) {
  // 템플릿 평가 없이 파일을 그대로 내보내 첫 화면 응답을 빠르게 한다.
  // 웹앱 주소 뒤에 ?page=admin 을 붙이면 관리자 화면
  if (e && e.parameter && e.parameter.page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('러너 올인원 관리자')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('러너 올인원')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// ───────────────────────── 설정 / 업그레이드 ─────────────────────────
/**
 * 편집기에서 실행. 처음이면 DB 시트, 서류 폴더, 암호화 키를 만들고,
 * 이미 있으면 빠진 열·서식·트리거만 보충한다. (여러 번 실행해도 안전)
 */
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('DB_ID')) {
    const root = DriveApp.createFolder('러너 올인원 데이터');
    const docs = root.createFolder('기사 서류');
    const ss = SpreadsheetApp.create('러너 올인원 DB');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    ss.getSheets()[0].setName(SH.DRIVERS);
    ss.insertSheet(SH.SESSIONS);
    p.setProperties({
      DB_ID: ss.getId(),
      ROOT_FOLDER_ID: root.getId(),
      DOCS_FOLDER_ID: docs.getId(),
      ENC_KEY: Utilities.base64Encode(randomBytes_(32)),
      MAC_KEY: Utilities.base64Encode(randomBytes_(32)),
      PEPPER: Utilities.base64Encode(randomBytes_(32))
    });
    _props = null;
  }
  ensureColumns();
  ensureCompany_();
  ensureTools_();
  installTriggers_();
  Logger.log('설정 완료. DB: ' + ss_().getUrl());
}

/** 빠진 머리글을 오른쪽 끝에 추가하고 서식·숨김·드롭다운·설명을 다시 적용한다. */
function ensureColumns(only) {
  if (!only) { try { ss_().setSpreadsheetTimeZone(CFG.TZ); } catch (e) { /* 권한 문제 시 무시 */ } }
  (only || Object.keys(SCHEMA)).forEach(function (name) {
    const def = SCHEMA[name];
    if (!ss_().getSheetByName(name)) ss_().insertSheet(name);
    const sh = sheet_(name);
    const lastCol = Math.max(sh.getLastColumn(), 1);
    let head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    if (head.length === 1 && head[0] === '') head = [];
    const missing = Object.keys(def).map(function (k) { return def[k]; })
      .filter(function (label) { return head.indexOf(label) < 0; });
    if (missing.length) {
      const need = head.length + missing.length;
      if (need > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
      sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
      head = head.concat(missing);
    }
    const width = head.length;
    sh.getRange(1, 1, sh.getMaxRows(), width).setNumberFormat('@'); // 0으로 시작하는 값·날짜 글자 보존
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    clearHeadCache_(name);
    const c = cols_(name, true);

    (HIDDEN[name] || []).forEach(function (k) { sh.hideColumns(c[k] + 1); });
    if (name === SH.DRIVERS) {
      sh.setFrozenColumns(Math.max(c.loginId, c.name) + 1 <= 5 ? Math.max(c.loginId, c.name) + 1 : 0);
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList([ST.PENDING, ST.ACTIVE, ST.REJECTED, ST.STOPPED], true).build();
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
      const tr = SpreadsheetApp.newDataValidation().requireValueInList(DTYPES, true).setAllowInvalid(true).build();
      sh.getRange(2, c.driverType + 1, sh.getMaxRows() - 1, 1).setDataValidation(tr);
      Object.keys(D_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(D_NOTES[k]); });
      sh.getRange(1, c.pwReset + 1).setBackground('#fff4e5');
    } else if (name === SH.ADMINS) {
      const rule = SpreadsheetApp.newDataValidation().requireValueInList([AST.ACTIVE, AST.STOPPED], true).build();
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
      Object.keys(A_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(A_NOTES[k]); });
      sh.getRange(1, c.pwReset + 1).setBackground('#fff4e5');
    } else if (name === SH.BIB) {
      const st = SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(BST).map(function (k) { return BST[k]; }), true).build();
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(st);
      const fu = SpreadsheetApp.newDataValidation().requireValueInList(FUELS, true).setAllowInvalid(true).build();
      sh.getRange(2, c.fuel + 1, sh.getMaxRows() - 1, 1).setDataValidation(fu);
      const bt = SpreadsheetApp.newDataValidation().requireValueInList(BODY_TYPES, true).setAllowInvalid(true).build();
      sh.getRange(2, c.bodyType + 1, sh.getMaxRows() - 1, 1).setDataValidation(bt);
      const mm = SpreadsheetApp.newDataValidation().requireValueInList(MANAGE, true).setAllowInvalid(true).build();
      sh.getRange(2, c.manageMethod + 1, sh.getMaxRows() - 1, 1).setDataValidation(mm);
      Object.keys(B_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(B_NOTES[k]); });
    } else if (name === SH.MEMO) {
      const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Y'], true).setAllowInvalid(true).build();
      sh.getRange(2, c.done + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
      Object.keys(M_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(M_NOTES[k]); });
    } else if (name === SH.CAMPS) {
      Object.keys(CP_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(CP_NOTES[k]); });
      sh.setFrozenColumns(Math.min(c.name + 1, 3));
    } else if (name === SH.PRICES) {
      Object.keys(RP_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(RP_NOTES[k]); });
      sh.getRange(1, c.level + 1).setBackground('#eef2f6');
    } else if (name === SH.CADDR) {
      Object.keys(CAD_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(CAD_NOTES[k]); });
    } else if (name === SH.CIMG) {
      Object.keys(CI_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(CI_NOTES[k]); });
    } else if (name === SH.ROUTES) {
      const rule = SpreadsheetApp.newDataValidation().requireValueInList([RST.ON, RST.OFF], true).build();
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
      Object.keys(R_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(R_NOTES[k]); });
      ['g1', 'g2', 'g3', 'g4', 'g5'].forEach(function (k) { sh.getRange(1, c[k] + 1).setBackground('#eef2f6'); });
    } else if (name === SH.SESSIONS) {
      sh.getRange(1, c.expiresAt + 1).setNote('지금보다 이전 시각으로 고치면 해당 기기는 로그아웃됩니다.');
    }
  });
}

/** 시트 편집·구조 변경·세션 정리 트리거 (중복 없이 설치) */
function installTriggers_() {
  const have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const ss = ss_();
  if (have.indexOf('onSheetEdit') < 0) ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  if (have.indexOf('onSheetChange') < 0) ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  if (have.indexOf('cleanupSessions') < 0) ScriptApp.newTrigger('cleanupSessions').timeBased().everyDays(1).atHour(4).create();
}

// ───────────────────────── 공용 핸들 (실행당 1회) ─────────────────────────
let _props = null, _ss = null;
const _sheets = {}, _cols = {};
function props_() { return _props || (_props = PropertiesService.getScriptProperties().getProperties()); }
function ss_() {
  if (_ss) return _ss;
  const id = props_().DB_ID;
  if (!id) fail_('서버 초기 설정(setup)이 되지 않았습니다. 관리자에게 문의해 주세요.');
  return (_ss = SpreadsheetApp.openById(id));
}
function sheet_(name) {
  if (_sheets[name]) return _sheets[name];
  let sh = ss_().getSheetByName(name);
  if (!sh && AUTO_SHEETS.indexOf(name) >= 0) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { if (!ss_().getSheetByName(name)) ensureColumns([name]); } finally { lock.releaseLock(); }
    sh = ss_().getSheetByName(name);
  }
  if (!sh) fail_('DB 시트 "' + name + '"을(를) 찾을 수 없습니다. 시트 이름을 바꾸지 마세요.');
  return (_sheets[name] = sh);
}
function cache_() { return CacheService.getScriptCache(); }

/**
 * 머리글 이름 → 열 번호(0부터). fresh=true 면 캐시를 쓰지 않고 시트에서 다시 읽는다(쓰기 작업용).
 * 반환: { key: index, ..., __w: 머리글 개수 }
 */
function cols_(name, fresh) {
  if (_cols[name] && !fresh) return _cols[name];
  const ck = 'hc:' + name;
  let head = fresh ? null : cache_().get(ck);
  if (head) head = JSON.parse(head);
  else {
    const sh = sheet_(name);
    head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    cache_().put(ck, JSON.stringify(head), CFG.HEAD_CACHE);
  }
  const def = SCHEMA[name], c = { __w: head.length }, missing = [];
  Object.keys(def).forEach(function (k) {
    const i = head.indexOf(def[k]);
    if (i < 0) missing.push(def[k]); else c[k] = i;
  });
  const autoable = missing.length && (AUTO_SHEETS.indexOf(name) >= 0 || (name === SH.DRIVERS &&
    missing.every(function (label) { return D_AUTO_ADD.some(function (k) { return D[k] === label; }); })));
  if (autoable) {
    addHeaders_(name, missing);
    return cols_(name, true);
  }
  if (missing.length) {
    fail_('DB 시트(' + name + ')에 머리글이 없습니다: ' + missing.join(', ') +
      '. 머리글 이름은 바꾸지 말고, 편집기에서 setup 을 다시 실행해 주세요.');
  }
  return (_cols[name] = c);
}
/** 빈 열을 오른쪽 끝에 추가 (안전한 새 열만 자동 추가에 사용) */
function addHeaders_(name, labels) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(name);
    const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    const need = labels.filter(function (l) { return head.indexOf(l) < 0; });
    if (!need.length) return;
    const start = head.length + 1;
    if (start + need.length - 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), need.length);
    sh.getRange(1, start, sh.getMaxRows(), need.length).setNumberFormat('@');
    sh.getRange(1, start, 1, need.length).setValues([need]).setFontWeight('bold').setBackground('#f1f3f4');
  } finally {
    lock.releaseLock();
    clearHeadCache_(name);
  }
}
function clearHeadCache_(name) { delete _cols[name]; cache_().remove('hc:' + name); }

// ───────────────────────── 응답 래퍼 ─────────────────────────
function run_(fn) {
  try { return fn(); }
  catch (err) {
    if (err && err.userMsg) return err.code ? { ok: false, code: err.code, msg: err.userMsg } : { ok: false, msg: err.userMsg };
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, msg: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
function fail_(msg) { const e = new Error(msg); e.userMsg = msg; throw e; }

// ───────────────────────── 값 정리 (사람이 직접 입력한 값도 같은 규칙으로) ─────────────────────────
function nowText_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function msText_(ms) { return Utilities.formatDate(new Date(ms), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
/** 셀 값 → 글자. 시트가 날짜로 바꿔 버린 값도 원래 글자 모양으로 되돌린다. */
function str_(v) {
  if (v instanceof Date) {
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, CFG.TZ, hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v).trim();
}
/** 날짜·시각 글자(또는 예전 방식의 숫자) → 밀리초 */
function toMs_(v) {
  if (v instanceof Date) return v.getTime();
  const s = str_(v);
  if (!s) return 0;
  if (/^\d{10,}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}
function digits_(v) { return str_(v).replace(/\D/g, ''); }
/** 시트가 숫자로 바꿔 앞자리 0이 빠진 전화번호(1012345678)도 되살린다 */
function phoneDigits_(v) {
  const d = digits_(v);
  return /^1\d{8,9}$/.test(d) ? '0' + d : d;
}
function fmtPhoneDigits_(d) {
  return d.length === 11 ? d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3') : d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
}
function maskRrn_(d) { return d.slice(0, 6) + '-' + d.charAt(6) + '******'; }
function maskLicense_(d) { return d.slice(0, 2) + '-' + d.slice(2, 4) + '-******-' + d.slice(10, 12); }
function maskAccount_(d) { return new Array(Math.max(0, d.length - 4) + 1).join('*') + d.slice(-4); }
function newDriverId_() {
  return 'D' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
}

// ───────────────────────── 시트 읽기·쓰기 (부분 읽기) ─────────────────────────
/** key 열에서 value 와 정확히 일치하는 첫 행 번호. 없으면 0 */
function findRow_(name, key, value) {
  if (value === '' || value == null) return 0;
  const col = cols_(name)[key];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const cell = sh.getRange(2, col + 1, last - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findNext();
  return cell ? cell.getRow() : 0;
}
/** 한 행을 { key: 글자값 } 객체로 읽는다 (호출 1회) */
function readObj_(name, row) {
  const c = cols_(name);
  let v;
  try { v = sheet_(name).getRange(row, 1, 1, c.__w).getValues()[0]; } catch (e) { return null; }
  const o = { _row: row };
  Object.keys(SCHEMA[name]).forEach(function (k) { o[k] = str_(v[c[k]]); });
  return o;
}
/** 지정한 칸들만 고쳐 쓴다 (다른 칸·사람이 넣은 수식은 건드리지 않음) */
/**
 * 시트가 수식으로 읽지 않도록: = 나 + 로 시작하는 글자는 앞에 공백을 붙여 저장한다.
 * (읽을 때 str_ 가 앞뒤 공백을 지우므로 원래 글자로 돌아온다)
 */
function safeText_(v) {
  return typeof v === 'string' && /^[=+]/.test(v) ? ' ' + v : v;
}
function writeFields_(name, row, fields) {
  const c = cols_(name, true), sh = sheet_(name);
  Object.keys(fields).forEach(function (k) {
    sh.getRange(row, c[k] + 1).setNumberFormat('@').setValue(safeText_(fields[k]));
  });
}
/** 잠금 안에서만 호출: 마지막 행 다음 줄에 객체를 한 번에 쓴다 */
function appendObj_(name, obj) {
  const c = cols_(name, true), sh = sheet_(name);
  const arr = new Array(c.__w).fill('');
  Object.keys(obj).forEach(function (k) { arr[c[k]] = safeText_(obj[k]); });
  const r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
  sh.getRange(r, 1, 1, arr.length).setNumberFormat('@').setValues([arr]);
  return r;
}

/** 아이디로 기사 찾기: 캐시된 행 번호 → 검증 → 실패 시 TextFinder */
function driverByLogin_(loginId) {
  const key = 'lr:' + loginId, hit = cache_().get(key);
  if (hit) {
    const o = readObj_(SH.DRIVERS, Number(hit));
    if (o && o.loginId.toLowerCase() === loginId) return o;
  }
  let row = findRow_(SH.DRIVERS, 'loginId', loginId);
  if (!row) {
    // 사람이 대문자로 입력한 아이디도 찾는다 (대소문자 무시 검색)
    const c = cols_(SH.DRIVERS), sh = sheet_(SH.DRIVERS), last = sh.getLastRow();
    if (last >= 2) {
      const cell = sh.getRange(2, c.loginId + 1, last - 1, 1)
        .createTextFinder(loginId).matchEntireCell(true).matchCase(false).findNext();
      row = cell ? cell.getRow() : 0;
    }
  }
  if (!row) return null;
  cache_().put(key, String(row), CFG.CACHE_MAX);
  return readObj_(SH.DRIVERS, row);
}
function driverById_(id) {
  const key = 'ir:' + id, hit = cache_().get(key);
  if (hit) {
    const o = readObj_(SH.DRIVERS, Number(hit));
    if (o && o.id === id) return o;
  }
  const row = findRow_(SH.DRIVERS, 'id', id);
  if (!row) return null;
  cache_().put(key, String(row), CFG.CACHE_MAX);
  return readObj_(SH.DRIVERS, row);
}
/** 세션 확인용 기사 요약 (10분 캐시, 시트를 고치면 즉시 삭제) */
function driverInfo_(id) {
  const key = 'dv:' + id, hit = cache_().get(key);
  if (hit) return JSON.parse(hit);
  const o = driverById_(id);
  if (!o) return null;
  const info = {
    name: o.name, loginId: o.loginId.toLowerCase(), status: o.status,
    pwChangedAt: toMs_(o.pwChangedAt), mustChange: mustChange_(o)
  };
  cache_().put(key, JSON.stringify(info), 600);
  return info;
}
/**
 * 로그인(세션)이 비밀번호 변경보다 나중에 만들어졌는지.
 * 변경일시가 미래로 기록된 경우(시간대 설정 차이 등)는 무시해서 모든 로그인이 막히지 않게 한다.
 */
function sessionAfterPw_(sessionCreated, pwChangedMs) {
  if (!pwChangedMs || pwChangedMs > Date.now() + 60000) return true;
  return sessionCreated >= pwChangedMs;
}
function mustChange_(o) { return String(o.pwMustChange || '').trim().toUpperCase() === 'Y'; }
function forgetDriver_(o) {
  const keys = [];
  if (o.id) keys.push('dv:' + o.id, 'ir:' + o.id);
  if (o.loginId) keys.push('lr:' + String(o.loginId).toLowerCase());
  if (keys.length) cache_().removeAll(keys);
}

// ───────────────────────── 암호화 / 해시 ─────────────────────────
function arr_(b) { return Array.prototype.slice.call(b); }
function toByte_(x) { x &= 0xff; return x > 127 ? x - 256 : x; }
function int32_(n) { return [toByte_(n >>> 24), toByte_(n >>> 16), toByte_(n >>> 8), toByte_(n)]; }
function key_(name) { return arr_(Utilities.base64Decode(props_()[name])); }
function utf8_(s) { return arr_(Utilities.newBlob(String(s)).getBytes()); }
function randomBytes_(n) {
  let out = [];
  while (out.length < n) {
    out = out.concat(arr_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Date.now())));
  }
  return out.slice(0, n);
}
function hmac_(bytes, key) { return arr_(Utilities.computeHmacSha256Signature(bytes, key)); }
/** 세션 토큰 해시: 't'+16진수. 시트가 수식(+, =)이나 숫자로 해석할 수 없는 모양 */
function tokenHash_(token) {
  return 't' + arr_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)))
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function sha256b64_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))); }

/** HMAC-SHA256 카운터 모드 키스트림 */
function xorStream_(key, iv, data) {
  const out = new Array(data.length);
  let block = null, ctr = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % 32 === 0) block = hmac_(iv.concat(int32_(ctr++)), key);
    out[i] = toByte_(data[i] ^ block[i % 32]);
  }
  return out;
}
/** 암호화 후 MAC (encrypt-then-MAC). 결과: "v1:" + base64(iv|암호문|태그) */
function encrypt_(plain) {
  if (plain === '' || plain == null) return '';
  const iv = randomBytes_(16);
  const ct = xorStream_(key_('ENC_KEY'), iv, utf8_(plain));
  const tag = hmac_(iv.concat(ct), key_('MAC_KEY')).slice(0, 16);
  return 'v1:' + Utilities.base64Encode(iv.concat(ct, tag));
}
function decrypt_(enc) {
  if (!enc || String(enc).indexOf('v1:') !== 0) return '';
  const all = arr_(Utilities.base64Decode(String(enc).slice(3)));
  const iv = all.slice(0, 16), ct = all.slice(16, all.length - 16), tag = all.slice(all.length - 16);
  const expect = hmac_(iv.concat(ct), key_('MAC_KEY')).slice(0, 16);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= (expect[i] ^ tag[i]);
  if (diff !== 0) throw new Error('암호문 무결성 검증 실패');
  return Utilities.newBlob(xorStream_(key_('ENC_KEY'), iv, ct)).getDataAsString('UTF-8');
}
/** 검색용 단방향 키 (같은 주민번호 → 같은 값) */
function blindIndex_(label, value) {
  return Utilities.base64Encode(hmac_(utf8_(label + ':' + value), key_('MAC_KEY')));
}
function hashPassword_(pw, saltB64) {
  const pepper = key_('PEPPER');
  let h = hmac_(arr_(Utilities.base64Decode(saltB64)).concat(utf8_(pw)), pepper);
  for (let i = 0; i < CFG.PW_ITER; i++) h = hmac_(h, pepper);
  return Utilities.base64Encode(h);
}
function passwordFields_(pw) {
  const salt = Utilities.base64Encode(randomBytes_(16));
  return { pwHash: hashPassword_(pw, salt), pwSalt: salt, pwChangedAt: nowText_() };
}
function checkPassword_(pw, o) {
  if (!o.pwSalt || !o.pwHash) return false;
  const a = hashPassword_(pw, o.pwSalt), b = o.pwHash;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function newToken_() { return Utilities.base64EncodeWebSafe(randomBytes_(32)).replace(/=+$/, ''); }

// ───────────────────────── 입력 검증 ─────────────────────────
function normLoginId_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!/^[^\s]{3,100}$/.test(s)) fail_('쿠팡플렉스 아이디를 확인해 주세요.');
  return s;
}
function fmtPhone_(v) {
  const d = phoneDigits_(v);
  if (!/^01\d{8,9}$/.test(d)) fail_('연락처를 확인해 주세요. (예: 010-1234-5678)');
  return fmtPhoneDigits_(d);
}
function pwValid_(pw) { pw = String(pw || ''); return pw.length >= 8 && pw.length <= 30 && /[A-Za-z]/.test(pw) && /\d/.test(pw); }
function checkPw_(pw) {
  if (!pwValid_(pw)) fail_('비밀번호는 영문과 숫자를 포함해 8~30자로 입력해 주세요.');
  return String(pw);
}
/** 주민등록번호 → { digits, birth(YYYY-MM-DD) } */
function parseRrn_(v) {
  const d = digits_(v);
  if (d.length !== 13) fail_('주민등록번호 13자리를 확인해 주세요.');
  const g = d.charAt(6);
  const century = (g === '1' || g === '2' || g === '5' || g === '6') ? 1900
    : (g === '3' || g === '4' || g === '7' || g === '8') ? 2000
    : (g === '9' || g === '0') ? 1800 : 0;
  if (!century) fail_('주민등록번호 뒷자리 첫 숫자를 확인해 주세요.');
  const y = century + Number(d.substr(0, 2)), m = Number(d.substr(2, 2)), day = Number(d.substr(4, 2));
  const dt = new Date(y, m - 1, day);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== day) fail_('주민등록번호 앞자리(생년월일)를 확인해 주세요.');
  return { digits: d, birth: y + '-' + ('0' + m).slice(-2) + '-' + ('0' + day).slice(-2) };
}
function req_(v, label, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) fail_(label + '을(를) 입력해 주세요.');
  if (s.length > (max || 200)) fail_(label + '이(가) 너무 깁니다.');
  return s;
}
const LICENSE_TYPES = ['1종 대형', '1종 보통', '2종 보통', '특수 대형견인', '특수 소형견인'];

function validateSignup_(f) {
  f = f || {};
  const out = {};
  out.loginId = normLoginId_(f.loginId);
  out.password = checkPw_(f.password);
  out.name = req_(f.name, '이름', 30);
  const rrn = parseRrn_(f.rrn);
  out.rrnDigits = rrn.digits;
  out.birthDate = rrn.birth;
  out.address = req_(f.address, '주소', 200);
  out.phone = fmtPhone_(f.phone);
  out.qualDate = req_(f.qualDate, '화물운송 종사자격 취득일', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.qualDate)) fail_('자격 취득일을 확인해 주세요.');
  out.qualNo = req_(f.qualNo, '화물운송 종사자격증 번호', 30);
  out.licenseDigits = digits_(req_(f.licenseNo, '자동차운전면허 번호', 30));
  if (out.licenseDigits.length !== 12) fail_('운전면허 번호 12자리를 확인해 주세요. (예: 11-10-123456-12)');
  out.licenseType = req_(f.licenseType, '운전면허 종류', 20);
  if (LICENSE_TYPES.indexOf(out.licenseType) < 0) fail_('운전면허 종류를 선택해 주세요.');
  out.carName = req_(f.carName, '차명', 40);
  out.carYear = req_(f.carYear, '연식', 4);
  if (!/^(19|20)\d{2}$/.test(out.carYear)) fail_('연식을 확인해 주세요.');
  out.maxLoad = req_(f.maxLoad, '최대적재량', 6);
  if (!/^\d{1,6}$/.test(out.maxLoad)) fail_('최대적재량은 kg 단위 숫자로 입력해 주세요.');
  out.bankName = req_(f.bankName, '은행명', 20);
  out.account = digits_(req_(f.account, '계좌번호', 30));
  if (out.account.length < 8 || out.account.length > 16) fail_('계좌번호를 확인해 주세요.');
  out.accountHolder = req_(f.accountHolder, '예금주', 30);
  if (f.agree !== true) fail_('개인정보 수집·이용에 동의해 주세요.');
  return out;
}

// ───────────────────────── API : 공통 ─────────────────────────
/** 화면을 열 때 서버를 미리 깨워 첫 요청 지연을 줄인다. */
function api_ping() { return { ok: true }; }

function api_checkLoginId(loginId) {
  return run_(function () {
    const id = normLoginId_(loginId);
    return { ok: true, available: !driverByLogin_(id) };
  });
}

// ───────────────────────── API : 로그인 / 세션 ─────────────────────────
function api_login(loginId, password, auto) {
  return run_(function () {
    const id = normLoginId_(loginId);
    if (!password) fail_('비밀번호를 입력해 주세요.');
    const fk = 'lf:' + id;
    const fails = Number(cache_().get(fk) || 0);
    if (fails >= CFG.LOGIN_MAX_FAIL) fail_('로그인 실패가 반복되어 15분간 잠겼습니다. 잠시 후 다시 시도해 주세요.');

    // 로그인은 항상 시트의 최신 행을 읽는다 → 시트에서 고친 상태·비밀번호가 즉시 반영
    const o = driverByLogin_(id);
    if (!o || !checkPassword_(String(password), o)) {
      cache_().put(fk, String(fails + 1), 900);
      fail_('아이디 또는 비밀번호가 맞지 않습니다.');
    }
    cache_().remove(fk);

    if (o.status === ST.PENDING) return { ok: false, code: 'PENDING', msg: '가입 승인 대기 중입니다. 관리자 승인 후 로그인할 수 있습니다.' };
    if (o.status === ST.REJECTED) return { ok: false, code: 'REJECTED', msg: '가입이 반려되었습니다. 관리자에게 문의해 주세요.' };
    if (o.status !== ST.ACTIVE) fail_('사용이 중지된 계정입니다. 관리자에게 문의해 주세요.');

    const s = createSession_(o.id, auto === true);
    return { ok: true, token: s.token, expiresAt: s.expiresAt, mustChange: mustChange_(o), user: { name: o.name, loginId: id } };
  });
}

function createSession_(driverId, auto) {
  const token = newToken_();
  const th = tokenHash_(token);
  const now = Date.now();
  const exp = now + (auto ? CFG.SESSION_AUTO_DAYS * 864e5 : CFG.SESSION_HOURS * 36e5);
  const c = cols_(SH.SESSIONS);
  const arr = new Array(c.__w).fill('');
  arr[c.tokenHash] = th; arr[c.driverId] = driverId; arr[c.createdAt] = msText_(now);
  arr[c.expiresAt] = msText_(exp); arr[c.auto] = auto ? 'Y' : 'N';
  sheet_(SH.SESSIONS).appendRow(arr); // 동시 로그인에도 안전한 원자적 추가
  cache_().put('ss:' + th, JSON.stringify({ d: driverId, c: now, e: exp, a: auto ? 1 : 0 }), sessTtl_(exp));
  return { token: token, expiresAt: exp };
}
function sessTtl_(exp) { return Math.max(1, Math.min(CFG.SESS_CACHE, Math.floor((exp - Date.now()) / 1000))); }

function getSession_(token) {
  if (!token || String(token).length > 200) return null;
  const th = tokenHash_(token);
  let s = cache_().get('ss:' + th);
  if (s) s = JSON.parse(s);
  else {
    const row = findRow_(SH.SESSIONS, 'tokenHash', th);
    if (!row) return null;
    const o = readObj_(SH.SESSIONS, row);
    if (!o) return null;
    // 생성일시는 초 단위로 저장되므로 같은 초 안의 비밀번호 변경과 비교할 때 1초 여유를 둔다
    s = { d: o.driverId, c: toMs_(o.createdAt) + 999, e: toMs_(o.expiresAt), a: o.auto === 'Y' ? 1 : 0 };
    if (s.e > Date.now()) cache_().put('ss:' + th, JSON.stringify(s), sessTtl_(s.e));
  }
  if (!(s.e > Date.now())) return null;
  s.th = th;
  return s;
}

/** 자동 로그인 확인: 대부분 캐시만으로 끝난다 (시트 접근 0회) */
function api_checkSession(token) {
  return run_(function () {
    const s = getSession_(token);
    if (!s) return { ok: false, code: 'EXPIRED' };
    const info = driverInfo_(s.d);
    if (!info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { ok: false, code: 'EXPIRED' };
    return { ok: true, mustChange: !!info.mustChange, user: { name: info.name, loginId: info.loginId } };
  });
}

function api_logout(token) {
  return run_(function () {
    if (!token) return { ok: true };
    const th = tokenHash_(token);
    cache_().remove('ss:' + th);
    const row = findRow_(SH.SESSIONS, 'tokenHash', th);
    if (row) writeFields_(SH.SESSIONS, row, { expiresAt: nowText_() });
    return { ok: true };
  });
}

// ───────────────────────── API : 회원가입 ─────────────────────────
/**
 * @param {Object} form  입력값
 * @param {Object} files { qual|license|biz|car : { data(base64), mime } }
 */
function api_signup(form, files) {
  return run_(function () {
    const f = validateSignup_(form);
    files = files || {};
    Object.keys(DOCS).forEach(function (k) {
      const x = files[k];
      if (!x || !x.data) fail_(DOCS[k].label + ' 이미지를 올려 주세요.');
      if (!/^image\//.test(String(x.mime))) fail_(DOCS[k].label + '는 이미지 파일만 올릴 수 있습니다.');
      if (String(x.data).length > CFG.MAX_FILE_B64) fail_(DOCS[k].label + ' 이미지가 너무 큽니다.');
    });

    const rrnIdx = blindIndex_('rrn', f.rrnDigits);

    // 1) 빠른 중복 검사 (잠금 없이)
    if (driverByLogin_(f.loginId)) fail_('이미 가입된 쿠팡플렉스 아이디입니다.');
    if (findRow_(SH.DRIVERS, 'rrnIndex', rrnIdx)) fail_('이미 가입된 기사입니다. 비밀번호 찾기를 이용해 주세요.');

    // 2) 서류 업로드 (잠금 밖에서 처리해 다른 사용자를 기다리게 하지 않음)
    const driverId = newDriverId_();
    const parent = DriveApp.getFolderById(props_().DOCS_FOLDER_ID);
    const folder = parent.createFolder(f.name + '_' + f.loginId + '_' + driverId);
    const urls = {};
    try {
      const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd');
      Object.keys(DOCS).forEach(function (k) {
        const blob = Utilities.newBlob(Utilities.base64Decode(files[k].data), files[k].mime,
          f.name + '_' + DOCS[k].label + '_' + stamp + '.jpg');
        urls[k] = folder.createFile(blob).getUrl();
      });
    } catch (e) {
      folder.setTrashed(true);
      throw e;
    }

    // 3) 저장 (짧게 잠금 → 재확인 → 한 줄 추가)
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (findRow_(SH.DRIVERS, 'loginId', f.loginId) || findRow_(SH.DRIVERS, 'rrnIndex', rrnIdx)) {
        folder.setTrashed(true);
        fail_('이미 가입된 정보입니다. 로그인 또는 비밀번호 찾기를 이용해 주세요.');
      }
      const now = nowText_();
      const pw = passwordFields_(f.password);
      const row = appendObj_(SH.DRIVERS, {
        id: driverId, loginId: f.loginId, name: f.name, phone: f.phone, status: ST.PENDING,
        birthDate: f.birthDate, rrn: maskRrn_(f.rrnDigits), address: f.address,
        qualDate: f.qualDate, qualNo: f.qualNo,
        licenseNo: maskLicense_(f.licenseDigits), licenseType: f.licenseType,
        carName: f.carName, carYear: f.carYear, maxLoad: f.maxLoad,
        bankName: f.bankName, account: maskAccount_(f.account), accountHolder: f.accountHolder,
        docQual: urls.qual, docLicense: urls.license, docBiz: urls.biz, docCar: urls.car, docFolder: folder.getUrl(),
        createdAt: now, updatedAt: now, pwChangedAt: pw.pwChangedAt,
        rrnEnc: encrypt_(f.rrnDigits.replace(/(\d{6})(\d{7})/, '$1-$2')), rrnIndex: rrnIdx,
        licenseNoEnc: encrypt_(f.licenseDigits.replace(/(\d{2})(\d{2})(\d{6})(\d{2})/, '$1-$2-$3-$4')),
        accountEnc: encrypt_(f.account),
        pwHash: pw.pwHash, pwSalt: pw.pwSalt
      });
      const put = {};
      put['lr:' + f.loginId] = String(row);
      put['ir:' + driverId] = String(row);
      cache_().putAll(put, CFG.CACHE_MAX);
    } finally {
      lock.releaseLock();
    }
    return { ok: true, msg: '가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.' };
  });
}

// ───────────────────────── API : 비밀번호 찾기 ─────────────────────────
/** 은행명 비교: 띄어쓰기와 끝의 "은행" 글자는 무시 (예: "신한" = "신한은행") */
function sameBank_(a, b) {
  const n = function (s) { return String(s || '').replace(/\s/g, '').replace(/은행$/, ''); };
  return !!n(a) && n(a) === n(b);
}
/** 등록된 계좌번호(암호화)와 입력값 비교 */
function sameAccount_(o, account) {
  const input = digits_(account);
  if (!input || !o.accountEnc) return false;
  try { return digits_(decrypt_(o.accountEnc)) === input; } catch (e) { return false; }
}

/** 1단계 본인 확인: 아이디 + 이름 + 연락처 + 생년월일(6자리) + 은행명 + 계좌번호 */
function api_resetVerify(loginId, name, phone, birth6, bankName, account) {
  return run_(function () {
    const id = normLoginId_(loginId);
    const rk = 'rf:' + id;
    const tries = Number(cache_().get(rk) || 0);
    if (tries >= CFG.RESET_MAX_TRY) fail_('본인 확인 시도가 많아 30분간 잠겼습니다. 잠시 후 다시 시도해 주세요.');

    const o = driverByLogin_(id);
    const ok = o &&
      o.name === String(name || '').trim() &&
      phoneDigits_(o.phone) === phoneDigits_(phone) &&
      digits_(o.birthDate).slice(2) === digits_(birth6) &&
      sameBank_(o.bankName, bankName) &&
      sameAccount_(o, account) &&
      o.status !== ST.STOPPED;
    if (!ok) {
      cache_().put(rk, String(tries + 1), 1800);
      fail_('입력한 정보와 일치하는 회원이 없습니다. 계속 안 되면 관리자에게 문의해 주세요.');
    }
    cache_().remove(rk);
    const t = newToken_();
    cache_().put('rt:' + sha256b64_(t), o.id, CFG.RESET_TOKEN_SEC);
    return { ok: true, resetToken: t };
  });
}

/** 2단계 새 비밀번호 저장. 기존 로그인(자동 로그인 포함)은 모두 만료된다. */
function api_resetPassword(resetToken, newPassword) {
  return run_(function () {
    const pw = checkPw_(newPassword);
    const key = 'rt:' + sha256b64_(String(resetToken || ''));
    const driverId = cache_().get(key);
    if (!driverId) fail_('재설정 시간이 지났습니다. 본인 확인을 다시 해 주세요.');
    cache_().remove(key);

    const o = driverById_(driverId);
    if (!o) fail_('회원 정보를 찾을 수 없습니다.');
    const fields = passwordFields_(pw);
    fields.updatedAt = fields.pwChangedAt;
    fields.pwMustChange = '';
    writeFields_(SH.DRIVERS, o._row, fields);
    forgetDriver_(o);
    return { ok: true, msg: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.' };
  });
}

// ───────────────────────── API : 비밀번호 변경 (로그인 상태) ─────────────────────────
/**
 * 현재 비밀번호 확인 후 새 비밀번호로 바꾼다.
 * 다른 기기의 로그인은 모두 해제되고, 지금 기기는 새 로그인 토큰으로 계속 사용한다.
 */
function api_changePassword(token, currentPassword, newPassword) {
  return run_(function () {
    const expired = { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    const s = getSession_(token);
    if (!s) return expired;
    const pw = checkPw_(newPassword);
    const o = driverById_(s.d);
    if (!o || o.status !== ST.ACTIVE || !sessionAfterPw_(s.c, toMs_(o.pwChangedAt))) return expired;

    const fk = 'cf:' + o.id;
    const fails = Number(cache_().get(fk) || 0);
    if (fails >= CFG.LOGIN_MAX_FAIL) fail_('비밀번호 확인 실패가 반복되어 15분간 잠겼습니다.');
    if (!checkPassword_(String(currentPassword || ''), o)) {
      cache_().put(fk, String(fails + 1), 900);
      fail_('현재 비밀번호가 맞지 않습니다.');
    }
    cache_().remove(fk);
    if (pw === String(currentPassword)) fail_('새 비밀번호는 현재 비밀번호와 다르게 정해 주세요.');

    const fields = passwordFields_(pw);
    fields.updatedAt = fields.pwChangedAt;
    fields.pwMustChange = '';
    writeFields_(SH.DRIVERS, o._row, fields);
    forgetDriver_(o);
    // 지금 쓰던 로그인은 바로 만료시키고 새 로그인으로 교체
    cache_().remove('ss:' + s.th);
    const oldRow = findRow_(SH.SESSIONS, 'tokenHash', s.th);
    if (oldRow) writeFields_(SH.SESSIONS, oldRow, { expiresAt: msText_(Date.now() - 1000) });
    const ns = createSession_(o.id, !!s.a);
    return { ok: true, token: ns.token, expiresAt: ns.expiresAt, msg: '비밀번호가 변경되었습니다.' };
  });
}

// ───────────────────────── 시트 직접 수정 처리 (설치형 트리거) ─────────────────────────
/**
 * 시트에서 칸을 고치면 실행된다 (setup 이 설치).
 * - 아이디 소문자 정리, 연락처 형식 정리, 새 줄이면 기사ID·가입일시 자동 입력
 * - 주민등록번호/운전면허번호/계좌번호에 새 번호 입력 → 자동 암호화 후 가린 번호로 표시
 * - 비밀번호 재설정 칸 입력 → 비밀번호 적용 후 칸 비움
 * - 상태를 '승인'으로 바꾸면 승인일시 기록
 * - 해당 기사 캐시 삭제 → 앱에 즉시 반영
 */
function onSheetEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  if (name === TOOLS.SHEET) { onToolsEdit_(e, sh); return; }
  if (!SCHEMA[name] || name === SH.ALOG) return;
  _sheets[name] = sh;
  _ss = sh.getParent();
  const r0 = e.range.getRow(), n = e.range.getNumRows();
  if (r0 === 1) {
    clearHeadCache_(name);
    if (AUTO_SHEETS.indexOf(name) >= 0) bumpMaster_();
    if (n === 1) return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const c = cols_(name, true);
    const start = Math.max(2, r0), end = Math.min(r0 + n - 1, start + 199);
    if (end < start) return;
    const block = sh.getRange(start, 1, end - start + 1, c.__w).getValues();
    let campRenamed = false;
    _campIdx = null; _routeList = null;
    block.forEach(function (v, i) {
      const o = { _row: start + i };
      Object.keys(SCHEMA[name]).forEach(function (k) { o[k] = str_(v[c[k]]); });
      if (name === SH.DRIVERS) fixDriverRow_(sh, c, o);
      else if (name === SH.ADMINS) fixAdminRow_(sh, c, o);
      else if (name === SH.MEMO) fixMemoRow_(sh, c, o);
      else if (name === SH.BIB) fixBibRow_(sh, c, o);
      else if (name === SH.CAMPS) { fixCampRow_(sh, c, o); campRenamed = true; }
      else if (name === SH.ROUTES) fixRouteRow_(sh, c, o);
      else if (name === SH.CIMG) fixCampImageRow_(sh, c, o);
      else if (name === SH.CADDR) fixCampAddrRow_(sh, c, o);
      else if (name === SH.PRICES) fixPriceRow_(sh, c, o);
      else if (name === SH.SESSIONS) cache_().remove('ss:' + o.tokenHash);
    });
    if (campRenamed) syncCampNames_();
  } finally {
    if (AUTO_SHEETS.indexOf(name) >= 0) bumpMaster_();
    lock.releaseLock();
  }
}

function fixDriverRow_(sh, c, o) {
  if (!o.id && !o.loginId && !o.name) return; // 빈 줄
  const upd = {}, notes = {};
  const set = function (k, val) { if (o[k] !== val) upd[k] = val; };
  const bad = function (k, msg) { notes[k] = msg; };

  const lid = o.loginId.toLowerCase();
  set('loginId', lid);
  if (!o.id && (lid || o.name)) { set('id', newDriverId_()); if (!o.createdAt) set('createdAt', nowText_()); }
  if (o.driverType) {
    const t = normDriverType_(o.driverType);
    if (t) set('driverType', t); else bad('driverType', DTYPES.join(' / ') + ' 중 하나로 입력해 주세요.');
  }
  if (o.driverCode) {
    const code = normDriverCode_(o.driverCode);
    if (code === null) bad('driverCode', '영문·숫자·한글·- 만, 20자 이내로 써 주세요.');
    else {
      set('driverCode', code);
      const last = sh.getLastRow();
      const same = sh.getRange(2, c.driverCode + 1, Math.max(last - 1, 1), 1).getValues()
        .filter(function (v, i) { return i + 2 !== o._row && normDriverCode_(v[0]) === code; }).length;
      if (same) bad('driverCode', '같은 기사코드를 쓰는 기사가 또 있습니다.');
    }
  }
  if (!o.status) set('status', ST.PENDING);
  if (o.status === ST.ACTIVE && !o.approvedAt) set('approvedAt', nowText_());

  const ph = phoneDigits_(o.phone);
  if (o.phone) { if (/^01\d{8,9}$/.test(ph)) set('phone', fmtPhoneDigits_(ph)); else bad('phone', '연락처 형식을 확인해 주세요.'); }

  // 주민등록번호: 가린 번호(*)가 아니면 새로 입력한 값으로 본다
  if (o.rrn && o.rrn.indexOf('*') < 0) {
    try {
      const p = parseRrn_(o.rrn);
      set('rrnEnc', encrypt_(p.digits.replace(/(\d{6})(\d{7})/, '$1-$2')));
      set('rrnIndex', blindIndex_('rrn', p.digits));
      set('birthDate', p.birth);
      set('rrn', maskRrn_(p.digits));
    } catch (err) { bad('rrn', err.userMsg || '주민등록번호를 확인해 주세요.'); }
  } else if (!o.rrn && o.rrnEnc) { set('rrnEnc', ''); set('rrnIndex', ''); }

  if (o.licenseNo && o.licenseNo.indexOf('*') < 0) {
    const d = digits_(o.licenseNo);
    if (d.length === 12) {
      set('licenseNoEnc', encrypt_(d.replace(/(\d{2})(\d{2})(\d{6})(\d{2})/, '$1-$2-$3-$4')));
      set('licenseNo', maskLicense_(d));
    } else bad('licenseNo', '운전면허번호 12자리를 입력해 주세요.');
  } else if (!o.licenseNo && o.licenseNoEnc) set('licenseNoEnc', '');

  if (o.account && o.account.indexOf('*') < 0) {
    const d = digits_(o.account);
    if (d.length >= 8 && d.length <= 16) {
      set('accountEnc', encrypt_(d));
      set('account', maskAccount_(d));
    } else bad('account', '계좌번호(숫자 8~16자리)를 확인해 주세요.');
  } else if (!o.account && o.accountEnc) set('accountEnc', '');

  if (o.pwReset) {
    if (pwValid_(o.pwReset)) {
      const pf = passwordFields_(o.pwReset);
      Object.keys(pf).forEach(function (k) { upd[k] = pf[k]; });
      upd.pwMustChange = 'Y'; // 임시 비밀번호 → 다음 로그인 때 기사가 직접 변경
    } else bad('pwReset', '적용 안 됨: 영문과 숫자를 포함해 8~30자로 입력해 주세요.');
    upd.pwReset = ''; // 비밀번호 원문은 시트에 남기지 않는다
  }

  if (Object.keys(upd).length) {
    upd.updatedAt = nowText_();
    Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(upd[k]); });
  }
  ['phone', 'rrn', 'licenseNo', 'account', 'pwReset', 'driverType', 'driverCode'].forEach(function (k) {
    const cell = sh.getRange(o._row, c[k] + 1);
    if (notes[k]) cell.setNote(notes[k]);
    else if (o[k] !== '' || upd[k] !== undefined) cell.clearNote();
  });

  forgetDriver_(o);
  if (upd.loginId) forgetDriver_({ loginId: upd.loginId });
}

// ───────────────────────── 관리자 : 계정 / 로그인 ─────────────────────────
// 관리자 로그인 기록은 sessions 시트의 기사ID 칸에 "admin:관리자ID" 로 남는다 (기사 로그인과 구분)
const ADMIN_SESSION = 'admin:';
function newAdminId_() {
  return 'A' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
}
function expired_() {
  const e = new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
  e.userMsg = e.message; e.code = 'EXPIRED';
  throw e;
}
function adminByLogin_(loginId) {
  let row = findRow_(SH.ADMINS, 'loginId', loginId);
  if (!row) {
    const c = cols_(SH.ADMINS), sh = sheet_(SH.ADMINS), last = sh.getLastRow();
    if (last >= 2) {
      const cell = sh.getRange(2, c.loginId + 1, last - 1, 1)
        .createTextFinder(loginId).matchEntireCell(true).matchCase(false).findNext();
      row = cell ? cell.getRow() : 0;
    }
  }
  return row ? readObj_(SH.ADMINS, row) : null;
}
/** 관리자 요약 (10분 캐시, admins 시트를 고치면 즉시 삭제) */
function adminInfo_(id) {
  const key = 'av:' + id, hit = cache_().get(key);
  if (hit) return JSON.parse(hit);
  const row = findRow_(SH.ADMINS, 'id', id);
  if (!row) return null;
  const o = readObj_(SH.ADMINS, row);
  const info = { id: o.id, name: o.name, loginId: o.loginId.toLowerCase(), status: o.status, pwChangedAt: toMs_(o.pwChangedAt) };
  cache_().put(key, JSON.stringify(info), 600);
  return info;
}
/** 모든 관리자 API 의 첫 줄: 로그인 확인 */
function requireAdmin_(token) {
  const s = getSession_(token);
  const d = s ? String(s.d) : '';
  if (d.indexOf(ADMIN_SESSION) !== 0) expired_();
  const a = adminInfo_(d.slice(ADMIN_SESSION.length));
  if (!a || a.status !== AST.ACTIVE || !sessionAfterPw_(s.c, a.pwChangedAt)) expired_();
  return a;
}
/** 관리자 작업 기록 (개인정보 열람·수정 추적용) */
function logAdmin_(a, action, target, detail) {
  try {
    sheet_(SH.ALOG).appendRow([nowText_(), a.name + ' (' + a.loginId + ')', action, target || '', detail || '']);
  } catch (e) { console.error(e); }
}

function adm_login(loginId, password, auto) {
  return run_(function () {
    const id = normLoginId_(loginId);
    if (!password) fail_('비밀번호를 입력해 주세요.');
    const fk = 'alf:' + id;
    const fails = Number(cache_().get(fk) || 0);
    if (fails >= CFG.LOGIN_MAX_FAIL) fail_('로그인 실패가 반복되어 15분간 잠겼습니다. 잠시 후 다시 시도해 주세요.');
    const o = adminByLogin_(id);
    if (!o || !checkPassword_(String(password), o)) {
      cache_().put(fk, String(fails + 1), 900);
      fail_('아이디 또는 비밀번호가 맞지 않습니다.');
    }
    cache_().remove(fk);
    if (o.status !== AST.ACTIVE) fail_('사용이 중지된 관리자 계정입니다.');
    if (!o.id) fail_('관리자ID가 비어 있습니다. admins 시트의 관리자ID 칸을 채워 주세요.');
    const s = createSession_(ADMIN_SESSION + o.id, auto === true);
    writeFields_(SH.ADMINS, o._row, { lastLoginAt: nowText_() });
    return { ok: true, token: s.token, admin: { name: o.name, loginId: o.loginId.toLowerCase() } };
  });
}
function adm_check(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    return { ok: true, admin: { name: a.name, loginId: a.loginId } };
  });
}
function adm_logout(token) { return api_logout(token); }

/** admins 시트를 직접 고쳤을 때: 아이디 정리, 관리자ID·생성일시 자동, 비밀번호 적용 */
function fixAdminRow_(sh, c, o) {
  if (!o.id && !o.loginId && !o.name) return;
  const upd = {};
  const set = function (k, v) { if (o[k] !== v) upd[k] = v; };
  const lid = o.loginId.toLowerCase();
  set('loginId', lid);
  if (!o.id && lid) { set('id', newAdminId_()); if (!o.createdAt) set('createdAt', nowText_()); }
  if (!o.status) set('status', AST.ACTIVE);
  let note = '';
  if (o.pwReset) {
    if (pwValid_(o.pwReset)) {
      const pf = passwordFields_(o.pwReset);
      Object.keys(pf).forEach(function (k) { upd[k] = pf[k]; });
    } else note = '적용 안 됨: 영문과 숫자를 포함해 8~30자로 입력해 주세요.';
    upd.pwReset = '';
  }
  Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(upd[k]); });
  const cell = sh.getRange(o._row, c.pwReset + 1);
  if (note) cell.setNote(note); else if (o.pwReset) cell.clearNote();
  if (o.id) cache_().remove('av:' + o.id);
  if (upd.id) cache_().remove('av:' + upd.id);
}

// ───────────────────────── 관리자 : 기사 정보관리 ─────────────────────────
const D_EDIT_LABEL = {
  loginId: '쿠팡플렉스 아이디', name: '이름', phone: '연락처', status: '상태', address: '주소',
  driverType: '기사구분', driverCode: '기사코드',
  qualDate: '자격 취득일', qualNo: '자격증 번호', licenseType: '면허 종류', carName: '차명', carYear: '연식',
  maxLoad: '최대적재량', carNo: '차량번호', bankName: '은행명', accountHolder: '예금주', memo: '관리자 메모',
  rrn: '주민등록번호', licenseNo: '운전면허번호', account: '계좌번호'
};
const SENSITIVE = { rrn: 'rrnEnc', licenseNo: 'licenseNoEnc', account: 'accountEnc' };

function docsOf_(o) {
  const out = {};
  Object.keys(DOCS).forEach(function (k) { out[k] = !!o[DOCS[k].col]; });
  return out;
}
/** 목록용 요약 */
function listRow_(o) {
  return {
    id: o.id, loginId: o.loginId, name: o.name, phone: o.phone, status: o.status,
    driverType: o.driverType, driverCode: o.driverCode,
    createdAt: o.createdAt, approvedAt: o.approvedAt, carNo: o.carNo, carName: o.carName, carYear: o.carYear,
    docs: docsOf_(o), mustChange: mustChange_(o), hasPw: !!o.pwHash, memo: o.memo
  };
}
/** 행 내용 지문: 화면이 불러온 뒤 시트나 다른 관리자가 고쳤는지 확인하는 용도 */
function rev_(o) {
  return sha256b64_(Object.keys(D).map(function (k) { return k === 'pwReset' ? '' : o[k]; }).join('\u0001')).slice(0, 16);
}
/** 상세용 (민감정보는 가린 값만) */
function detailOf_(o) {
  const out = listRow_(o);
  ['birthDate', 'address', 'qualDate', 'qualNo', 'licenseType', 'maxLoad', 'bankName', 'accountHolder',
    'updatedAt', 'pwChangedAt', 'docFolder'].forEach(function (k) { out[k] = o[k]; });
  out.rrn = o.rrn; out.licenseNo = o.licenseNo; out.account = o.account;
  out.has = { rrn: !!o.rrnEnc, licenseNo: !!o.licenseNoEnc, account: !!o.accountEnc };
  out.rev = rev_(o);
  return out;
}

/** 기사 전체 목록: 시트를 한 번에 읽는다 (호출 1회) */
function adm_listDrivers(token) {
  return run_(function () {
    requireAdmin_(token);
    const sh = sheet_(SH.DRIVERS), c = cols_(SH.DRIVERS), last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
    const keys = Object.keys(D), list = [], counts = { all: 0 };
    [ST.PENDING, ST.ACTIVE, ST.REJECTED, ST.STOPPED].forEach(function (k) { counts[k] = 0; });
    rows.forEach(function (v) {
      const o = {};
      keys.forEach(function (k) { o[k] = str_(v[c[k]]); });
      if (!o.id && !o.loginId && !o.name) return;
      list.push(listRow_(o));
      counts.all++;
      if (counts[o.status] !== undefined) counts[o.status]++;
    });
    list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
    return { ok: true, rows: list, counts: counts };
  });
}

function adm_getDriver(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const o = driverById_(String(id || ''));
    if (!o) fail_('기사를 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    return { ok: true, driver: detailOf_(o) };
  });
}

/** 주민등록번호·운전면허번호·계좌번호 전체 보기 (기록 남김) */
function adm_reveal(token, id, field) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!SENSITIVE[field]) fail_('알 수 없는 항목입니다.');
    const o = driverById_(String(id || ''));
    if (!o) fail_('기사를 찾을 수 없습니다.');
    const v = decrypt_(o[SENSITIVE[field]]);
    logAdmin_(a, '개인정보 열람', o.name + ' (' + o.id + ')', D_EDIT_LABEL[field]);
    return { ok: true, value: v };
  });
}

/**
 * 기사 정보 수정
 * @param changes  바뀐 항목만 { key: 값 }. 민감정보(rrn/licenseNo/account)는 새 전체 번호.
 * @param seenRev 화면이 불러온 시점의 행 지문 (그 뒤 다른 곳에서 고쳤으면 거절)
 */
function adm_updateDriver(token, id, changes, seenRev) {
  return run_(function () {
    const a = requireAdmin_(token);
    changes = changes || {};
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const o = driverById_(String(id || ''));
      if (!o) fail_('기사를 찾을 수 없습니다. 목록을 새로고침해 주세요.');
      if (seenRev && String(seenRev) !== rev_(o)) {
        fail_('다른 곳(시트 또는 다른 관리자)에서 먼저 수정되었습니다. 새로고침 후 다시 수정해 주세요.');
      }
      const r = driverFields_(changes, o), f = r.f, changed = r.changed;
      if (!changed.length) return { ok: true, driver: detailOf_(o) };
      f.updatedAt = nowText_();
      writeFields_(SH.DRIVERS, o._row, f);
      forgetDriver_(o);
      if (f.loginId) forgetDriver_({ loginId: f.loginId });
      logAdmin_(a, '기사 정보 수정', o.name + ' (' + o.id + ')', changed.join(', ') +
        (f.status ? ' → ' + f.status : ''));
      const fresh = readObj_(SH.DRIVERS, o._row);
      return { ok: true, driver: detailOf_(fresh) };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * 관리자 화면에서 받은 기사 항목 검사·정리 (수정·등록 공용).
 * o = 지금 저장된 기사 (새 등록이면 빈 객체). 반환: { f: 시트에 쓸 칸들, changed: 바뀐 항목 이름 }
 */
function driverFields_(changes, o) {
  const f = {}, changed = [];
  const opt = function (v, label, max) {
    const s = String(v == null ? '' : v).trim();
    if (s.length > (max || 200)) fail_(label + '이(가) 너무 깁니다.');
    return s;
  };
  Object.keys(changes).forEach(function (k) {
    if (!D_EDIT_LABEL[k]) return;
    const v = changes[k];
    switch (k) {
      case 'loginId': {
        if (!String(v == null ? '' : v).trim()) { f.loginId = ''; break; }
        const lid = normLoginId_(v);
        if (lid !== String(o.loginId || '').toLowerCase()) {
          const other = driverByLogin_(lid);
          if (other && other.id !== o.id) fail_('이미 다른 기사가 쓰는 쿠팡플렉스 아이디입니다.');
        }
        f.loginId = lid; break;
      }
      case 'name': f.name = req_(v, '이름', 30); break;
      case 'phone': f.phone = fmtPhone_(v); break;
      case 'status':
        if ([ST.PENDING, ST.ACTIVE, ST.REJECTED, ST.STOPPED].indexOf(v) < 0) fail_('상태 값을 확인해 주세요.');
        f.status = v;
        if (v === ST.ACTIVE && !o.approvedAt) f.approvedAt = nowText_();
        break;
      case 'qualDate':
        f.qualDate = opt(v, '자격 취득일', 10);
        if (f.qualDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.qualDate)) fail_('자격 취득일을 확인해 주세요.');
        break;
      case 'licenseType':
        f.licenseType = opt(v, '면허 종류', 20);
        if (f.licenseType && LICENSE_TYPES.indexOf(f.licenseType) < 0) fail_('운전면허 종류를 확인해 주세요.');
        break;
      case 'carYear':
        f.carYear = opt(v, '연식', 4);
        if (f.carYear && !/^(19|20)\d{2}$/.test(f.carYear)) fail_('연식을 확인해 주세요.');
        break;
      case 'maxLoad':
        f.maxLoad = opt(v, '최대적재량', 6);
        if (f.maxLoad && !/^\d{1,6}$/.test(f.maxLoad)) fail_('최대적재량은 kg 단위 숫자로 입력해 주세요.');
        break;
      case 'rrn': {
        const p = parseRrn_(v);
        const idx = blindIndex_('rrn', p.digits);
        const dupRow = findRow_(SH.DRIVERS, 'rrnIndex', idx);
        if (dupRow && dupRow !== o._row) fail_('같은 주민등록번호로 등록된 다른 기사가 있습니다.');
        f.rrnEnc = encrypt_(p.digits.replace(/(\d{6})(\d{7})/, '$1-$2'));
        f.rrnIndex = idx; f.birthDate = p.birth; f.rrn = maskRrn_(p.digits);
        break;
      }
      case 'licenseNo': {
        const d = digits_(v);
        if (d.length !== 12) fail_('운전면허번호 12자리를 확인해 주세요.');
        f.licenseNoEnc = encrypt_(d.replace(/(\d{2})(\d{2})(\d{6})(\d{2})/, '$1-$2-$3-$4'));
        f.licenseNo = maskLicense_(d);
        break;
      }
      case 'account': {
        const d = digits_(v);
        if (d.length < 8 || d.length > 16) fail_('계좌번호(숫자 8~16자리)를 확인해 주세요.');
        f.accountEnc = encrypt_(d); f.account = maskAccount_(d);
        break;
      }
      case 'driverType':
        f.driverType = opt(v, '기사구분', 10);
        if (f.driverType && DTYPES.indexOf(f.driverType) < 0) fail_('기사구분은 ' + DTYPES.join(' / ') + ' 중에서 골라 주세요.');
        break;
      case 'driverCode': {
        const code = normDriverCode_(v);
        if (code === null) fail_('기사코드에는 영문·숫자·한글·- 만, 20자 이내로 써 주세요.');
        if (code) {
          const dup = findRow_(SH.DRIVERS, 'driverCode', code);
          if (dup && dup !== o._row) fail_('이미 다른 기사가 쓰는 기사코드입니다: ' + code);
        }
        f.driverCode = code;
        break;
      }
      case 'memo': f.memo = opt(v, '관리자 메모', 2000); break;
      case 'address': f.address = opt(v, '주소', 200); break;
      case 'qualNo': f.qualNo = opt(v, '자격증 번호', 30); break;
      case 'carName': f.carName = opt(v, '차명', 40); break;
      case 'carNo': f.carNo = opt(v, '차량번호', 20).replace(/\s/g, ''); break;
      case 'bankName': f.bankName = opt(v, '은행명', 20); break;
      case 'accountHolder': f.accountHolder = opt(v, '예금주', 30); break;
    }
    changed.push(D_EDIT_LABEL[k]);
  });
  return { f: f, changed: changed };
}
/** 기사코드 정리: 공백 제거, 영문 대문자. 비었으면 '', 잘못되면 null */
function normDriverCode_(v) {
  const s = str_(v).replace(/\s+/g, '').toUpperCase();
  if (!s) return '';
  return /^[0-9A-Z가-힣_-]{1,20}$/.test(s) ? s : null;
}
/** 기사구분 글자 정리: '고정기사' → '고정', '용차' → '외부용차'. 모르는 값이면 null */
function normDriverType_(v) {
  const s = str_(v).replace(/\s+/g, '');
  if (!s) return '';
  if (/^고정/.test(s)) return '고정';
  if (/^백업/.test(s)) return '백업';
  if (/^품앗이/.test(s)) return '품앗이';
  if (/^(외부|용차|외부용차)/.test(s)) return '외부용차';
  return null;
}

/** 관리자가 기사를 직접 등록. fields = 수정과 같은 항목들, tempPw = 앱 로그인용 임시 비밀번호(선택) */
function adm_createDriver(token, fields, tempPw) {
  return run_(function () {
    const a = requireAdmin_(token);
    fields = Object.assign({}, fields || {});
    if (!str_(fields.name)) fail_('이름을 입력해 주세요.');
    if (!str_(fields.driverType)) fail_('기사구분(고정 / 백업 / 품앗이 / 외부용차)을 골라 주세요.');
    if (!fields.status) fields.status = ST.ACTIVE;
    const pw = tempPw ? checkPw_(tempPw) : '';
    if (pw && !str_(fields.loginId)) fail_('앱 로그인용 비밀번호를 지정하려면 쿠팡플렉스 아이디를 입력해 주세요.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const r = driverFields_(fields, { _row: -1, loginId: '', approvedAt: '' });
      const now = nowText_();
      const row = Object.assign({ id: newDriverId_(), createdAt: now, updatedAt: now }, r.f);
      if (row.status === ST.ACTIVE) row.approvedAt = now;
      if (pw) { Object.assign(row, passwordFields_(pw)); row.pwMustChange = 'Y'; }
      const at = appendObj_(SH.DRIVERS, row);
      if (row.loginId) forgetDriver_({ loginId: row.loginId });
      logAdmin_(a, '기사 등록', row.name + ' (' + row.id + ')', [row.driverType, row.driverCode].filter(String).join(' ') + (pw ? ', 임시 비밀번호 지정' : ''));
      return { ok: true, driver: detailOf_(readObj_(SH.DRIVERS, at)) };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * 기사 삭제 (되돌릴 수 없음). confirmName = 화면에서 다시 입력한 기사 이름 (실수 방지)
 * - drivers 시트의 그 줄을 지우고, 그 기사의 로그인(세션)도 모두 지운다 → 앱에서 바로 로그아웃
 * - 앱 가입 때 만들어진 서류 폴더는 드라이브 휴지통으로 옮긴다 (30일 안에는 드라이브에서 복구 가능)
 * - 배번호 신청서 같은 기록은 지우지 않는다 (이름이 남아 있어 나중에 확인 가능)
 */
function adm_deleteDriver(token, id, confirmName) {
  return run_(function () {
    const a = requireAdmin_(token);
    let o, folderId = '';
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      o = driverById_(String(id || ''));
      if (!o) return { ok: true, already: true };
      if (str_(confirmName).replace(/\s+/g, '') !== str_(o.name).replace(/\s+/g, '')) fail_('입력한 이름이 기사 이름과 다릅니다. 삭제하지 않았습니다.');
      sheet_(SH.DRIVERS).deleteRow(o._row);
      forgetDriver_(o);
      // 이 기사의 로그인 기록 지우기
      const ss = readAll_(SH.SESSIONS).filter(function (x) { return x.driverId === o.id; });
      ss.map(function (x) { return x._row; }).sort(function (p, q) { return q - p; })
        .forEach(function (r) { sheet_(SH.SESSIONS).deleteRow(r); });
      if (ss.length) cache_().removeAll(ss.map(function (x) { return 'ss:' + x.tokenHash; }));
      folderId = (String(o.docFolder || '').match(/folders\/([A-Za-z0-9_-]{10,})/) || [])[1] || fileIdOf_(o.docFolder);
      logAdmin_(a, '기사 삭제', o.name + ' (' + o.id + ')', [o.driverType, o.driverCode].filter(String).join(' ') + (ss.length ? ', 로그인 ' + ss.length + '건 해제' : ''));
    } finally {
      lock.releaseLock();
    }
    // 서류 폴더: 앱이 만든 "기사 서류" 폴더 안의 것만 휴지통으로
    let trashed = false;
    if (folderId) {
      try {
        const f = DriveApp.getFolderById(folderId), parents = f.getParents();
        while (parents.hasNext()) {
          if (parents.next().getId() === props_().DOCS_FOLDER_ID) { f.setTrashed(true); trashed = true; break; }
        }
      } catch (e) { /* 이미 없는 폴더 */ }
    }
    return { ok: true, docsTrashed: trashed };
  });
}

/** 임시 비밀번호 지정 → 기사는 다음 로그인 때 직접 변경 */
function adm_setTempPassword(token, id, password) {
  return run_(function () {
    const a = requireAdmin_(token);
    const pw = checkPw_(password);
    const o = driverById_(String(id || ''));
    if (!o) fail_('기사를 찾을 수 없습니다.');
    const f = passwordFields_(pw);
    f.pwMustChange = 'Y';
    f.updatedAt = f.pwChangedAt;
    writeFields_(SH.DRIVERS, o._row, f);
    forgetDriver_(o);
    logAdmin_(a, '임시 비밀번호 지정', o.name + ' (' + o.id + ')', '');
    return { ok: true, driver: detailOf_(readObj_(SH.DRIVERS, o._row)) };
  });
}

/** 서류 이미지·PDF 를 화면에 보여주기 위해 내려준다 (관리자가 드라이브 권한이 없어도 볼 수 있게) */
function adm_getDoc(token, id, kind) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!DOCS[kind]) fail_('알 수 없는 서류입니다.');
    const o = driverById_(String(id || ''));
    if (!o) fail_('기사를 찾을 수 없습니다.');
    const url = o[DOCS[kind].col];
    const m = String(url || '').match(/\/d\/([A-Za-z0-9_-]{10,})/) || String(url || '').match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (!m) fail_('등록된 ' + DOCS[kind].label + ' 파일이 없습니다.');
    let file;
    try { file = DriveApp.getFileById(m[1]); } catch (e) { fail_('파일을 열 수 없습니다. 드라이브에서 지워졌는지 확인해 주세요.'); }
    if (file.getSize() > 15 * 1024 * 1024) fail_('파일이 너무 커서 화면에 표시할 수 없습니다. 드라이브에서 열어 주세요.');
    const blob = file.getBlob();
    logAdmin_(a, '서류 열람', o.name + ' (' + o.id + ')', DOCS[kind].label);
    return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()), name: file.getName(), url: url };
  });
}

// ───────────────────────── 관리자 : 업무스케줄 (날짜별 메모) ─────────────────────────
function newMemoId_() {
  return 'M' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
}
/** 날짜 글자 → yyyy-MM-dd. 2026.11.3 / 2026/11/3 / 2026-11-03 / 시트의 날짜값 모두 허용. 잘못되면 '' */
function normDate_(v) {
  const s = str_(v);
  const m = s.match(/^(\d{4})[-.\/\s]+(\d{1,2})[-.\/\s]+(\d{1,2})\.?$/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}
/** 시간 글자 → HH:mm. 9:30 / 0930 / 09:30:00 허용. 비었으면 '', 잘못되면 null */
function normTime_(v) {
  const s = str_(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):?(\d{2})(?::\d{2})?$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return ('0' + (+m[1])).slice(-2) + ':' + m[2];
}
function memoView_(o) {
  return {
    id: o.id, date: o.date, time: o.time, content: o.content, done: String(o.done).toUpperCase() === 'Y',
    author: o.author, createdAt: o.createdAt, updatedAt: o.updatedAt
  };
}
function memoSort_(a, b) {
  return a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : a.time !== b.time ? (!a.time ? 1 : !b.time ? -1 : a.time < b.time ? -1 : 1)
    : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** 한 달치 메모 (시트를 한 번에 읽는다). ym = 'yyyy-MM' */
function adm_memoMonth(token, ym) {
  return run_(function () {
    requireAdmin_(token);
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) fail_('월 형식이 올바르지 않습니다.');
    const sh = sheet_(SH.MEMO), c = cols_(SH.MEMO), last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
    const list = [];
    let pastUndone = 0;
    const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    rows.forEach(function (v) {
      const o = {};
      Object.keys(M).forEach(function (k) { o[k] = str_(v[c[k]]); });
      o.date = normDate_(o.date) || o.date;
      if (!o.id || !o.date) return;
      const m = memoView_(o);
      if (o.date.indexOf(ym) === 0) list.push(m);
      if (!m.done && o.date < today) pastUndone++;
    });
    list.sort(memoSort_);
    return { ok: true, memos: list, pastUndone: pastUndone, today: today };
  });
}

/** 지난 날짜의 완료 안 된 메모 목록 */
function adm_memoPastUndone(token) {
  return run_(function () {
    requireAdmin_(token);
    const sh = sheet_(SH.MEMO), c = cols_(SH.MEMO), last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
    const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    const list = [];
    rows.forEach(function (v) {
      const o = {};
      Object.keys(M).forEach(function (k) { o[k] = str_(v[c[k]]); });
      o.date = normDate_(o.date) || o.date;
      if (!o.id || !o.date) return;
      const m = memoView_(o);
      if (!m.done && o.date < today) list.push(m);
    });
    list.sort(memoSort_);
    return { ok: true, memos: list };
  });
}

/** 메모 추가(id 없음) 또는 수정(id 있음). 바꿀 항목만 보내도 된다. */
function adm_memoSave(token, memo) {
  return run_(function () {
    const a = requireAdmin_(token);
    memo = memo || {};
    const f = {};
    if (memo.date !== undefined) {
      f.date = normDate_(memo.date);
      if (!f.date) fail_('날짜를 확인해 주세요.');
    }
    if (memo.time !== undefined) {
      f.time = normTime_(memo.time);
      if (f.time === null) fail_('시간은 09:30 형식으로 입력해 주세요.');
    }
    if (memo.content !== undefined) {
      f.content = String(memo.content || '').trim();
      if (!f.content) fail_('내용을 입력해 주세요.');
      if (f.content.length > 2000) fail_('내용이 너무 깁니다. (2000자 이내)');
    }
    if (memo.done !== undefined) f.done = memo.done ? 'Y' : '';

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (!memo.id) {
        if (!f.date || !f.content) fail_('날짜와 내용을 입력해 주세요.');
        const id = newMemoId_();
        const row = appendObj_(SH.MEMO, {
          id: id, date: f.date, time: f.time || '', content: f.content, done: f.done || '',
          author: a.name, createdAt: now, updatedAt: now
        });
        return { ok: true, memo: memoView_(readObj_(SH.MEMO, row)) };
      }
      const row = findRow_(SH.MEMO, 'id', String(memo.id));
      if (!row) fail_('메모를 찾을 수 없습니다. 시트에서 지워졌을 수 있습니다. 새로고침해 주세요.');
      if (!Object.keys(f).length) return { ok: true, memo: memoView_(readObj_(SH.MEMO, row)) };
      f.updatedAt = now;
      writeFields_(SH.MEMO, row, f);
      return { ok: true, memo: memoView_(readObj_(SH.MEMO, row)) };
    } finally {
      lock.releaseLock();
    }
  });
}

function adm_memoDelete(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.MEMO, 'id', String(id || ''));
      if (!row) return { ok: true }; // 이미 지워짐
      sheet_(SH.MEMO).deleteRow(row);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/** work_memo 시트를 직접 고쳤을 때: 메모ID·작성일시 자동, 날짜·시간·완료 형식 정리 */
function fixMemoRow_(sh, c, o) {
  if (!o.id && !o.date && !o.content) return;
  const upd = {}, notes = {};
  const set = function (k, v) { if (o[k] !== v) upd[k] = v; };
  if (!o.id && (o.date || o.content)) { set('id', newMemoId_()); if (!o.createdAt) set('createdAt', nowText_()); }
  if (o.date) {
    const d = normDate_(o.date);
    if (d) set('date', d); else notes.date = '날짜 형식을 확인해 주세요. (예: 2026-11-03)';
  }
  if (o.time) {
    const t = normTime_(o.time);
    if (t) set('time', t); else notes.time = '시간 형식을 확인해 주세요. (예: 09:30)';
  }
  if (o.done) {
    const yes = /^(y|yes|o|ok|v|완료|true|1)$/i.test(o.done);
    set('done', yes ? 'Y' : '');
  }
  if (Object.keys(upd).length) {
    upd.updatedAt = nowText_();
    Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(safeText_(upd[k])); });
  }
  ['date', 'time'].forEach(function (k) {
    const cell = sh.getRange(o._row, c[k] + 1);
    if (notes[k]) cell.setNote(notes[k]); else if (o[k]) cell.clearNote();
  });
}

// ───────────────────────── 관리자 : 배번호 관리 ─────────────────────────
/** company 시트 만들기 (항목 | 값). 이미 있으면 빠진 항목만 추가 */
function ensureCompany_() {
  const ss = ss_();
  let sh = ss.getSheetByName(COMPANY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(COMPANY_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([['항목', '값']]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 520);
    sh.getRange('A1').setNote('배번호 서류에 들어가는 회사 고정 정보입니다. 값(B열)만 고치세요. 항목 이름(A열)은 바꾸지 마세요.');
  }
  sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  const last = sh.getLastRow();
  const have = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); }) : [];
  const add = COMPANY.filter(function (c) { return have.indexOf(c[1]) < 0; }).map(function (c) { return [c[1], c[2]]; });
  if (add.length) sh.getRange(last + 1, 1, add.length, 2).setValues(add);
}
function companyInfo_() {
  const sh = ss_().getSheetByName(COMPANY_SHEET);
  const out = {};
  COMPANY.forEach(function (c) { out[c[0]] = ''; });
  if (!sh) return out;
  const last = sh.getLastRow();
  if (last < 2) return out;
  const map = {};
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { map[str_(r[0])] = str_(r[1]); });
  COMPANY.forEach(function (c) { if (map[c[1]] !== undefined) out[c[0]] = map[c[1]]; });
  return out;
}

function newBibId_() {
  return 'B' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
}
/** 년월 글자 → yyyy-MM. 2025-05 / 2025.5 / 2025년 5월 / 202505 허용. 잘못되면 '' */
function normYm_(v) {
  const s = str_(v).replace(/\s/g, '');
  const m = s.match(/^(\d{4})(?:[-.\/년]?)(\d{1,2})월?\.?$/) || s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return m[1] + '-' + ('0' + (+m[2])).slice(-2);
}
function addYearsMinusDay_(d) {
  if (!d) return '';
  const dt = new Date(+d.slice(0, 4) + 1, +d.slice(5, 7) - 1, +d.slice(8, 10) - 1);
  return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
}
function yearsBetween_(a, b) {
  if (!a || !b) return '';
  const days = (new Date(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - new Date(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5 + 1;
  return days > 0 ? String(Math.max(1, Math.round(days / 365))) : '';
}
function careerYears_(a, b) {
  if (!a || !b) return '';
  const months = (+b.slice(0, 4) * 12 + +b.slice(5, 7)) - (+a.slice(0, 4) * 12 + +a.slice(5, 7)) + 1;
  return months > 0 ? String(Math.max(1, Math.round(months / 12))) : '';
}
function todayText_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }

function bibView_(o) {
  const v = {};
  Object.keys(B).forEach(function (k) { if (k !== 'snapshotEnc') v[k] = o[k]; });
  v.optConsent = String(o.optConsent).toUpperCase() === 'Y';
  v.hasSnapshot = !!o.snapshotEnc;
  return v;
}
/** 서류에 필요한데 비어 있는 항목 */
function bibMissing_(d, app, co) {
  const miss = [];
  const need = function (ok, label) { if (!ok) miss.push(label); };
  if (!d) return ['기사 정보'];
  need(d.name, '이름'); need(d.rrnEnc, '주민등록번호'); need(d.address, '주소'); need(d.phone, '연락처');
  need(d.licenseNoEnc, '운전면허번호'); need(d.licenseType, '운전면허 종류');
  need(d.qualNo, '화물운송 종사자격증 번호'); need(d.qualDate, '자격 취득일');
  need(d.carName, '차명'); need(d.carYear, '연식'); need(d.maxLoad, '최대적재량');
  need(app.applyDate, '신청일'); need(app.contractStart, '계약 시작일'); need(app.contractEnd, '계약 종료일');
  need(app.careerStart && app.careerEnd, '경력기간'); need(app.carNo, '차량번호');
  need(app.fuel, '연료'); need(app.bodyType, '형태'); need(app.manageMethod, '허가 후 관리 방법');
  COMPANY.forEach(function (c) { need(co[c[0]], '회사 정보: ' + c[1]); });
  return miss;
}
function readAll_(name) {
  const sh = sheet_(name), c = cols_(name), last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
  const keys = Object.keys(SCHEMA[name]);
  return rows.map(function (v, i) {
    const o = { _row: i + 2 };
    keys.forEach(function (k) { o[k] = str_(v[c[k]]); });
    return o;
  });
}

/** 목록 + 신청서 만들 때 고를 기사 목록 */
function adm_bibList(token) {
  return run_(function () {
    requireAdmin_(token);
    const apps = readAll_(SH.BIB).filter(function (o) { return o.id; }).map(bibView_);
    const counts = { all: apps.length };
    Object.keys(BST).forEach(function (k) { counts[BST[k]] = 0; });
    apps.forEach(function (a) { if (counts[a.status] !== undefined) counts[a.status]++; });
    apps.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
    const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id; }).map(function (o) {
      return { id: o.id, name: o.name, loginId: o.loginId, phone: o.phone, status: o.status, carNo: o.carNo };
    });
    return { ok: true, apps: apps, counts: counts, drivers: drivers };
  });
}

function bibById_(id) {
  const row = findRow_(SH.BIB, 'id', String(id || ''));
  return row ? readObj_(SH.BIB, row) : null;
}
/** 상세: 신청서 + 기사 요약 + 빈 항목 */
function bibDetail_(app) {
  const d = driverById_(app.driverId);
  const co = companyInfo_();
  return {
    app: bibView_(app),
    driver: d ? {
      id: d.id, name: d.name, phone: d.phone, address: d.address, birthDate: d.birthDate, rrn: d.rrn,
      licenseNo: d.licenseNo, licenseType: d.licenseType, qualNo: d.qualNo, qualDate: d.qualDate,
      carNo: d.carNo, carName: d.carName, carYear: d.carYear, maxLoad: d.maxLoad, status: d.status
    } : null,
    missing: bibMissing_(d, app, co)
  };
}
function adm_bibGet(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const app = bibById_(id);
    if (!app) fail_('신청서를 찾을 수 없습니다. 새로고침해 주세요.');
    return Object.assign({ ok: true }, bibDetail_(app));
  });
}

/** 신청서 새로 만들기(driverId) 또는 수정(id) */
function adm_bibSave(token, data) {
  return run_(function () {
    const a = requireAdmin_(token);
    data = data || {};
    const f = {};
    const date = function (k, label) {
      if (data[k] === undefined) return;
      const v = str_(data[k]);
      f[k] = v ? normDate_(v) : '';
      if (v && !f[k]) fail_(label + ' 날짜를 확인해 주세요.');
    };
    const ym = function (k, label) {
      if (data[k] === undefined) return;
      const v = str_(data[k]);
      f[k] = v ? normYm_(v) : '';
      if (v && !f[k]) fail_(label + '을(를) 2025-05 형식으로 입력해 주세요.');
    };
    const num = function (k, label) {
      if (data[k] === undefined) return;
      const v = str_(data[k]);
      if (v && !/^\d{1,2}$/.test(v)) fail_(label + '은(는) 숫자로 입력해 주세요.');
      f[k] = v;
    };
    const pick = function (k, list, label) {
      if (data[k] === undefined) return;
      const v = str_(data[k]);
      if (v && list.indexOf(v) < 0) fail_(label + ' 값을 확인해 주세요.');
      f[k] = v;
    };
    date('applyDate', '신청일'); date('contractStart', '계약 시작일'); date('contractEnd', '계약 종료일');
    ym('careerStart', '경력 시작'); ym('careerEnd', '경력 종료');
    num('contractYears', '계약기간'); num('careerYears', '경력기간');
    pick('fuel', FUELS, '연료'); pick('bodyType', BODY_TYPES, '형태'); pick('manageMethod', MANAGE, '허가 후 관리 방법');
    if (data.fuelEtc !== undefined) f.fuelEtc = str_(data.fuelEtc).slice(0, 20);
    if (data.carNo !== undefined) f.carNo = str_(data.carNo).replace(/\s/g, '').slice(0, 20);
    if (data.optConsent !== undefined) f.optConsent = data.optConsent ? 'Y' : '';
    if (data.memo !== undefined) f.memo = str_(data.memo).slice(0, 1000);
    if (f.contractStart && f.contractEnd && f.contractEnd < f.contractStart) fail_('계약 종료일이 시작일보다 빠릅니다.');
    if (f.careerStart && f.careerEnd && f.careerEnd < f.careerStart) fail_('경력 종료가 시작보다 빠릅니다.');

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (!data.id) {
        // 새 신청서: 기사 정보와 같은 기사의 지난 신청서로 기본값을 채운다
        const d = driverById_(String(data.driverId || ''));
        if (!d) fail_('기사를 찾을 수 없습니다.');
        const prev = readAll_(SH.BIB).filter(function (o) { return o.driverId === d.id && o.id; })
          .sort(function (x, y) { return x.createdAt < y.createdAt ? 1 : -1; })[0] || {};
        const today = todayText_();
        const start = f.contractStart || today;
        const end = f.contractEnd || addYearsMinusDay_(start);
        const cs = f.careerStart !== undefined ? f.careerStart : (prev.careerStart || '');
        const ce = f.careerEnd !== undefined ? f.careerEnd : (prev.careerEnd || '');
        const id = newBibId_();
        const row = appendObj_(SH.BIB, {
          id: id, driverId: d.id, name: d.name, status: BST.DRAFT,
          applyDate: f.applyDate || today, contractStart: start, contractEnd: end,
          contractYears: f.contractYears || yearsBetween_(start, end),
          careerStart: cs, careerEnd: ce, careerYears: f.careerYears || prev.careerYears || careerYears_(cs, ce),
          carNo: f.carNo !== undefined ? f.carNo : (d.carNo || prev.carNo || ''),
          fuel: f.fuel || prev.fuel || '', fuelEtc: f.fuelEtc || prev.fuelEtc || '', bodyType: f.bodyType || prev.bodyType || '',
          manageMethod: f.manageMethod || prev.manageMethod || '자동 증명', optConsent: f.optConsent || '',
          memo: f.memo || '', admin: a.name, createdAt: now, updatedAt: now
        });
        return Object.assign({ ok: true }, bibDetail_(readObj_(SH.BIB, row)));
      }
      const app = bibById_(data.id);
      if (!app) fail_('신청서를 찾을 수 없습니다. 새로고침해 주세요.');
      if (app.status === BST.APPROVED) fail_('허가가 끝난 신청서는 고칠 수 없습니다. 필요하면 시트에서 직접 고쳐 주세요.');
      // 날짜를 바꾸면 기간(년)을 다시 계산 (직접 입력한 값이 있으면 그 값을 사용)
      const cStart = f.contractStart !== undefined ? f.contractStart : app.contractStart;
      const cEnd = f.contractEnd !== undefined ? f.contractEnd : app.contractEnd;
      if ((f.contractStart !== undefined || f.contractEnd !== undefined) && f.contractYears === undefined) f.contractYears = yearsBetween_(cStart, cEnd);
      const kStart = f.careerStart !== undefined ? f.careerStart : app.careerStart;
      const kEnd = f.careerEnd !== undefined ? f.careerEnd : app.careerEnd;
      if (cStart && cEnd && cEnd < cStart) fail_('계약 종료일이 시작일보다 빠릅니다.');
      if (kStart && kEnd && kEnd < kStart) fail_('경력 종료가 시작보다 빠릅니다.');
      if ((f.careerStart !== undefined || f.careerEnd !== undefined) && f.careerYears === undefined) f.careerYears = careerYears_(kStart, kEnd);
      if (!Object.keys(f).length) return Object.assign({ ok: true }, bibDetail_(app));
      f.updatedAt = now;
      writeFields_(SH.BIB, app._row, f);
      return Object.assign({ ok: true }, bibDetail_(readObj_(SH.BIB, app._row)));
    } finally {
      lock.releaseLock();
    }
  });
}

/** 진행 상태 변경: submit(제출) / approve(허가, 번호판) / reject(반려, 사유) / reopen(다시 작성) */
function adm_bibStatus(token, id, action, value) {
  return run_(function () {
    const a = requireAdmin_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const app = bibById_(id);
      if (!app) fail_('신청서를 찾을 수 없습니다. 새로고침해 주세요.');
      const f = { updatedAt: nowText_() };
      let log = '';
      if (action === 'submit') {
        f.status = BST.SUBMITTED; f.submittedAt = normDate_(value) || todayText_(); log = '제출';
      } else if (action === 'approve') {
        const plate = str_(value).replace(/\s/g, '');
        if (!plate) fail_("허가받은 '배' 번호판 차량번호를 입력해 주세요.");
        if (plate.length > 20) fail_('차량번호를 확인해 주세요.');
        f.status = BST.APPROVED; f.approvedAt = todayText_(); f.plateNo = plate; log = '허가 ' + plate;
      } else if (action === 'reject') {
        const reason = str_(value);
        if (!reason) fail_('반려 사유를 입력해 주세요.');
        f.status = BST.REJECTED; f.rejectedAt = todayText_(); f.rejectReason = reason.slice(0, 500); log = '반려';
      } else if (action === 'reopen') {
        f.status = BST.DRAFT; log = '다시 작성';
      } else fail_('알 수 없는 작업입니다.');
      writeFields_(SH.BIB, app._row, f);
      if (action === 'approve') {
        // 허가받은 번호판을 기사 정보의 차량번호로 (신청 전 번호는 신청서에 남아 있음)
        const d = driverById_(app.driverId);
        if (d) { writeFields_(SH.DRIVERS, d._row, { carNo: f.plateNo, updatedAt: f.updatedAt }); forgetDriver_(d); }
      }
      logAdmin_(a, '배번호 진행', app.name + ' (' + app.driverId + ')', log);
      return Object.assign({ ok: true }, bibDetail_(readObj_(SH.BIB, app._row)));
    } finally {
      lock.releaseLock();
    }
  });
}

function adm_bibDelete(token, id) {
  return run_(function () {
    const a = requireAdmin_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const app = bibById_(id);
      if (!app) return { ok: true };
      if (app.status !== BST.DRAFT && app.status !== BST.REJECTED) fail_('작성 또는 반려 상태의 신청서만 지울 수 있습니다.');
      sheet_(SH.BIB).deleteRow(app._row);
      logAdmin_(a, '배번호 신청서 삭제', app.name + ' (' + app.driverId + ')', app.id);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * 서류 출력용 데이터 (주민번호·면허번호 포함 전체 값).
 * 빈 항목이 있으면 allowMissing 없이는 거절. 출력하면 상태 작성→출력, 출력 내용을 암호화해 보관, 기록 남김.
 */
function adm_bibPrint(token, id, allowMissing) {
  return run_(function () {
    const a = requireAdmin_(token);
    const app = bibById_(id);
    if (!app) fail_('신청서를 찾을 수 없습니다.');
    const d = driverById_(app.driverId);
    if (!d) fail_('기사 정보를 찾을 수 없습니다.');
    const co = companyInfo_();
    const missing = bibMissing_(d, app, co);
    if (missing.length && !allowMissing) return { ok: false, code: 'MISSING', missing: missing, msg: '비어 있는 항목이 있습니다.' };
    const rrn = d.rrnEnc ? decrypt_(d.rrnEnc) : '';
    const lic = d.licenseNoEnc ? decrypt_(d.licenseNoEnc) : '';
    const data = {
      no: app.id, applyDate: app.applyDate,
      name: d.name, rrn: rrn, address: d.address, phone: d.phone, birthDate: d.birthDate,
      contractStart: app.contractStart, contractEnd: app.contractEnd, contractYears: app.contractYears,
      careerStart: app.careerStart, careerEnd: app.careerEnd, careerYears: app.careerYears,
      fuel: app.fuel, fuelEtc: app.fuelEtc, bodyType: app.bodyType, carNo: app.carNo,
      carName: d.carName, carYear: d.carYear, maxLoad: d.maxLoad,
      licenseNo: lic, licenseType: d.licenseType, qualNo: d.qualNo, qualDate: d.qualDate,
      manageMethod: app.manageMethod, optConsent: String(app.optConsent).toUpperCase() === 'Y',
      company: co
    };
    const f = { printedAt: nowText_(), snapshotEnc: encrypt_(JSON.stringify(data)), updatedAt: nowText_() };
    if (app.status === BST.DRAFT) f.status = BST.PRINTED;
    writeFields_(SH.BIB, app._row, f);
    logAdmin_(a, '배번호 서류 출력', d.name + ' (' + d.id + ')', '서류 4종' + (missing.length ? ' (빈 항목 ' + missing.length + '개)' : ''));
    return { ok: true, data: data, detail: bibDetail_(readObj_(SH.BIB, app._row)) };
  });
}

function adm_companyGet(token) {
  return run_(function () {
    requireAdmin_(token);
    const co = companyInfo_();
    return { ok: true, fields: COMPANY.map(function (c) { return { key: c[0], label: c[1], value: co[c[0]] }; }) };
  });
}
function adm_companySave(token, values) {
  return run_(function () {
    const a = requireAdmin_(token);
    values = values || {};
    ensureCompany_();
    const sh = ss_().getSheetByName(COMPANY_SHEET);
    const last = sh.getLastRow();
    const labels = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
    const changed = [];
    COMPANY.forEach(function (c) {
      if (values[c[0]] === undefined) return;
      const i = labels.indexOf(c[1]);
      if (i < 0) return;
      sh.getRange(i + 2, 2).setNumberFormat('@').setValue(safeText_(str_(values[c[0]]).slice(0, 200)));
      changed.push(c[1]);
    });
    if (changed.length) logAdmin_(a, '회사 정보 수정', '', changed.join(', '));
    return { ok: true };
  });
}

/** bib_applications 시트를 직접 고쳤을 때: 신청ID 자동, 날짜·년월·동의 형식 정리 */
function fixBibRow_(sh, c, o) {
  if (!o.id && !o.driverId && !o.name) return;
  const upd = {};
  const set = function (k, v) { if (o[k] !== v) upd[k] = v; };
  if (!o.id && o.driverId) { set('id', newBibId_()); if (!o.createdAt) set('createdAt', nowText_()); if (!o.status) set('status', BST.DRAFT); }
  ['applyDate', 'contractStart', 'contractEnd', 'submittedAt', 'approvedAt', 'rejectedAt'].forEach(function (k) {
    if (o[k]) { const v = normDate_(o[k]); if (v) set(k, v); }
  });
  ['careerStart', 'careerEnd'].forEach(function (k) { if (o[k]) { const v = normYm_(o[k]); if (v) set(k, v); } });
  if (o.optConsent) set('optConsent', /^(y|yes|o|동의|true|1)$/i.test(o.optConsent) ? 'Y' : '');
  if (Object.keys(upd).length) {
    upd.updatedAt = nowText_();
    Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(safeText_(upd[k])); });
  }
}

// ───────────────────────── 서류 일괄 연결 ─────────────────────────
/**
 * 사용법
 *  1) 구글 드라이브 "러너 올인원 데이터/서류 올리기" 폴더에 서류 파일을 한꺼번에 올린다.
 *     파일 이름 = "기사_서류종류.확장자"
 *       기사 : 쿠팡플렉스 아이디, 연락처, 기사ID, 이름(동명이인 없을 때) 중 하나
 *       서류종류 : 자격증 / 면허증 / 사업자 / 자동차 (예: kim@flex.com_면허증.jpg, 01012345678_자격증.png)
 *  2) DB 시트의 "서류 연결" 탭에서 실행 체크박스를 누른다. (또는 편집기에서 linkUploadedDocs 실행)
 *  3) 파일이 기사별 서류 폴더로 옮겨지고 drivers 시트의 서류 칸에 링크가 채워진다.
 *     연결하지 못한 파일은 올리기 폴더에 그대로 남고, 이유가 "서류 연결" 탭에 기록된다.
 */
const TOOLS = { SHEET: '서류 연결', RUN_CELL: 'B4', RESULT_CELL: 'B7', LAST_CELL: 'B6', LOG_ROW: 9 };
// 순서 중요: "자동차운전면허증"이 자동차보다 면허로, "사업자등록증"이 등록증보다 사업자로 먼저 판별되도록
const DOC_KINDS = [
  { key: 'biz', words: ['사업자'] },
  { key: 'qual', words: ['자격', '화물운송', '종사'] },
  { key: 'license', words: ['면허', '운전'] },
  { key: 'car', words: ['자동차', '차량', '차등록', '등록증'] }
];
const DOC_TIME_LIMIT_MS = 270000; // 4분 30초 넘으면 멈추고 다음 실행에서 이어서

/** 서류 올리기 폴더 (없으면 만든다) */
function uploadFolder_() {
  const p = props_();
  if (p.UPLOAD_FOLDER_ID) {
    try {
      const f = DriveApp.getFolderById(p.UPLOAD_FOLDER_ID);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 지워졌으면 새로 만든다 */ }
  }
  const f = DriveApp.getFolderById(p.ROOT_FOLDER_ID).createFolder('서류 올리기');
  PropertiesService.getScriptProperties().setProperty('UPLOAD_FOLDER_ID', f.getId());
  _props = null;
  return f;
}

/** DB 시트에 "서류 연결" 탭을 만든다 (setup 에서 호출, 이미 있으면 그대로) */
function ensureTools_() {
  const ss = ss_();
  let sh = ss.getSheetByName(TOOLS.SHEET);
  const folder = uploadFolder_();
  if (!sh) {
    sh = ss.insertSheet(TOOLS.SHEET);
    sh.getRange('A1').setValue('서류 일괄 연결').setFontSize(14).setFontWeight('bold');
    sh.getRange('A2').setValue('① "서류 올리기" 폴더에 서류 파일을 한꺼번에 올립니다. 파일 이름: 기사_서류종류  (예: kim@flex.com_면허증.jpg)');
    sh.getRange('A3').setValue('   기사 = 쿠팡플렉스 아이디 / 연락처 / 기사ID / 이름(동명이인 없을 때),  서류종류 = 자격증 / 면허증 / 사업자 / 자동차');
    sh.getRange('A4').setValue('② 실행').setFontWeight('bold');
    sh.getRange('C4').setValue('← 체크하면 바로 연결을 시작합니다. 끝나면 체크가 자동으로 풀립니다.');
    sh.getRange('A5').setValue('올리기 폴더').setFontWeight('bold');
    sh.getRange('A6').setValue('마지막 실행').setFontWeight('bold');
    sh.getRange('A7').setValue('결과').setFontWeight('bold');
    sh.getRange(TOOLS.LOG_ROW, 1, 1, 5).setValues([['시각', '파일 이름', '결과', '기사', '내용']])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(TOOLS.LOG_ROW);
    sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 60);
    sh.setColumnWidth(4, 220); sh.setColumnWidth(5, 380);
  }
  sh.getRange(TOOLS.RUN_CELL).insertCheckboxes().setValue(false);
  sh.getRange('B5').setFormula('=HYPERLINK("' + folder.getUrl() + '","서류 올리기 폴더 열기")');
}

/** "서류 연결" 탭 편집: 실행 체크박스를 누르면 연결 실행 */
function onToolsEdit_(e, sh) {
  if (e.range.getA1Notation() !== TOOLS.RUN_CELL || e.range.getValue() !== true) return;
  _ss = sh.getParent();
  try {
    sh.getRange(TOOLS.RESULT_CELL).setValue('연결 중… 파일이 많으면 몇 분 걸립니다.');
    SpreadsheetApp.flush();
    linkUploadedDocs_();
  } finally {
    sh.getRange(TOOLS.RUN_CELL).setValue(false);
  }
}

/** 편집기에서 직접 실행할 때 */
function linkUploadedDocs() {
  Logger.log(JSON.stringify(linkUploadedDocs_()));
}

function docKind_(text) {
  const t = String(text || '').replace(/\s/g, '');
  for (let i = 0; i < DOC_KINDS.length; i++) {
    if (DOC_KINDS[i].words.some(function (w) { return t.indexOf(w) >= 0; })) return DOC_KINDS[i].key;
  }
  return '';
}

/** 파일 이름 앞부분으로 기사 찾기: 아이디 → 기사ID → 연락처 → 이름 순 */
function findDriverForDoc_(idx, who) {
  const w = String(who || '').trim();
  if (!w) return null;
  if (idx.login[w.toLowerCase()]) return idx.login[w.toLowerCase()];
  if (idx.id[w]) return idx.id[w];
  const d = phoneDigits_(w);
  if (/^01\d{8,9}$/.test(d) && d.length === w.replace(/[\s-]/g, '').length && idx.phone[d]) return idx.phone[d];
  return idx.name[w] || null;
}

function folderFromUrl_(url) {
  const m = String(url || '').match(/folders\/([A-Za-z0-9_-]{10,})/);
  if (!m) return null;
  try {
    const f = DriveApp.getFolderById(m[1]);
    return f.isTrashed() ? null : f;
  } catch (e) { return null; }
}

function linkUploadedDocs_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    writeDocResult_([], '다른 작업이 진행 중입니다. 잠시 후 다시 체크해 주세요.');
    return { busy: true };
  }
  const started = Date.now(), logs = [];
  let done = 0, failed = 0, remaining = false;
  try {
    // 기사 목록을 한 번에 읽어 찾기표를 만든다 (파일마다 시트를 읽지 않음)
    const sh = sheet_(SH.DRIVERS), c = cols_(SH.DRIVERS, true), last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
    const idx = { login: {}, id: {}, phone: {}, name: {} };
    rows.forEach(function (v, i) {
      const r = {
        row: i + 2, id: str_(v[c.id]), loginId: str_(v[c.loginId]).toLowerCase(),
        name: str_(v[c.name]), phone: phoneDigits_(v[c.phone]), docFolder: str_(v[c.docFolder])
      };
      if (!r.id && !r.loginId) return;
      if (r.loginId) idx.login[r.loginId] = r;
      if (r.id) idx.id[r.id] = r;
      if (r.phone) idx.phone[r.phone] = r;
      if (r.name) idx.name[r.name] = idx.name[r.name] ? 'DUP' : r;
    });

    const docsParent = DriveApp.getFolderById(props_().DOCS_FOLDER_ID);
    const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd');
    const it = uploadFolder_().getFiles();
    while (it.hasNext()) {
      if (Date.now() - started > DOC_TIME_LIMIT_MS) { remaining = true; break; }
      const file = it.next(), fname = file.getName();
      const fail = function (msg) { failed++; logs.push([nowText_(), fname, '실패', '', msg]); };

      const mime = file.getMimeType();
      if (!/^image\//.test(mime) && mime !== 'application/pdf') { fail('이미지나 PDF 파일만 연결할 수 있습니다.'); continue; }
      const base = fname.replace(/\.[^.]+$/, ''), cut = base.lastIndexOf('_');
      if (cut < 1) { fail('파일 이름이 "기사_서류종류" 형식이 아닙니다. (예: kim@flex.com_면허증.jpg)'); continue; }
      const kind = docKind_(base.slice(cut + 1));
      if (!kind) { fail('서류 종류를 알 수 없습니다. _ 뒤에 자격증/면허증/사업자/자동차 중 하나를 써 주세요.'); continue; }
      const r = findDriverForDoc_(idx, base.slice(0, cut));
      if (r === 'DUP') { fail('같은 이름의 기사가 여러 명입니다. 이름 대신 아이디나 연락처로 바꿔 주세요.'); continue; }
      if (!r) { fail('drivers 시트에서 "' + base.slice(0, cut) + '" 기사를 찾을 수 없습니다.'); continue; }

      let folder = folderFromUrl_(r.docFolder);
      if (!folder) {
        folder = docsParent.createFolder((r.name || '기사') + '_' + (r.loginId || r.id) + '_' + (r.id || ''));
        r.docFolder = folder.getUrl();
        sh.getRange(r.row, c.docFolder + 1).setValue(r.docFolder);
      }
      const ext = ((fname.match(/\.([^.]+)$/) || [])[1] || (mime === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
      file.moveTo(folder);
      file.setName((r.name || r.loginId) + '_' + DOCS[kind].label + '_' + stamp + '.' + ext);
      const cell = sh.getRange(r.row, c[DOCS[kind].col] + 1);
      const had = str_(cell.getValue());
      cell.setValue(file.getUrl());
      done++;
      logs.push([nowText_(), fname, '연결', (r.name || '') + ' (' + (r.loginId || r.id) + ')',
        DOCS[kind].label + (had ? ' · 기존 링크를 새 파일로 교체 (예전 파일은 폴더에 남아 있음)' : '')]);
    }
  } finally {
    lock.releaseLock();
  }
  let summary = '연결 ' + done + '건, 실패 ' + failed + '건';
  if (!done && !failed && !remaining) summary = '올리기 폴더에 파일이 없습니다.';
  if (remaining) summary += ' · 파일이 많아 일부만 처리했습니다. 실행을 한 번 더 체크해 주세요.';
  else if (failed) summary += ' · 실패한 파일은 이름을 고친 뒤 다시 체크하면 됩니다.';
  writeDocResult_(logs, summary);
  return { done: done, failed: failed, remaining: remaining };
}

/** 결과를 "서류 연결" 탭에 기록 (최근 결과가 위로) */
function writeDocResult_(logs, summary) {
  const sh = ss_().getSheetByName(TOOLS.SHEET);
  if (!sh) return;
  sh.getRange(TOOLS.LAST_CELL).setValue(nowText_());
  sh.getRange(TOOLS.RESULT_CELL).setValue(summary);
  if (logs.length) {
    sh.insertRowsAfter(TOOLS.LOG_ROW, logs.length);
    sh.getRange(TOOLS.LOG_ROW + 1, 1, logs.length, 5).setNumberFormat('@').setValues(logs);
  }
}

/** 열 추가·삭제·이동 같은 구조 변경 시 머리글 위치 캐시를 지운다 */
function onSheetChange() {
  Object.keys(SCHEMA).forEach(clearHeadCache_);
  bumpMaster_(); // 행 삭제·추가 등 구조 변경 → 노선 기준 데이터 캐시 버림
}

/** 매일 새벽 만료된 세션을 한 번에 정리 (setup 에서 트리거 등록) */
function cleanupSessions() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_(SH.SESSIONS), c = cols_(SH.SESSIONS, true);
    const last = sh.getLastRow();
    if (last < 2) return;
    const now = Date.now();
    const rows = sh.getRange(2, 1, last - 1, c.__w).getValues();
    const keep = rows.filter(function (r) { return toMs_(r[c.expiresAt]) > now; })
      .map(function (r) { return r.map(str_); });
    if (keep.length === rows.length) return;
    sh.getRange(2, 1, last - 1, c.__w).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, c.__w).setNumberFormat('@').setValues(keep);
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── 관리자용 도구 (편집기에서 실행) ─────────────────────────
/** 개인정보 암복호화가 정상인지 확인 */
function testCrypto() {
  const enc = encrypt_('900101-1234567');
  Logger.log(enc);
  Logger.log(decrypt_(enc));
}

// ───────────────────────── 관리자 : 노선관리 (캠프 > 노선코드) ─────────────────────────
/*
 * 시트 3개: camps(캠프) / routes(노선) / camp_images(캠프 참고 이미지)
 * - 화면은 세 시트를 한 번에 읽어 캐시해 두고(adm_routeAll), 저장할 때만 캐시를 버린다.
 * - 시트에서 직접 고쳐도 같은 규칙으로 정리되고(fix*Row_), 캐시는 자동으로 버려진다.
 * - 캠프명은 camps 탭이 기준. routes·camp_images 의 캠프명 칸은 보기 편하라고 같이 적어 두는 사본이다.
 */
function newRid_(prefix) {
  return prefix + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
}
function campKey_(v) { return str_(v).replace(/\s+/g, '').toUpperCase(); }
/** 노선코드 정리: 공백 제거, 영문 대문자 */
function normCode_(v) { return str_(v).replace(/\s+/g, '').toUpperCase(); }
/**
 * 노선코드 → 구분1~5
 *   110ABCD     → 110 / A / B / C / D   (앞쪽 숫자 묶음 = 구분1, 그 뒤 한 글자씩)
 *   110-A-B-C-D → - 기준으로 나눔 (구분 하나가 두 글자 이상일 때)
 *   남는 글자는 구분5에 붙인다.
 */
function splitCode_(code) {
  code = normCode_(code);
  let parts;
  if (code.indexOf('-') >= 0) {
    parts = code.split('-').filter(function (x) { return x; });
    if (parts.length > 5) parts = parts.slice(0, 4).concat([parts.slice(4).join('-')]);
  } else {
    const m = code.match(/^(\d+)(.*)$/);
    const head = m ? m[1] : code.charAt(0), rest = m ? m[2] : code.slice(1);
    parts = head ? [head].concat(rest.split('')) : [];
    if (parts.length > 5) parts = parts.slice(0, 4).concat([parts.slice(4).join('')]);
  }
  while (parts.length < 5) parts.push('');
  return { g1: parts[0], g2: parts[1], g3: parts[2], g4: parts[3], g5: parts[4] };
}
function checkCode_(v) {
  const code = normCode_(v);
  if (!code) fail_('노선코드를 입력해 주세요.');
  if (code.length > 20) fail_('노선코드가 너무 깁니다. (20자 이내): ' + code);
  if (!/^[0-9A-Z가-힣_-]+$/.test(code)) fail_('노선코드에는 영문·숫자·한글·- 만 쓸 수 있습니다: ' + code);
  return code;
}
function fileIdOf_(v) {
  const s = str_(v);
  const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}
function campView_(o) {
  return { id: o.id, name: o.name, address: o.address, memo: o.memo, createdAt: o.createdAt, updatedAt: o.updatedAt };
}
function routeView_(o) {
  const g = splitCode_(o.code);
  return {
    id: o.id, campId: o.campId, code: normCode_(o.code), g1: g.g1, g2: g.g2, g3: g.g3, g4: g.g4, g5: g.g5,
    status: o.status === RST.OFF ? RST.OFF : RST.ON, memo: o.memo, createdAt: o.createdAt, updatedAt: o.updatedAt
  };
}
function imageView_(o) {
  return {
    id: o.id, campId: o.campId, fileId: fileIdOf_(o.file), url: o.file, desc: o.desc,
    order: Number(o.order) || 0, createdAt: o.createdAt, updatedAt: o.updatedAt
  };
}
function conflict_(seen, o) {
  if (seen !== undefined && seen !== null && String(seen) !== String(o.updatedAt || '')) {
    fail_('다른 곳(다른 관리자 또는 시트)에서 먼저 수정되었습니다. 새로고침한 뒤 다시 해 주세요.');
  }
}

// ── 기준 데이터 캐시: 버전 키가 바뀌면 이전 캐시는 쓰지 않는다 (읽는 중 저장이 끼어들어도 안전) ──
const MST_CHUNK = 30000; // 캐시 1칸 100KB 제한 (한글 3바이트) 안쪽
function masterVer_() {
  let v = cache_().get('mst:v');
  if (!v) { v = String(Date.now()); cache_().put('mst:v', v, CFG.CACHE_MAX); }
  return v;
}
function bumpMaster_() {
  try { cache_().put('mst:v', Date.now() + Math.random().toString(36).slice(2, 6), CFG.CACHE_MAX); } catch (e) { /* 캐시 오류는 무시 */ }
}
function master_() {
  const ck = cache_(), v = masterVer_(), base = 'mst:' + v + ':';
  const n = Number(ck.get(base + 'n') || 0);
  if (n) {
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(base + i);
    const got = ck.getAll(keys);
    if (keys.every(function (k) { return got[k] != null; })) {
      try { return JSON.parse(keys.map(function (k) { return got[k]; }).join('')); } catch (e) { /* 다시 읽는다 */ }
    }
  }
  const data = {
    camps: readAll_(SH.CAMPS).filter(function (o) { return o.id; }).map(campView_),
    routes: readAll_(SH.ROUTES).filter(function (o) { return o.id && o.code; }).map(routeView_),
    images: readAll_(SH.CIMG).filter(function (o) { return o.id; }).map(imageView_),
    addresses: readAll_(SH.CADDR).filter(function (o) { return o.id && o.address; }).map(addrView_),
    prices: readAll_(SH.PRICES).filter(function (o) { return o.id && o.num; }).map(priceView_)
  };
  const json = JSON.stringify(data);
  if (json.length <= MST_CHUNK * 60) {
    const put = {};
    let i = 0;
    for (let p = 0; p < json.length; p += MST_CHUNK) put[base + (i++)] = json.slice(p, p + MST_CHUNK);
    put[base + 'n'] = String(i);
    try { ck.putAll(put, CFG.CACHE_MAX); } catch (e) { /* 캐시 실패해도 결과는 돌려준다 */ }
  }
  return data;
}

/** 노선관리 화면 데이터 (캠프·노선·이미지 목록) 한 번에 */
function adm_routeAll(token) {
  return run_(function () {
    requireAdmin_(token);
    return Object.assign({ ok: true }, master_());
  });
}

/** camps 의 캠프명을 routes·camp_images 의 캠프명 칸에 맞춘다 (바뀐 칸이 있을 때만 쓴다) */
function syncCampNames_() {
  const names = {};
  readAll_(SH.CAMPS).forEach(function (o) { if (o.id) names[o.id] = o.name; });
  [SH.ROUTES, SH.CIMG, SH.CADDR, SH.PRICES].forEach(function (sn) {
    const sh = sheet_(sn), c = cols_(sn, true), last = sh.getLastRow();
    if (last < 2) return;
    const ids = sh.getRange(2, c.campId + 1, last - 1, 1).getValues();
    const rng = sh.getRange(2, c.campName + 1, last - 1, 1), cur = rng.getValues();
    let changed = false;
    const out = cur.map(function (r, i) {
      const id = str_(ids[i][0]), now = str_(r[0]);
      const want = id && names[id] !== undefined ? names[id] : now;
      if (want !== now) changed = true;
      return [safeText_(want)];
    });
    if (changed) rng.setNumberFormat('@').setValues(out);
  });
}

// ── 캠프 ──
function adm_campSave(token, f) {
  return run_(function () {
    const a = requireAdmin_(token);
    f = f || {};
    const name = str_(f.name).replace(/\s+/g, ' ');
    if (!name) fail_('캠프명을 입력해 주세요.');
    if (name.length > 40) fail_('캠프명은 40자 이내로 입력해 주세요.');
    const address = str_(f.address).replace(/\s+/g, ' ');
    if (address.length > 200) fail_('주소가 너무 깁니다.');
    const memo = String(f.memo == null ? '' : f.memo).trim();
    if (memo.length > 2000) fail_('메모가 너무 깁니다. (2000자 이내)');
    const addrs = f.addresses === undefined ? undefined : cleanAddrs_(f.addresses);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const camps = readAll_(SH.CAMPS).filter(function (o) { return o.id || o.name; });
      if (camps.some(function (o) { return campKey_(o.name) === campKey_(name) && o.id !== f.id; })) {
        fail_('같은 이름의 캠프가 이미 있습니다: ' + name);
      }
      const now = nowText_();
      let row;
      if (!f.id) {
        row = appendObj_(SH.CAMPS, { id: newRid_('C'), name: name, address: address, memo: memo, createdAt: now, updatedAt: now });
      } else {
        const o = camps.filter(function (x) { return x.id === f.id; })[0];
        if (!o) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
        conflict_(f.seen, o);
        row = o._row;
        writeFields_(SH.CAMPS, row, { name: name, address: address, memo: memo, updatedAt: now });
        if (o.name !== name) syncCampNames_();
      }
      const camp = campView_(readObj_(SH.CAMPS, row));
      if (addrs !== undefined) saveAddrs_(camp, addrs, now);
      bumpMaster_();
      return {
        ok: true, camp: camp,
        addresses: readAll_(SH.CADDR).filter(function (x) { return x.campId === camp.id && x.address; }).map(addrView_)
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function adm_campDelete(token, id) {
  return run_(function () {
    const a = requireAdmin_(token);
    id = String(id || '');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let files = [];
    try {
      const row = findRow_(SH.CAMPS, 'id', id);
      if (!row) return { ok: true };
      const n = readAll_(SH.ROUTES).filter(function (r) { return r.campId === id && r.code; }).length;
      if (n) fail_('이 캠프에 노선이 ' + n + '개 있습니다. 노선을 먼저 지우거나 다른 캠프로 옮겨 주세요.');
      const o = readObj_(SH.CAMPS, row);
      const imgs = readAll_(SH.CIMG).filter(function (x) { return x.campId === id; });
      files = imgs.map(function (x) { return fileIdOf_(x.file); });
      imgs.map(function (x) { return x._row; }).sort(function (p, q) { return q - p; })
        .forEach(function (r) { sheet_(SH.CIMG).deleteRow(r); });
      sheet_(SH.CAMPS).deleteRow(row);
      [SH.CADDR, SH.PRICES].forEach(function (sn) {
        readAll_(sn).filter(function (x) { return x.campId === id; }).map(function (x) { return x._row; })
          .sort(function (p, q) { return q - p; }).forEach(function (r) { sheet_(sn).deleteRow(r); });
      });
      logAdmin_(a, '캠프 삭제', o.name + ' (' + id + ')', '이미지 ' + imgs.length + '장');
      bumpMaster_();
    } finally {
      lock.releaseLock();
    }
    files.forEach(trashCampFile_);
    return { ok: true };
  });
}

// ── 캠프 참고 이미지 ──
function campImgFolder_() {
  const p = props_();
  if (p.CAMP_IMG_FOLDER_ID) {
    try {
      const f = DriveApp.getFolderById(p.CAMP_IMG_FOLDER_ID);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 지워졌으면 새로 만든다 */ }
  }
  const f = DriveApp.getFolderById(p.ROOT_FOLDER_ID).createFolder('캠프 참고 이미지');
  PropertiesService.getScriptProperties().setProperty('CAMP_IMG_FOLDER_ID', f.getId());
  _props = null;
  return f;
}
/** 앱이 올린 파일(캠프 참고 이미지 폴더 안)만 휴지통으로. 시트에 직접 붙여 넣은 다른 파일은 건드리지 않는다. */
function trashCampFile_(fileId) {
  if (!fileId) return;
  try {
    const folderId = props_().CAMP_IMG_FOLDER_ID;
    const file = DriveApp.getFileById(fileId), parents = file.getParents();
    while (parents.hasNext()) {
      if (parents.next().getId() === folderId) { file.setTrashed(true); return; }
    }
  } catch (e) { /* 이미 없는 파일 */ }
}
function cleanDesc_(v) {
  const d = String(v == null ? '' : v).trim();
  if (d.length > 500) fail_('설명은 500자 이내로 입력해 주세요.');
  return d;
}

/** 이미지 1장 올리기: img = { data(base64), mime, desc } */
function adm_campImageAdd(token, campId, img) {
  return run_(function () {
    requireAdmin_(token);
    img = img || {};
    if (!img.data || !/^image\//.test(String(img.mime))) fail_('이미지 파일만 올릴 수 있습니다.');
    if (String(img.data).length > CFG.MAX_FILE_B64) fail_('이미지가 너무 큽니다.');
    const desc = cleanDesc_(img.desc);
    const row = findRow_(SH.CAMPS, 'id', String(campId || ''));
    if (!row) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
    const camp = readObj_(SH.CAMPS, row);
    // 업로드는 잠금 밖에서
    const id = newRid_('I');
    const ext = /png/.test(img.mime) ? '.png' : /webp/.test(img.mime) ? '.webp' : '.jpg';
    const fname = (camp.name + '_' + (desc.split('\n')[0].slice(0, 30) || '이미지') + '_' + id).replace(/[\\\/:*?"<>|]/g, ' ') + ext;
    const file = campImgFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(img.data), img.mime, fname));
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const max = readAll_(SH.CIMG).filter(function (x) { return x.campId === camp.id; })
        .reduce(function (m, x) { return Math.max(m, Number(x.order) || 0); }, 0);
      const now = nowText_();
      const r = appendObj_(SH.CIMG, {
        id: id, campId: camp.id, campName: camp.name, file: file.getUrl(), desc: desc, order: String(max + 1),
        createdAt: now, updatedAt: now
      });
      bumpMaster_();
      return { ok: true, image: imageView_(readObj_(SH.CIMG, r)) };
    } catch (e) {
      try { file.setTrashed(true); } catch (x) { /* 무시 */ }
      throw e;
    } finally {
      lock.releaseLock();
    }
  });
}

/** 설명 고치기 */
function adm_campImageSave(token, id, f) {
  return run_(function () {
    requireAdmin_(token);
    f = f || {};
    const desc = cleanDesc_(f.desc);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.CIMG, 'id', String(id || ''));
      if (!row) fail_('이미지를 찾을 수 없습니다. 새로고침해 주세요.');
      conflict_(f.seen, readObj_(SH.CIMG, row));
      writeFields_(SH.CIMG, row, { desc: desc, updatedAt: nowText_() });
      bumpMaster_();
      return { ok: true, image: imageView_(readObj_(SH.CIMG, row)) };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 순서 바꾸기: ids = 보여 줄 순서대로 이미지ID 목록 */
function adm_campImageOrder(token, campId, ids) {
  return run_(function () {
    requireAdmin_(token);
    ids = (ids || []).map(String);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const rows = {};
      readAll_(SH.CIMG).forEach(function (x) { if (x.campId === campId) rows[x.id] = x; });
      ids.forEach(function (id, i) {
        const x = rows[id];
        if (x && Number(x.order) !== i + 1) writeFields_(SH.CIMG, x._row, { order: String(i + 1) });
      });
      bumpMaster_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function adm_campImageDelete(token, id) {
  return run_(function () {
    requireAdmin_(token);
    let fileId = '';
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.CIMG, 'id', String(id || ''));
      if (!row) return { ok: true };
      fileId = fileIdOf_(readObj_(SH.CIMG, row).file);
      sheet_(SH.CIMG).deleteRow(row);
      bumpMaster_();
    } finally {
      lock.releaseLock();
    }
    trashCampFile_(fileId);
    return { ok: true };
  });
}

/** 이미지 내용. full=false 면 목록용 (큰 파일은 드라이브 썸네일, 작은 결과는 캐시) */
function adm_campImage(token, id, full) {
  return run_(function () {
    requireAdmin_(token);
    const row = findRow_(SH.CIMG, 'id', String(id || ''));
    if (!row) fail_('이미지를 찾을 수 없습니다.');
    const o = readObj_(SH.CIMG, row), fid = fileIdOf_(o.file);
    if (!fid) fail_('이미지 링크가 없습니다. camp_images 탭의 이미지 링크를 확인해 주세요.');
    const ck = 'cim:' + fid;
    if (!full) {
      const hit = cache_().get(ck);
      if (hit) {
        const p = hit.split('|', 2);
        return { ok: true, mime: p[0], thumb: p[1] === 't', data: hit.slice(p[0].length + p[1].length + 2), url: o.file };
      }
    }
    let file;
    try { file = DriveApp.getFileById(fid); } catch (e) { fail_('이미지 파일을 열 수 없습니다. 드라이브에서 지워졌는지 확인해 주세요.'); }
    const size = file.getSize();
    if (size > 15 * 1024 * 1024) fail_('파일이 너무 커서 화면에 표시할 수 없습니다. 드라이브에서 열어 주세요.');
    let blob = null, thumb = false;
    if (!full && size > 600 * 1024) { try { blob = file.getThumbnail(); thumb = !!blob; } catch (e) { blob = null; } }
    if (!blob) blob = file.getBlob();
    const mime = blob.getContentType() || 'image/jpeg';
    if (!/^image\//.test(mime)) fail_('이미지 파일이 아닙니다.');
    const data = Utilities.base64Encode(blob.getBytes());
    if (!full && data.length < 90000) { try { cache_().put(ck, mime + '|' + (thumb ? 't' : 'f') + '|' + data, CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
    return { ok: true, mime: mime, thumb: thumb, data: data, url: o.file };
  });
}

// ── 노선 ──
function routeRowObj_(campId, campName, code, status, memo, now) {
  const g = splitCode_(code);
  return {
    id: newRid_('R'), campId: campId, campName: campName, code: code,
    g1: g.g1, g2: g.g2, g3: g.g3, g4: g.g4, g5: g.g5,
    status: status || RST.ON, memo: memo || '', createdAt: now, updatedAt: now
  };
}
/** 여러 줄을 한 번에 추가 (잠금 안에서만 호출) */
function appendObjs_(name, objs) {
  if (!objs.length) return 0;
  const c = cols_(name, true), sh = sheet_(name);
  const rows = objs.map(function (obj) {
    const arr = new Array(c.__w).fill('');
    Object.keys(obj).forEach(function (k) { arr[c[k]] = safeText_(obj[k]); });
    return arr;
  });
  const r = sh.getLastRow() + 1;
  if (r + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 500);
  sh.getRange(r, 1, rows.length, c.__w).setNumberFormat('@').setValues(rows);
  return r;
}
function campMap_() {
  const m = {};
  readAll_(SH.CAMPS).forEach(function (o) { if (o.id) m[o.id] = o; });
  return m;
}

/** 노선 추가(id 없음) 또는 수정. 수정은 바꿀 항목만 보내도 된다: code, campId, status, memo */
function adm_routeSave(token, f) {
  return run_(function () {
    requireAdmin_(token);
    f = f || {};
    if (f.status !== undefined && f.status !== RST.ON && f.status !== RST.OFF) fail_('사용여부는 사용 또는 중지만 됩니다.');
    const memo = f.memo === undefined ? undefined : String(f.memo || '').trim();
    if (memo && memo.length > 1000) fail_('메모가 너무 깁니다. (1000자 이내)');
    const code = f.code === undefined ? undefined : checkCode_(f.code);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const camps = campMap_(), routes = readAll_(SH.ROUTES);
      const dup = function (campId, cd, selfId) {
        return routes.some(function (r) { return r.id !== selfId && r.campId === campId && normCode_(r.code) === cd; });
      };
      const now = nowText_();
      let row;
      if (!f.id) {
        const camp = camps[f.campId];
        if (!camp) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
        if (!code) fail_('노선코드를 입력해 주세요.');
        if (dup(camp.id, code, '')) fail_(camp.name + '에 이미 있는 노선코드입니다: ' + code);
        row = appendObj_(SH.ROUTES, routeRowObj_(camp.id, camp.name, code, f.status, memo, now));
      } else {
        const o = routes.filter(function (r) { return r.id === f.id; })[0];
        if (!o) fail_('노선을 찾을 수 없습니다. 시트에서 지워졌을 수 있습니다. 새로고침해 주세요.');
        conflict_(f.seen, o);
        const upd = {};
        let campId = o.campId, cd = normCode_(o.code);
        if (f.campId !== undefined && f.campId !== o.campId) {
          const camp = camps[f.campId];
          if (!camp) fail_('옮길 캠프를 찾을 수 없습니다.');
          campId = upd.campId = camp.id; upd.campName = camp.name;
        }
        if (code !== undefined) {
          cd = upd.code = code;
          const g = splitCode_(code);
          Object.keys(g).forEach(function (k) { upd[k] = g[k]; });
        }
        if (f.status !== undefined) upd.status = f.status;
        if (memo !== undefined) upd.memo = memo;
        if (dup(campId, cd, o.id)) fail_((camps[campId] ? camps[campId].name : '같은 캠프') + '에 이미 있는 노선코드입니다: ' + cd);
        upd.updatedAt = now;
        row = o._row;
        writeFields_(SH.ROUTES, row, upd);
      }
      bumpMaster_();
      return { ok: true, route: routeView_(readObj_(SH.ROUTES, row)) };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 노선 여러 개 한 번에 추가. text = 줄바꿈·쉼표·띄어쓰기로 나눈 노선코드들 */
function adm_routeBulkAdd(token, campId, text) {
  return run_(function () {
    requireAdmin_(token);
    const list = String(text || '').split(/[\s,;]+/).map(normCode_).filter(function (x) { return x; });
    if (!list.length) fail_('노선코드를 입력해 주세요.');
    if (list.length > 500) fail_('한 번에 500개까지 추가할 수 있습니다.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const camp = campMap_()[campId];
      if (!camp) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
      const have = {};
      readAll_(SH.ROUTES).forEach(function (r) { if (r.campId === camp.id) have[normCode_(r.code)] = 1; });
      const now = nowText_(), add = [], skipped = [];
      list.forEach(function (cd) {
        let bad = '';
        try { checkCode_(cd); } catch (e) { bad = '사용할 수 없는 글자'; }
        if (!bad && have[cd]) bad = '이미 있음';
        if (bad) { skipped.push({ code: cd, reason: bad }); return; }
        have[cd] = 1;
        add.push(routeRowObj_(camp.id, camp.name, cd, RST.ON, '', now));
      });
      const r0 = appendObjs_(SH.ROUTES, add);
      bumpMaster_();
      const routes = add.map(function (x, i) { x._row = r0 + i; return routeView_(x); });
      return { ok: true, routes: routes, skipped: skipped };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 여러 노선 사용/중지 */
function adm_routeStatus(token, ids, status) {
  return run_(function () {
    requireAdmin_(token);
    if (status !== RST.ON && status !== RST.OFF) fail_('사용여부는 사용 또는 중지만 됩니다.');
    const want = {};
    (ids || []).forEach(function (id) { want[String(id)] = 1; });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const now = nowText_(), done = [];
      readAll_(SH.ROUTES).forEach(function (r) {
        if (!want[r.id]) return;
        if (r.status !== status) writeFields_(SH.ROUTES, r._row, { status: status, updatedAt: now });
        r.status = status; r.updatedAt = now;
        done.push(routeView_(r));
      });
      bumpMaster_();
      return { ok: true, routes: done };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 노선 삭제 (여러 개 가능) */
function adm_routeDelete(token, ids) {
  return run_(function () {
    const a = requireAdmin_(token);
    const want = {};
    (ids || []).forEach(function (id) { want[String(id)] = 1; });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const hit = readAll_(SH.ROUTES).filter(function (r) { return want[r.id]; });
      hit.map(function (r) { return r._row; }).sort(function (p, q) { return q - p; })
        .forEach(function (row) { sheet_(SH.ROUTES).deleteRow(row); });
      if (hit.length) {
        logAdmin_(a, '노선 삭제', hit.length + '개', hit.slice(0, 30).map(function (r) { return r.campName + ' ' + r.code; }).join(', '));
      }
      bumpMaster_();
      return { ok: true, deleted: hit.map(function (r) { return r.id; }) };
    } finally {
      lock.releaseLock();
    }
  });
}

// ── 시트를 직접 고쳤을 때 (onSheetEdit 에서 호출) ──
let _campIdx = null, _routeList = null;
function campIndex_() {
  if (_campIdx) return _campIdx;
  const idx = { byId: {}, byName: {}, count: {} };
  readAll_(SH.CAMPS).forEach(function (o) {
    if (!o.name) return;
    const k = campKey_(o.name);
    idx.count[k] = (idx.count[k] || 0) + 1;
    if (o.id) { idx.byId[o.id] = o.name; if (!idx.byName[k]) idx.byName[k] = o.id; }
  });
  return (_campIdx = idx);
}
/** 캠프명(우선) 또는 캠프ID로 캠프 찾기 → { campId, campName } 또는 { err } */
function resolveCamp_(o) {
  const idx = campIndex_();
  if (o.campName) {
    const id = idx.byName[campKey_(o.campName)];
    if (id) return { campId: id, campName: idx.byId[id] };
    return { err: '없는 캠프명입니다. camps 탭에 있는 캠프명과 똑같이 입력해 주세요.' };
  }
  if (o.campId && idx.byId[o.campId] !== undefined) return { campId: o.campId, campName: idx.byId[o.campId] };
  return { err: '캠프명을 입력해 주세요.' };
}
function putCells_(sh, c, row, upd) {
  Object.keys(upd).forEach(function (k) { sh.getRange(row, c[k] + 1).setNumberFormat('@').setValue(safeText_(upd[k])); });
}
function putNote_(sh, c, row, k, msg, had) {
  const cell = sh.getRange(row, c[k] + 1);
  if (msg) cell.setNote(msg); else if (had !== false) cell.clearNote();
}

function fixCampRow_(sh, c, o) {
  if (!o.id && !o.name) return;
  const upd = {}, now = nowText_();
  if (!o.id) { upd.id = newRid_('C'); if (!o.createdAt) upd.createdAt = now; }
  const name = o.name.replace(/\s+/g, ' ');
  if (name !== o.name) upd.name = name;
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  const n = campIndex_().count[campKey_(name)] || 0;
  putNote_(sh, c, o._row, 'name', !name ? '캠프명을 입력해 주세요.' : n > 1 ? '같은 캠프명이 또 있습니다. 캠프명은 겹치지 않게 해 주세요.' : '');
}

function fixRouteRow_(sh, c, o) {
  if (!o.id && !o.code && !o.campName && !o.campId) return;
  const upd = {}, now = nowText_();
  if (!o.id) { upd.id = newRid_('R'); if (!o.createdAt) upd.createdAt = now; }
  const code = normCode_(o.code);
  if (code !== o.code) upd.code = code;
  const g = splitCode_(code);
  Object.keys(g).forEach(function (k) { if (o[k] !== g[k]) upd[k] = g[k]; });
  const st = /^(중지|n|no|x|off|미사용|사용안함|0)$/i.test(o.status) ? RST.OFF : RST.ON;
  if (st !== o.status) upd.status = st;
  const camp = resolveCamp_(o);
  if (!camp.err) {
    if (camp.campId !== o.campId) upd.campId = camp.campId;
    if (camp.campName !== o.campName) upd.campName = camp.campName;
  }
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  putNote_(sh, c, o._row, 'campName', camp.err || '');
  let codeMsg = '';
  if (!code) codeMsg = '노선코드를 입력해 주세요.';
  else if (!/^[0-9A-Z가-힣_-]+$/.test(code) || code.length > 20) codeMsg = '노선코드에는 영문·숫자·한글·- 만, 20자 이내로 써 주세요.';
  else if (!camp.err) {
    if (!_routeList) _routeList = readAll_(SH.ROUTES);
    const same = _routeList.some(function (r) { return r._row !== o._row && r.campId === camp.campId && normCode_(r.code) === code; });
    if (same) codeMsg = '같은 캠프에 같은 노선코드가 또 있습니다.';
  }
  putNote_(sh, c, o._row, 'code', codeMsg);
}

function fixCampImageRow_(sh, c, o) {
  if (!o.id && !o.file && !o.campName && !o.campId) return;
  const upd = {}, now = nowText_();
  if (!o.id) { upd.id = newRid_('I'); if (!o.createdAt) upd.createdAt = now; }
  const camp = resolveCamp_(o);
  if (!camp.err) {
    if (camp.campId !== o.campId) upd.campId = camp.campId;
    if (camp.campName !== o.campName) upd.campName = camp.campName;
  }
  if (o.order && !/^\d+$/.test(o.order)) upd.order = String(parseInt(o.order, 10) || '');
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  putNote_(sh, c, o._row, 'campName', camp.err || '');
  putNote_(sh, c, o._row, 'file', fileIdOf_(o.file) ? '' : '드라이브 이미지 링크를 붙여 넣어 주세요.');
}

// ── 캠프 주소와 다른 곳 (상차지 등) ──
function addrView_(o) {
  return { id: o.id, campId: o.campId, label: o.label || '상차지', address: o.address, order: Number(o.order) || 0 };
}
/** 화면에서 받은 주소 목록 정리: 주소가 빈 줄은 버린다 */
function cleanAddrs_(list) {
  const out = [];
  (list || []).forEach(function (x) {
    const address = str_(x && x.address).replace(/\s+/g, ' ');
    const label = str_(x && x.label).replace(/\s+/g, ' ') || '상차지';
    if (!address) return;
    if (address.length > 200) fail_('주소가 너무 깁니다: ' + address.slice(0, 20) + '…');
    if (label.length > 20) fail_('주소 이름은 20자 이내로 입력해 주세요: ' + label);
    out.push({ label: label, address: address });
  });
  if (out.length > CAD_MAX) fail_('주소는 캠프마다 ' + CAD_MAX + '개까지 넣을 수 있습니다.');
  return out;
}
/** 캠프의 추가 주소를 받은 목록으로 바꾼다 (잠금 안에서만 호출). 같은 내용이면 쓰지 않는다. */
function saveAddrs_(camp, list, now) {
  const sh = sheet_(SH.CADDR);
  const have = readAll_(SH.CADDR).filter(function (x) { return x.campId === camp.id; })
    .sort(function (p, q) { return (Number(p.order) || 1e9) - (Number(q.order) || 1e9); });
  const same = have.length === list.length && have.every(function (x, i) {
    return (x.label || '상차지') === list[i].label && x.address === list[i].address && Number(x.order) === i + 1;
  });
  if (same) return;
  // 이름·주소가 같은 줄은 주소ID·등록일시를 유지한다
  const keep = {};
  have.forEach(function (x) { keep[x.label + '|' + x.address] = keep[x.label + '|' + x.address] || x; });
  have.map(function (x) { return x._row; }).sort(function (p, q) { return q - p; })
    .forEach(function (r) { sh.deleteRow(r); });
  appendObjs_(SH.CADDR, list.map(function (x, i) {
    const old = keep[x.label + '|' + x.address];
    if (old) delete keep[x.label + '|' + x.address];
    return {
      id: old ? old.id : newRid_('A'), campId: camp.id, campName: camp.name, label: x.label, address: x.address,
      order: String(i + 1), createdAt: old ? old.createdAt : now, updatedAt: now
    };
  }));
}
function fixCampAddrRow_(sh, c, o) {
  if (!o.id && !o.address && !o.campName && !o.campId && !o.label) return;
  const upd = {}, now = nowText_();
  if (!o.id) { upd.id = newRid_('A'); if (!o.createdAt) upd.createdAt = now; }
  const camp = resolveCamp_(o);
  if (!camp.err) {
    if (camp.campId !== o.campId) upd.campId = camp.campId;
    if (camp.campName !== o.campName) upd.campName = camp.campName;
  }
  if (!o.label && o.address) upd.label = '상차지';
  if (o.order && !/^\d+$/.test(o.order)) upd.order = String(parseInt(o.order, 10) || '');
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  putNote_(sh, c, o._row, 'campName', camp.err || '');
  putNote_(sh, c, o._row, 'address', o.address ? '' : '주소를 입력해 주세요.');
}

// ── 구분별 단가 (숫자별 구분2~5 글자마다) ──
/** 구분 글자 정리: '구분3' / '3' → 3. 2~5 가 아니면 0 */
function normLevel_(v) {
  const m = str_(v).match(/^(?:구분)?\s*([2-5])$/);
  return m ? Number(m[1]) : 0;
}
function priceKey_(num, level, value) { return num + '|' + level + '|' + value; }
/** 금액 글자 정리: '1,200원' → '1200'. 비었으면 '', 잘못되면 null */
function normMoney_(v) {
  const s = str_(v).replace(/[,\s원₩]/g, '');
  if (!s) return '';
  return /^\d{1,9}$/.test(s) ? String(Number(s)) : null;
}
function priceView_(o) {
  const v = {
    id: o.id, campId: o.campId, num: normCode_(o.num), level: normLevel_(o.level), value: normCode_(o.value),
    tmpStart: o.tmpStart, tmpEnd: o.tmpEnd, updatedAt: o.updatedAt
  };
  RP_PRICE_KEYS.forEach(function (k) { const m = normMoney_(o[k]); v[k] = m === null ? o[k] : m; });
  return v;
}

/**
 * 캠프의 구분별 단가를 한 번에 저장.
 * rows = [{ num, level, value, p1..p5, tmp, tmpStart, tmpEnd, seen }] — 보낸 줄만 바뀐다. 단가를 모두 비우면 그 줄은 지운다.
 */
function adm_priceSave(token, campId, rows) {
  return run_(function () {
    const a = requireAdmin_(token);
    rows = rows || [];
    if (!rows.length) fail_('저장할 단가가 없습니다.');
    if (rows.length > 2000) fail_('한 번에 2000줄까지 저장할 수 있습니다.');
    // 1) 값 검사 (잠금 밖)
    const clean = rows.map(function (r) {
      const num = normCode_(r.num), level = normLevel_(r.level), value = normCode_(r.value);
      if (!num || !level || !value || num.length > 10 || value.length > 10) fail_('구분 정보가 올바르지 않습니다: ' + [r.num, r.level, r.value].join(' '));
      const name = num + ' 구분' + level + ' ' + value;
      const x = { num: num, level: level, value: value, key: priceKey_(num, level, value), name: name, seen: r.seen };
      RP_PRICE_KEYS.forEach(function (k) {
        const m = normMoney_(r[k]);
        if (m === null) fail_(name + ' ' + RP[k] + ': 숫자만 입력해 주세요.');
        x[k] = m;
      });
      x.tmpStart = r.tmpStart ? normDate_(r.tmpStart) : '';
      x.tmpEnd = r.tmpEnd ? normDate_(r.tmpEnd) : '';
      if ((r.tmpStart && !x.tmpStart) || (r.tmpEnd && !x.tmpEnd)) fail_(name + ' 일시단가 기간의 날짜 형식을 확인해 주세요.');
      if (x.tmp && (!x.tmpStart || !x.tmpEnd)) fail_(name + ' 일시단가는 시작일과 종료일을 같이 입력해 주세요.');
      if (x.tmpStart && x.tmpEnd && x.tmpStart > x.tmpEnd) fail_(name + ' 일시단가 종료일이 시작일보다 빠릅니다.');
      if (!x.tmp && (x.tmpStart || x.tmpEnd)) fail_(name + ' 일시단가 금액을 입력하거나 기간을 지워 주세요.');
      x.empty = RP_PRICE_KEYS.every(function (k) { return !x[k]; });
      return x;
    });
    // 2) 저장 (짧게 잠금)
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const camp = campMap_()[campId];
      if (!camp) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
      const have = {};
      readAll_(SH.PRICES).forEach(function (o) {
        if (o.campId !== camp.id) return;
        const k = priceKey_(normCode_(o.num), normLevel_(o.level), normCode_(o.value));
        if (!have[k]) have[k] = o;
      });
      clean.forEach(function (x) {
        const o = have[x.key];
        if (o && x.seen !== undefined && x.seen !== null && String(x.seen) !== String(o.updatedAt || '')) {
          fail_(x.name + ' 단가가 다른 곳(다른 관리자 또는 시트)에서 먼저 수정되었습니다. 새로고침한 뒤 다시 해 주세요.');
        }
        if (!o && x.seen) fail_(x.name + ' 단가가 다른 곳에서 지워졌습니다. 새로고침한 뒤 다시 해 주세요.');
      });
      const now = nowText_(), add = [], del = [];
      let changed = 0;
      clean.forEach(function (x) {
        const o = have[x.key];
        if (x.empty) { if (o) { del.push(o._row); changed++; } return; }
        const f = { num: x.num, level: '구분' + x.level, value: x.value, tmpStart: x.tmpStart, tmpEnd: x.tmpEnd };
        RP_PRICE_KEYS.forEach(function (k) { f[k] = x[k]; });
        if (!o) {
          add.push(Object.assign({ id: newRid_('P'), campId: camp.id, campName: camp.name, createdAt: now, updatedAt: now }, f));
          changed++;
          return;
        }
        const upd = {};
        Object.keys(f).forEach(function (k) { if (String(o[k] || '') !== String(f[k])) upd[k] = f[k]; });
        if (Object.keys(upd).length) { upd.updatedAt = now; writeFields_(SH.PRICES, o._row, upd); changed++; }
      });
      appendObjs_(SH.PRICES, add);
      del.sort(function (p, q) { return q - p; }).forEach(function (r) { sheet_(SH.PRICES).deleteRow(r); });
      if (changed) {
        logAdmin_(a, '단가 저장', camp.name, clean.slice(0, 20).map(function (x) {
          return x.name + (x.empty ? ' 삭제' : ' ' + RP_PRICE_KEYS.map(function (k) { return x[k] || '-'; }).join('/'));
        }).join(', ') + (clean.length > 20 ? ' 외 ' + (clean.length - 20) + '건' : ''));
      }
      bumpMaster_();
      const prices = readAll_(SH.PRICES).filter(function (o) { return o.campId === camp.id && o.num; }).map(priceView_);
      return { ok: true, changed: changed, prices: prices };
    } finally {
      lock.releaseLock();
    }
  });
}

/** route_prices 시트를 직접 고쳤을 때 */
function fixPriceRow_(sh, c, o) {
  if (!o.id && !o.num && !o.value && !o.campName && !o.campId) return;
  const upd = {}, now = nowText_(), notes = {};
  if (!o.id) { upd.id = newRid_('P'); if (!o.createdAt) upd.createdAt = now; }
  const camp = resolveCamp_(o);
  if (!camp.err) {
    if (camp.campId !== o.campId) upd.campId = camp.campId;
    if (camp.campName !== o.campName) upd.campName = camp.campName;
  }
  const num = normCode_(o.num), value = normCode_(o.value), level = normLevel_(o.level);
  if (num) { if (num !== o.num) upd.num = num; } else notes.num = '노선코드 앞 숫자를 입력해 주세요. (예: 110)';
  if (level) { if ('구분' + level !== o.level) upd.level = '구분' + level; } else notes.level = '구분2 ~ 구분5 중 하나로 입력해 주세요.';
  if (value) { if (value !== o.value) upd.value = value; } else notes.value = '그 구분 자리의 글자를 입력해 주세요. (예: A)';
  RP_PRICE_KEYS.forEach(function (k) {
    const m = normMoney_(o[k]);
    if (m === null) notes[k] = '숫자만 입력해 주세요.';
    else if (m !== o[k]) upd[k] = m;
  });
  ['tmpStart', 'tmpEnd'].forEach(function (k) {
    if (!o[k]) return;
    const d = normDate_(o[k]);
    if (d) { if (d !== o[k]) upd[k] = d; } else notes[k] = '날짜 형식을 확인해 주세요. (예: 2026-11-01)';
  });
  if (o.tmp && (!o.tmpStart || !o.tmpEnd)) notes.tmp = '일시단가는 시작일과 종료일을 같이 입력해 주세요.';
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  putNote_(sh, c, o._row, 'campName', camp.err || '');
  ['num', 'level', 'value', 'tmpStart', 'tmpEnd'].concat(RP_PRICE_KEYS).forEach(function (k) { putNote_(sh, c, o._row, k, notes[k] || ''); });
}
