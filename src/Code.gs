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
  SIGNUP_PER_HOUR: 30,           // 전체 가입 신청 1시간 최대 건수 (자동 가입 공격으로 드라이브가 가득 차는 것 방지)
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
  CAMPS: 'camps', CIMG: 'camp_images', ROUTES: 'routes', CADDR: 'camp_addresses', PRICES: 'route_prices', NOTICE: 'notices', ACC: 'accounts', ACAT: 'account_categories',
  PJOB: 'pumasi_jobs', PAPP: 'pumasi_apps', PALERT: 'pumasi_alerts', PPUSH: 'push_tokens', PAVAIL: 'pumasi_avail',
  BPOST: 'board_posts', BCMT: 'board_comments', BREP: 'board_reports', BBAN: 'board_bans', BWORD: 'board_words', APPSET: 'app_settings', TAXINV: 'tax_invoices', RCHG: 'route_changes', PERF: 'perf_log', ERR: 'error_log', PDAY: 'perf_daily', RPERF: 'route_perf', RSLA: 'route_sla', RLIN: 'route_lineage', RFB: 'route_fb', TEAMS: 'teams_msgs', CTHUMB: 'camp_thumbs', RNOTE: 'route_notes', CPROS: 'coupang_roster', INVCHK: 'inv_checks', INSREP: 'ins_reports' };

// drivers 시트 열 정의. 값 = 시트 머리글 (머리글 이름은 바꾸지 말 것, 순서는 자유)
const D = {
  id: '기사ID', loginId: '쿠팡플렉스 아이디', name: '이름', phone: '연락처', status: '상태', workStatus: '근무상태', leaveDate: '퇴사일', subId1: '서브아이디1', subId2: '서브아이디2',
  workerId: '실제 근무자 기사ID', // 같은 근무자 연결: 이 기사는 명의(아이디)만 있고 실제로는 그 기사가 뜀 → 스케줄은 근무자 한 줄 · 정산서는 명의별로 따로
  subType1: '서브아이디1 단가코드', subType2: '서브아이디2 단가코드', stlMode: '정산 방식', insEx: '산재·고용 제외', fbCut: '프레시백 차감',
  driverType: '단가코드', driverCode: '기사코드', title: '직함',
  birthDate: '생년월일', rrn: '주민등록번호', address: '주소(주민등록상)',
  qualDate: '화물운송 종사자격 취득일', qualNo: '화물운송 종사자격증 번호',
  licenseNo: '운전면허번호', licenseType: '운전면허 종류',
  carNo: '차량번호', carName: '차명', carYear: '연식', maxLoad: '최대적재량(kg)',
  schCampId: '소속캠프ID', schCamp: '소속캠프', baseRoute: '기본노선', fixedOff: '고정휴무일', extraOff: '추가휴무',
  workPattern: '근무형태', schMemo: '스케줄 메모', schOrder: '스케줄 순서', backupArea: '백업 범위', extraAssign: '추가 배정', tiOn: '역발행 대상',
  // 정산관리: 명의자 세금계산서 정보 (정산 기준인 쿠팡 아이디·단가코드·일시단가는 정산 DB 의 아이디 관리·일시단가 탭)
  bizNo: '사업자등록번호', bizName: '상호', bizEmail: '계산서 이메일', bizCeo: '사업자 대표자', bizAddr: '사업장 주소', bizType: '업태', bizItem: '종목',
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
const D_AUTO_ADD = ['pwMustChange', 'carNo', 'driverType', 'driverCode', 'schCampId', 'schCamp', 'baseRoute', 'fixedOff', 'extraOff', 'workPattern', 'schMemo', 'schOrder',
  'bizNo', 'bizName', 'bizEmail', 'bizCeo', 'bizAddr', 'bizType', 'bizItem', 'title', 'backupArea', 'workStatus', 'leaveDate', 'subId1', 'subId2',
  'subType1', 'subType2', 'stlMode', 'insEx', 'fbCut', 'extraAssign', 'tiOn', 'workerId'];
// 단가코드 (고정/백업/품앗이/외부용차 → 노선관리 고정단가/백업단가/품앗이단가/외부용차단가)
const DTYPES = ['고정', '백업', '품앗이', '외부용차'];
// 직함 = 단가와 무관한 러너 내부 직책. 대신 뛴 건은 기사 정산서에 이름이 안 보이고, 앞으로 권한 부여에 쓴다
const TITLES = ['관리자', '운영자', '대표'];
const DTYPES_STAFF = TITLES; // (예전 이름)
/** 러너 내부 인원(관리자·운영자·대표)인지: 직함 칸 (예전에 단가코드에 적은 값도 인정) */
function isStaff_(o) { return !!o && (TITLES.indexOf(str_(o.title)) >= 0 || TITLES.indexOf(str_(o.driverType)) >= 0); }
/** 직함 글자 ('관리자'·'운영자'·'대표' · 일반 기사는 ''). 예전에 단가코드에 적은 값도 인정 */
function titleOf_(o) { if (!o) return ''; const t = normTitle_(o.title); if (t) return t; return TITLES.indexOf(str_(o.driverType)) >= 0 ? str_(o.driverType) : ''; }
/** 운영자 전용 가짜 캠프(노선 없음)인지 — 기사 앱에는 캠프로 안 보여 준다 */
function isStaffCamp_(name) { return /^운영자/.test(str_(name).replace(/\s+/g, '')); }
/** 직함 글자 정리. 모르는 값이면 null */
function normTitle_(v) {
  const s = str_(v).replace(/\s+/g, '');
  if (!s) return '';
  if (/^관리/.test(s)) return '관리자';
  if (/^운영/.test(s)) return '운영자';
  if (/^대표/.test(s)) return '대표';
  return null;
}
// 근무상태 = 실제 일하는지 (재직 = 빈칸). '상태'(승인대기·승인·반려·정지)는 기사 앱 사용 여부라 따로 관리
const WSTAT = ['재직', '휴직', '퇴사'];
/** 스케줄·입차에서 빠지는 첫날: 퇴사면 퇴사일 다음 날 (퇴사일 = 마지막 근무일), 퇴사일이 없으면 처음부터 */
function schLeaveFrom_(o) {
  if (str_(o.workStatus) !== '퇴사') return '';
  const d = parseYmd_(o.leaveDate);
  return d ? ymd_(addDays_(d, 1)) : '0000-00-00';
}
const D_HIDDEN = ['rrnEnc', 'rrnIndex', 'licenseNoEnc', 'accountEnc', 'pwHash', 'pwSalt'];
const D_NOTES = {
  schCamp: '스케줄에서 이 기사가 속한 캠프. camps 탭의 캠프명과 같게 쓰면 소속캠프ID가 자동으로 채워집니다.',
  baseRoute: '평소 맡는 노선. 예: 527B, 530AB (F3), 404D,405AB. 백업 기사는 백업, 용차는 용차',
  extraAssign: '소속 캠프 말고 추가로 맡는 캠프·노선 (기사 정보관리에서 고침). 예: [{"c":"캠프ID","r":"527B"}] → 기사스케줄에 그 캠프 줄이 하나 더 생김',
  fixedOff: '고정 휴무 요일. 예: 목,금 (스케줄 빈칸 자동 채우기에 사용)',
  subId1: '이 기사가 쓰는 다른 쿠팡플렉스 아이디 (서브). 넣으면 그 아이디로 뛴 건은 이 기사 정산서로 합쳐지고, 그 아이디로 가입한 기사는 앱 사용만 정지됩니다',
  subId2: '두 번째 서브아이디',
  subType1: '서브아이디1로 뛴 건의 단가코드 (고정/백업/품앗이/외부용차). 비우면 메인과 같음',
  subType2: '서브아이디2로 뛴 건의 단가코드. 비우면 메인과 같음',
  stlMode: '정산 방식: 빈칸(기본) / 원청단가 / 용차내역',
  insEx: '산재·고용보험 공제 제외면 Y',
  fbCut: '프레시백 차감: 13% 같은 비율 또는 금액 (비우면 차감 없음)',
  workStatus: '재직(빈칸) / 휴직 / 퇴사. 기사 앱 사용(상태 칸)과 따로. 퇴사면 퇴사일 다음 날부터 스케줄·쿠팡 입차 목록에서 빠짐',
  leaveDate: '마지막 근무일 (yyyy-mm-dd). 근무상태가 퇴사일 때만 씀',
  backupArea: '백업으로 들어갈 수 있는 곳. 전지역 또는 캠프 이름(예: 강서1,수원1). 기사스케줄 백업 추천에 사용',
  driverType: '고정 / 백업 / 품앗이 / 외부용차 (노선관리 고정단가 / 백업단가 / 품앗이단가 / 외부용차단가)',
  title: '관리자 / 운영자 / 대표 (빈칸 = 일반 기사). 단가와 무관한 러너 내부 직책.\n직함이 있는 사람이 대신 뛴 건은 기사 정산서에 수행자 이름이 안 보입니다. 앞으로 권한 부여에도 씁니다.',
  driverCode: '기사마다 겹치지 않는 코드 (영문은 자동 대문자)',
  status: '승인대기 / 승인 / 반려 / 정지 중 선택.\n승인으로 바꾸면 승인일시가 자동 기록됩니다.',
  rrn: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.\n생년월일도 자동 갱신됩니다.\n※ 시트에 직접 입력한 원래 번호는 구글 시트 "버전 기록"에 남습니다. 가능하면 관리자 화면에서 입력하세요.',
  licenseNo: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.\n※ 시트 "버전 기록"에 남으므로 가능하면 관리자 화면에서 입력하세요.',
  account: '새 번호를 그대로 입력하면 자동 암호화되고 가린 번호로 바뀝니다.\n※ 시트 "버전 기록"에 남으므로 가능하면 관리자 화면에서 입력하세요.',
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
  author: '작성자', createdAt: '작성일시', updatedAt: '수정일시', cat: '비고 줄'
};
// 코드 업데이트로 새로 생긴 열 중, 비어 있어도 안전해서 자동으로 추가하는 열 (시트별)
const AUTO_ADD_COLS = { work_memo: ['cat'], camps: ['cpCode'] };
// 예전 버전이 쓰던 머리글 (지금은 정산 DB 로 옮겨짐). 남아 있어도 '이름 바뀐 머리글'로 보지 않는다
const LEGACY_HEADS = { drivers: ['정산 대상 기사ID', '기사 일시단가', '기사 일시단가 노선', '기사 일시단가 시작일', '기사 일시단가 종료일'] };
const M_NOTES = {
  date: '2026-11-03 형식. 2026.11.3, 2026/11/3 처럼 입력해도 자동으로 맞춰집니다.',
  time: '선택. 09:30 형식 (24시간)',
  done: '완료하면 Y',
  cat: '기사스케줄의 어느 비고 줄에 보일지 (비고 줄 이름). 비우면 첫 번째 비고 줄(업무 관련)에 보입니다.',
  content: '새 줄에 날짜와 내용을 입력하면 메모ID와 작성일시가 자동으로 채워집니다.'
};

// notices 시트 (기사 앱 공지사항). 시트에서 직접 줄을 추가·수정해도 된다.
const NST = { ON: '게시', OFF: '숨김' };
const N = {
  id: '공지ID', title: '제목', body: '내용', important: '중요', target: '대상 캠프', start: '게시 시작일', end: '게시 종료일',
  status: '상태', author: '작성자', createdAt: '작성일시', updatedAt: '수정일시', attach: '사진'
};
const N_NOTES = {
  title: '새 줄에 제목·내용을 입력하면 공지ID·작성일시가 자동으로 채워지고 기사 앱에 바로 보입니다.',
  important: 'Y 이면 기사 앱 맨 위에 고정되고, 처음 열 때 팝업으로 한 번 보여 줍니다.',
  target: '비우면 전체 기사. 캠프명을 쓰면 그 캠프 소속 기사에게만 (여러 캠프는 쉼표로). 예: 강서1, 서초1',
  start: '2026-11-04 형식. 비우면 바로 게시',
  end: '2026-11-30 형식. 비우면 계속 게시 (그날까지 보임)',
  status: '게시 / 숨김. 숨김으로 바꾸면 기사 앱에서 바로 사라집니다.'
};

// accounts 시트 (회사가 쓰는 다른 프로그램·서비스 계정: 쿠팡 어드민, 팀즈, 메일, 홈택스 등. 기사 계정 아님)
const ACC_MASK = '●●●●●●●●';
const ACST = { ON: '사용', OFF: '정지' }; // 예전 값 '중지' 도 정지로 읽는다
const ACC_CATS = ['쿠팡', '팀즈', '메일', '홈택스·세무', '은행·카드', '통신·인터넷', '기타'];
const AC = {
  id: '계정ID', category: '분류', service: '서비스명', camp: '캠프', loginId: '아이디', password: '비밀번호',
  owner: '사용자·담당자', url: '접속 주소', memo: '메모', status: '상태', pwChangedAt: '비밀번호 변경일',
  author: '등록자', createdAt: '등록일시', updatedAt: '수정일시', pwEnc: '비밀번호(암호화)'
};
// account_categories 시트: 계정관리 분류 목록 (순서대로 탭에 보임). 시트에서 직접 고쳐도 된다.
const ACAT = { name: '분류', order: '순서' };
const AC_NOTES = {
  password: '새 비밀번호를 그대로 입력하면 자동 암호화되고 ●●●● 로 바뀝니다. 지우면 저장된 비밀번호도 지워집니다.\n' +
    '※ 시트에 직접 입력한 원래 값은 구글 시트 "버전 기록"에 남습니다. 가능하면 관리자 화면 > 계정관리에서 입력하세요.',
  category: '예: 쿠팡 / 팀즈 / 메일 / 홈택스·세무 / 은행·카드 / 통신·인터넷 / 기타 (자유롭게 써도 됨)',
  camp: '캠프별 계정이면 캠프명 (비우면 공통)',
  status: '사용 / 중지',
  loginId: '새 줄에 서비스명·아이디를 입력하면 계정ID·등록일시가 자동으로 채워집니다.'
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
  ['court', '관할법원 (OO지방법원의 OO)', '서울중앙'],
  // ↓ 세금계산서 역발행(공급받는자)에만 쓰는 항목 — 배번호 서류의 빈 항목 검사에서는 뺀다
  ['branchBizType', '영업점 업태', '운수 및 창고업', 'tax'],
  ['branchBizItem', '영업점 종목', '택배업', 'tax'],
  ['branchEmail', '영업점 이메일 (세금계산서)', '', 'tax']
];
const COMPANY_SHEET = 'company';

// route_changes 시트 (노선 변경 예약·이력). 기사 한 명의 캠프·기본노선 변경, 또는 쿠팡 노선 이관(안양1 110 → 군포1 212)
const RC = {
  id: '변경ID', kind: '종류', date: '적용일', driverId: '기사ID', name: '기사',
  fromCampId: '이전 캠프ID', fromCamp: '이전 캠프', fromRoute: '이전 노선', toCampId: '새 캠프ID', toCamp: '새 캠프', toRoute: '새 노선',
  status: '상태', parentId: '이관ID', memo: '메모', admin: '등록자', createdAt: '등록일시', appliedAt: '적용일시'
};
const RCK = { DRV: '기사', MOVE: '노선이관' };
const RCS = { WAIT: '예약', DONE: '적용', OFF: '취소' };

// ── 노선관리 (2단계 기준 데이터). 캠프명 > 노선코드 ──
// camps 시트: 캠프 기본 정보
const CP = { id: '캠프ID', name: '캠프명', address: '주소', memo: '메모', rot: '기본 회전', cpCode: '쿠팡 캠프코드', createdAt: '등록일시', updatedAt: '수정일시' };
const ROTS = ['D1', 'D2', 'F3'];
const CP_NOTES = {
  name: '새 줄에 캠프명만 입력해도 캠프ID가 자동으로 채워집니다. 캠프명을 바꾸면 routes·camp_images 탭의 캠프명도 자동으로 바뀝니다.',
  rot: '이 캠프에서 운영하는 회전. 예: D1,D2,F3 (비우면 D1,D2,F3). 미입차 계산에 사용',
  cpCode: '쿠팡 SLA 파일의 Camp 코드 (예: AYG_1). SLA 점수 올릴 때 캠프를 맞추는 데 씀'
};
// camp_images 시트: 캠프 참고 이미지 (파일은 드라이브 "캠프 참고 이미지" 폴더)
const CI = {
  id: '이미지ID', campId: '캠프ID', campName: '캠프명', file: '이미지 링크', desc: '설명', order: '순서',
  createdAt: '등록일시', updatedAt: '수정일시', delBy: '삭제한 기사', delAt: '삭제 시각'
};
const CI_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다.',
  file: '드라이브 이미지 파일 링크. 드라이브에서 "링크 복사"한 주소를 붙여 넣어도 됩니다.',
  order: '작은 숫자가 앞에 표시됩니다.'
};
// routes 시트: 노선 (구분1~5는 노선코드에서 자동으로 나뉜다)
const RST = { ON: '사용', OFF: '정지' }; // 예전 값 '중지' 도 정지로 읽는다
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
  p1: '원청단가', p2: '고정단가', p3: '백업단가', p4: '품앗이단가', p5: '외부용차단가',
  createdAt: '등록일시', updatedAt: '수정일시'
};
const RP_PRICE_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5']; // 일시단가는 정산관리(기사 + 기간)로 옮김
const RP_NOTES = {
  campName: '캠프명을 입력하면 캠프ID가 자동으로 채워집니다.',
  num: '노선코드 앞 숫자. 예: 110ABCD 이면 110',
  level: '구분2 / 구분3 / 구분4 / 구분5 (2 처럼 숫자만 써도 됨)',
  value: '그 구분 자리의 글자. 예: 110ABCD 의 구분3 은 B',
  p1: '숫자만 (원). 1,200 처럼 써도 됩니다.',
};
// ── 품앗이 (기사끼리 용차 일감 주고받기 · Pumasi.gs) ──
const PST = { OPEN: '모집 중', TALK: '배차 협의중', DONE: '배차 확정', CLOSED: '모집 마감', CANCEL: '취소' };
const PAST = { APPLY: '지원', TALK: '협의 중', OK: '확정', NO: '미선정', CANCEL: '지원 취소', OFFER: '제안' };
const PJ = {
  id: '일감ID', status: '상태', posterId: '등록 기사ID', poster: '등록 기사', kind: '구분', date: '배차일자', time: '입차시간',
  area: '배송지', campId: '센터ID', camp: '센터', route: '라우트', qty: '평균 물량', top: '탑 종류', price: '건당 단가(VAT포함)', pay: '지급방법',
  desc: '상세 설명', secret: '배차 확정 기사에게만 (배송지코드·연락처 등)', attach: '첨부파일', acceptedId: '확정 기사ID', accepted: '확정 기사',
  createdAt: '등록일시', updatedAt: '수정일시', offerToId: '제안 기사ID', offerTo: '제안 기사', useId: '배송 아이디', byOffice: '사무실 등록'
};
const PJ_NOTES = {
  status: '모집 중 / 배차 협의중 / 배차 확정 / 모집 마감 / 취소',
  kind: '주간 / 야간 / 일택',
  secret: '배차가 확정된 기사와 등록한 기사에게만 보입니다.'
};
const PA = { id: '지원ID', jobId: '일감ID', driverId: '지원 기사ID', name: '지원 기사', date: '배차일자', status: '상태', memo: '한마디', createdAt: '지원일시', updatedAt: '수정일시' };
const PA_NOTES = { status: '지원 / 협의 중 / 확정 / 미선정 / 지원 취소 / 제안' };
// 품앗이 주세요: 일감을 원하는 기사의 근무 가능일 (기사 1명 · 날짜 1개 = 1줄). 품앗이 맡길 기사가 보고 일감을 제안
const PV = { id: '가능일ID', driverId: '기사ID', name: '기사', date: '근무 가능일', kind: '구분', memo: '한마디', createdAt: '등록일시',
  area: '원하는 지역', campId: '희망 캠프ID', camp: '희망 캠프', crew: '배송 인원', qty: '원하는 수량', top: '탑 종류', price: '희망 단가', pay: '지급방법', useId: '배송 아이디' };
// 품앗이 알림: 기사 1명에게 가는 알림 1건 = 1줄 (앱 안 알림 + 휴대폰 푸시)
const PN = { id: '알림ID', driverId: '받는 기사ID', name: '받는 기사', jobId: '일감ID', kind: '종류', text: '내용', createdAt: '보낸일시', readAt: '읽은일시' };
// 휴대폰 푸시 받는 기기: 기사가 '휴대폰 알림 받기'를 켠 기기 1대 = 1줄. 지우면 그 기기로는 안 감
const PT = { token: '기기 토큰', driverId: '기사ID', name: '기사', device: '기기', createdAt: '등록일시', lastOk: '마지막 전송' };
// 자유게시판 (Board.gs): 글 · 댓글 · 신고 · 글쓰기 정지 · 금칙어. 시트에서 직접 고쳐도 된다
const BP = { id: '글ID', cat: '말머리', title: '제목', body: '내용', authorId: '작성 기사ID', author: '작성자', attach: '첨부', status: '상태',
  likes: '좋아요 기사ID', cmts: '댓글 수', reports: '신고 수', createdAt: '작성일시', updatedAt: '수정일시' };
const BC = { id: '댓글ID', postId: '글ID', parentId: '답글 대상 댓글ID', authorId: '작성 기사ID', author: '작성자', body: '내용', status: '상태', reports: '신고 수', createdAt: '작성일시', updatedAt: '수정일시' };
const BRP = { id: '신고ID', kind: '대상', targetId: '대상ID', postId: '글ID', reporterId: '신고 기사ID', reporter: '신고자', reason: '사유', status: '처리', createdAt: '신고일시' };
const BBN = { driverId: '기사ID', name: '기사', until: '정지 끝 (비우면 계속)', memo: '사유', admin: '처리 관리자', createdAt: '등록일시' };
const BWD = { word: '금칙어', memo: '메모' };
// 앱 설정 (키 | 값 | 설명): 품앗이 일감 올리기 ON/OFF 등. 시트에서 값만 고쳐도 됨
const APS = { key: '키', value: '값', memo: '설명' };
// route_perf 탭: 쿠팡 주간 수행률 (RoutePerf.gs) · 1줄 = 주차 × 라우트
const RPF = {
  key: '키', week: '주차', wk: 'WK', from: '시작일', to: '종료일', wave: '웨이브', camp: '캠프', code: '라우트',
  perf: '배송수행률', grade: '배송등급', ret: '반품회수율', retGrade: '반품등급', improve: '개선요청',
  f1: '배송수행률1', f2: '반품수행률', f3: '인접', parcel: 'Parcel', zip: '우편번호',
  file: '원본파일', uploadedAt: '업로드일시', by: '업로드관리자'
};
// route_lineage 탭: 라우트 계보 (RoutePerf.gs) · 코드가 바뀐 라우트를 이어 붙이기 위한 '이전 → 이후' 한 줄. 종류 개명/이관/분할/병합
// 팀즈 소식 (Teams.gs): 크롬 확장 '러너 팀즈 수집기'가 보낸 메시지 중 키워드에 걸린 것
const TMS = { id: '메시지ID', postedAt: '올린 시각', channel: '채널', author: '작성자', text: '내용', keywords: '키워드', status: '상태', by: '확인한 사람', checkedAt: '확인 시각', collectedAt: '가져온 시각', url: '팀즈 주소', memo: '메모' };
const RLN = { id: '계보ID', date: '적용일', kind: '종류', fromCamp: '이전 캠프', fromCode: '이전 라우트', toCamp: '이후 캠프', toCode: '이후 라우트', memo: '메모', by: '등록자', createdAt: '등록일시' };
// route_sla 탭: 쿠팡 월간 SLA 점수 (RoutePerf.gs) · 1줄 = 집계기간(끝 날짜) × 라우트 ('영업점' 줄 = Vendor Score)
const RSL = {
  key: '키', period: '기간끝', from: '기간시작', to: '기간종료', wave: '웨이브', cpCamp: '쿠팡캠프코드', camp: '캠프', code: '라우트', type: '타입',
  total: '총점', miss: '미수행률', ret: '반품미회수율', cs: '고객만족', cx: '고객불만', file: '원본파일', uploadedAt: '업로드일시', by: '업로드관리자'
};
// route_fb 탭: 쿠팡 프레시백 가중요인(추가 인센티브) 해당여부 (RoutePerf.gs) · 1줄 = 종류(누적/일별/월간) × 기간 × 라우트
const RFB = {
  key: '키', period: '정산기간끝', kind: '종류', from: '시작일', to: '기준일', date: '날짜', wave: '웨이브', camp: '캠프', code: '라우트',
  f1pct: '가중요인1 %', f1: '가중요인1', f2pct: '가중요인2 %', f2: '가중요인2', file: '원본파일', uploadedAt: '업로드일시', by: '업로드관리자'
};
// 세금계산서 역발행 (Tax.gs): 기사(공급자) → 러너(공급받는자). 한 줄 = 계산서 1장, 품목은 4줄까지
const TI = { id: '코드', month: '정산월', date: '작성일자', book1: '권', book2: '호', serial: '일련번호', kind: '영수/청구', nts: '국세청등록', pub: '기사 앱 공개',
  supId: '공급자 정산ID', supNo: '공급자 등록번호', supName: '공급자 상호', supCeo: '공급자 성명', supAddr: '공급자 주소', supType: '공급자 업태', supItem: '공급자 종목', supEmail: '공급자 이메일', supDriverId: '공급자 기사ID',
  buyNo: '공급받는자 등록번호', buyName: '공급받는자 상호', buyCeo: '공급받는자 성명', buyAddr: '공급받는자 주소', buyType: '공급받는자 업태', buyItem: '공급받는자 종목', buyEmail: '공급받는자 이메일',
  supply: '공급가액', tax: '세액', total: '합계금액', cash: '현금', check: '수표', bill: '어음', credit: '외상미수금', note: '비고',
  i1md: '품목1 월일', i1name: '품목1 품목', i1spec: '품목1 규격', i1qty: '품목1 수량', i1price: '품목1 단가', i1supply: '품목1 공급가액', i1tax: '품목1 세액', i1note: '품목1 비고', i2md: '품목2 월일', i2name: '품목2 품목', i2spec: '품목2 규격', i2qty: '품목2 수량', i2price: '품목2 단가', i2supply: '품목2 공급가액', i2tax: '품목2 세액', i2note: '품목2 비고', i3md: '품목3 월일', i3name: '품목3 품목', i3spec: '품목3 규격', i3qty: '품목3 수량', i3price: '품목3 단가', i3supply: '품목3 공급가액', i3tax: '품목3 세액', i3note: '품목3 비고', i4md: '품목4 월일', i4name: '품목4 품목', i4spec: '품목4 규격', i4qty: '품목4 수량', i4price: '품목4 단가', i4supply: '품목4 공급가액', i4tax: '품목4 세액', i4note: '품목4 비고',
  createdAt: '작성일시', updatedAt: '수정일시', admin: '처리 관리자' };
// 시트가 없으면 처음 쓸 때 자동으로 만든다 (setup 을 다시 실행하지 않아도 됨)
const AUTO_SHEETS = ['camps', 'camp_images', 'routes', 'camp_addresses', 'route_prices'];
// 없으면 처음 쓸 때 만드는 시트 (노선 기준 데이터 캐시와는 무관)
const AUTO_CREATE = AUTO_SHEETS.concat(['notices', 'accounts', 'account_categories', 'work_memo', 'pumasi_jobs', 'pumasi_apps', 'pumasi_alerts', 'push_tokens', 'pumasi_avail', 'board_posts', 'board_comments', 'board_reports', 'board_bans', 'board_words', 'app_settings', 'tax_invoices', 'route_changes', 'perf_log', 'error_log', 'perf_daily', 'route_perf', 'route_sla', 'route_lineage', 'route_fb', 'teams_msgs', 'camp_thumbs', 'route_notes', 'coupang_roster', 'inv_checks', 'ins_reports']);

/** 머리글 이름 바꿈 (예전 → 지금): 단가코드 = 고정·백업·품앗이·외부용차, 노선 단가도 같은 이름 + '단가' */
const HEAD_RENAME = {};
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
HEAD_RENAME[SH.DRIVERS] = { '기사구분': '단가코드', '서브아이디1 단가': '서브아이디1 단가코드', '서브아이디2 단가': '서브아이디2 단가코드' };
HEAD_RENAME[SH.PRICES] = { '기사단가': '고정단가', '외부단가': '외부용차단가' };
SCHEMA[SH.ROUTES] = R;
SCHEMA[SH.NOTICE] = N;
SCHEMA[SH.ACC] = AC;
SCHEMA[SH.ACAT] = ACAT;
SCHEMA[SH.PJOB] = PJ;
SCHEMA[SH.PAPP] = PA;
SCHEMA[SH.PALERT] = PN;
SCHEMA[SH.PPUSH] = PT;
SCHEMA[SH.PAVAIL] = PV;
SCHEMA[SH.BPOST] = BP;
SCHEMA[SH.BCMT] = BC;
SCHEMA[SH.BREP] = BRP;
SCHEMA[SH.BBAN] = BBN;
SCHEMA[SH.BWORD] = BWD;
SCHEMA[SH.APPSET] = APS;
SCHEMA[SH.RPERF] = RPF;
SCHEMA[SH.RSLA] = RSL;
SCHEMA[SH.RLIN] = RLN;
SCHEMA[SH.RFB] = RFB;
SCHEMA[SH.TEAMS] = TMS;
// camp_thumbs: 참고 이미지 미리보기(작은 JPEG, base64) — 노선관리 목록은 캠프마다 이 탭 한 번 읽기로 끝 (원본은 크게 볼 때만)
// 기사 노선 정보 (RouteInfo.gs): 기사 앱 '내 캠프'에서 기사들이 자유롭게 쓰는 노선·캠프 정보 (route = 라우트 코드 · 비우면 캠프 전체)
const RNT = { id: '정보ID', campId: '캠프ID', campName: '캠프명', route: '라우트', text: '내용', photos: '사진', authorId: '작성자ID', author: '작성자', status: '상태', createdAt: '등록일시', updatedAt: '수정일시' };
// 쿠팡 어드민 등록 목록 (아이디 × 캠프): 쿠팡 어드민에서 받은 기사스케줄 엑셀을 올려 갱신 → 쿠팡 업로드 엑셀의 휴무 줄을 만든다
const CRS = { camp: '캠프명', loginId: '아이디', name: '이름', updatedAt: '올린 날짜' };
const CTH = { id: '이미지ID', campId: '캠프ID', fileId: '파일ID', data: '미리보기', updatedAt: '만든일시' };
SCHEMA[SH.CTHUMB] = CTH;
SCHEMA[SH.RNOTE] = RNT;
SCHEMA[SH.CPROS] = CRS;
// 계산서/산재 관리 (DocCheck.gs): 기사 전자세금계산서 발행 체크 · 산재/고용 월보수액 신고 상황 (정산월 × 정산ID 한 줄)
const IVC = { month: '정산월', acct: '정산ID', driverId: '기사ID', name: '이름', total: '합계금액', done: '발행', date: '발행일', approvalNo: '승인번호', memo: '메모', by: '처리자', at: '처리일시' };
const INR = { month: '정산월', acct: '정산ID', driverId: '기사ID', name: '이름', bosu: '월보수액', san: '산재', goy: '고용', start: '자격취득일', done: '신고', date: '신고일', memo: '메모', by: '처리자', at: '처리일시' };
SCHEMA[SH.INVCHK] = IVC;
SCHEMA[SH.INSREP] = INR;
SCHEMA[SH.TAXINV] = TI;
SCHEMA[SH.RCHG] = RC;
// 속도 측정 (Perf.gs): 1분마다 화면·함수별 합계 한 줄
const PF = { at: '시각', app: '앱', view: '화면', fn: '함수', n: '횟수', rt: '왕복 합계(ms)', rtMax: '왕복 최대(ms)', srv: '서버 합계(ms)', who: '누가', upd: '업데이트' };
SCHEMA[SH.PERF] = PF;
// 오류 기록: 서버 오류 · 화면 오류 · 저장 충돌(처리 중) · 60초 초과 (Perf.gs errLog_) — 운영 중 문제를 그날 안에 알기 위한 기록
SCHEMA[SH.ERR] = { at: '시각', app: '앱', kind: '종류', view: '화면', fn: '함수', msg: '내용', upd: '업데이트', who: '누가' };
// 속도 기록 하루 요약: 7일 지난 perf_log 줄을 날짜·앱·함수별로 줄여 남긴다 (Perf.gs perfRollup_)
SCHEMA[SH.PDAY] = { day: '날짜', app: '앱', fn: '함수', n: '횟수', rt: '왕복 합계(ms)', rtMax: '왕복 최대(ms)', srv: '서버 합계(ms)' };
const HIDDEN = {};
HIDDEN[SH.DRIVERS] = D_HIDDEN;
HIDDEN[SH.ADMINS] = ['pwHash', 'pwSalt'];
HIDDEN[SH.BIB] = ['snapshotEnc'];
HIDDEN[SH.ACC] = ['pwEnc'];

const DOCS = {
  qual: { col: 'docQual', label: '화물운송종사자격증' },
  license: { col: 'docLicense', label: '운전면허증' },
  biz: { col: 'docBiz', label: '사업자등록증' },
  car: { col: 'docCar', label: '자동차등록증' }
};

// ───────────────────────── 웹앱 진입점 ─────────────────────────
var GLOBAL_ = typeof globalThis !== 'undefined' ? globalThis : this; // 앱스크립트 V8: 최상위 함수는 전역 객체에 있다

/**
 * 깃허브 페이지 화면이 부르는 입구 (google.script.run 대신 POST).
 * 본문: {"fn":"api_login","args":[...]}  → 그 함수의 반환값을 JSON 으로 돌려준다.
 * - 이름이 api_ / adm_ 로 시작하고 _ 로 끝나지 않는 함수만 부를 수 있다 (setup 등 관리 함수는 막힘).
 * - 화면은 Content-Type: text/plain 으로 보내 CORS 사전 요청 없이 바로 처리된다.
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(req.fn || '');
    const f = /^(api|adm)_[A-Za-z0-9_]+$/.test(fn) && !/_$/.test(fn) ? GLOBAL_[fn] : null;
    if (typeof f !== 'function') out = { ok: false, code: 'UNKNOWN_FN', msg: '알 수 없는 요청입니다. 화면을 새로고침해 주세요.' };
    else {
      _curFn = fn;
      out = f.apply(null, Array.isArray(req.args) ? req.args : []);
      if (out === undefined) out = null;
      // Firestore 사본: 읽기 전용으로 등록된 함수가 아니면(= 새로 만든 기능 포함) '데이터가 바뀌었을 수 있음' 으로 표시
      // → 개발하면서 저장 기능을 추가해도 오래된 사본이 쓰이지 않는다 (안전한 쪽이 기본)
      if (out && out.ok !== false && FS_READ_FNS.indexOf(fn) < 0) fsMark_(/^(adm_notice|adm_bd|api_bd)/.test(fn) ? 'nb' : '');
    }
  } catch (err) {
    try { errLog_('서버 오류', _curFn, '입구: ' + String(err && err.message || err)); } catch (x) { /* 무시 */ }
    out = { ok: false, msg: '서버 오류: ' + (err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const prm = (e && e.parameter) || {};
  if (prm.ping) return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON);
  // 깃허브 페이지로 옮긴 뒤: 스크립트 속성 PAGES_URL 이 있으면 예전 주소는 새 주소 안내 화면을 보여 준다 (?stay=1 이면 예전 화면)
  const pages = str_(props_().PAGES_URL).replace(/\/+$/, '');
  if (pages && !prm.stay) return movePage_(pages + '/' + (prm.page === 'admin' ? 'admin/' : ''), prm.page === 'admin');
  // 템플릿 평가 없이 파일을 그대로 내보내 첫 화면 응답을 빠르게 한다.
  // 웹앱 주소 뒤에 ?page=admin 을 붙이면 관리자 화면
  if (prm.page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('러너 올인원 관리자')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('러너 올인원')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 러너 심볼 (화면 로고와 같은 모양, 색은 글자색을 따름) */
const RUNNER_LOGO_SVG = '<svg class="rlogo" viewBox="30 24 740 588" aria-hidden="true" focusable="false"><path fill="currentColor" d="M541.1 447.8 C628.1 428.7 683.2 395.1 671.3 339 C659.1 281.2 586.5 237.9 501.9 206.5 C440.8 183.8 373.3 167.3 317.7 156 C293.5 150.1 271.9 144.8 268.7 144 L230.8 39.7 L227.7 31.1 L224.5 39.7 L192.9 124.4 C159.4 116.5 51.5 91.3 37.3 87.9 L58.8 106.1 C58.8 106.1 168.3 198.4 172.6 202.1 L122.3 335.8 L104.1 384.1 C128.2 362.4 206.1 292.2 237.5 263.9 C259.7 282.9 321.6 336.1 332.8 345.8 L324.9 320.6 C324.9 320.6 295.7 228.2 292.4 217.8 L336.5 190.5 L336.1 189.6 L279.8 207.3 L273.2 209.3 L275.6 216.8 L302.1 299 C279.5 279 242.9 246.6 242.9 246.6 L237.7 242.1 L232.1 246.5 L155.8 306.6 L181.8 202.1 L182.5 199.3 L180.6 197.5 L88.6 114.6 C123.1 123.7 196.3 143 196.3 143 L204.6 145.2 L206.6 137.2 C206.6 137.2 223.1 72.1 227.8 53.7 C233 72.8 255.2 153 255.2 153 L256.4 157.1 L260.8 158.3 C260.8 158.3 311.7 171.3 344.2 179.7 C355.9 182.6 366.2 189.5 373.4 199.1 C378 205.2 381.8 211.8 384.5 218.9 C388.8 230.4 389.8 246.2 387.9 264.7 C385.2 290.6 376.9 322.1 364 355.7 C361.6 361.7 359.2 367.8 356.5 374 C348.5 392.9 339.1 412.3 328.6 431.6 C321.6 444.4 314.1 457.2 306.2 469.8 C272.5 522.9 230.9 571.9 185.5 604 C228.3 598.6 279 593.8 337.2 590.7 C370.1 549.7 396.7 507.5 418.3 465.9 C417.6 465.6 416.9 465.2 416.1 464.9 C417.1 464.8 418 464.8 418.9 464.7 C418.7 465.1 418.5 465.5 418.3 465.9 C480.1 494.4 540.6 534.2 583.9 589.2 C621.4 590.6 720.9 598.3 762 601.3 C723 537.5 604.7 483.9 541.1 447.8 Z M485 289.8 C522.1 302.8 551.1 319.5 553.9 340 C556.2 357.4 518.2 362.8 463.2 361.9 C472 336.8 479.2 312.6 485 289.8 Z"/></svg>';

/** 예전 주소로 들어온 사람에게 새 주소 안내 (구글 화면은 자동 이동이 막혀 있어 버튼을 누르게 한다) */
function movePage_(url, admin) {
  const u = String(url).replace(/[<>"']/g, '');
  const html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><base target="_top"></head>' +
    '<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif;background:#f5f6f8;color:#191f28">' +
    '<div style="max-width:420px;margin:12vh auto;padding:28px 24px;background:#fff;border-radius:16px;text-align:center">' +
    '<div style="color:#1b64da;margin-bottom:10px">' + RUNNER_LOGO_SVG.replace('class="rlogo"', 'width="80"') + '</div>' +
    '<div style="font-size:22px;font-weight:800;margin-bottom:8px">러너 올인원' + (admin ? ' 관리자' : '') + '</div>' +
    '<div style="font-size:15px;color:#6b7684;line-height:1.6;margin-bottom:22px">앱 주소가 바뀌었습니다.<br>아래 버튼을 눌러 새 주소로 들어가 주세요.<br>' + (admin ? '' : '들어간 뒤 <b>홈 화면에 추가</b>하면 다음부터 바로 열립니다.') + '</div>' +
    '<a href="' + u + '" target="_top" style="display:block;background:#1b64da;color:#fff;text-decoration:none;font-weight:700;font-size:17px;padding:15px;border-radius:12px">새 주소로 열기</a>' +
    '<div style="margin-top:14px;font-size:12px;color:#8b95a1;word-break:break-all">' + u + '</div></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('러너 올인원').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ───────────────────────── 설정 / 업그레이드 ─────────────────────────
/**
 * 편집기(또는 스크립트 주인)에서만 실행되게 막는다.
 * 웹앱 화면의 google.script.run 은 _ 로 끝나지 않는 함수를 누구나 부를 수 있으므로,
 * setup 같은 관리 함수는 '지금 실행하는 사람 = 스크립트 주인' 일 때만 진행한다.
 * (익명 방문자는 이메일이 비어 있고, 다른 구글 계정은 주인과 다르다)
 */
function editorOnly_() {
  let me = '', owner = '';
  try { me = Session.getActiveUser().getEmail(); owner = Session.getEffectiveUser().getEmail(); } catch (e) { /* 무시 */ }
  if (!me || me !== owner) throw new Error('이 함수는 Apps Script 편집기에서만 실행할 수 있습니다.');
}
/**
 * 편집기에서 실행. 처음이면 DB 시트, 서류 폴더, 암호화 키를 만들고,
 * 이미 있으면 빠진 열·서식·트리거만 보충한다. (여러 번 실행해도 안전)
 */
function setup() {
  editorOnly_();
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
  ensureColumns_();
  ensureCompany_();
  ensureTools_();
  installTriggers_();
  schSS_(); // 스케줄 DB 파일 (없으면 만들고 트리거 설치)
  Logger.log('설정 완료. DB: ' + ss_().getUrl());
}

/** 빠진 머리글을 오른쪽 끝에 추가하고 서식·숨김·드롭다운·설명을 다시 적용한다. */
/** 편집기에서 직접 실행할 때 (빠진 열·서식 보충) */
function ensureColumns() { editorOnly_(); ensureColumns_(); }
function ensureColumns_(only) {
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
      if (c.title >= 0) sh.getRange(2, c.title + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(TITLES, true).setAllowInvalid(true).build());
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
    } else if (name === SH.ACC) {
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([ACST.ON, ACST.OFF], true).build());
      sh.getRange(2, c.category + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ACC_CATS, true).setAllowInvalid(true).build());
      Object.keys(AC_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(AC_NOTES[k]); });
      sh.getRange(1, c.password + 1).setBackground('#fff4e5');
      sh.setFrozenColumns(Math.min(c.service + 1, 3));
    } else if (name === SH.NOTICE) {
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([NST.ON, NST.OFF], true).build());
      sh.getRange(2, c.important + 1, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Y'], true).setAllowInvalid(true).build());
      Object.keys(N_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(N_NOTES[k]); });
      sh.setColumnWidth(c.body + 1, 420);
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
  installSheetTriggers_(ss_());
  if (have.indexOf('cleanupSessions') < 0) ScriptApp.newTrigger('cleanupSessions').timeBased().everyDays(1).atHour(4).create();
}
/** 스프레드시트 하나에 편집·구조변경 트리거 (그 파일에 이미 있으면 건너뜀) */
function installSheetTriggers_(book) {
  const id = book.getId();
  const have = ScriptApp.getProjectTriggers()
    .filter(function (t) { try { return t.getTriggerSourceId() === id; } catch (e) { return false; } })
    .map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('onSheetEdit') < 0) ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(book).onEdit().create();
  if (have.indexOf('onSheetChange') < 0) ScriptApp.newTrigger('onSheetChange').forSpreadsheet(book).onChange().create();
}

// ───────────────────────── 공용 핸들 (실행당 1회) ─────────────────────────
let _props = null, _ss = null;
const _sheets = {}, _cols = {}, _colsFresh = {}; // _colsFresh: 이번 실행에서 시트 머리글을 직접 읽어 확인한 열 위치 (쓰기마다 다시 읽지 않게)
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
  if (!sh && AUTO_CREATE.indexOf(name) >= 0) {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try { if (!ss_().getSheetByName(name)) ensureColumns_([name]); } finally { lock.releaseLock(); }
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
  if (fresh && _colsFresh[name]) return _colsFresh[name];
  const ck = 'hc:' + name;
  let head = fresh ? null : cache_().get(ck);
  if (head) head = JSON.parse(head);
  else {
    const sh = sheet_(name);
    head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    cache_().put(ck, JSON.stringify(head), CFG.HEAD_CACHE);
  }
  // 이름이 바뀐 머리글: 시트의 예전 이름을 새 이름으로 고쳐 쓴다 (값은 그대로)
  const ren = HEAD_RENAME[name];
  if (ren && head.some(function (h) { return ren[h] && head.indexOf(ren[h]) < 0; })) {
    const sh = sheet_(name);
    head.forEach(function (h, i) { if (ren[h] && head.indexOf(ren[h]) < 0) sh.getRange(1, i + 1).setValue(ren[h]); });
    cache_().remove(ck);
    return cols_(name, true);
  }
  const def = SCHEMA[name], c = { __w: head.length }, missing = [];
  Object.keys(def).forEach(function (k) {
    const i = head.indexOf(def[k]);
    if (i < 0) missing.push(def[k]); else c[k] = i;
  });
  // 시트에 모르는 머리글이 없으면(= 누가 머리글 이름을 바꾼 게 아니면) 새로 생긴 열은 그냥 추가해도 안전하다
  const known = Object.keys(def).map(function (k) { return def[k]; }).concat(LEGACY_HEADS[name] || []);
  const core = [def[Object.keys(def)[0]]].concat((HIDDEN[name] || []).map(function (k) { return def[k]; }));
  const noRename = head.every(function (h) { return !h || known.indexOf(h) >= 0; }) &&
    missing.every(function (l) { return core.indexOf(l) < 0; });
  const autoable = missing.length && (noRename || AUTO_CREATE.indexOf(name) >= 0 || (name === SH.DRIVERS &&
    missing.every(function (label) { return D_AUTO_ADD.some(function (k) { return D[k] === label; }); })) ||
    (AUTO_ADD_COLS[name] && missing.every(function (label) { return AUTO_ADD_COLS[name].some(function (k) { return def[k] === label; }); })));
  if (autoable) {
    addHeaders_(name, missing);
    return cols_(name, true);
  }
  if (missing.length) {
    fail_('DB 시트(' + name + ')에 머리글이 없습니다: ' + missing.join(', ') +
      '. 머리글 이름은 바꾸지 말고, 편집기에서 setup 을 다시 실행해 주세요.');
  }
  if (fresh) _colsFresh[name] = c;
  return (_cols[name] = c);
}
/** 빈 열을 오른쪽 끝에 추가 (안전한 새 열만 자동 추가에 사용) */
function addHeaders_(name, labels) {
  const lock = scriptLock_();
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
/** 여러 줄 지우기: 아래 줄부터, 붙어 있는 줄은 한 번에 (줄 번호가 밀리지 않게) */
function delRows_(sh, rows) {
  const rs = rows.filter(function (r, i, a) { return r >= 2 && a.indexOf(r) === i; }).sort(function (a, b) { return b - a; });
  for (let i = 0; i < rs.length;) {
    let j = i + 1;
    while (j < rs.length && rs[j] === rs[j - 1] - 1) j++;
    sh.deleteRows(rs[j - 1], j - i);
    i = j;
  }
  return rs.length;
}
function clearHeadCache_(name) { delete _cols[name]; delete _colsFresh[name]; cache_().remove('hc:' + name); }

// ───────────────────────── 잠금 (겹쳐 잡아도 안전) ─────────────────────────
/**
 * LockService 스크립트 잠금을 감싼 것. 잠금 안에서 부른 함수가 또 잠금을 잡았다 풀어도
 * 바깥 잠금이 먼저 풀리지 않도록 횟수를 센다 (열 자동 추가·시트 자동 생성이 저장 중에 일어나는 경우 등).
 */
var _lockN = 0, _lockObj = null;
function scriptLock_() {
  let mine = false;
  const real = function () { return _lockObj || (_lockObj = LockService.getScriptLock()); };
  return {
    waitLock: function (ms) { if (mine) return; if (_lockN === 0) real().waitLock(ms); _lockN++; mine = true; },
    tryLock: function (ms) { if (mine) return true; if (_lockN === 0 && !real().tryLock(ms)) return false; _lockN++; mine = true; return true; },
    hasLock: function () { return mine; },
    // 풀기 전에 시트 쓰기를 먼저 반영(flush)한다: 반영 전에 풀면 다음 실행이 잠금을 잡고도 아직 안 써진 줄을 못 봐 같은 줄에 덮어쓸 수 있다
    releaseLock: function () { if (!mine) return; mine = false; _lockN = Math.max(0, _lockN - 1); if (_lockN === 0) { try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ } real().releaseLock(); } }
  };
}

// ───────────────────────── 응답 래퍼 ─────────────────────────
var _curFn = ''; // 지금 처리 중인 서버 함수 이름 (doPost 가 적어 둠 · 오류 기록용)
// 단계별 걸린 시간 (ms). stg_() = 시작, stg_('이름') = 앞 단계 뒤부터 지금까지를 그 이름에 더함. run_ 이 응답의 _st 로 실어 보내고 화면이 속도 기록에 'st_함수_단계' 로 남긴다
var _stg = null, _stgT = 0;
function stg_(name) { const t = Date.now(); if (!name) { _stg = {}; _stgT = t; return; } if (!_stg) return; _stg[name] = (_stg[name] || 0) + (t - _stgT); _stgT = t; }
function run_(fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    if (r && typeof r === 'object' && !Array.isArray(r)) { r._ms = Date.now() - t0; if (_stg) { r._st = _stg; _stg = null; } } // 서버 처리 시간 (속도 측정)
    return r;
  }
  catch (err) {
    if (err && err.userMsg) return err.code ? { ok: false, code: err.code, msg: err.userMsg } : { ok: false, msg: err.userMsg };
    if (/lock timeout|lock.*too long|잠금.*(시간|초과)/i.test(String(err && err.message || err))) {
      console.warn('잠금 대기 시간 초과: ' + (err && err.message));
      errLog_('저장 충돌', _curFn, '다른 저장이 진행 중이라 20초 안에 잠금을 못 잡음');
      return { ok: false, code: 'BUSY', msg: '다른 저장 작업이 처리 중입니다. 잠시 후 다시 시도해 주세요.' };
    }
    console.error(err && err.stack ? err.stack : err);
    errLog_('서버 오류', _curFn, String(err && err.message || err) + (err && err.stack ? ' @ ' + String(err.stack).split('\n').slice(1, 3).join(' | ').replace(/\s+/g, ' ') : ''));
    return { ok: false, msg: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
/** 데이터를 바꾸지 않는 함수 (Firestore 사본을 오래된 것으로 표시하지 않음). 여기에 없는 함수는 저장으로 보고 표시한다. */
const FS_READ_FNS = ['adm_ntPhoto', 'api_ntPhoto', 'api_ntAdmPhoto', 'api_ntAdmList', 'adm_live', 'adm_einvList', 'adm_insRepList', 'adm_issueList', 'adm_issueCell', 'api_routeNotePhoto', 'api_routeInfo', 'api_campImage', 'adm_routeNotes', 'adm_stlTaxPack', 'adm_teamsList', 'api_teamsConfig', 'api_teamsPush', 'adm_dash', 'adm_dashStl', 'adm_perfList', 'adm_slaList', 'adm_lineageList', 'adm_lineageSuggest', 'adm_fbList', 'api_myFb', 'api_myPerf', 'api_pmPushLog', 'adm_pushCheck', 'adm_uiText', 'api_uiText', 'adm_accList', 'adm_accReveal', 'adm_bdList', 'adm_bdPost', 'adm_bibGet', 'adm_bibList', 'adm_bibPrint', 'adm_campImage', 'adm_campRoutes',
  'adm_check', 'adm_companyGet', 'adm_fsStatus', 'adm_fsToken', 'adm_fsRebuild', 'adm_getDoc', 'adm_getDriver', 'adm_listDrivers', 'adm_login', 'adm_logout', 'adm_changePassword',
  'adm_memoMonth', 'api_memoMonth', 'adm_memoPastUndone', 'adm_noticeList', 'adm_perf', 'adm_perfDrv', 'adm_perfStats', 'adm_pmJob', 'adm_pmList', 'adm_rcList', 'adm_reveal',
  'adm_routeAll', 'adm_routeVolumes', 'adm_schRange', 'adm_schUploadTable', 'adm_schWeek', 'adm_schYear', 'adm_stlDrivers', 'adm_stlFund', 'adm_stlIdsView',
  'adm_stlMonth', 'adm_stlPayList', 'adm_stlPnl', 'adm_stlRoundInfo', 'adm_stlSlip', 'adm_stlTable', 'adm_stlTax', 'adm_tiList',
  'api_bdList', 'api_bdPost', 'api_bdRecent', 'api_bdAttach', 'api_campSchedule', 'api_checkLoginId', 'api_checkSession', 'api_fsToken', 'api_login', 'api_logout',
  'api_changePassword', 'api_myInfo', 'api_mySchedule', 'api_mySettle', 'api_mySlip', 'api_notices', 'api_perf', 'api_ping', 'api_pmAlerts', 'api_pmAlertsRead',
  'api_pmAttach', 'api_pmAvailList', 'api_pmAvailMine', 'api_pmForm', 'api_pmJob', 'api_pmList', 'api_pmMine', 'api_pmPrice', 'api_pmPushConfig', 'api_pmPushSave', 'api_pmPushDel',
  // 읽기만 하는 함수인데 빠져 있던 것 (부를 때마다 '자료가 바뀜' 표시가 찍혔음 · 2026-11-11 점검)
  'adm_stlAdjSummary', 'adm_campThumbs', 'adm_pmMeta', 'adm_bankList', 'adm_bankPreview', 'adm_accCats', 'adm_stlDriveList', 'adm_stlFbView', 'adm_stlReportExtra', 'adm_stlReportYear', 'adm_stlBank'
];
/** Firestore 사본: 데이터가 바뀜 (Firebase.gs · 없으면 아무것도 안 함) */
function fsMark_(area, extra) { if (typeof fsDirty_ === 'function') fsDirty_(area, extra); }
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
/**
 * 겹치지 않는 아이디 만들기.
 * 예전에는 '시각(초) + 두 자리 난수' 라서 시트에 여러 줄을 한 번에 붙여넣으면 같은 초에 같은 번호가 나올 수 있었다
 * (실제로 두 기사가 같은 기사ID를 받아 한 명을 고르면 둘 다 선택되는 문제가 생김).
 * 이제는 이번 실행에서 이미 쓴 번호를 기억하고, 기사ID는 시트에 이미 있는 번호와도 대조한다.
 */
var _usedIds = {};
var _driverIdSet = null; // 이번 실행에서 drivers 탭 기사ID 목록 (처음 한 번만 읽음)
function uniqId_(prefix, taken) {
  for (let i = 0; i < 50; i++) {
    // 시각(초) + 무작위 5자리: 같은 초에 두 실행이 동시에 만들어도 겹치지 않게 (3자리 때는 1/900 확률로 같은 ID가 날 수 있었음)
    const id = prefix + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90000 + 10000);
    if (_usedIds[id] || (taken && taken[id])) continue;
    _usedIds[id] = 1;
    return id;
  }
  // 같은 초에 900개 가까이 만든 극단적인 경우: 순번을 붙인다
  let n = 1, id;
  do { id = prefix + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss') + 'X' + (n++); } while (_usedIds[id] || (taken && taken[id]));
  _usedIds[id] = 1;
  return id;
}
function driverIdSet_() {
  if (_driverIdSet) return _driverIdSet;
  const set = {};
  try {
    const sh = sheet_(SH.DRIVERS), c = cols_(SH.DRIVERS), last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, c.id + 1, last - 1, 1).getValues().forEach(function (v) { const s = str_(v[0]); if (s) set[s] = 1; });
  } catch (e) { /* 시트가 없으면 빈 목록 */ }
  return (_driverIdSet = set);
}
function newDriverId_() {
  const set = driverIdSet_();
  const id = uniqId_('D', set);
  set[id] = 1;
  return id;
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
  // 붙어 있는 열은 한 번에 쓴다 (호출 수 줄이기). 사이에 낀 다른 열은 건드리지 않는다.
  const cells = Object.keys(fields).filter(function (k) { return c[k] !== undefined; })
    .map(function (k) { return [c[k], safeText_(fields[k])]; }).sort(function (a, b) { return a[0] - b[0]; });
  for (let i = 0; i < cells.length;) {
    let j = i + 1;
    while (j < cells.length && cells[j][0] === cells[j - 1][0] + 1) j++;
    const vals = [cells.slice(i, j).map(function (x) { return x[1]; })];
    sh.getRange(row, cells[i][0] + 1, 1, j - i).setNumberFormat('@').setValues(vals);
    i = j;
  }
}
/**
 * 잠금 안에서 행 번호가 그대로인지(그 사이 다른 줄이 지워져 밀리지 않았는지) 확인하고 쓴다.
 * 밀렸으면 key 값으로 줄을 다시 찾는다. 못 찾으면 0.
 */
function writeByKey_(name, key, value, row, fields) {
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    let r = row;
    if (r) { const o = readObj_(name, r); if (!o || o[key] !== String(value)) r = 0; }
    if (!r) r = findRow_(name, key, value);
    if (r) writeFields_(name, r, fields);
    return r;
  } finally { lock.releaseLock(); }
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
    pwChangedAt: toMs_(o.pwChangedAt), mustChange: mustChange_(o), campId: o.schCampId, camp: o.schCamp, title: titleOf_(o)
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
  fsMark_('sch'); // 기사 정보(캠프·노선 등)가 바뀌면 기사스케줄 줄도 바뀐다
  try { stlBump_(); } catch (e) { /* 기사 정보가 바뀌면 정산 계산 결과도 다시 */ }
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
  const biz = digits_(req_(f.bizNo, '사업자등록번호', 20));
  if (biz.length !== 10) fail_('사업자등록번호 10자리를 입력해 주세요.');
  out.bizNo = biz.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3');
  out.qualDate = req_(f.qualDate, '화물운송 종사자격 취득일', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.qualDate)) fail_('자격 취득일을 확인해 주세요.');
  out.qualNo = qualFmt_(req_(f.qualNo, '화물운송 종사자격증 번호', 30));
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
    return { ok: true, token: s.token, expiresAt: s.expiresAt, mustChange: mustChange_(o), user: { name: o.name, loginId: id, title: titleOf_(o) }, slipClose: stlLastClose_() };
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
  if (typeof PERF_BENCH_ !== 'undefined' && PERF_BENCH_ && token === PERF_BENCH_.tok) return PERF_BENCH_.s; // 속도 측정 (이 실행 안에서만)
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
    return { ok: true, mustChange: !!info.mustChange, user: { name: info.name, loginId: info.loginId, title: info.title || '' }, slipClose: stlLastClose_() };
  });
}

function api_logout(token) {
  return run_(function () {
    if (!token) return { ok: true };
    const th = tokenHash_(token);
    cache_().remove('ss:' + th);
    writeByKey_(SH.SESSIONS, 'tokenHash', th, 0, { expiresAt: nowText_() });
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
    const hk = 'su:' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMddHH');
    if (Number(cache_().get(hk) || 0) >= CFG.SIGNUP_PER_HOUR) fail_('지금 가입 신청이 많아 잠시 막혀 있습니다. 1시간 뒤에 다시 시도하거나 사무실로 연락해 주세요.');
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      if (findRow_(SH.DRIVERS, 'loginId', f.loginId) || findRow_(SH.DRIVERS, 'rrnIndex', rrnIdx)) {
        folder.setTrashed(true);
        fail_('이미 가입된 정보입니다. 로그인 또는 비밀번호 찾기를 이용해 주세요.');
      }
      const now = nowText_();
      const pw = passwordFields_(f.password);
      const row = appendObj_(SH.DRIVERS, {
        id: driverId, loginId: f.loginId, name: f.name, phone: f.phone, bizNo: f.bizNo, status: ST.PENDING,
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
    cache_().put(hk, String(Number(cache_().get(hk) || 0) + 1), 3700);
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
    if (!writeByKey_(SH.DRIVERS, 'id', o.id, o._row, fields)) fail_('회원 정보를 찾을 수 없습니다.');
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
    if (!writeByKey_(SH.DRIVERS, 'id', o.id, o._row, fields)) return expired;
    forgetDriver_(o);
    // 지금 쓰던 로그인은 바로 만료시키고 새 로그인으로 교체
    cache_().remove('ss:' + s.th);
    writeByKey_(SH.SESSIONS, 'tokenHash', s.th, 0, { expiresAt: msText_(Date.now() - 1000) });
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
  if (/^stl_/.test(name)) { stlOnEdit_(name); return; } // 정산 DB 를 손으로 고침 → 그 탭 캐시만 버림
  if (name === SH.DRIVERS) { try { stlBump_(); } catch (x) { /* 정산 캐시 */ } }
  if (name === TOOLS.SHEET) { onToolsEdit_(e, sh); return; }
  if (name === SCH.SHEET) { onSchEdit_(e, sh); return; }
  if (!SCHEMA[name] || name === SH.ALOG) return;
  if (name !== SH.PERF && name !== SH.SESSIONS) fsMark_('nb'); // 시트를 손으로 고침 → Firestore 사본은 다시 만들 때까지 안 씀
  _sheets[name] = sh;
  _ss = sh.getParent();
  const r0 = e.range.getRow(), n = e.range.getNumRows();
  if (r0 === 1) {
    clearHeadCache_(name);
    if (AUTO_SHEETS.indexOf(name) >= 0) bumpMaster_();
    if (n === 1) return;
  }
  const lock = scriptLock_();
  // 다른 저장이 길어져 잠금을 못 잡으면(드묾) 그냥 넘기지 않고 첫 칸에 메모를 남긴다 — 주민번호·계좌 같은 값이 가린 글자로 바뀌지 않은 채 남지 않게
  try { lock.waitLock(40000); } catch (e) {
    try { sh.getRange(Math.max(2, r0), 1).setNote('⚠ ' + nowText_() + ' 다른 저장 작업 중이라 자동 정리(가리기·검사)를 못 했습니다. 이 줄의 칸을 한 번 더 고쳐 주세요.'); } catch (x) { /* 무시 */ }
    return;
  }
  try {
    const c = cols_(name, true);
    const start = Math.max(2, r0), end = Math.min(r0 + n - 1, start + 1999); // 한 번에 2000줄까지 (200줄씩 끊어 읽음)
    if (end < start) return;
    const block = [];
    for (let b0 = start; b0 <= end; b0 += 200) block.push.apply(block, sh.getRange(b0, 1, Math.min(200, end - b0 + 1), c.__w).getValues());
    let campRenamed = false;
    _campIdx = null; _routeList = null;
    block.forEach(function (v, i) {
      const o = { _row: start + i };
      Object.keys(SCHEMA[name]).forEach(function (k) { o[k] = str_(v[c[k]]); });
      if (name === SH.DRIVERS) { fixDriverRow_(sh, c, o); if (o.id && o.loginId && typeof stlEnsureIdFor_ === 'function') stlEnsureIdFor_(o); }
      else if (name === SH.ADMINS) fixAdminRow_(sh, c, o);
      else if (name === SH.MEMO) fixMemoRow_(sh, c, o);
      else if (name === SH.NOTICE) fixNoticeRow_(sh, c, o);
      else if (name === SH.ACC) fixAccountRow_(sh, c, o);
      else if (name === SH.BIB) fixBibRow_(sh, c, o);
      else if (name === SH.CAMPS) { fixCampRow_(sh, c, o); campRenamed = true; }
      else if (name === SH.ROUTES) fixRouteRow_(sh, c, o);
      else if (name === SH.CIMG) fixCampImageRow_(sh, c, o);
      else if (name === SH.CADDR) fixCampAddrRow_(sh, c, o);
      else if (name === SH.PRICES) fixPriceRow_(sh, c, o);
      else if (name === SH.SESSIONS) cache_().remove('ss:' + o.tokenHash);
      else if (name === SH.PJOB || name === SH.PAPP || name === SH.PAVAIL) pmTouch_();
      else if ([SH.BPOST, SH.BCMT, SH.BREP, SH.BBAN, SH.BWORD].indexOf(name) >= 0) bdTouch_();
      else if (name === SH.APPSET) cache_().remove('appset');
      else if (name === SH.PALERT) pmAlertBump_(o.driverId);
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
  if (o.schCamp || o.schCampId) {
    _campIdx = null;
    const camp = resolveCamp_({ campName: o.schCamp, campId: o.schCampId });
    if (camp.err) { if (o.schCamp) bad('schCamp', camp.err); }
    else { set('schCampId', camp.campId); set('schCamp', camp.campName); }
  }
  if (o.baseRoute) set('baseRoute', normBaseRoute_(o.baseRoute));
  if (o.schOrder && !/^\d{1,5}$/.test(o.schOrder)) bad('schOrder', '숫자로 입력해 주세요.');
  if (o.driverType) {
    const t = normDriverType_(o.driverType);
    if (t) set('driverType', t); else bad('driverType', DTYPES.join(' / ') + ' 중 하나로 입력해 주세요. (관리자·운영자·대표는 직함 칸)');
  }
  if (o.title) {
    const t = normTitle_(o.title);
    if (t) set('title', t); else bad('title', TITLES.join(' / ') + ' 중 하나로 입력하거나 비워 주세요.');
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
  ['phone', 'rrn', 'licenseNo', 'account', 'pwReset', 'driverType', 'driverCode', 'title', 'schCamp', 'schOrder'].forEach(function (k) {
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
    try { if (typeof fsEnsureTrigger_ === 'function') fsEnsureTrigger_(); } catch (e) { /* 사본 트리거 확인 (6시간에 한 번만 실제 확인) */ }
    let check = null;
    try { check = JSON.parse(appSet_().dataCheck || 'null'); } catch (e) { check = null; } // 새벽 자료 점검 결과 (대시보드에 표시)
    return { ok: true, admin: { name: a.name, loginId: a.loginId }, check: check };
  });
}
function adm_logout(token) { return api_logout(token); }

/**
 * 관리자 본인 비밀번호 변경 (현재 비밀번호 확인 후).
 * 다른 PC·휴대폰의 관리자 로그인은 모두 끊기고, 지금 화면은 새 로그인으로 계속 쓴다.
 */
function adm_changePassword(token, currentPassword, newPassword) {
  return run_(function () {
    const a = requireAdmin_(token);
    const s = getSession_(token);
    const pw = checkPw_(newPassword);
    const row = findRow_(SH.ADMINS, 'id', a.id);
    const o = row ? readObj_(SH.ADMINS, row) : null;
    if (!o) expired_();
    const fk = 'acf:' + o.id;
    const fails = Number(cache_().get(fk) || 0);
    if (fails >= CFG.LOGIN_MAX_FAIL) fail_('비밀번호 확인 실패가 반복되어 15분간 잠겼습니다. 잠시 후 다시 시도해 주세요.');
    if (!checkPassword_(String(currentPassword || ''), o)) {
      cache_().put(fk, String(fails + 1), 900);
      fail_('현재 비밀번호가 맞지 않습니다.');
    }
    cache_().remove(fk);
    if (pw === String(currentPassword)) fail_('새 비밀번호는 현재 비밀번호와 다르게 정해 주세요.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    let ns;
    try {
      writeFields_(SH.ADMINS, o._row, passwordFields_(pw)); // 비밀번호 변경일시가 바뀌어 그 전 로그인은 모두 만료
      cache_().remove('av:' + o.id);
      cache_().remove('ss:' + s.th);
      const oldRow = findRow_(SH.SESSIONS, 'tokenHash', s.th);
      if (oldRow) writeFields_(SH.SESSIONS, oldRow, { expiresAt: msText_(Date.now() - 1000) });
      ns = createSession_(ADMIN_SESSION + o.id, !!s.a);
    } finally {
      lock.releaseLock();
    }
    logAdmin_(a, '관리자 비밀번호 변경', a.name + ' (' + a.loginId + ')', '다른 기기 로그인 해제');
    return { ok: true, token: ns.token, msg: '비밀번호를 바꿨습니다. 다른 PC·휴대폰은 새 비밀번호로 다시 로그인해야 합니다.' };
  });
}

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
  driverType: '단가코드', driverCode: '기사코드', title: '직함',
  qualDate: '자격 취득일', qualNo: '자격증 번호', licenseType: '면허 종류', carName: '차명', carYear: '연식',
  maxLoad: '최대적재량', carNo: '차량번호', bankName: '은행명', accountHolder: '예금주', memo: '관리자 메모',
  rrn: '주민등록번호', licenseNo: '운전면허번호', account: '계좌번호',
  schCampId: '소속 캠프', baseRoute: '기본노선', fixedOff: '고정휴무일', extraOff: '추가휴무', workPattern: '근무형태',
  schMemo: '스케줄 메모', schOrder: '스케줄 순서', backupArea: '백업 범위', workStatus: '근무상태', leaveDate: '퇴사일', subId1: '서브아이디1', subId2: '서브아이디2',
  subType1: '서브아이디1 단가코드', subType2: '서브아이디2 단가코드', stlMode: '정산 방식', insEx: '산재·고용 제외', fbCut: '프레시백 차감', extraAssign: '추가 배정', tiOn: '세금계산서 역발행 대상',
  bizNo: '사업자등록번호', bizName: '상호', bizCeo: '사업자 대표자', bizAddr: '사업장 주소', bizType: '업태', bizItem: '종목', bizEmail: '계산서 이메일'
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
    driverType: o.driverType, driverCode: o.driverCode, title: o.title || '', workStatus: o.workStatus || '', leaveDate: o.leaveDate || '', subId1: o.subId1 || '', subId2: o.subId2 || '', subType1: o.subType1 || '', subType2: o.subType2 || '', stlMode: o.stlMode || '', insEx: o.insEx || '', fbCut: o.fbCut === undefined ? '' : String(o.fbCut), schCampId: o.schCampId, schCamp: o.schCamp, baseRoute: o.baseRoute,
    createdAt: o.createdAt, approvedAt: o.approvedAt, carNo: o.carNo, carName: o.carName, carYear: o.carYear,
    docs: docsOf_(o), mustChange: mustChange_(o), hasPw: !!o.pwHash, memo: o.memo
  };
}
/** 행 내용 지문: 화면이 불러온 뒤 시트나 다른 관리자가 고쳤는지 확인하는 용도 */
function rev_(o) {
  return sha256b64_(Object.keys(D).map(function (k) { return k === 'pwReset' ? '' : o[k]; }).join('\u0001')).slice(0, 16);
}
/** 화물운송 종사자격증 번호 양식: 숫자 9자리 → 1-19-055113 (지역-연도-일련번호 6자리), 10자리 → 01-19-055113. 그 밖의 자리 수는 적은 그대로 */
function qualFmt_(v) {
  const s = String(v == null ? '' : v).trim(), d = s.replace(/\D/g, '');
  if (/[^\d\s\-]/.test(s)) return s;
  if (d.length === 9) return d.slice(0, 1) + '-' + d.slice(1, 3) + '-' + d.slice(3);
  if (d.length === 10) return d.slice(0, 2) + '-' + d.slice(2, 4) + '-' + d.slice(4);
  return s;
}
/** 상세용 (민감정보는 가린 값만) */
function detailOf_(o) {
  const out = listRow_(o);
  ['birthDate', 'address', 'qualDate', 'qualNo', 'licenseType', 'maxLoad', 'bankName', 'accountHolder',
    'bizNo', 'bizName', 'bizCeo', 'bizAddr', 'bizType', 'bizItem', 'bizEmail', 'extraAssign', 'tiOn',
    'updatedAt', 'pwChangedAt', 'docFolder'].forEach(function (k) { out[k] = o[k]; });
  out.qualNo = qualFmt_(o.qualNo);
  out.rrn = o.rrn; out.licenseNo = o.licenseNo; out.account = o.account;
  out.has = { rrn: !!o.rrnEnc, licenseNo: !!o.licenseNoEnc, account: !!o.accountEnc };
  out.rev = rev_(o);
  return out;
}

/** 기사 전체 목록: 시트를 한 번에 읽는다 (호출 1회) */
function adm_listDrivers(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (typeof stlEnsureIdsV2_ === 'function') { try { stlEnsureIdsV2_(); } catch (e) { console.error('아이디 옮김 실패: ' + (e && e.message)); } }
    try { rcApplyDue_(); } catch (e) { console.error('노선 변경 예약 적용 실패: ' + (e && e.message)); } // 적용일이 된 노선 변경을 먼저
    const sh = sheet_(SH.DRIVERS), c = cols_(SH.DRIVERS), last = sh.getLastRow();
    let rows = last >= 2 ? sh.getRange(2, 1, last - 1, c.__w).getValues() : [];
    // 기사ID가 겹친 줄이 있으면 먼저 고친다 (겹치면 한 명을 고를 때 다른 기사도 같이 선택됨)
    let repaired = [];
    const seen = {};
    if (rows.some(function (v) { const id = str_(v[c.id]); if (!id) return false; if (seen[id]) return true; seen[id] = 1; return false; })) {
      repaired = repairDriverIds_(a);
      const l2 = sh.getLastRow();
      rows = l2 >= 2 ? sh.getRange(2, 1, l2 - 1, c.__w).getValues() : [];
    }
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
    // 기사코드: 비어 있으면 자동으로 (R001, R002 … 가입 순서, 한 번 정하면 그대로)
    if (list.some(function (r) { return !r.driverCode; })) { try { fillDriverCodes_(); list.forEach(function (r) { if (!r.driverCode) { const x = driverById_(r.id); if (x) r.driverCode = x.driverCode; } }); } catch (e) { console.error('기사코드 자동 채우기 실패: ' + e); } }
    // 서브아이디: 다른 기사의 서브로 등록된 아이디면 표시
    const subOf = {};
    list.forEach(function (r) { [r.subId1, r.subId2].forEach(function (x) { if (x) subOf[String(x).toLowerCase()] = r.name; }); });
    list.forEach(function (r) { if (r.loginId && subOf[String(r.loginId).toLowerCase()]) r.subOf = subOf[String(r.loginId).toLowerCase()]; });
    list.sort(function (p, q) { return p.createdAt < q.createdAt ? 1 : p.createdAt > q.createdAt ? -1 : 0; });
    return { ok: true, rows: list, counts: counts, repaired: repaired };
  });
}

/**
 * 겹친 기사ID 고치기 (잠금 안에서 다시 읽어 처리)
 * - 같은 ID 중 위쪽(먼저 있던) 줄은 그대로 두고, 아래쪽 줄에 새 ID를 준다.
 * - 스케줄 DB 의 행ID 가 그 ID 이고 이름이 아래쪽 기사와 같으면 새 ID로 옮긴다. 배번호 신청도 이름으로 같이 옮긴다.
 * - 그 ID 로 열린 로그인은 누구 것인지 알 수 없으므로 해제한다 (다시 로그인하면 됨).
 * 반환: [{ name, oldId, newId }]
 */
function repairDriverIds_(a) {
  const lock = scriptLock_();
  lock.waitLock(30000);
  const out = [];
  try {
    _driverIdSet = null;
    const all = readAll_(SH.DRIVERS);
    const first = {}, moves = [];
    all.forEach(function (o) {
      if (!o.id) return;
      if (!first[o.id]) { first[o.id] = o; return; }
      moves.push(o);
    });
    if (!moves.length) return out;
    const dupIds = {};
    moves.forEach(function (o) {
      const nid = newDriverId_();
      writeFields_(SH.DRIVERS, o._row, { id: nid, updatedAt: nowText_() });
      dupIds[o.id] = 1;
      forgetDriver_(o); forgetDriver_(first[o.id]);
      out.push({ name: o.name, loginId: o.loginId, oldId: o.id, newId: nid, keptName: first[o.id].name });
    });
    const byOldName = {};
    out.forEach(function (m) { byOldName[m.oldId + '|' + m.name] = m.newId; });

    // 배번호 신청 (이름 사본으로 주인을 가린다)
    try {
      readAll_(SH.BIB).forEach(function (b) {
        const nid = byOldName[b.driverId + '|' + b.name];
        if (nid) writeFields_(SH.BIB, b._row, { driverId: nid });
      });
    } catch (e) { /* 탭이 없으면 건너뜀 */ }

    // 스케줄 DB 행ID
    let schMoved = 0;
    try {
      if (props_().SCH_DB_ID) {
        const ssh = schSheet_(), h = schHeader_(true), sl = ssh.getLastRow();
        if (sl >= 2) {
          ssh.getRange(2, 1, sl - 1, 5).getValues().forEach(function (f, i) {
            const nid = byOldName[str_(f[h.fixed['행ID']]) + '|' + str_(f[h.fixed['이름']])];
            if (nid) { ssh.getRange(i + 2, h.fixed['행ID'] + 1).setNumberFormat('@').setValue(nid); schMoved++; }
          });
        }
      }
    } catch (e) { /* 스케줄 DB 를 못 열면 건너뜀 */ }

    // 겹친 ID 로 열린 로그인 해제
    const ss = readAll_(SH.SESSIONS).filter(function (x) { return dupIds[x.driverId]; });
    delRows_(sheet_(SH.SESSIONS), ss.map(function (x) { return x._row; }));
    if (ss.length) cache_().removeAll(ss.map(function (x) { return 'ss:' + x.tokenHash; }));

    logAdmin_(a, '기사ID 중복 정리', out.length + '명',
      out.map(function (m) { return m.name + ' ' + m.oldId + '→' + m.newId + ' (' + m.keptName + ' 은 그대로)'; }).join(', ') +
      (schMoved ? ' · 스케줄 ' + schMoved + '줄 이동' : '') + (ss.length ? ' · 로그인 ' + ss.length + '건 해제' : ''));
    return out;
  } finally {
    lock.releaseLock();
  }
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      return updateDriverCore_(a, id, changes, seenRev);
    } finally {
      lock.releaseLock();
    }
  });
}
/** 기사 한 명 수정 (잠금 안에서 부름): 검사 → 시트 → 노선 이력 → 정산 아이디 · 서브아이디 연동 */
function updateDriverCore_(a, id, changes, seenRev) {
  const o = driverById_(String(id || ''));
  if (!o) fail_('기사를 찾을 수 없습니다. 목록을 새로고침해 주세요.');
  if (seenRev && String(seenRev) !== rev_(o)) {
    fail_('다른 곳(시트 또는 다른 관리자)에서 먼저 수정되었습니다. 새로고침 후 다시 수정해 주세요.');
  }
  // _fix = 정정 (잘못 넣은 캠프·노선 바로잡기): 노선 변경 이력을 남기지 않는다
  const fix = !!(changes && changes._fix);
  if (changes && '_fix' in changes) { changes = Object.assign({}, changes); delete changes._fix; }
  const r = driverFields_(changes, o), f = r.f, changed = r.changed;
  if (!changed.length) return { ok: true, driver: detailOf_(o) };
  f.updatedAt = nowText_();
  writeFields_(SH.DRIVERS, o._row, f);
  forgetDriver_(o);
  // 소속캠프·기본노선을 바로 바꾸면 이력으로 남긴다 (지난 날짜 스케줄·업로드는 예전 캠프·노선으로 계산되게)
  try {
    const nc = f.schCampId !== undefined ? f.schCampId : o.schCampId, nr = f.baseRoute !== undefined ? f.baseRoute : o.baseRoute;
    if (!fix && (o.schCampId || o.baseRoute) && (nc !== o.schCampId || nr !== o.baseRoute)) {
      appendObj_(SH.RCHG, {
        id: uniqId_('RC'), kind: RCK.DRV, date: todayText_(), driverId: o.id, name: o.name,
        fromCampId: o.schCampId, fromCamp: o.schCamp, fromRoute: o.baseRoute, toCampId: nc, toCamp: f.schCamp !== undefined ? f.schCamp : o.schCamp, toRoute: nr,
        status: RCS.DONE, parentId: '', memo: '바로 변경', admin: a.name, createdAt: f.updatedAt, appliedAt: f.updatedAt
      });
      rcTouch_();
    }
  } catch (e) { console.error('노선 변경 이력 기록 실패: ' + (e && e.message)); }
  // 기본노선을 추가 배정 캠프로 바꿈(서로 맞바꿈) → 오늘부터의 기사스케줄 칸도 줄끼리 맞바꿈
  try {
    if (f.schCampId !== undefined && f.extraAssign !== undefined && o.schCampId && f.schCampId && f.schCampId !== o.schCampId) {
      const oldEx = extraAssignOf_(o).map(function (x) { return x.c; }), newEx = extraAssignOf_({ extraAssign: f.extraAssign }).map(function (x) { return x.c; });
      if (oldEx.indexOf(f.schCampId) >= 0 && newEx.indexOf(o.schCampId) >= 0) schSwapAssign_(o, f, todayText_());
    }
  } catch (e) { console.error('추가 배정 칸 맞바꾸기 실패: ' + (e && e.message)); }
  if (f.loginId) forgetDriver_({ loginId: f.loginId });
  // 단가코드이 바뀌면 정산 아이디(본인 쿠팡플렉스 아이디)의 단가코드도 맞춘다
  if (f.driverType !== undefined && f.driverType !== o.driverType && typeof stlSyncIdType_ === 'function') stlSyncIdType_(o.id, f.loginId || o.loginId, o.driverType, f.driverType);
  // 직함이 바뀌면 정산 결과(정산서 수행자 이름 숨김)를 다시 계산하게
  if (f.title !== undefined && f.title !== (o.title || '') && typeof stlBump_ === 'function') { try { stlBump_(); } catch (e) { /* 무시 */ } }
  logAdmin_(a, '기사 정보 수정', o.name + ' (' + o.id + ')', changed.join(', ') +
    (f.status ? ' → ' + f.status : ''));
  const fresh = readObj_(SH.DRIVERS, o._row);
  if (typeof stlEnsureIdFor_ === 'function' && (f.loginId !== undefined || f.name !== undefined)) stlEnsureIdFor_(fresh); // 아이디 관리 연동
  const subMsg = (f.subId1 !== undefined || f.subId2 !== undefined || f.loginId !== undefined) ? drvLinkSubs_(a, fresh, [o.subId1, o.subId2]) : [];
  if (typeof stlBump_ === 'function' && props_().STL_DB_ID) { try { stlBump_(); } catch (e) { /* 무시 */ } } // 정산 아이디 = 기사 정보 → 다시 계산
  return { ok: true, driver: detailOf_(readObj_(SH.DRIVERS, o._row)), subMsg: subMsg };
}
/**
 * 여러 기사 한 번에: ids = [기사ID…], changes = { status | workStatus | leaveDate | driverType | title | schCampId … }
 * 기사마다 한 명 수정과 같은 검사·연동을 거친다. 반환: { done: [{id,name}], failed: [{id,name,msg}], subMsg: [] }
 */
function adm_bulkUpdateDrivers(token, ids, changes) {
  return run_(function () {
    const a = requireAdmin_(token);
    ids = (ids || []).map(String).filter(Boolean);
    changes = changes || {};
    if (!ids.length) fail_('기사를 골라 주세요.');
    if (ids.length > 300) fail_('한 번에 300명까지 바꿀 수 있습니다.');
    const keys = Object.keys(changes).filter(function (k) { return D_EDIT_LABEL[k] && ['loginId', 'name', 'rrn', 'licenseNo', 'account', 'phone', 'subId1', 'subId2', 'driverCode'].indexOf(k) < 0; });
    if (!keys.length) fail_('일괄로 바꿀 항목이 없습니다.');
    const ch = {}; keys.forEach(function (k) { ch[k] = changes[k]; });
    const out = { ok: true, done: [], failed: [], subMsg: [] };
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      ids.forEach(function (id) {
        const o = driverById_(id);
        try {
          const r = updateDriverCore_(a, id, Object.assign({}, ch), null);
          out.done.push({ id: id, name: o ? o.name : id });
          (r.subMsg || []).forEach(function (m) { out.subMsg.push(m); });
        } catch (e) { out.failed.push({ id: id, name: o ? o.name : id, msg: String(e && e.message || e) }); }
      });
    } finally { lock.releaseLock(); }
    logAdmin_(a, '기사 일괄 수정', out.done.length + '명', keys.map(function (k) { return D_EDIT_LABEL[k] + '=' + (ch[k] === '' ? '(빈칸)' : ch[k]); }).join(', ') + (out.failed.length ? ' · 실패 ' + out.failed.length : ''));
    return out;
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
        f.driverType = opt(v, '단가코드', 10);
        if (f.driverType && DTYPES.indexOf(f.driverType) < 0) fail_('단가코드은 ' + DTYPES.join(' / ') + ' 중에서 골라 주세요.');
        break;
      case 'title':
        f.title = opt(v, '직함', 10);
        if (f.title && TITLES.indexOf(f.title) < 0) fail_('직함은 ' + TITLES.join(' / ') + ' 중에서 고르거나 비워 주세요.');
        break;
      case 'schCampId': {
        const id = str_(v);
        if (!id) { f.schCampId = ''; f.schCamp = ''; break; }
        const camp = campMap_()[id];
        if (!camp) fail_('캠프를 찾을 수 없습니다. 노선관리에서 확인해 주세요.');
        f.schCampId = camp.id; f.schCamp = camp.name;
        break;
      }
      case 'baseRoute': f.baseRoute = normBaseRoute_(opt(v, '기본노선', 60)); break;
      case 'fixedOff': f.fixedOff = opt(v, '고정휴무일', 60); break;
      case 'extraOff': f.extraOff = opt(v, '추가휴무', 60); break;
      case 'workPattern': f.workPattern = opt(v, '근무형태', 30); break;
      case 'schMemo': f.schMemo = opt(v, '스케줄 메모', 500); break;
      case 'backupArea': f.backupArea = normBackupArea_(opt(v, '백업 범위', 100)); break;
      case 'subId1': case 'subId2': {
        const sid = str_(v).replace(/\s+/g, '');
        if (sid && !/^[A-Za-z0-9_.@-]{3,40}$/.test(sid)) fail_('서브아이디는 쿠팡플렉스 아이디(영문·숫자)로 써 주세요.');
        const mine = str_(changes.loginId !== undefined ? changes.loginId : o.loginId).toLowerCase();
        if (sid && sid.toLowerCase() === mine) fail_('서브아이디가 이 기사의 쿠팡플렉스 아이디와 같습니다.');
        const other = k === 'subId1' ? (changes.subId2 !== undefined ? changes.subId2 : o.subId2) : (changes.subId1 !== undefined ? changes.subId1 : o.subId1);
        if (sid && str_(other).toLowerCase() === sid.toLowerCase()) fail_('서브아이디1과 2가 같습니다.');
        if (sid) {
          const dup = readAll_(SH.DRIVERS).filter(function (x) { return x.id !== o.id && [x.subId1, x.subId2].some(function (y) { return str_(y).toLowerCase() === sid.toLowerCase(); }); })[0];
          if (dup) fail_(sid + ' 는 이미 ' + dup.name + ' 기사님의 서브아이디입니다.');
        }
        f[k] = sid;
        break;
      }
      case 'subType1': case 'subType2': {
        const t = str_(v) ? normDriverType_(v) : '';
        if (t === null) fail_('서브아이디 단가는 ' + DTYPES.join(' / ') + ' 중에서 골라 주세요 (비우면 메인과 같음).');
        f[k] = t; break;
      }
      case 'stlMode':
        f.stlMode = str_(v) === '기본' ? '' : str_(v);
        if (['', '원청단가', '용차내역'].indexOf(f.stlMode) < 0) fail_('정산 방식은 기본 / 원청단가 / 용차내역 중에서 골라 주세요.');
        break;
      case 'insEx': f.insEx = /^(y|yes|o|예|제외|true|1)$/i.test(str_(v)) ? 'Y' : ''; break;
      case 'fbCut': {
        const t = str_(v).replace(/[,\s원]/g, '');
        if (t && !/^(\d{1,7}|\d{1,2}(\.\d+)?%|0?\.\d+)$/.test(t)) fail_('프레시백 차감은 13% 같은 비율이나 금액으로 써 주세요 (비우면 차감 없음).');
        f.fbCut = t; break;
      }
      case 'workStatus':
        f.workStatus = str_(v);
        if (f.workStatus && WSTAT.indexOf(f.workStatus) < 0) fail_('근무상태는 ' + WSTAT.join(' / ') + ' 중에서 골라 주세요.');
        if (f.workStatus === '재직') f.workStatus = '';
        break;
      case 'leaveDate': {
        const d = str_(v);
        if (d && !parseYmd_(d)) fail_('퇴사일을 확인해 주세요.');
        f.leaveDate = d ? ymd_(parseYmd_(d)) : '';
        break;
      }
      case 'schOrder':
        f.schOrder = opt(v, '스케줄 순서', 5);
        if (f.schOrder && !/^\d{1,5}$/.test(f.schOrder)) fail_('스케줄 순서는 숫자로 입력해 주세요.');
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
      case 'qualNo': f.qualNo = qualFmt_(opt(v, '자격증 번호', 30)); break;
      case 'carName': f.carName = opt(v, '차명', 40); break;
      case 'carNo': f.carNo = opt(v, '차량번호', 20).replace(/\s/g, ''); break;
      case 'bankName': f.bankName = opt(v, '은행명', 20); break;
      case 'accountHolder': f.accountHolder = opt(v, '예금주', 30); break;
      // 사업자 정보 (명의자 세금계산서용) — 정산관리 › 아이디 관리 › 명의자 사업자 정보 표는 여기 값을 읽기만 함
      case 'bizNo': {
        const d = String(v == null ? '' : v).replace(/\D/g, '');
        if (d && d.length !== 10) fail_('사업자등록번호는 10자리로 입력해 주세요.');
        f.bizNo = d ? d.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3') : ''; break;
      }
      case 'bizName': f.bizName = opt(v, '상호', 100); break;
      case 'tiOn': f.tiOn = /^(y|yes|예|역발행|true|1)$/i.test(str_(v)) ? 'Y' : ''; break; // Y = 기사 앱 정산서에 역발행 세금계산서를 보여 줌
      case 'extraAssign': f.extraAssign = extraAssignNorm_(v, changes.schCampId !== undefined ? str_(changes.schCampId) : o.schCampId); break;
      case 'bizCeo': f.bizCeo = opt(v, '대표자', 50); break;
      case 'bizAddr': f.bizAddr = opt(v, '사업장 주소', 200); break;
      case 'bizType': f.bizType = opt(v, '업태', 100); break;
      case 'bizItem': f.bizItem = opt(v, '종목', 100); break;
      case 'bizEmail': {
        const e = opt(v, '계산서 이메일', 100);
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail_('계산서 이메일 형식을 확인해 주세요.');
        f.bizEmail = e; break;
      }
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
/** 단가코드 글자 정리: '고정기사' → '고정', '용차' → '외부용차'. 모르는 값이면 null */
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
    if (!str_(fields.driverType)) fail_('단가코드(고정 / 백업 / 품앗이 / 외부용차)을 골라 주세요.');
    if (!fields.status) fields.status = ST.ACTIVE;
    const pw = tempPw ? checkPw_(tempPw) : '';
    if (pw && !str_(fields.loginId)) fail_('앱 로그인용 비밀번호를 지정하려면 쿠팡플렉스 아이디를 입력해 주세요.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const r = driverFields_(fields, { _row: -1, loginId: '', approvedAt: '' });
      const now = nowText_();
      const row = Object.assign({ id: newDriverId_(), createdAt: now, updatedAt: now }, r.f);
      if (!row.driverCode) row.driverCode = nextDriverCode_();
      if (row.status === ST.ACTIVE) row.approvedAt = now;
      if (pw) { Object.assign(row, passwordFields_(pw)); row.pwMustChange = 'Y'; }
      const at = appendObj_(SH.DRIVERS, row);
      if (row.loginId) forgetDriver_({ loginId: row.loginId });
      logAdmin_(a, '기사 등록', row.name + ' (' + row.id + ')', [row.driverType, row.driverCode].filter(String).join(' ') + (pw ? ', 임시 비밀번호 지정' : ''));
      const made = readObj_(SH.DRIVERS, at);
      if (typeof stlEnsureIdFor_ === 'function') stlEnsureIdFor_(made); // 정산관리 아이디 관리에도 추가
      const subMsg = made.subId1 || made.subId2 ? drvLinkSubs_(a, made, []) : [];
      return { ok: true, driver: detailOf_(readObj_(SH.DRIVERS, at)), subMsg: subMsg };
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      o = driverById_(String(id || ''));
      if (!o) return { ok: true, already: true };
      if (str_(confirmName).replace(/\s+/g, '') !== str_(o.name).replace(/\s+/g, '')) fail_('입력한 이름이 기사 이름과 다릅니다. 삭제하지 않았습니다.');
      sheet_(SH.DRIVERS).deleteRow(o._row);
      forgetDriver_(o);
      if (typeof fsDropDriver_ === 'function') fsDropDriver_([o.id]);
      if (typeof stlBump_ === 'function' && props_().STL_DB_ID) { try { stlBump_(); } catch (e) { /* 무시 */ } }
      // 이 기사의 로그인 기록 지우기
      const ss = readAll_(SH.SESSIONS).filter(function (x) { return x.driverId === o.id; });
      delRows_(sheet_(SH.SESSIONS), ss.map(function (x) { return x._row; }));
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

/** 앱이 만든 "기사 서류" 폴더 안의 기사 폴더만 휴지통으로 */
function trashDriverFolder_(link) {
  const id = (String(link || '').match(/folders\/([A-Za-z0-9_-]{10,})/) || [])[1] || fileIdOf_(link);
  if (!id) return false;
  try {
    const f = DriveApp.getFolderById(id), parents = f.getParents();
    while (parents.hasNext()) if (parents.next().getId() === props_().DOCS_FOLDER_ID) { f.setTrashed(true); return true; }
  } catch (e) { /* 이미 없는 폴더 */ }
  return false;
}

/**
 * 선택한 기사 여러 명 삭제 (되돌릴 수 없음). confirm = '<명수>명 삭제' (예: 3명 삭제) 를 그대로 입력해야 한다.
 * 한 명 삭제와 같은 처리: 줄 삭제, 로그인 해제, 가입 서류 폴더 휴지통. 스케줄·배번호 기록은 남긴다.
 */
function adm_deleteDrivers(token, ids, confirm) {
  return run_(function () {
    const a = requireAdmin_(token);
    const want = {};
    (ids || []).forEach(function (id) { if (id) want[String(id)] = 1; });
    const n = Object.keys(want).length;
    if (!n) fail_('삭제할 기사를 골라 주세요.');
    if (n > 500) fail_('한 번에 500명까지 삭제할 수 있습니다.');
    if (str_(confirm).replace(/\s+/g, '') !== n + '명삭제') fail_('확인 문구가 다릅니다. "' + n + '명 삭제" 를 그대로 입력해 주세요. 삭제하지 않았습니다.');
    const lock = scriptLock_();
    lock.waitLock(30000);
    let hit = [];
    try {
      hit = readAll_(SH.DRIVERS).filter(function (o) { return o.id && want[o.id]; });
      delRows_(sheet_(SH.DRIVERS), hit.map(function (o) { return o._row; }));
      hit.forEach(forgetDriver_);
      if (typeof fsDropDriver_ === 'function') fsDropDriver_(hit.map(function (o) { return o.id; }));
      if (typeof stlBump_ === 'function' && props_().STL_DB_ID) { try { stlBump_(); } catch (e) { /* 무시 */ } }
      const gone = {};
      hit.forEach(function (o) { gone[o.id] = 1; });
      const ss = readAll_(SH.SESSIONS).filter(function (x) { return gone[x.driverId]; });
      delRows_(sheet_(SH.SESSIONS), ss.map(function (x) { return x._row; }));
      if (ss.length) cache_().removeAll(ss.map(function (x) { return 'ss:' + x.tokenHash; }));
      if (hit.length) {
        logAdmin_(a, '기사 삭제', hit.length + '명', hit.slice(0, 40).map(function (o) { return o.name + ' (' + o.id + ')'; }).join(', ') +
          (hit.length > 40 ? ' 외 ' + (hit.length - 40) + '명' : '') + (ss.length ? ' · 로그인 ' + ss.length + '건 해제' : ''));
      }
    } finally {
      lock.releaseLock();
    }
    let trashed = 0;
    hit.forEach(function (o) { if (trashDriverFolder_(o.docFolder)) trashed++; });
    return { ok: true, deleted: hit.map(function (o) { return o.id; }), missing: n - hit.length, docsTrashed: trashed };
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
    const row = writeByKey_(SH.DRIVERS, 'id', o.id, o._row, f);
    if (!row) fail_('기사를 찾을 수 없습니다.');
    forgetDriver_(o);
    logAdmin_(a, '임시 비밀번호 지정', o.name + ' (' + o.id + ')', '');
    return { ok: true, driver: detailOf_(readObj_(SH.DRIVERS, row)) };
  });
}

/**
 * 임시 비밀번호 일괄 지정: ids = 기사ID 목록, opt = { mode: 'same'|'auto', password }
 *  same = 입력한 비밀번호를 모두에게 · auto = 기사마다 다른 임시 비밀번호를 만들어 줌 (결과에 한 번만 보여 줌)
 *  모두 다음 로그인 때 비밀번호를 바꿔야 함(pwMustChange). 한 번에 200명까지.
 */
function adm_setTempPasswordBulk(token, ids, opt) {
  return run_(function () {
    const a = requireAdmin_(token);
    opt = opt || {}; ids = (ids || []).map(String).filter(Boolean);
    if (!ids.length) fail_('기사를 골라 주세요.');
    if (ids.length > 200) fail_('한 번에 200명까지 바꿀 수 있습니다.');
    const same = opt.mode !== 'auto' ? checkPw_(opt.password) : '';
    const gen = function () { // 영문 소문자 + 숫자 8자 (헷갈리는 글자 l·o·0·1 제외) — 영문·숫자 둘 다 들어가게
      const L = 'abcdefghjkmnpqrstuvwxyz', N = '23456789', b = randomBytes_(8); let out = '';
      for (let i = 0; i < 8; i++) { const pool = (i % 2 === 0) ? L : N, v = Number(b[i]); out += pool.charAt((isFinite(v) ? Math.abs(v) : Math.floor(Math.random() * 256)) % pool.length); }
      return out;
    };
    const lock = scriptLock_();
    lock.waitLock(20000);
    const done = [], miss = [];
    try {
      const now = nowText_();
      ids.forEach(function (id) {
        const o = driverById_(id);
        if (!o) { miss.push(id); return; }
        const pw = same || gen(), f = passwordFields_(pw);
        f.pwMustChange = 'Y'; f.updatedAt = now;
        const row = writeByKey_(SH.DRIVERS, 'id', o.id, o._row, f);
        if (!row) { miss.push(id); return; }
        forgetDriver_(o);
        done.push({ id: o.id, name: o.name, loginId: o.loginId, pw: pw });
      });
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    logAdmin_(a, '임시 비밀번호 일괄 지정', done.length + '명' + (opt.mode === 'auto' ? ' (자동 생성)' : ''), done.map(function (d) { return d.name; }).join(', ').slice(0, 300));
    return { ok: true, done: done, missing: miss.length };
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
function newMemoId_() { return uniqId_('M'); }
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
    author: o.author, createdAt: o.createdAt, updatedAt: o.updatedAt, cat: o.cat || '',
    note: o.author === SCH_NOTE_AUTHOR // 기사스케줄 비고에서 옮겨 온 글 (할 일이 아니므로 '미완료' 로 세지 않음)
  };
}
function memoSort_(a, b) {
  return a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : a.time !== b.time ? (!a.time ? 1 : !b.time ? -1 : a.time < b.time ? -1 : 1)
    : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** 한 달치 메모 (시트를 한 번에 읽는다). ym = 'yyyy-MM' */
function adm_memoMonth(token, ym) {
  return run_(function () { requireAdmin_(token); return memoMonth_(ym); });
}
/** 한 달치 메모 (관리자앱 · 기사앱 직함자 공용) */
function memoMonth_(ym) {
  {
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
      if (!m.done && !m.note && o.date < today) pastUndone++;
    });
    list.sort(memoSort_);
    let noteLabels = [];
    try { noteLabels = schNotes_().map(function (n) { return n.label; }); } catch (e) { /* 스케줄 DB 가 없으면 비움 */ }
    const holidays = {}; Object.keys(HOLIDAYS).forEach(function (d) { if (d.indexOf(ym) === 0) holidays[d] = HOLIDAYS[d]; });
    return { ok: true, memos: list, pastUndone: pastUndone, today: today, noteLabels: noteLabels, holidays: holidays };
  }
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
      if (!m.done && !m.note && o.date < today) list.push(m);
    });
    list.sort(memoSort_);
    return { ok: true, memos: list };
  });
}

/** 메모 추가(id 없음) 또는 수정(id 있음). 바꿀 항목만 보내도 된다. */
function adm_memoSave(token, memo) {
  return run_(function () { return memoSave_(requireAdmin_(token), memo); });
}
/** 메모 추가·수정 (관리자앱 · 기사앱 직함자 공용). a = { name } 작성자 */
function memoSave_(a, memo) {
  {
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
    if (memo.cat !== undefined) f.cat = str_(memo.cat).slice(0, 30);

    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (!memo.id) {
        if (!f.date || !f.content) fail_('날짜와 내용을 입력해 주세요.');
        const id = newMemoId_();
        const row = appendObj_(SH.MEMO, {
          id: id, date: f.date, time: f.time || '', content: f.content, done: f.done || '', cat: f.cat || '',
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
  }
}

function adm_memoDelete(token, id) {
  return run_(function () { requireAdmin_(token); return memoDelete_(id); });
}
function memoDelete_(id) {
  {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.MEMO, 'id', String(id || ''));
      if (!row) return { ok: true }; // 이미 지워짐
      sheet_(SH.MEMO).deleteRow(row);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  }
}

// ───── 기사앱: 러너 업무스케줄 (직함자 = 관리자·운영자·대표만 · 보기·쓰기·고치기·지우기) ─────
/** 기사앱 세션 + 직함 확인. 직함이 없으면 막는다 */
function memoStaff_(token) {
  const s = getSession_(token);
  const info = s ? driverInfo_(s.d) : null;
  if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { err: { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' } };
  if (info.mustChange) return { err: { ok: false, code: 'MUST_CHANGE', msg: '비밀번호를 먼저 바꿔 주세요.' } };
  if (!info.title) fail_('관리자·운영자·대표만 쓸 수 있는 기능입니다.');
  return { me: info };
}
function api_memoMonth(token, ym) {
  return run_(function () { const x = memoStaff_(token); return x.err || memoMonth_(ym); });
}
function api_memoSave(token, memo) {
  return run_(function () {
    const x = memoStaff_(token); if (x.err) return x.err;
    const out = memoSave_({ name: x.me.name }, memo);
    logAdmin_({ name: x.me.name + ' (기사앱 ' + x.me.title + ')', loginId: x.me.loginId }, memo && memo.id ? '업무스케줄 수정' : '업무스케줄 추가', (out.memo && out.memo.date) || '', String((memo && memo.content) || '').slice(0, 40));
    return out;
  });
}
function api_memoDelete(token, id) {
  return run_(function () {
    const x = memoStaff_(token); if (x.err) return x.err;
    logAdmin_({ name: x.me.name + ' (기사앱 ' + x.me.title + ')', loginId: x.me.loginId }, '업무스케줄 삭제', String(id || ''), '');
    return memoDelete_(id);
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

// ───────────────────────── 공지사항 (관리자 작성 → 기사 앱 표시) ─────────────────────────
/*
 * notices 시트 한 장. 기사 앱은 캐시된 '게시 중' 목록만 읽는다 (저장·시트 수정 시 캐시 삭제).
 * 대상 캠프를 비우면 전체, 캠프명을 쓰면 그 캠프 소속 기사에게만 보인다.
 */
function newNoticeId_() { return uniqId_('N'); }
function noticeView_(o) {
  return {
    id: o.id, title: o.title, body: o.body, important: String(o.important).toUpperCase() === 'Y', target: o.target,
    start: normDate_(o.start) || '', end: normDate_(o.end) || '', status: o.status === NST.OFF ? NST.OFF : NST.ON,
    author: o.author, createdAt: o.createdAt, updatedAt: o.updatedAt, photos: ntPhotos_(o.attach).length
  };
}
function noticeSort_(a, b) {
  if (a.important !== b.important) return a.important ? -1 : 1;
  const x = a.start || a.createdAt, y = b.start || b.createdAt;
  return x < y ? 1 : x > y ? -1 : (a.createdAt < b.createdAt ? 1 : -1);
}
/** 모든 공지 (10분 캐시) */
function noticeAll_() {
  const hit = cache_().get('nt:all');
  if (hit) return JSON.parse(hit);
  const list = readAll_(SH.NOTICE).filter(function (o) { return o.id && (o.title || o.body); }).map(noticeView_);
  try { cache_().put('nt:all', JSON.stringify(list), 600); } catch (e) { /* 너무 크면 캐시 없이 */ }
  return list;
}
function noticeLive_(n, today) {
  return n.status === NST.ON && (!n.start || n.start <= today) && (!n.end || n.end >= today);
}
/** 대상 캠프 글자 → 캠프명 목록 ('캠프' 글자·띄어쓰기 무시) */
function noticeTargets_(t) {
  return str_(t).split(/[,，、\/]/).map(function (x) { return x.replace(/\s+/g, '').replace(/캠프$/, ''); }).filter(Boolean);
}
function noticeFor_(n, campName) {
  const t = noticeTargets_(n.target);
  if (!t.length) return true;
  const mine = str_(campName).replace(/\s+/g, '').replace(/캠프$/, '');
  return !!mine && t.indexOf(mine) >= 0;
}

/** 기사 앱: 나에게 보이는 공지 (중요 먼저, 최신순) */
function api_notices(token) {
  return run_(function () {
    const fsT0 = Date.now();
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    const today = todayText_();
    let camp = info.camp || '';
    if (info.campId) { const c = master_().camps.filter(function (x) { return x.id === info.campId; })[0]; if (c) camp = c.name; }
    const list = noticeAll_().filter(function (n) { return noticeLive_(n, today) && noticeFor_(n, camp); }).sort(noticeSort_).slice(0, 50)
      .map(function (n) { return { id: n.id, title: n.title, body: n.body, important: n.important, date: n.start || n.createdAt.slice(0, 10), updatedAt: n.updatedAt, photos: n.photos || 0 }; });
    const out = { ok: true, notices: list, today: today };
    // 기사 앱 홈 사본 (공지 + 게시판 최근 글) → 다음 번엔 Firestore 에서
    if (typeof fsSaveDrvHome_ === 'function' && fsCopyOn_() && !(typeof PERF_BENCH_ !== 'undefined' && PERF_BENCH_)) fsSaveDrvHome_(s.d, out, fsT0);
    return out;
  });
}

/** 관리자: 공지 전체 + 캠프 목록(대상 고르기용) */
function adm_noticeList(token) {
  return run_(function () { requireAdmin_(token); return noticeList_(); });
}
/** 공지 전체 + 캠프 목록 (관리자앱 · 기사앱 직함자 공용) */
function noticeList_() {
  {
    const today = todayText_();
    const list = noticeAll_().map(function (n) { n.live = noticeLive_(n, today); return n; }).sort(function (a, b) {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return noticeSort_(a, b);
    });
    return { ok: true, notices: list, today: today, camps: master_().camps.filter(function (c) { return c.name && !isStaffCamp_(c.name); }).map(function (c) { return c.name; }) };
  }
}

// ───── 공지 사진 (드라이브 '공지사항 사진' 폴더 · 사진 칸에 주소를 줄바꿈으로) ─────
const NT_MAX_PHOTOS = 5;
function ntPhotos_(v) { return str_(v).split(/\s*\n\s*/).filter(function (x) { return !!fileIdOf_(x); }); }
function ntFolder_() {
  const p = props_();
  if (p.NT_FOLDER) { try { return DriveApp.getFolderById(p.NT_FOLDER); } catch (e) { /* 새로 */ } }
  const root = DriveApp.getFolderById(p.ROOT_FOLDER_ID), it = root.getFoldersByName('공지사항 사진');
  const f = it.hasNext() ? it.next() : root.createFolder('공지사항 사진');
  PropertiesService.getScriptProperties().setProperty('NT_FOLDER', f.getId());
  _props = null;
  return f;
}
/** 사진 한 장 → {mime, data} (600KB 넘으면 작은 그림) */
function ntPhotoBlob_(url) {
  let file;
  try { file = DriveApp.getFileById(fileIdOf_(url)); } catch (e) { fail_('사진을 열 수 없습니다.'); }
  let blob = null;
  if (file.getSize() > 600 * 1024) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
  if (!blob) blob = file.getBlob();
  return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
}
/** 기사 앱: 나에게 보이는 공지의 사진 i번째 */
function api_ntPhoto(token, id, i) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    let camp = info.camp || '';
    if (info.campId) { const c = master_().camps.filter(function (x) { return x.id === info.campId; })[0]; if (c) camp = c.name; }
    const row = findRow_(SH.NOTICE, 'id', String(id || ''));
    const o = row ? readObj_(SH.NOTICE, row) : null;
    if (!o || !noticeLive_(noticeView_(o), todayText_()) || !noticeFor_(noticeView_(o), camp)) fail_('공지를 찾을 수 없습니다.');
    const u = ntPhotos_(o.attach)[Number(i) || 0];
    if (!u) fail_('사진이 없습니다.');
    return ntPhotoBlob_(u);
  });
}
/** 관리자: 공지 사진 i번째 (수정 화면 미리보기) */
function adm_ntPhoto(token, id, i) {
  return run_(function () { requireAdmin_(token); return ntPhotoAny_(id, i); });
}
/** 공지 사진 (게시 여부와 상관없이 · 관리자 · 직함자용) */
function ntPhotoAny_(id, i) {
  {
    const row = findRow_(SH.NOTICE, 'id', String(id || ''));
    const u = row ? ntPhotos_(readObj_(SH.NOTICE, row).attach)[Number(i) || 0] : '';
    if (!u) fail_('사진이 없습니다.');
    return ntPhotoBlob_(u);
  }
}
/** 공지 추가(id 없음)·수정 */
function adm_noticeSave(token, n) {
  return run_(function () { return noticeSave_(requireAdmin_(token), n); });
}
/** 공지 추가·수정 (관리자앱 · 기사앱 직함자 공용). a = { name, loginId } */
function noticeSave_(a, n) {
  {
    fsMark_('nb');
    n = n || {};
    const f = {
      title: str_(n.title), body: String(n.body == null ? '' : n.body).replace(/\r\n?/g, '\n').trim(),
      important: n.important ? 'Y' : '', target: noticeTargets_(n.target).join(', '),
      start: n.start ? normDate_(n.start) : '', end: n.end ? normDate_(n.end) : '', status: n.status === NST.OFF ? NST.OFF : NST.ON
    };
    if (!f.title) fail_('제목을 입력해 주세요.');
    if (f.title.length > 100) fail_('제목은 100자까지 쓸 수 있습니다.');
    if (f.body.length > 5000) fail_('내용은 5000자까지 쓸 수 있습니다.');
    if (n.start && !f.start) fail_('게시 시작일을 확인해 주세요.');
    if (n.end && !f.end) fail_('게시 종료일을 확인해 주세요.');
    if (f.start && f.end && f.end < f.start) fail_('게시 종료일이 시작일보다 빠릅니다.');
    // 사진: keep = 남길 기존 사진 번호들 · add = 새 사진 [{data, mime}] (최대 5장 · 잠금 밖에서 드라이브에 올림)
    const add = Array.isArray(n.add) ? n.add : [];
    if (add.length > NT_MAX_PHOTOS) fail_('사진은 ' + NT_MAX_PHOTOS + '장까지 올릴 수 있습니다.');
    const newUrls = add.map(function (x, i) {
      if (!x || !/^image\//.test(String(x.mime))) fail_('사진(이미지)만 올릴 수 있습니다.');
      if (String(x.data || '').length > CFG.MAX_FILE_B64) fail_('사진이 너무 큽니다.');
      return ntFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(x.data), x.mime, (todayText_() + '_' + f.title + '_' + (i + 1)).replace(/[\\\/:*?"<>|]/g, '_').slice(0, 80) + (/png/.test(x.mime) ? '.png' : '.jpg'))).getUrl();
    });
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      let row;
      if (!n.id) {
        f.attach = newUrls.slice(0, NT_MAX_PHOTOS).join('\n');
        row = appendObj_(SH.NOTICE, Object.assign({ id: newNoticeId_(), author: a.name, createdAt: now, updatedAt: now }, f));
        logAdmin_(a, '공지 등록', f.title, f.target || '전체');
      } else {
        row = findRow_(SH.NOTICE, 'id', String(n.id));
        if (!row) fail_('공지를 찾을 수 없습니다. 시트에서 지워졌을 수 있습니다. 새로고침해 주세요.');
        const old = ntPhotos_(readObj_(SH.NOTICE, row).attach), keep = Array.isArray(n.keep) ? n.keep.map(Number) : old.map(function (_, i) { return i; });
        const urls = old.filter(function (_, i) { return keep.indexOf(i) >= 0; }).concat(newUrls);
        if (urls.length > NT_MAX_PHOTOS) fail_('사진은 ' + NT_MAX_PHOTOS + '장까지 올릴 수 있습니다.');
        f.attach = urls.join('\n');
        f.updatedAt = now;
        writeFields_(SH.NOTICE, row, f);
        logAdmin_(a, '공지 수정', f.title, n.id);
      }
      cache_().remove('nt:all');
      return { ok: true, notice: noticeView_(readObj_(SH.NOTICE, row)) };
    } finally {
      lock.releaseLock();
    }
  }
}

function adm_noticeDelete(token, id) {
  return run_(function () { return noticeDelete_(requireAdmin_(token), id); });
}
function noticeDelete_(a, id) {
  {
    fsMark_('nb');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.NOTICE, 'id', String(id || ''));
      if (!row) return { ok: true };
      const o = readObj_(SH.NOTICE, row);
      sheet_(SH.NOTICE).deleteRow(row);
      cache_().remove('nt:all');
      logAdmin_(a, '공지 삭제', o.title, o.id);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  }
}

// ───── 기사앱: 공지사항 편집 (직함자 = 관리자·운영자·대표만 · 관리자앱 공지사항과 같은 데이터) ─────
/** 기사앱 직함자 → 작업 기록용 { name, loginId } */
function ntStaff_(token) {
  const x = memoStaff_(token); if (x.err) return x;
  return { a: { name: x.me.name, loginId: x.me.loginId + ' · 기사앱 ' + x.me.title } };
}
function api_ntAdmList(token) { return run_(function () { const x = ntStaff_(token); return x.err || noticeList_(); }); }
function api_ntAdmSave(token, n) { return run_(function () { const x = ntStaff_(token); return x.err || noticeSave_(x.a, n); }); }
function api_ntAdmDelete(token, id) { return run_(function () { const x = ntStaff_(token); return x.err || noticeDelete_(x.a, id); }); }
function api_ntAdmPhoto(token, id, i) { return run_(function () { const x = ntStaff_(token); return x.err || ntPhotoAny_(id, i); }); }

/** notices 시트를 직접 고쳤을 때: 공지ID·작성일시 자동, 날짜·중요·상태 정리, 캐시 삭제 */
function fixNoticeRow_(sh, c, o) {
  cache_().remove('nt:all');
  if (!o.id && !o.title && !o.body) return;
  const upd = {};
  const set = function (k, v) { if (o[k] !== v) upd[k] = v; };
  if (!o.id) { set('id', newNoticeId_()); if (!o.createdAt) set('createdAt', nowText_()); }
  if (!o.status) set('status', NST.ON);
  else if (/^(숨김|숨기기|off|n|no|x|중지)$/i.test(o.status)) set('status', NST.OFF);
  else if (o.status !== NST.OFF) set('status', NST.ON);
  if (o.important) set('important', /^(y|yes|o|v|중요|true|1)$/i.test(o.important) ? 'Y' : '');
  ['start', 'end'].forEach(function (k) {
    if (!o[k]) return;
    const d = normDate_(o[k]);
    const cell = sh.getRange(o._row, c[k] + 1);
    if (d) { set(k, d); cell.clearNote(); } else cell.setNote('날짜 형식을 확인해 주세요. (예: 2026-11-04)');
  });
  if (o.target) set('target', noticeTargets_(o.target).join(', '));
  if (Object.keys(upd).length) {
    upd.updatedAt = nowText_();
    Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(safeText_(upd[k])); });
  }
}

// ───────────────────────── 계정관리 (다른 프로그램·서비스 계정 보관) ─────────────────────────
/*
 * accounts 시트 한 장. 비밀번호는 암호화 칸(숨김)에만 저장하고, 보이는 칸에는 ●●●● 만 둔다.
 * 비밀번호 보기·복사는 서버에서 풀어 주며 매번 관리자 기록(admin_log)에 남긴다.
 */
function newAccId_() { return uniqId_('AC'); }
function accView_(o) {
  return {
    id: o.id, category: o.category, service: o.service, camp: o.camp, loginId: o.loginId, hasPw: !!o.pwEnc,
    owner: o.owner, url: o.url, memo: o.memo, status: (o.status === ACST.OFF || o.status === '중지') ? ACST.OFF : ACST.ON,
    pwChangedAt: o.pwChangedAt, author: o.author, createdAt: o.createdAt, updatedAt: o.updatedAt
  };
}
function accUrl_(v) {
  const s = str_(v);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}([\/:?#].*)?$/i.test(s)) return 'https://' + s;
  return s;
}

function adm_accList(token) {
  return run_(function () {
    requireAdmin_(token);
    const list = readAll_(SH.ACC).filter(function (o) { return o.id && (o.service || o.loginId); }).map(accView_);
    const cats = accCats_();
    list.forEach(function (x) { if (x.category && cats.indexOf(x.category) < 0) cats.push(x.category); }); // 시트에 직접 쓴 새 분류도 보이게
    return { ok: true, accounts: list, categories: cats, camps: master_().camps.map(function (c) { return c.name; }) };
  });
}

/** 추가(id 없음)·수정. password 가 undefined 면 비밀번호는 그대로, '' 이면 지움 */
function adm_accSave(token, x) {
  return run_(function () {
    const a = requireAdmin_(token);
    x = x || {};
    const f = {
      category: str_(x.category).slice(0, 30), service: str_(x.service).slice(0, 60), camp: str_(x.camp).slice(0, 30),
      loginId: str_(x.loginId).slice(0, 200), owner: str_(x.owner).slice(0, 60), url: accUrl_(x.url).slice(0, 500),
      memo: String(x.memo == null ? '' : x.memo).replace(/\r\n?/g, '\n').trim().slice(0, 2000),
      status: (x.status === ACST.OFF || x.status === '중지') ? ACST.OFF : ACST.ON
    };
    if (!f.service) fail_('서비스명을 입력해 주세요. (예: 쿠팡 어드민, 팀즈, 홈택스)');
    let pwChanged = false;
    if (x.password !== undefined && x.password !== null) {
      const pw = String(x.password);
      if (pw.length > 200) fail_('비밀번호가 너무 깁니다.');
      f.pwEnc = pw ? encrypt_(pw) : '';
      f.password = pw ? ACC_MASK : '';
      f.pwChangedAt = pw ? todayText_() : '';
      pwChanged = true;
    }
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      let row;
      if (f.category && accCats_().indexOf(f.category) < 0) accCatWrite_(accCats_().concat([f.category]));
      if (!x.id) {
        row = appendObj_(SH.ACC, Object.assign({ id: newAccId_(), author: a.name, createdAt: now, updatedAt: now }, f));
        logAdmin_(a, '계정 등록', f.service + (f.camp ? ' (' + f.camp + ')' : ''), f.loginId);
      } else {
        row = findRow_(SH.ACC, 'id', String(x.id));
        if (!row) fail_('계정을 찾을 수 없습니다. 시트에서 지워졌을 수 있습니다. 새로고침해 주세요.');
        f.updatedAt = now;
        writeFields_(SH.ACC, row, f);
        if (pwChanged) logAdmin_(a, '계정 비밀번호 변경', f.service + (f.camp ? ' (' + f.camp + ')' : ''), f.loginId);
      }
      return { ok: true, account: accView_(readObj_(SH.ACC, row)) };
    } finally {
      lock.releaseLock();
    }
  });
}

// ── 계정관리 분류 목록 (account_categories 시트) ──
/** 분류 이름 목록 (순서대로). 시트가 비어 있으면 기본 분류로 채운다 */
function accCats_() {
  const rows = readAll_(SH.ACAT).filter(function (o) { return o.name; });
  if (!rows.length) {
    const lock = scriptLock_();
    lock.waitLock(20000);
    try { if (!readAll_(SH.ACAT).some(function (o) { return o.name; })) accCatWrite_(ACC_CATS); } finally { lock.releaseLock(); }
    return accCats_();
  }
  rows.sort(function (a, b) { return (Number(a.order) || 999) - (Number(b.order) || 999) || a._row - b._row; });
  const out = [];
  rows.forEach(function (o) { if (out.indexOf(o.name) < 0) out.push(o.name); });
  return out;
}
/** 분류 목록을 통째로 다시 쓴다 (순서 1,2,3…) + accounts 탭 드롭다운 갱신 */
function accCatWrite_(names) {
  const sh = sheet_(SH.ACAT), c = cols_(SH.ACAT, true), last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, c.__w).clearContent();
  if (names.length) {
    const rows = names.map(function (n, i) { const r = new Array(c.__w).fill(''); r[c.name] = n; r[c.order] = String(i + 1); return r; });
    sh.getRange(2, 1, rows.length, c.__w).setNumberFormat('@').setValues(rows);
  }
  try {
    const ac = sheet_(SH.ACC), cc = cols_(SH.ACC);
    if (names.length) ac.getRange(2, cc.category + 1, ac.getMaxRows() - 1, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(names, true).setAllowInvalid(true).build());
  } catch (e) { /* 드롭다운은 실패해도 무시 */ }
}
function accCatName_(v) {
  const n = str_(v).replace(/\s+/g, ' ');
  if (!n) fail_('분류 이름을 입력해 주세요.');
  if (n.length > 30) fail_('분류 이름은 30자까지 쓸 수 있습니다.');
  if (/[,]/.test(n)) fail_('분류 이름에는 쉼표(,)를 쓸 수 없습니다.');
  return n;
}
/** accounts 탭에서 분류 칸이 from 인 줄을 모두 to 로 바꾼다. 바꾼 줄 수 반환 */
function accMoveCat_(from, to) {
  const sh = sheet_(SH.ACC), c = cols_(SH.ACC, true), last = sh.getLastRow();
  if (last < 2) return 0;
  const rng = sh.getRange(2, c.category + 1, last - 1, 1), vals = rng.getValues();
  let n = 0;
  vals.forEach(function (r) { if (str_(r[0]) === from) { r[0] = to; n++; } });
  if (n) { rng.setNumberFormat('@').setValues(vals); }
  return n;
}

/**
 * 분류 편집. op = { action: 'add' | 'rename' | 'delete' | 'order', name, newName, moveTo, names }
 * - rename: 그 분류를 쓰는 계정도 모두 새 이름으로
 * - delete: 그 분류를 쓰는 계정은 moveTo 로 옮김 (비우면 '기타')
 * - order : names 순서대로 저장
 */
function adm_accCats(token, op) {
  return run_(function () {
    const a = requireAdmin_(token);
    op = op || {};
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      let cats = accCats_(), msg = '';
      // 시트에 직접 쓴 분류도 목록에 포함
      readAll_(SH.ACC).forEach(function (o) { if (o.category && cats.indexOf(o.category) < 0) cats.push(o.category); });
      if (op.action === 'add') {
        const n = accCatName_(op.name);
        if (cats.indexOf(n) >= 0) fail_('이미 있는 분류입니다.');
        cats.push(n); msg = '"' + n + '" 분류를 추가했습니다.';
        logAdmin_(a, '계정 분류 추가', n, '');
      } else if (op.action === 'rename') {
        const from = str_(op.name), to = accCatName_(op.newName);
        if (cats.indexOf(from) < 0) fail_('분류를 찾을 수 없습니다. 새로고침해 주세요.');
        if (from === to) return { ok: true, categories: cats, msg: '' };
        const moved = accMoveCat_(from, to);
        cats = cats.map(function (x) { return x === from ? to : x; }).filter(function (x, i, arr) { return arr.indexOf(x) === i; });
        msg = '"' + from + '" → "' + to + '" 로 바꿨습니다.' + (moved ? ' (계정 ' + moved + '개 함께 변경)' : '');
        logAdmin_(a, '계정 분류 이름 변경', from + ' → ' + to, moved + '개');
      } else if (op.action === 'delete') {
        const name = str_(op.name);
        if (cats.indexOf(name) < 0) fail_('분류를 찾을 수 없습니다. 새로고침해 주세요.');
        const to = op.moveTo ? accCatName_(op.moveTo) : '기타';
        if (to === name) fail_('옮길 분류를 다른 것으로 골라 주세요.');
        const moved = accMoveCat_(name, to);
        cats = cats.filter(function (x) { return x !== name; });
        if (moved && cats.indexOf(to) < 0) cats.push(to);
        msg = '"' + name + '" 분류를 지웠습니다.' + (moved ? ' 계정 ' + moved + '개는 "' + to + '"(으)로 옮겼습니다.' : '');
        logAdmin_(a, '계정 분류 삭제', name, moved ? moved + '개 → ' + to : '');
      } else if (op.action === 'order') {
        const want = (op.names || []).map(str_).filter(function (x) { return cats.indexOf(x) >= 0; });
        cats = want.concat(cats.filter(function (x) { return want.indexOf(x) < 0; }));
      } else fail_('알 수 없는 작업입니다.');
      accCatWrite_(cats);
      return { ok: true, categories: cats, msg: msg };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 비밀번호 보기 (복사 포함). 매번 기록 */
function adm_accReveal(token, id, why) {
  return run_(function () {
    const a = requireAdmin_(token);
    const row = findRow_(SH.ACC, 'id', String(id || ''));
    if (!row) fail_('계정을 찾을 수 없습니다. 새로고침해 주세요.');
    const o = readObj_(SH.ACC, row);
    if (!o.pwEnc) fail_('저장된 비밀번호가 없습니다.');
    let pw;
    try { pw = decrypt_(o.pwEnc); } catch (e) { fail_('비밀번호를 풀 수 없습니다. 시트에서 암호화 칸이 바뀌었는지 확인해 주세요.'); }
    logAdmin_(a, why === 'copy' ? '계정 비밀번호 복사' : '계정 비밀번호 열람', o.service + (o.camp ? ' (' + o.camp + ')' : ''), o.loginId);
    return { ok: true, password: pw };
  });
}

function adm_accDelete(token, id) {
  return run_(function () {
    const a = requireAdmin_(token);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.ACC, 'id', String(id || ''));
      if (!row) return { ok: true };
      const o = readObj_(SH.ACC, row);
      sheet_(SH.ACC).deleteRow(row);
      logAdmin_(a, '계정 삭제', o.service + (o.camp ? ' (' + o.camp + ')' : ''), o.loginId);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/** accounts 시트를 직접 고쳤을 때: 계정ID 자동, 비밀번호 칸 → 암호화 후 ●●●● */
function fixAccountRow_(sh, c, o) {
  if (!o.id && !o.service && !o.loginId && !o.password) return;
  const upd = {};
  const set = function (k, v) { if (o[k] !== v) upd[k] = v; };
  if (!o.id) { set('id', newAccId_()); if (!o.createdAt) set('createdAt', nowText_()); }
  if (!o.status) set('status', ACST.ON);
  else if (/^(중지|정지|off|n|no|x)$/i.test(o.status)) set('status', ACST.OFF);
  else if (o.status !== ACST.OFF) set('status', ACST.ON);
  if (o.password && o.password !== ACC_MASK) {
    set('pwEnc', encrypt_(o.password)); set('password', ACC_MASK); set('pwChangedAt', todayText_());
  } else if (!o.password && o.pwEnc) {
    set('pwEnc', ''); set('pwChangedAt', '');
  } else if (o.password === ACC_MASK && !o.pwEnc) {
    set('password', ''); // 암호문 없이 ●만 있는 경우
  }
  if (o.url) set('url', accUrl_(o.url));
  if (Object.keys(upd).length) {
    upd.updatedAt = nowText_();
    Object.keys(upd).forEach(function (k) { sh.getRange(o._row, c[k] + 1).setNumberFormat('@').setValue(safeText_(upd[k])); });
  }
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
  // 시트에 아직 없는 항목(코드 업데이트로 새로 생긴 항목)은 기본값. 시트에서 비워 둔 값은 빈칸 그대로
  COMPANY.forEach(function (c) { out[c[0]] = c[2] || ''; });
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
  COMPANY.forEach(function (c) { if (c[3] !== 'tax') need(co[c[0]], '회사 정보: ' + c[1]); });
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
      licenseNo: d.licenseNo, licenseType: d.licenseType, qualNo: qualFmt_(d.qualNo), qualDate: d.qualDate,
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

    const lock = scriptLock_();
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
    const lock = scriptLock_();
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
    const lock = scriptLock_();
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
      licenseNo: lic, licenseType: d.licenseType, qualNo: qualFmt_(d.qualNo), qualDate: d.qualDate,
      manageMethod: app.manageMethod, optConsent: String(app.optConsent).toUpperCase() === 'Y',
      company: co
    };
    const f = { printedAt: nowText_(), snapshotEnc: encrypt_(JSON.stringify(data)), updatedAt: nowText_() };
    if (app.status === BST.DRAFT) f.status = BST.PRINTED;
    const row = writeByKey_(SH.BIB, 'id', app.id, app._row, f);
    if (!row) fail_('신청서를 찾을 수 없습니다.');
    logAdmin_(a, '배번호 서류 출력', d.name + ' (' + d.id + ')', '서류 4종' + (missing.length ? ' (빈 항목 ' + missing.length + '개)' : ''));
    return { ok: true, data: data, detail: bibDetail_(readObj_(SH.BIB, row)) };
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
    const lock = scriptLock_();
    lock.waitLock(20000); // 다른 저장과 같은 잠금 (동시에 두 명이 저장해도 덮어쓰지 않게)
    try {
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
    } finally { lock.releaseLock(); }
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
  editorOnly_();
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
  const lock = scriptLock_();
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
function onSheetChange(e) {
  try { stlTouchAll_(); } catch (x) { /* 정산 DB 캐시 (행·탭 추가·삭제 등 구조 변경) */ }
  cache_().remove('nt:all');
  Object.keys(SCHEMA).forEach(clearHeadCache_);
  cache_().remove('sch:h');
  bumpMaster_(); // 행 삭제·추가 등 구조 변경 → 노선 기준 데이터 캐시 버림
}

/** 매일 새벽 만료된 세션을 한 번에 정리 (setup 에서 트리거 등록) */
function cleanupSessions() {
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    const sh = sheet_(SH.SESSIONS), c = cols_(SH.SESSIONS, true);
    const last = sh.getLastRow();
    if (last < 2) return;
    const now = Date.now();
    const rows = sh.getRange(2, 1, last - 1, c.__w).getValues();
    // 지난 줄만 아래쪽부터 지운다 (전체를 지웠다 다시 쓰면 그 사이 appendRow 로 들어온 새 로그인 줄이 덮일 수 있음)
    const gone = [];
    rows.forEach(function (r, i) { if (!(toMs_(r[c.expiresAt]) > now)) gone.push(i + 2); });
    if (gone.length) delRows_(sh, gone);
  } finally {
    lock.releaseLock();
    try { pmAlertCleanup_(); } catch (e) { console.error('품앗이 알림 정리 실패: ' + (e && e.message)); } // 60일 지난 품앗이 알림 정리
    try { rcApplyDue_(); } catch (e) { console.error('노선 변경 예약 적용 실패: ' + (e && e.message)); } // 적용일이 된 노선 변경
    try { dataCheck_(); } catch (e) { console.error('자료 점검 실패: ' + (e && e.message)); errLog_('서버 오류', 'dataCheck_', String(e && e.message || e)); } // 자료 점검 (읽기만)
    try { if (typeof stlLegacyRouteFixAll_ === 'function') stlLegacyRouteFixAll_(); } catch (e) { console.error('그날 노선 되살리기 실패: ' + (e && e.message)); } // 기존 정산 이식 달 (한 번씩만)
    try { perfRollup_(); } catch (e) { console.error('속도 기록 요약 실패: ' + (e && e.message)); } // 7일 지난 속도 기록 → 하루 요약으로 · 60일 지난 오류 기록 정리
  }
}

// ───────────────────────── 관리자용 도구 (편집기에서 실행) ─────────────────────────
/** 개인정보 암복호화가 정상인지 확인 */
function testCrypto() {
  editorOnly_();
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
  return uniqId_(prefix);
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
  return { id: o.id, name: o.name, address: o.address, memo: o.memo, rot: normRot_(o.rot).join(',') || ROTS.join(','), cpCode: str_(o.cpCode).toUpperCase(), createdAt: o.createdAt, updatedAt: o.updatedAt };
}
/** 회전 글자 정리: 'd1, d2 f3' → ['D1','D2','F3'] (모르는 값은 버림) */
/** 기본 회전이 D1,D2,F3 가 아닌 캠프만 { 짧은캠프명: 'D1,D2' } (기사앱 칸 표시용 — 그 캠프 기본과 같으면 회전 글자 생략) */
function campRotMap_() {
  const out = {};
  try {
    master_().camps.forEach(function (c) {
      const r = normRot_(c.rot).join(',');
      if (r && r !== ROTS.join(',')) out[str_(c.name).replace(/\s*캠프\s*$/, '').replace(/\s+/g, '')] = r;
    });
  } catch (e) { /* 표시용이라 실패해도 무시 */ }
  return out;
}
function normRot_(v) {
  const out = [];
  str_(v).toUpperCase().split(/[\s,\/]+/).forEach(function (x) { if (ROTS.indexOf(x) >= 0 && out.indexOf(x) < 0) out.push(x); });
  return ROTS.filter(function (r) { return out.indexOf(r) >= 0; });
}
/** 기본노선 정리: 영문 대문자, 공백 하나 ('530ab (f3)' → '530AB (F3)') */
function normBaseRoute_(v) {
  return str_(v).replace(/\s+/g, ' ').replace(/[a-z]/g, function (ch) { return ch.toUpperCase(); });
}
function routeView_(o) {
  const g = splitCode_(o.code);
  return {
    id: o.id, campId: o.campId, code: normCode_(o.code), g1: g.g1, g2: g.g2, g3: g.g3, g4: g.g4, g5: g.g5,
    status: (o.status === RST.OFF || o.status === '중지') ? RST.OFF : RST.ON, memo: o.memo, createdAt: o.createdAt, updatedAt: o.updatedAt
  };
}
function imageView_(o) {
  return {
    id: o.id, campId: o.campId, fileId: fileIdOf_(o.file), url: o.file, desc: o.desc,
    order: Number(o.order) || 0, createdAt: o.createdAt, updatedAt: o.updatedAt, delBy: o.delBy || '', delAt: o.delAt || ''
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
/** 캐시 버전을 올리기 전에 시트 쓰기를 먼저 반영한다 → 새 버전으로 읽는 다른 실행이 아직 안 써진 값을 캐시에 넣지 않게 */
function flushBeforeBump_() { try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ } }
function bumpMaster_() {
  flushBeforeBump_(); fsMark_();
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
  // 기사 소속캠프 이름도 맞춘다
  (function () {
    const sh = sheet_(SH.DRIVERS), c = cols_(SH.DRIVERS, true), last = sh.getLastRow();
    if (last < 2) return;
    const ids = sh.getRange(2, c.schCampId + 1, last - 1, 1).getValues();
    const rng = sh.getRange(2, c.schCamp + 1, last - 1, 1), cur = rng.getValues();
    let changed = false;
    const out = cur.map(function (r, i) {
      const id = str_(ids[i][0]), now = str_(r[0]);
      const want = id && names[id] !== undefined ? names[id] : now;
      if (want !== now) changed = true;
      return [safeText_(want)];
    });
    if (changed) rng.setNumberFormat('@').setValues(out);
  })();
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
    const rot = f.rot === undefined ? undefined : normRot_(f.rot).join(',');
    const cpCode = f.cpCode === undefined ? undefined : str_(f.cpCode).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 12);
    if (rot === '') fail_('기본 회전을 하나 이상 골라 주세요.');
    const addrs = f.addresses === undefined ? undefined : cleanAddrs_(f.addresses);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const camps = readAll_(SH.CAMPS).filter(function (o) { return o.id || o.name; });
      if (camps.some(function (o) { return campKey_(o.name) === campKey_(name) && o.id !== f.id; })) {
        fail_('같은 이름의 캠프가 이미 있습니다: ' + name);
      }
      const now = nowText_();
      let row;
      if (!f.id) {
        row = appendObj_(SH.CAMPS, { id: newRid_('C'), name: name, address: address, memo: memo, rot: rot || ROTS.join(','), cpCode: cpCode || '', createdAt: now, updatedAt: now });
      } else {
        const o = camps.filter(function (x) { return x.id === f.id; })[0];
        if (!o) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
        conflict_(f.seen, o);
        row = o._row;
        const cf = { name: name, address: address, memo: memo, updatedAt: now };
        if (rot !== undefined) cf.rot = rot;
        if (cpCode !== undefined) cf.cpCode = cpCode;
        writeFields_(SH.CAMPS, row, cf);
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
    const lock = scriptLock_();
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
      if (parents.next().getId() === folderId) { file.setTrashed(true); return true; }
    }
  } catch (e) { /* 이미 없는 파일 */ }
  return false;
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const max = readAll_(SH.CIMG).filter(function (x) { return x.campId === camp.id; })
        .reduce(function (m, x) { return Math.max(m, Number(x.order) || 0); }, 0);
      const now = nowText_();
      const r = appendObj_(SH.CIMG, {
        id: id, campId: camp.id, campName: camp.name, file: file.getUrl(), desc: desc, order: String(max + 1),
        createdAt: now, updatedAt: now
      });
      if (img.thumb) ctSave_([{ id: id, campId: camp.id, fileId: file.getId(), data: img.thumb }], now);
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
    const lock = scriptLock_();
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
    const lock = scriptLock_();
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
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.CIMG, 'id', String(id || ''));
      if (!row) return { ok: true };
      fileId = fileIdOf_(readObj_(SH.CIMG, row).file);
      sheet_(SH.CIMG).deleteRow(row);
      try { const tr = findRow_(SH.CTHUMB, 'id', String(id)); if (tr) sheet_(SH.CTHUMB).deleteRow(tr); } catch (e) { /* 미리보기 없음 */ }
      bumpMaster_();
    } finally {
      lock.releaseLock();
    }
    trashCampFile_(fileId);
    return { ok: true };
  });
}

/** 잠금 안에서: 미리보기 저장 (이미지ID 기준 덮어쓰기) */
function ctSave_(items, now) {
  const have = {}, dup = [];
  readAll_(SH.CTHUMB).forEach(function (x) { if (have[x.id]) dup.push(x._row); else have[x.id] = x._row; });
  const add = {};
  items.forEach(function (t) {
    const data = String(t.data || '');
    if (!t.id || !data || data.length > 45000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return; // 칸 한 개(5만 자)에 들어가는 크기만
    const o = { id: String(t.id), campId: String(t.campId || ''), fileId: String(t.fileId || ''), data: data, updatedAt: now };
    if (have[o.id]) writeFields_(SH.CTHUMB, have[o.id], o); else add[o.id] = o; // 같은 묶음 안에 같은 이미지가 두 번 와도 한 줄
  });
  Object.keys(add).forEach(function (k) { appendObj_(SH.CTHUMB, add[k]); });
  if (dup.length) delRows_(sheet_(SH.CTHUMB), dup); // 예전에 겹쳐 생긴 줄 정리
}
/** 캠프 참고 이미지 미리보기 한꺼번에: { thumbs: { 이미지ID: { fileId, data } } } (캠프ID 없으면 전체) */
function adm_campThumbs(token, campId) {
  return run_(function () {
    requireAdmin_(token);
    const out = {};
    readAll_(SH.CTHUMB).forEach(function (x) { if (!campId || x.campId === campId) out[x.id] = { fileId: x.fileId, data: x.data }; });
    return { ok: true, thumbs: out };
  });
}
/** 화면에서 만든 미리보기 저장 (예전에 올린 이미지는 처음 볼 때 화면이 만들어 올림): items = [{ id, campId, fileId, data }] */
function adm_campThumbSave(token, items) {
  return run_(function () {
    requireAdmin_(token);
    items = (items || []).slice(0, 40);
    if (!items.length) return { ok: true, saved: 0 };
    const lock = scriptLock_();
    lock.waitLock(20000);
    try { ctSave_(items, nowText_()); } finally { lock.releaseLock(); }
    return { ok: true, saved: items.length };
  });
}
/** 이미지 내용. full=false 면 목록용 (큰 파일은 드라이브 썸네일, 작은 결과는 캐시) */
function adm_campImage(token, id, full) {
  return run_(function () {
    requireAdmin_(token);
    return campImageData_(id, full);
  });
}
/** 캠프 참고 이미지 내용 (관리자 adm_campImage · 기사 앱 api_campImage 공용) */
function campImageData_(id, full) {
  {
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
  }
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
    if (f.status === '중지') f.status = RST.OFF;
    if (f.status !== undefined && f.status !== RST.ON && f.status !== RST.OFF) fail_('사용여부는 사용 또는 정지만 됩니다.');
    const memo = f.memo === undefined ? undefined : String(f.memo || '').trim();
    if (memo && memo.length > 1000) fail_('메모가 너무 깁니다. (1000자 이내)');
    const code = f.code === undefined ? undefined : checkCode_(f.code);
    const lock = scriptLock_();
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
    const lock = scriptLock_();
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
    if (status === '중지') status = RST.OFF;
    if (status !== RST.ON && status !== RST.OFF) fail_('사용여부는 사용 또는 정지만 됩니다.');
    const want = {};
    (ids || []).forEach(function (id) { want[String(id)] = 1; });
    const lock = scriptLock_();
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
    const lock = scriptLock_();
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
  const rot = normRot_(o.rot).join(',');
  if (o.rot && rot && rot !== o.rot) upd.rot = rot;
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
  const st = /^(중지|정지|n|no|x|off|미사용|사용안함|0)$/i.test(o.status) ? RST.OFF : RST.ON;
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
    updatedAt: o.updatedAt
  };
  RP_PRICE_KEYS.forEach(function (k) { const m = normMoney_(o[k]); v[k] = m === null ? o[k] : m; });
  return v;
}

/**
 * 캠프의 구분별 단가를 한 번에 저장.
 * rows = [{ num, level, value, p1..p5, seen }] — 보낸 줄만 바뀐다. 단가를 모두 비우면 그 줄은 지운다.
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
      x.empty = RP_PRICE_KEYS.every(function (k) { return !x[k]; });
      return x;
    });
    // 2) 저장 (짧게 잠금)
    const lock = scriptLock_();
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
        const f = { num: x.num, level: '구분' + x.level, value: x.value };
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
  upd.updatedAt = now;
  putCells_(sh, c, o._row, upd);
  putNote_(sh, c, o._row, 'campName', camp.err || '');
  ['num', 'level', 'value'].concat(RP_PRICE_KEYS).forEach(function (k) { putNote_(sh, c, o._row, k, notes[k] || ''); });
}

// ───────────────────────── 관리자 : 스케줄관리 (배차) ─────────────────────────
/*
 * schedule 시트 = 기사 1줄 × 날짜 1칸 (기존 운영시트의 '백업' 탭과 같은 모양)
 *   A~E열: 행ID(기사ID 또는 비고ID) | 구분(기사/비고) | 캠프 | 이름 | 기본노선   ← 캠프·이름·기본노선은 보기 편하라고 적어 두는 사본
 *   F열부터: 2026-01-01, 2026-01-02 … 날짜마다 1칸. 칸에는 스케줄 글자 그대로 (출근, 휴무, 527B (D1,D2), 안양1 724ABCD …)
 * 화면은 2주(14칸)씩 읽고, 고친 칸만 골라서 쓴다. 시트에서 직접 고쳐도 그대로 화면에 나온다.
 */
const SCH = { SHEET: 'schedule', FIXED: ['행ID', '구분', '캠프', '이름', '기본노선'], KIND_DRIVER: '기사', KIND_NOTE: '비고', KIND_PM: '품앗이' };
// 품앗이 줄: 행ID = 'PM' + 기사ID. 품앗이로 남의 일을 대신 뛰는 기사 1명 = 1줄, 날짜 칸 = 그날 뛰는 캠프·라우트 (배차 확정 때 자동으로 적힘)
const SCH_PM_PREFIX = 'PM';
const SCH_DAYS = 14;
const SCH_MAX_TEXT = 300;
// 대한민국 공휴일 (운영시트 스크립트의 내장 공휴일 사전과 같음)
const HOLIDAYS = {
  '2025-01-01': '신정', '2025-01-27': '임시공휴일', '2025-01-28': '설날 연휴', '2025-01-29': '설날', '2025-01-30': '설날 연휴',
  '2025-03-01': '삼일절', '2025-03-03': '대체공휴일', '2025-05-05': '어린이날·부처님오신날', '2025-05-06': '대체공휴일',
  '2025-06-03': '대통령선거일', '2025-06-06': '현충일', '2025-08-15': '광복절',
  '2025-10-03': '개천절', '2025-10-05': '추석 연휴', '2025-10-06': '추석', '2025-10-07': '추석 연휴', '2025-10-08': '대체공휴일', '2025-10-09': '한글날',
  '2025-12-25': '성탄절',
  '2026-01-01': '신정', '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절', '2026-03-02': '대체공휴일', '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날', '2026-05-25': '대체공휴일', '2026-06-03': '지방선거일', '2026-06-06': '현충일',
  '2026-07-17': '제헌절', '2026-08-15': '광복절', '2026-08-17': '대체공휴일',
  '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절', '2026-10-05': '대체공휴일', '2026-10-09': '한글날', '2026-12-25': '성탄절',
  '2027-01-01': '신정', '2027-02-06': '설날 연휴', '2027-02-07': '설날', '2027-02-08': '설날 연휴', '2027-02-09': '대체공휴일',
  '2027-03-01': '삼일절', '2027-05-05': '어린이날', '2027-05-13': '부처님오신날', '2027-06-06': '현충일',
  '2027-07-17': '제헌절', '2027-08-15': '광복절', '2027-08-16': '대체공휴일',
  '2027-09-14': '추석 연휴', '2027-09-15': '추석', '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절', '2027-10-04': '대체공휴일', '2027-10-09': '한글날', '2027-10-11': '대체공휴일', '2027-12-25': '성탄절'
};

function ymd_(d) { return Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd'); }
function parseYmd_(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function sundayOf_(d) { return addDays_(d, -d.getDay()); }

/**
 * 스케줄 DB = 별도 구글시트 파일 "러너 올인원 스케줄 DB" (러너 올인원 데이터 폴더).
 * 날짜 칸이 많아 무거우므로 기사·노선 DB 와 나눠서 관리한다. 파일 ID 는 설정값 SCH_DB_ID.
 * 예전처럼 메인 DB 안에 schedule 탭이 있으면 처음 한 번 새 파일로 옮기고, 메인 DB 의 탭은 "schedule(이전됨)" 으로 이름만 바꿔 둔다.
 */
let _schSS = null;
function schSS_() {
  if (_schSS) return _schSS;
  const id = props_().SCH_DB_ID;
  if (id) {
    try { return (_schSS = SpreadsheetApp.openById(id)); }
    catch (e) { fail_('스케줄 DB 파일을 열 수 없습니다. 드라이브 휴지통에 있는지 확인하거나, 스크립트 속성 SCH_DB_ID 를 비우면 새로 만듭니다.'); }
  }
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    const p = PropertiesService.getScriptProperties();
    const again = p.getProperty('SCH_DB_ID');
    if (again) { _props = null; return (_schSS = SpreadsheetApp.openById(again)); }
    const book = SpreadsheetApp.create('러너 올인원 스케줄 DB');
    try { DriveApp.getFileById(book.getId()).moveTo(DriveApp.getFolderById(props_().ROOT_FOLDER_ID)); } catch (e) { /* 폴더 이동 실패해도 사용 가능 */ }
    try { book.setSpreadsheetTimeZone(CFG.TZ); } catch (e) { /* 무시 */ }
    const old = ss_().getSheetByName(SCH.SHEET);
    if (old) {
      const copy = old.copyTo(book);
      copy.setName(SCH.SHEET);
      old.setName(SCH.SHEET + '(이전됨)');
      try { old.getRange(1, 1).setNote('스케줄은 "러너 올인원 스케줄 DB" 파일로 옮겼습니다. 이 탭은 확인 후 지워도 됩니다.'); } catch (e) { /* 무시 */ }
      book.getSheets().forEach(function (sh) { if (sh.getName() !== SCH.SHEET) book.deleteSheet(sh); });
    }
    p.setProperty('SCH_DB_ID', book.getId());
    _props = null;
    try { installSheetTriggers_(book); } catch (e) { console.error('스케줄 DB 트리거 설치 실패: ' + e); }
    cache_().remove('sch:h');
    return (_schSS = book);
  } finally {
    lock.releaseLock();
  }
}

/** schedule 시트 (없으면 만든다: 올해 1월 1일 ~ 내년 12월 31일 날짜 칸, 비고 3줄) */
function schSheet_() {
  const book = schSS_();
  let sh = book.getSheetByName(SCH.SHEET);
  if (sh) return sh;
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    sh = book.getSheetByName(SCH.SHEET);
    if (sh) return sh;
    const blank = book.getSheets().filter(function (x) { return x.getLastRow() === 0 && x.getLastColumn() === 0; });
    sh = book.insertSheet(SCH.SHEET);
    blank.forEach(function (x) { book.deleteSheet(x); }); // 새 파일의 빈 "시트1" 정리
    const y = new Date().getFullYear();
    const dates = schDateRange_(new Date(y, 0, 1), new Date(y + 1, 11, 31));
    const head = SCH.FIXED.concat(dates);
    if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
    sh.getRange(1, 1, Math.min(sh.getMaxRows(), 300), head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange(2, 1, 1, 5).setValues([['NOTE1', SCH.KIND_NOTE, '', '업무 관련', '']]);
    sh.setFrozenRows(1); sh.setFrozenColumns(5);
    sh.getRange(1, 1).setNote('행ID = 기사ID(drivers 탭) 또는 비고ID. 이 열과 1행 날짜는 바꾸지 마세요. 날짜 칸은 자유롭게 고쳐도 됩니다.');
    cache_().remove('sch:h');
    return sh;
  } finally {
    lock.releaseLock();
  }
}
function schDateRange_(from, to) {
  const out = [];
  for (let d = new Date(from); d <= to; d = addDays_(d, 1)) out.push(ymd_(d));
  return out;
}
/** 머리글 위치: { fixed: {행ID: 0, …}, dates: {'2026-11-01': 열번호(0부터)}, first, last, w } (캐시) */
function schHeader_(fresh) {
  if (!fresh) {
    const hit = cache_().get('sch:h');
    if (hit) return JSON.parse(hit);
  }
  const sh = schSheet_();
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (v) { return v instanceof Date ? ymd_(v) : str_(v); });
  const h = { fixed: {}, dates: {}, first: '', last: '', w: head.length };
  head.forEach(function (t, i) {
    if (SCH.FIXED.indexOf(t) >= 0) h.fixed[t] = i;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      h.dates[t] = i;
      if (!h.first || t < h.first) h.first = t;
      if (!h.last || t > h.last) h.last = t;
    }
  });
  SCH.FIXED.forEach(function (t) { if (h.fixed[t] === undefined) fail_('schedule 시트 1행에 "' + t + '" 머리글이 없습니다. 머리글 이름은 바꾸지 마세요.'); });
  try { cache_().put('sch:h', JSON.stringify(h), CFG.HEAD_CACHE); } catch (e) { /* 무시 */ }
  return h;
}
/** 날짜 칸이 없으면 만든다 (앞쪽은 그 해 1월 1일부터, 뒤쪽은 그 해 12월 31일까지 한 번에) */
function schEnsureDates_(from, to) {
  let h = schHeader_();
  if (h.dates[ymd_(from)] !== undefined && h.dates[ymd_(to)] !== undefined) return h;
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    h = schHeader_(true);
    const sh = schSheet_();
    if (h.dates[ymd_(to)] === undefined && (!h.last || ymd_(to) > h.last)) {
      const start = h.last ? addDays_(parseYmd_(h.last), 1) : new Date(from.getFullYear(), 0, 1);
      const add = schDateRange_(start, new Date(to.getFullYear(), 11, 31));
      const at = sh.getLastColumn();
      if (sh.getMaxColumns() < at + add.length) sh.insertColumnsAfter(sh.getMaxColumns(), at + add.length - sh.getMaxColumns());
      sh.getRange(1, at + 1, sh.getMaxRows(), add.length).setNumberFormat('@');
      sh.getRange(1, at + 1, 1, add.length).setValues([add]).setFontWeight('bold').setBackground('#f1f3f4');
    }
    h = schHeader_(true);
    if (h.dates[ymd_(from)] === undefined && h.first && ymd_(from) < h.first) {
      const add = schDateRange_(new Date(from.getFullYear(), 0, 1), addDays_(parseYmd_(h.first), -1));
      const firstCol = h.dates[h.first] + 1;
      sh.insertColumnsBefore(firstCol, add.length);
      sh.getRange(1, firstCol, sh.getMaxRows(), add.length).setNumberFormat('@');
      sh.getRange(1, firstCol, 1, add.length).setValues([add]).setFontWeight('bold').setBackground('#f1f3f4');
    }
    cache_().remove('sch:h');
    h = schHeader_(true);
    if (h.dates[ymd_(from)] === undefined || h.dates[ymd_(to)] === undefined) {
      fail_('schedule 시트의 날짜 칸이 비어 있거나 순서가 섞였습니다. 1행 날짜를 확인해 주세요.');
    }
    return h;
  } finally {
    lock.releaseLock();
  }
}

/** schedule 시트의 캠프·이름·기본노선 사본을 기사 정보에 맞춘다 (다를 때만, 바쁘면 다음에) */
function schSyncCopies_(sh, h, drivers, fixedRows) {
  const by = {};
  drivers.forEach(function (d) { by[d.id] = d; });
  let fixed = fixedRows;
  if (!fixed) { const last = sh.getLastRow(); if (last < 2) return; fixed = sh.getRange(2, 1, last - 1, 5).getValues(); }
  const fix = [];
  fixed.forEach(function (f, i) {
    const d = by[str_(f[h.fixed['행ID']])];
    if (!d) return;
    [['캠프', d.camp || ''], ['이름', d.name || ''], ['기본노선', d.baseRoute || '']].forEach(function (p) {
      if (str_(f[h.fixed[p[0]]]) !== p[1]) fix.push([i + 2, h.fixed[p[0]] + 1, p[1]]);
    });
  });
  if (!fix.length) return;
  const lock = scriptLock_();
  if (!lock.tryLock(3000)) return;
  try { fix.forEach(function (x) { sh.getRange(x[0], x[1]).setNumberFormat('@').setValue(safeText_(x[2])); }); }
  finally { lock.releaseLock(); }
}
// ───── 추가 배정: 소속 캠프 말고 다른 캠프의 라우트도 맡는 기사 ─────
// drivers '추가 배정' 칸 = JSON [{ c: 캠프ID, r: 라우트 }]. 기사스케줄에는 그 캠프 줄이 하나 더 생긴다 (행ID = EX기사ID@캠프ID)
const SCH_EX_PREFIX = 'EX';
// #279 추가 배정 기능 삭제: 칸에 값이 남아 있어도 읽지 않는다 (기사스케줄 EX 줄 · 내 스케줄 합치기 · 수행률 EX 모두 없어짐). 다른 캠프 입차는 칸에 '강서1 527B' 처럼 적는다.
function extraAssignOf_(o) { return []; }
function extraAssignNorm_(v, mainCampId) {
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a || '[]'); } catch (e) { fail_('추가 배정 값을 알아볼 수 없습니다.'); } }
  if (!Array.isArray(a)) a = [];
  const camps = {}; master_().camps.forEach(function (c) { camps[c.id] = c; });
  const seen = {}, out = [];
  a.forEach(function (x) {
    const c = str_(x && x.c); if (!c) return;
    if (!camps[c]) fail_('추가 배정: 노선관리에 없는 캠프입니다.');
    if (c === str_(mainCampId)) fail_('추가 배정: ' + camps[c].name + ' 은(는) 이미 소속 캠프입니다.');
    if (seen[c]) fail_('추가 배정: ' + camps[c].name + ' 이(가) 두 번 들어갔습니다.');
    seen[c] = 1;
    const r = normBaseRoute_(str_(x.r).slice(0, 60));
    if (!r) fail_('추가 배정: ' + camps[c].name + ' 의 라우트를 골라 주세요.');
    out.push({ c: c, r: r });
  });
  if (out.length > 5) fail_('추가 배정은 5개 캠프까지 할 수 있습니다.');
  return out.length ? JSON.stringify(out) : '';
}
const schExId_ = function (driverId, campId) { return SCH_EX_PREFIX + driverId + '@' + campId; };
/** 기본 배정 ↔ 추가 배정 맞바꿈: from 날짜부터 기사 줄 칸 ↔ 추가 배정 줄 칸 (지난 날짜는 그대로) */
function schSwapAssign_(o, f, from) {
  if (!props_().SCH_DB_ID) return;
  const sh = schSheet_(), h = schHeader_(), last = sh.getLastRow();
  if (last < 2) return;
  const lock = scriptLock_(); lock.waitLock(20000);
  try {
    const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
    const rowOf = function (id) { const i = ids.indexOf(id); return i < 0 ? 0 : i + 2; };
    const rMain = rowOf(String(o.id)), rOldEx = rowOf(schExId_(o.id, f.schCampId));
    if (!rMain && !rOldEx) return;
    const cols = Object.keys(h.dates).filter(function (d) { return d >= from; }).map(function (d) { return h.dates[d]; });
    if (!cols.length) return;
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols), w = c1 - c0 + 1, on = {};
    cols.forEach(function (c) { on[c - c0] = 1; });
    const read = function (r) { return r ? sh.getRange(r, c0 + 1, 1, w).getValues()[0].map(str_) : new Array(w).fill(''); };
    const vMain = read(rMain), vEx = read(rOldEx);
    // 예전 소속 캠프 → 새 추가 배정 줄
    let rNewEx = rowOf(schExId_(o.id, o.schCampId));
    if (!rNewEx && vMain.some(function (v, i) { return on[i] && v; })) {
      rNewEx = sh.getLastRow() + 1;
      const line = new Array(5).fill('');
      line[h.fixed['행ID']] = schExId_(o.id, o.schCampId); line[h.fixed['구분']] = SCH.KIND_DRIVER;
      line[h.fixed['캠프']] = o.schCamp || ''; line[h.fixed['이름']] = o.name; line[h.fixed['기본노선']] = o.baseRoute || '';
      sh.getRange(rNewEx, 1, 1, 5).setNumberFormat('@').setValues([line.map(safeText_)]);
    }
    const put = function (r, src, keep) {
      if (!r) return;
      const cur = read(r), out = cur.map(function (v, i) { return on[i] ? (src ? src[i] : '') : (keep ? v : v); });
      sh.getRange(r, c0 + 1, 1, w).setNumberFormat('@').setValues([out.map(safeText_)]);
    };
    if (rNewEx) put(rNewEx, vMain);
    if (rMain) put(rMain, vEx); else if (vEx.some(function (v, i) { return on[i] && v; })) { /* 기사 줄이 없으면 다음 저장 때 생김 */ }
    if (rOldEx) put(rOldEx, null);
  } finally { lock.releaseLock(); }
}
/** EX행ID → { driverId, campId } (아니면 null) */
function schExParse_(id) {
  const m = String(id || '').match(/^EX([^@]+)@(.+)$/);
  return m ? { driverId: m[1], campId: m[2] } : null;
}
/** 기사 → 화면용 요약 (스케줄에 필요한 것만, 개인정보 없음) */
function schDriver_(o) {
  return {
    id: o.id, name: o.name, loginId: o.loginId, type: o.driverType, code: o.driverCode, status: o.status, title: titleOf_(o),
    campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute, fixedOff: o.fixedOff, extraOff: o.extraOff,
    workPattern: o.workPattern, memo: o.schMemo, order: o.schOrder, carNo: o.carNo, backupArea: o.backupArea || '',
    workStatus: o.workStatus || '', leaveDate: schLeaveFrom_(o),
    subIds: [o.subId1, o.subId2].map(function (x) { return str_(x); }).filter(Boolean), // 칸 편집기 '서브아이디 업무등록' 추천용
    workerId: str_(o.workerId), alias: [],
    phone: str_(o.phone), carName: str_(o.carName), joinDate: str_(o.createdAt).slice(0, 10) // 기사스케줄 오른쪽 확인용 칸 (관리자 화면에만 내려감)
  };
}

/**
 * 2주 스케줄 읽기. start = 아무 날짜 (그 주 일요일부터 14일)
 * 반환: dates, holidays, camps, routes(캠프별 노선코드), drivers, cells{행ID:{날짜:값}}, notes[{id,label,cells}]
 */
function adm_schWeek(token, start) {
  return run_(function () {
    requireAdmin_(token);
    const base = parseYmd_(start) || new Date();
    const sun = sundayOf_(new Date(base.getFullYear(), base.getMonth(), base.getDate()));
    const fsT0 = Date.now(), res = schRead_(sun, addDays_(sun, SCH_DAYS - 1));
    // 이번 주면 Firestore 사본도 (다음 번엔 거기서)
    if (typeof fsSaveAdmSched_ === 'function' && fsCopyOn_() && sun.getTime() === sundayOf_(new Date()).getTime()) fsSaveAdmSched_(Utilities.formatDate(sun, CFG.TZ, 'yyyy-MM-dd'), res, fsT0);
    return res;
  });
}
/**
 * 기간 스케줄 읽기 (한 달 보기 등). from·to = 'yyyy-MM-dd', 최대 62일.
 * 반환 모양은 adm_schWeek 와 같다.
 */
function adm_schRange(token, from, to) {
  return run_(function () {
    requireAdmin_(token);
    const a = parseYmd_(from), b = parseYmd_(to);
    if (!a || !b || b < a) fail_('기간을 확인해 주세요.');
    if ((b - a) / 86400000 > 61) fail_('한 번에 62일까지 볼 수 있습니다.');
    return schRead_(a, b);
  });
}
/** from~to 기간의 스케줄 + 기사·캠프·노선 (adm_schWeek / adm_schRange 공용) */
function schRead_(sun, end) {
  const h = schEnsureDates_(sun, end);
  const dates = schDateRange_(sun, end);
  const sh = schSheet_(), last = sh.getLastRow();
  const cols = dates.map(function (d) { return h.dates[d]; });
  const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
  const cells = {}, notes = [], rowIds = {};
  let fixed = null, touched = false; // fixed = 행ID·구분·캠프·이름·기본노선 열 (아래 schSyncCopies_ 가 다시 읽지 않게 넘김 · 줄을 지웠으면 안 넘김)
  if (last >= 2) {
    fixed = sh.getRange(2, 1, last - 1, 5).getValues();
    const block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
    fixed.forEach(function (f, i) {
      const id = str_(f[h.fixed['행ID']]);
      if (!id) return;
      const kind = str_(f[h.fixed['구분']]);
      const row = {};
      dates.forEach(function (d, j) { const v = str_(block[i][cols[j] - c0]); if (v) row[d] = v; });
      if (kind === SCH.KIND_NOTE) notes.push({ id: id, label: str_(f[h.fixed['이름']]) || id, cells: row });
      else if (!rowIds[id]) { rowIds[id] = 1; cells[id] = row; }
    });
  }
  // 비고 줄은 첫 줄(업무 관련) 하나만 쓴다: 예전에 만든 둘째·셋째 비고 줄은 한 번만 지우고, 그 줄의 메모는 첫 줄로 옮긴다
  if (!props_().SCH_NOTE_TRIM) {
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      if (notes.length > 1) {
      const all = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
      const extra = notes.slice(1).map(function (n) { return n; });
      const rows = [];
      all.forEach(function (f, i) { if (extra.some(function (n) { return n.id === str_(f[h.fixed['행ID']]); }) && str_(f[h.fixed['구분']]) === SCH.KIND_NOTE) rows.push(i + 2); });
      rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
      extra.forEach(function (n) { if (n.label) schNoteRelabel_(n.label, ''); });
      notes.splice(1); touched = true;
      }
      // 한 번만: 이후 '+ 비고 줄'로 새로 만든 줄은 지우지 않는다
      PropertiesService.getScriptProperties().setProperty('SCH_NOTE_TRIM', '1');
      _props = null;
    } finally { lock.releaseLock(); }
  }
  // 비고 줄은 업무스케줄(work_memo)과 연동: 시트에 남아 있는 예전 비고 글은 업무스케줄로 옮기고, 칸 내용은 메모에서 만든다
  if (notes.length && (!cache_().get('sch:nmig') || notes.some(function (n) { return Object.keys(n.cells).length; }))) {
    const lock = scriptLock_();
    lock.waitLock(30000);
    try { schMigrateNotes_(sh, schHeader_(true)); cache_().put('sch:nmig', '1', 600); touched = true; } finally { lock.releaseLock(); }
  }
  const nm = schNoteMemos_(notes, dates[0], dates[dates.length - 1]);
  notes.forEach(function (n) {
    n.cells = {};
    Object.keys(nm[n.id] || {}).forEach(function (d) { n.cells[d] = schNoteText_(nm[n.id][d]); });
  });
  const m = master_();
  const routes = {};
  m.routes.forEach(function (r) { if (r.status !== RST.OFF) (routes[r.campId] = routes[r.campId] || []).push(r.code); });
  // 캠프 이름은 노선관리(camps)에서, 이름·노선은 기사 정보에서 바로 가져온다
  const campName = {};
  m.camps.forEach(function (c) { campName[c.id] = c.name; });
  try { rcApplyDue_(); } catch (e) { console.error('노선 변경 예약 적용 실패: ' + (e && e.message)); }
  const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name; }).map(function (o) {
    const d = schDriver_(o);
    if (d.campId && !campName[d.campId]) { d.campId = ''; d.camp = ''; } // 노선관리에서 지워진 캠프
    else if (d.campId) d.camp = campName[d.campId];
    d.extra = extraAssignOf_(o).filter(function (x) { return campName[x.c]; });
    return d;
  });
  // 같은 근무자 연결: 명의 기사(workerId 가 있는 기사)는 줄을 만들지 않고, 근무자 줄에 '다른 명의 아이디'(alias)로 붙인다
  //  → 기사스케줄 표 · 미입차/중복 계산 · 어드민 업로드 표 모두 근무자 한 줄만 본다 (명의 기사 줄의 예전 칸은 시트에 그대로 남음)
  (function () {
    const byId = {}; drivers.forEach(function (d) { byId[d.id] = d; });
    for (let i = drivers.length - 1; i >= 0; i--) {
      const d = drivers[i], w = d.workerId && d.workerId !== d.id ? byId[d.workerId] : null;
      if (!w || w.workerId) continue; // 근무자가 없거나 근무자도 다른 사람에게 연결돼 있으면 연결로 보지 않음
      if (d.loginId) w.alias.push({ id: d.id, name: d.name, login: d.loginId });
      drivers.splice(i, 1);
    }
  })();
  // 추가 배정 → 그 캠프에 한 줄 더 (같은 기사 · 행ID EX기사ID@캠프ID)
  drivers.slice().forEach(function (d) {
    (d.extra || []).forEach(function (x) {
      drivers.push(Object.assign({}, d, { id: schExId_(d.id, x.c), mainId: d.id, campId: x.c, camp: campName[x.c], baseRoute: x.r, extra: [], ex: true }));
    });
    delete d.extra;
  });
  // 지금은 추가 배정이 아니지만 보는 기간에 칸이 남아 있는 줄(예전 추가 배정) → 그대로 보여 줌
  const haveId = {}; drivers.forEach(function (d) { haveId[d.id] = 1; });
  Object.keys(cells).forEach(function (id) {
    const ex = schExParse_(id); if (!ex || haveId[id] || !campName[ex.campId] || !Object.keys(cells[id]).length) return;
    const d = drivers.filter(function (x) { return x.id === ex.driverId; })[0]; if (!d) return;
    drivers.push(Object.assign({}, d, { id: id, mainId: d.id, campId: ex.campId, camp: campName[ex.campId], baseRoute: '', extra: [], ex: true, old: true }));
  });
  // 노선 변경 예약: 보는 기간 안에서 캠프·노선이 바뀌는 기사는 구간(segs)을 붙인다 → 적용일부터 새 캠프 쪽에 보인다
  let rcBy = {};
  try { rcBy = rcByDriver_(); } catch (e) { rcBy = {}; }
  const rcMoves = [];
  drivers.forEach(function (d) {
    const list = rcBy[d.id];
    if (!list) return;
    const segs = rcSegs_({ campId: d.campId, camp: d.camp, baseRoute: d.baseRoute }, list, dates);
    if (segs) { segs.forEach(function (x) { x.camp = campName[x.campId] || x.camp; }); d.segs = segs; }
    const show = list.filter(function (c) { return c.status === RCS.WAIT || (c.date >= dates[0] && c.date <= dates[dates.length - 1]); });
    if (show.length) d.changes = show.map(function (c) { return rcView_(c, campName); });
  });
  try { rcRows_().forEach(function (c) { if (c.kind === RCK.MOVE && c.status === RCS.WAIT) rcMoves.push(rcView_(c, campName)); }); } catch (e) { /* 무시 */ }
  // 노선 이관 기록 (예약 · 적용 모두): 이관 전후로 이름만 바뀐 같은 노선 → 미입차 계산이 '옛 이름 = 새 이름'으로 본다
  const routeMoves = [];
  try { rcRows_().forEach(function (c) { if (c.kind === RCK.MOVE) routeMoves.push({ date: c.date, fromCamp: campName[c.fromCampId] || c.fromCamp || '', from: str_(c.fromRoute), toCamp: campName[c.toCampId] || c.toCamp || '', to: str_(c.toRoute) }); }); } catch (e) { /* 무시 */ }
  if (last >= 2) schSyncCopies_(sh, h, drivers, touched ? null : fixed);
  const holidays = {};
  dates.forEach(function (d) { if (HOLIDAYS[d]) holidays[d] = HOLIDAYS[d]; });
  let issues = [];
  try { issues = schIssues_(dates[0], dates[dates.length - 1]).map(issView_); } catch (e) { issues = []; }
  // 품앗이 줄 (대신 뛰는 기사) + 내 일을 품앗이로 맡겨 배차 확정된 칸 표시
  const byDrv = {};
  drivers.forEach(function (d) { byDrv[d.id] = d; });
  // 배차 확정 품앗이 칸 = 잠금 (취소·변경은 품앗이에서만) · 칸 글자가 빠져 있으면 다시 채움 (실수로 지웠거나 시트에서 직접 고친 경우)
  let pmLocks = {};
  try {
    pmLocks = pmSchLocks_(dates);
    const fix = [];
    Object.keys(pmLocks).forEach(function (id) {
      if (!byDrv[id.slice(SCH_PM_PREFIX.length)]) return;
      Object.keys(pmLocks[id]).forEach(function (dt) {
        pmLocks[id][dt].forEach(function (L) {
          const cur = str_((cells[id] || {})[dt]);
          if (cur.split(/\r?\n/).some(function (x) { return x.trim().indexOf(L.text) === 0; })) return; // 확정 글자로 시작하는 줄이 있으면 그대로 둠 (예: 뒤에 회전을 덧붙인 '시흥2 708C (D1)')
          fix.push({ op: 'set', driverId: id.slice(SCH_PM_PREFIX.length), date: dt, value: L.text });
          (cells[id] = cells[id] || {})[dt] = cur ? cur + '\n' + L.text : L.text;
        });
      });
    });
    if (fix.length) pmSchApply_(fix, true); // 읽는 길이므로 잠금을 기다리지 않는다: 다른 저장이 진행 중이면 이번엔 화면 값만 맞추고 시트는 다음 조회 때
  } catch (e) { console.error('품앗이 칸 잠금·복구 실패: ' + (e && e.message)); }
  const pmRows = Object.keys(cells).filter(function (id) { return id.indexOf(SCH_PM_PREFIX) === 0 && byDrv[id.slice(SCH_PM_PREFIX.length)]; }).map(function (id) {
    const d = byDrv[id.slice(SCH_PM_PREFIX.length)];
    return { id: id, driverId: d.id, name: d.name, loginId: d.loginId || '', campId: d.campId || '' };
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
  let pmMarks = {}, pmTips = {};
  try { pmMarks = pmAdminMarks_(cells, dates, byDrv, pmTips); } catch (e) { pmMarks = {}; pmTips = {}; }
  const VP = typeof schVendorPack_ === 'function' ? schVendorPack_() : { vendors: [], routes: [] };
  return {
    ok: true, start: ymd_(sun), today: todayText_(), dates: dates, holidays: holidays, maxDays: schMaxDays_(),
    camps: m.camps.map(function (c) { return { id: c.id, name: c.name, rot: c.rot }; }),
    routes: routes, drivers: drivers, cells: cells, notes: notes, pmRows: pmRows, pmMarks: pmMarks, pmTips: pmTips, rcMoves: rcMoves,
    issues: issues, issueKinds: SCH_ISSUE.KINDS, pmLocks: pmLocks,
    vendorRoutes: VP.routes, vendors: VP.vendors, routeMoves: routeMoves,
    routeMiss: (function () { try { return typeof schRmRead_ === 'function' ? schRmRead_().filter(function (x) { return x.date >= dates[0] && x.date <= dates[dates.length - 1]; }).map(function (x) { return { date: x.date, camp: x.camp, unit: x.unit, result: x.result, reason: x.reason, memo: x.memo, by: x.by }; }) : []; } catch (e) { return []; } })(),
    vendorDays: (function () { try { return typeof schUnvRead_ === 'function' ? schUnvRead_().filter(function (x) { return x.date >= dates[0] && x.date <= dates[dates.length - 1]; }).map(function (x) { return { date: x.date, campId: x.campId, code: x.code, name: x.vendor }; }) : []; } catch (e) { return []; } })()
  };
}

/**
 * 칸 여러 개 저장. changes = [{ row: 행ID, date: 'yyyy-MM-dd', value: 새 값, old: 화면에 있던 값 }]
 * 다른 곳에서 먼저 바뀐 칸(old 와 지금 값이 다르고 새 값과도 다름)은 쓰지 않고 conflicts 로 돌려준다.
 */
function adm_schSave(token, changes) {
  return run_(function () {
    stg_();
    const a = requireAdmin_(token); stg_('auth'); fsMark_('sch', { by: a.loginId }); stg_('mark');
    changes = (changes || []).filter(function (x) { return x && x.row && parseYmd_(x.date); });
    if (!changes.length) return { ok: true, saved: 0, conflicts: [] };
    if (changes.length > 3000) fail_('한 번에 3000칸까지 저장할 수 있습니다.');
    // 배차 확정 품앗이 칸은 스케줄에서 못 바꾼다 (화면이 늦게 갱신된 상태에서 저장해도 서버가 막음 · 확정 글자를 그대로 둔 채 덧붙이는 것만 허용)
    const pmLocked = [];
    try {
      const pmCh = changes.filter(function (x) { return x.row.indexOf(SCH_PM_PREFIX) === 0; });
      if (pmCh.length) {
        const dset = {}; pmCh.forEach(function (x) { dset[x.date] = 1; });
        const L = pmSchLocks_(Object.keys(dset));
        changes = changes.filter(function (x) {
          const l = x.row.indexOf(SCH_PM_PREFIX) === 0 ? (L[x.row] || {})[x.date] : null;
          if (!l) return true;
          const lines = String(x.value == null ? '' : x.value).split(/\r?\n/).map(function (v) { return v.trim(); });
          if (l.every(function (o) { return lines.some(function (v) { return v.indexOf(o.text) === 0; }); })) return true;
          pmLocked.push({ row: x.row, date: x.date, current: l.map(function (o) { return o.text; }).join('\n') });
          return false;
        });
      }
    } catch (e) { /* 품앗이 자료를 못 읽으면 그대로 저장 */ }
    // 품앗이로 맡긴 날(배차 확정)에 맡긴 기사 본인 칸을 '출근'으로 바꾸는 것도 막는다 — 품앗이가 그대로 남아 두 사람이 같은 노선으로 잡히고 정산 연동도 남는다.
    //  (화면에서는 '품앗이 취소하고 출근으로'를 먼저 거치므로, 여기 걸리는 것은 품앗이를 취소하지 않고 저장한 경우뿐)
    try {
      const cand = changes.filter(function (x) { return x.row.indexOf(SCH_PM_PREFIX) !== 0 && !/^NOTE\d+$/.test(x.row) && schWorkDay_(x.value, []) && !schWorkDay_(x.old, []); });
      if (cand.length) {
        const given = {};
        pmData_().jobs.forEach(function (j) { if (j.status === PST.DONE && j.posterId && j.acceptedId) given[j.posterId + '|' + j.date] = 1; });
        changes = changes.filter(function (x) {
          if (cand.indexOf(x) < 0 || !given[x.row + '|' + x.date]) return true;
          pmLocked.push({ row: x.row, date: x.date, current: String(x.old == null ? '' : x.old), given: true });
          return false;
        });
      }
    } catch (e) { /* 품앗이 자료를 못 읽으면 그대로 저장 */ }
    if (!changes.length) return { ok: true, saved: 0, conflicts: [], pmLocked: pmLocked };
    changes.forEach(function (x) {
      x.value = String(x.value == null ? '' : x.value).replace(/\r\n?/g, '\n').trim();
      x.old = String(x.old == null ? '' : x.old).replace(/\r\n?/g, '\n').trim();
      if (x.value.length > SCH_MAX_TEXT) fail_('한 칸에 ' + SCH_MAX_TEXT + '자까지 입력할 수 있습니다.');
    });
    // 칸에 '노선변경'이 들어가면 노선 변경 예약으로 바꾸고, 칸은 '출근'으로 저장한다
    const rcExtra = { replaced: [], routeChanges: [], routeWarn: [] };
    const rcCh = changes.filter(function (x) { return x.value && !/^NOTE\d+$/.test(x.row) && x.row.indexOf(SCH_PM_PREFIX) !== 0 && !schExParse_(x.row) && /노선\s*변경/.test(x.value); });
    if (rcCh.length) {
      const lk = scriptLock_();
      lk.waitLock(20000);
      try {
        rcCh.forEach(function (x) {
          const o = driverById_(x.row);
          if (!o) return;
          const at = rcAt_({ campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute }, rcByDriver_()[o.id], x.date);
          const pr = rcParseCell_(x.value, at.campId);
          const day = x.date.slice(5).replace('-', '/');
          if (!pr || pr.err) { rcExtra.routeWarn.push(o.name + ' ' + day + ': ' + (pr ? pr.err : '알아볼 수 없음') + ' — 칸 글자는 그대로 저장했습니다.'); return; }
          const r = rcAddDriver_(a, o, x.date, pr.campId, pr.route, '기사스케줄 칸: ' + x.value.slice(0, 60), '');
          const c = r.change;
          rcExtra.routeChanges.push({ name: o.name, date: c.date, dup: r.dup, applied: c.status === RCS.DONE, text: (rcCampNames_()[c.toCampId] || c.toCamp) + ' ' + c.toRoute,
            warnings: rcWarnings_(o, c.date, c.toCampId, c.toRoute, c.fromCampId, c.fromRoute, !!c.parentId) });
          x.value = '출근';
          rcExtra.replaced.push({ row: x.row, date: x.date, value: '출근' });
          if (!r.dup) logAdmin_(a, '노선 변경 예약', o.name + ' (' + o.id + ')', c.date + ' → ' + c.toCamp + ' ' + c.toRoute + ' (기사스케줄 칸)');
        });
      } finally { lk.releaseLock(); }
    }
    const dmin = changes.reduce(function (m, x) { return x.date < m ? x.date : m; }, changes[0].date);
    const dmax = changes.reduce(function (m, x) { return x.date > m ? x.date : m; }, changes[0].date);
    stg_('pre');
    let h = schEnsureDates_(parseYmd_(dmin), parseYmd_(dmax));
    stg_('dates');
    const lock = scriptLock_();
    lock.waitLock(20000);
    stg_('lock');
    try {
      const sh = schSheet_();
      // 비고 줄은 업무스케줄 메모로 저장
      const noteCh = changes.filter(function (x) { return /^NOTE\d+$/.test(x.row); });
      let noteRes = { saved: 0, conflicts: [] };
      if (noteCh.length) {
        noteRes = schNoteSave_(a, noteCh);
        changes = changes.filter(function (x) { return !/^NOTE\d+$/.test(x.row); });
        if (!changes.length) {
          if (noteRes.saved) logAdmin_(a, '기사스케줄 비고 수정', noteRes.saved + '칸', '업무스케줄에 저장');
          return Object.assign({ ok: true, saved: noteRes.saved, conflicts: noteRes.conflicts, pmLocked: pmLocked }, rcExtra);
        }
      }
      // 행 찾기 (없는 기사는 새 줄)
      const last = sh.getLastRow();
      const ids = last >= 2 ? sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); }) : [];
      const rowOf = {};
      ids.forEach(function (id, i) { if (id && !rowOf[id]) rowOf[id] = i + 2; });
      const need = {};
      changes.forEach(function (x) { if (!rowOf[x.row]) need[x.row] = 1; });
      const newIds = Object.keys(need);
      if (newIds.length) {
        const drv = {};
        readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) drv[o.id] = o; });
        let r = last + 1;
        const rows = [];
        const cn = {}; master_().camps.forEach(function (c) { cn[c.id] = c.name; });
        newIds.forEach(function (id) {
          const pm = id.indexOf(SCH_PM_PREFIX) === 0 && drv[id.slice(SCH_PM_PREFIX.length)];
          const ex = schExParse_(id), exO = ex && drv[ex.driverId], exA = exO && extraAssignOf_(exO).filter(function (x) { return x.c === ex.campId; })[0];
          if (ex && !exA) return; // 추가 배정이 없어진 캠프 줄은 만들지 않음
          const o = pm || exO || drv[id];
          if (!o) return; // 없는 기사·비고는 무시
          const line = new Array(5).fill('');
          line[h.fixed['행ID']] = id; line[h.fixed['구분']] = pm ? SCH.KIND_PM : SCH.KIND_DRIVER;
          line[h.fixed['캠프']] = pm ? SCH.KIND_PM : exA ? (cn[exA.c] || '') : o.schCamp; line[h.fixed['이름']] = o.name; line[h.fixed['기본노선']] = pm ? '' : exA ? exA.r : o.baseRoute;
          rows.push(line.map(safeText_)); rowOf[id] = r++;
        });
        if (rows.length) {
          if (last + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 200);
          sh.getRange(last + 1, 1, rows.length, 5).setNumberFormat('@').setValues(rows);
        }
      }
      // 지금 값 읽어서 충돌 확인 (바뀌는 칸을 감싸는 범위를 한 번에)
      const ok = changes.filter(function (x) { return rowOf[x.row]; });
      const conflicts = [];
      if (!ok.length) return Object.assign({ ok: true, saved: noteRes.saved, conflicts: noteRes.conflicts, pmLocked: pmLocked }, rcExtra);
      const r0 = Math.min.apply(null, ok.map(function (x) { return rowOf[x.row]; }));
      const r1 = Math.max.apply(null, ok.map(function (x) { return rowOf[x.row]; }));
      const cs = ok.map(function (x) { return h.dates[x.date] + 1; });
      const c0 = Math.min.apply(null, cs), c1 = Math.max.apply(null, cs);
      const area = (r1 - r0 + 1) * (c1 - c0 + 1);
      const cur = area <= 60000 ? sh.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1).getValues() : null;
      stg_('read');
      let saved = 0;
      const savedList = [];
      ok.forEach(function (x) {
        const r = rowOf[x.row], c = h.dates[x.date] + 1;
        const now = str_(cur ? cur[r - r0][c - c0] : sh.getRange(r, c).getValue()).replace(/\r\n?/g, '\n');
        if (now === x.value) return;
        if (now !== x.old) { conflicts.push({ row: x.row, date: x.date, current: now }); return; }
        saved++; savedList.push({ row: x.row, date: x.date, value: x.value, old: now, _r: r, _c: c });
      });
      // 쓰기: 같은 줄에서 옆으로 이어진 칸은 한 번에 (한 주를 끌어 채우면 7번 → 1번). 같은 칸이 두 번 오면 나중 값
      const cellOf = {};
      savedList.forEach(function (x) { cellOf[x._r + ':' + x._c] = x; });
      const cells = Object.keys(cellOf).map(function (k) { return cellOf[k]; }).sort(function (p, q) { return p._r - q._r || p._c - q._c; });
      for (let i = 0; i < cells.length;) {
        let j = i + 1;
        while (j < cells.length && cells[j]._r === cells[i]._r && cells[j]._c === cells[j - 1]._c + 1) j++;
        sh.getRange(cells[i]._r, cells[i]._c, 1, j - i).setNumberFormat('@').setValues([cells.slice(i, j).map(function (x) { return safeText_(x.value); })]);
        i = j;
      }
      savedList.forEach(function (x) { delete x._r; delete x._c; });
      stg_('write');
      if (saved) { logSchChange_(a, ok, saved); try { stlBump_(); } catch (e) { /* 정산 캐시 */ } } // 정산서 근무일수는 기사스케줄에서 세므로 정산 캐시도 새로
      stg_('log');
      // 칸 → 이슈 (2026-11-01 이후 · 미입차·노쇼·회전 줄임이면 '사유 미정' 이슈를 만들고, 정상으로 고치면 이슈에서 뺌)
      let issueSync = null;
      if (savedList.length) {
        try {
          const r = issFromCells_(a, savedList);
          if (r.created.length || r.changed.length || r.removed.length) issueSync = { created: r.created.map(issView_), changed: r.changed.map(issView_), removed: r.removed, cells: r.cells || [] };
        } catch (e) { issueSync = { error: String(e && e.message || e) }; }
      }
      stg_('iss');
      // 용차 칸 → 정산 [품앗이/용차 지정] (업체가 적힌 용차 칸만 · 실패해도 칸 저장은 그대로)
      let yong = null;
      try { if (typeof schYongSync_ === 'function') yong = schYongSync_(savedList); } catch (e) { yong = { added: 0, removed: 0, warn: ['용차 청구 기록 연동 실패: ' + String(e && e.message || e)] }; try { errLog_('서버 오류', 'schYongSync_', String(e && e.message || e)); } catch (e2) { /* 무시 */ } }
      return Object.assign({ ok: true, saved: saved + noteRes.saved, conflicts: conflicts.concat(noteRes.conflicts), issueSync: issueSync, pmLocked: pmLocked, yong: yong }, rcExtra);
    } finally {
      lock.releaseLock();
    }
  });
}
// ───── 기사스케줄 비고 줄 ↔ 업무스케줄(work_memo) 연동 ─────
const SCH_NOTE_AUTHOR = '기사스케줄 비고';
/*
 * 비고 줄의 글은 업무스케줄 메모로 저장한다 (한 곳에만 저장 → 양쪽 화면에 똑같이 보임).
 * 메모의 '비고 줄' 칸 = 비고 줄 이름. 비어 있으면 첫 번째 비고 줄(보통 '업무 관련')에 보인다.
 * 한 칸에 메모가 여러 개면 시간순으로 줄바꿈해 보여 준다. 시간이 있으면 '09:30 내용' 모양.
 */
/** 비고 줄 목록 [{id, label, row}] (시트 순서) */
function schNotes_() {
  const sh = schSheet_(), h = schHeader_(), last = sh.getLastRow();
  if (last < 2) return [];
  const out = [];
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (f, i) {
    const id = str_(f[h.fixed['행ID']]);
    if (/^NOTE\d+$/.test(id) && str_(f[h.fixed['구분']]) === SCH.KIND_NOTE) out.push({ id: id, label: str_(f[h.fixed['이름']]) || id, row: i + 2 });
  });
  return out;
}
/** 메모 → 비고 줄 id (이름이 같은 줄, 없으면 첫 줄) */
function schNoteOf_(notes, cat) {
  if (!notes.length) return '';
  const c = str_(cat);
  for (let i = 0; i < notes.length; i++) if (c && notes[i].label === c) return notes[i].id;
  return notes[0].id;
}
/** { 비고줄id: { 날짜: [메모…] } } (from~to) */
function schNoteMemos_(notes, from, to) {
  const out = {};
  if (!notes.length) return out;
  readAll_(SH.MEMO).forEach(function (o) {
    o.date = normDate_(o.date) || o.date;
    if (!o.id || !o.date || o.date < from || o.date > to) return;
    const nid = schNoteOf_(notes, o.cat);
    ((out[nid] = out[nid] || {})[o.date] = out[nid][o.date] || []).push(memoView_(o));
  });
  Object.keys(out).forEach(function (k) { Object.keys(out[k]).forEach(function (d) { out[k][d].sort(memoSort_); }); });
  return out;
}
function schNoteText_(list) {
  return list.map(function (m) { return (m.time ? m.time + ' ' : '') + m.content + (m.done ? ' ✓' : ''); }).join('\n');
}
/** 시트의 비고 줄 칸에 남은 글 → 업무스케줄 메모로 옮기고 칸은 비운다. 잠금은 부르는 쪽에서 */
function schMigrateNotes_(sh, h) {
  const last = sh.getLastRow(), w = sh.getLastColumn();
  if (last < 2) return 0;
  const fixed = sh.getRange(2, 1, last - 1, 5).getValues();
  const head = sh.getRange(1, 1, 1, w).getValues()[0].map(function (v) { return v instanceof Date ? ymd_(v) : str_(v); });
  const now = nowText_(), add = [];
  fixed.forEach(function (f, i) {
    const id = str_(f[h.fixed['행ID']]);
    if (!/^NOTE\d+$/.test(id)) return;
    const label = str_(f[h.fixed['이름']]) || id;
    const rng = sh.getRange(i + 2, 6, 1, w - 5), vals = rng.getValues()[0];
    let any = false;
    vals.forEach(function (v, j) {
      const t = str_(v).replace(/\r\n?/g, '\n'), d = head[5 + j];
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      add.push({ id: newMemoId_(), date: d, time: '', content: t.slice(0, 2000), done: '', cat: label, author: SCH_NOTE_AUTHOR, createdAt: now, updatedAt: now });
      any = true;
    });
    if (any) rng.clearContent();
  });
  if (add.length) appendObjs_(SH.MEMO, add);
  return add.length;
}
/** 비고 칸 저장 (기사스케줄 화면) → 메모 추가·수정·삭제. 반환 { saved, conflicts } */
function schNoteSave_(a, changes) {
  const notes = schNotes_(), byId = {};
  notes.forEach(function (n) { byId[n.id] = n; });
  const all = readAll_(SH.MEMO);
  const now = nowText_(), conflicts = [], dels = [];
  let saved = 0;
  changes.forEach(function (x) {
    const n = byId[x.row];
    if (!n) return;
    const list = all.filter(function (o) { return (normDate_(o.date) || o.date) === x.date && schNoteOf_(notes, o.cat) === n.id && !o._gone; });
    list.sort(function (p, q) { return memoSort_(memoView_(p), memoView_(q)); });
    const cur = schNoteText_(list.map(memoView_));
    if (cur === x.value) return;
    if (cur !== x.old) { conflicts.push({ row: x.row, date: x.date, current: cur }); return; }
    if (!x.value) { list.forEach(function (o) { o._gone = 1; dels.push(o._row); }); saved++; return; }
    let time = '', content = x.value.replace(/ ✓$/, '');
    const done = / ✓$/.test(x.value) ? 'Y' : '';
    const m = content.match(/^(\d{1,2}:\d{2})\s+([\s\S]+)$/);
    if (m && content.indexOf('\n') < 0) { time = normTime_(m[1]) || ''; if (time) content = m[2]; }
    const cat = n === notes[0] ? (list[0] ? list[0].cat : '') : n.label;
    if (!list.length) {
      const o = { id: newMemoId_(), date: x.date, time: time, content: content.slice(0, 2000), done: done, cat: cat, author: a.name, createdAt: now, updatedAt: now };
      o._row = appendObj_(SH.MEMO, o); all.push(o);
    } else {
      // 메모가 여러 개였던 칸을 고치면 하나로 합친다 (첫 메모를 고치고 나머지는 지움)
      const f = { time: list.length > 1 ? '' : time, content: content.slice(0, 2000), done: done, updatedAt: now };
      writeFields_(SH.MEMO, list[0]._row, f);
      list.slice(1).forEach(function (o) { o._gone = 1; dels.push(o._row); });
    }
    saved++;
  });
  delRows_(sheet_(SH.MEMO), dels);
  return { saved: saved, conflicts: conflicts };
}
/** 비고 줄 이름이 바뀌면 메모의 '비고 줄' 칸도 바꾼다 / 지우면 첫 줄로 돌린다 */
function schNoteRelabel_(from, to) {
  const sh = sheet_(SH.MEMO), c = cols_(SH.MEMO, true), last = sh.getLastRow();
  if (last < 2 || !from) return 0;
  const rng = sh.getRange(2, c.cat + 1, last - 1, 1), vals = rng.getValues();
  let n = 0;
  vals.forEach(function (r) { if (str_(r[0]) === from) { r[0] = to; n++; } });
  if (n) rng.setNumberFormat('@').setValues(vals);
  return n;
}
/** 스케줄 변경 기록: 관리자 작업 기록에 요약만 (칸이 많으면 개수만) */
function logSchChange_(a, list, saved) {
  try {
    const dates = list.map(function (x) { return x.date; }).sort();
    logAdmin_(a, '스케줄 수정', saved + '칸', dates[0] + (dates.length > 1 ? ' ~ ' + dates[dates.length - 1] : ''));
  } catch (e) { /* 기록 실패는 무시 */ }
}

/** 비고 줄: action = add / rename / delete */
function adm_schNote(token, action, id, label) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    const h = schHeader_();
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const sh = schSheet_(), last = sh.getLastRow();
      const fixed = last >= 2 ? sh.getRange(2, 1, last - 1, 5).getValues() : [];
      const find = function (nid) {
        for (let i = 0; i < fixed.length; i++) if (str_(fixed[i][h.fixed['행ID']]) === nid) return i + 2;
        return 0;
      };
      label = str_(label).slice(0, 30);
      if (action === 'add') {
        let n = 1;
        while (find('NOTE' + n)) n++;
        const line = new Array(5).fill('');
        line[h.fixed['행ID']] = 'NOTE' + n; line[h.fixed['구분']] = SCH.KIND_NOTE; line[h.fixed['이름']] = label || '비고 ' + n;
        sh.getRange(last + 1, 1, 1, 5).setNumberFormat('@').setValues([line.map(safeText_)]);
        return { ok: true, id: 'NOTE' + n, label: line[h.fixed['이름']] };
      }
      const row = find(String(id || ''));
      if (!row) fail_('비고 줄을 찾을 수 없습니다. 새로고침해 주세요.');
      if (action === 'rename') {
        if (!label) fail_('이름을 입력해 주세요.');
        const old = str_(fixed[row - 2][h.fixed['이름']]);
        sh.getRange(row, h.fixed['이름'] + 1).setNumberFormat('@').setValue(safeText_(label));
        if (old && old !== label) schNoteRelabel_(old, label); // 업무스케줄 메모도 새 이름으로
        return { ok: true, id: id, label: label };
      }
      if (action === 'delete') {
        const old = str_(fixed[row - 2][h.fixed['이름']]);
        sh.deleteRow(row);
        if (old) schNoteRelabel_(old, ''); // 그 줄의 메모는 지우지 않고 첫 비고 줄로
        return { ok: true };
      }
      fail_('알 수 없는 작업입니다.');
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * 기사스케줄 표 순서 저장 (▲▼ 로 옮긴 결과). list = [{ id: 기사ID, order: 숫자 }]
 * drivers 탭 '스케줄 순서' 열만 한 번 읽고 한 번에 다시 쓴다 (다른 칸은 그대로).
 */
function adm_schOrder(token, list) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    if (!Array.isArray(list) || !list.length) return { ok: true, saved: 0 };
    if (list.length > 1000) fail_('한 번에 너무 많습니다.');
    const want = {};
    list.forEach(function (x) {
      const id = str_(x && x.id), n = Number(x && x.order);
      if (!id || !(n >= 1 && n <= 99999) || Math.floor(n) !== n) fail_('순서 값이 올바르지 않습니다.');
      want[id] = String(n);
    });
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const c = cols_(SH.DRIVERS, true), sh = sheet_(SH.DRIVERS), last = sh.getLastRow();
      if (last < 2) fail_('기사를 찾을 수 없습니다.');
      const ids = sh.getRange(2, c.id + 1, last - 1, 1).getValues();
      const rng = sh.getRange(2, c.schOrder + 1, last - 1, 1);
      const cur = rng.getValues();
      let saved = 0;
      const gone = [];
      ids.forEach(function (r, i) {
        const id = str_(r[0]);
        if (want[id] !== undefined && str_(cur[i][0]) !== want[id]) { cur[i][0] = want[id]; saved++; gone.push('dv:' + id, 'ir:' + id); }
      });
      if (saved) {
        rng.setNumberFormat('@').setValues(cur);
        cache_().removeAll(gone);
        logAdmin_(a, '기사스케줄 순서 변경', saved + '명', '');
      }
      return { ok: true, saved: saved };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * 기사 앱: 내 스케줄
 * month 없음 → 이번 주 일요일부터 2주 / month = 'yyyy-MM' → 그 달 1일~말일 (앞뒤 12개월까지)
 */
function api_mySchedule(token, month) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    if (info.mustChange) return { ok: false, code: 'MUST_CHANGE', msg: '비밀번호를 먼저 바꿔 주세요.' };
    let dates, ym = '';
    const mm = str_(month).match(/^(\d{4})-(\d{2})$/);
    if (mm) {
      const first = new Date(+mm[1], +mm[2] - 1, 1), now = new Date();
      const diff = (first.getFullYear() - now.getFullYear()) * 12 + first.getMonth() - now.getMonth();
      if (Math.abs(diff) > 12) fail_('앞뒤 12개월까지 볼 수 있습니다.');
      dates = schDateRange_(first, new Date(+mm[1], +mm[2], 0));
      ym = mm[1] + '-' + mm[2];
    } else {
      const sun = sundayOf_(new Date());
      dates = schDateRange_(sun, addDays_(sun, SCH_DAYS - 1));
    }
    const out = { ok: true, today: todayText_(), month: ym, dates: dates, cells: {}, holidays: {} };
    dates.forEach(function (d) { if (HOLIDAYS[d]) out.holidays[d] = HOLIDAYS[d]; });
    // 같은 근무자 연결: 명의 계정으로 들어와도 근무자 줄(스케줄 한 줄)을 본다 · 그날 쓸 아이디(서브 · 다른 명의)를 앱이 알 수 있게 내려 준다
    let rowId = String(s.d);
    out.subIds = []; out.alias = [];
    try {
      const allD = readAll_(SH.DRIVERS), lk = schLinkMap_(allD);
      const meO = allD.filter(function (o) { return o.id === String(s.d); })[0], wk = lk.workerOf[String(s.d)] || meO;
      if (wk) {
        rowId = String(wk.id);
        out.baseRoute = str_(wk.baseRoute); out.loginId = str_(wk.loginId);
        out.subIds = schSubIdsOf_(wk); out.alias = lk.aliasOf[wk.id] || [];
        if (wk !== meO) out.workerName = wk.name;
      } else out.baseRoute = '';
    } catch (e) { try { const me0 = driverById_(String(s.d)); out.baseRoute = me0 ? str_(me0.baseRoute) : ''; } catch (e2) { out.baseRoute = ''; } }
    out.campRots = campRotMap_(); // '출근' 칸을 기본노선 코드로 보여 주기 위해
    // 노선 변경 예약 안내: '11/11부터 군포1캠프 212AB'
    try {
      rcApplyDue_();
      const cn = rcCampNames_(), t0 = todayText_();
      out.routeChanges = (rcByDriver_()[String(s.d)] || []).filter(function (c) { return c.status === RCS.WAIT || (c.date >= addDaysText_(t0, -7) && c.memo !== '바로 변경'); })
        .map(function (c) { return { date: c.date, camp: cn[c.toCampId] || c.toCamp, route: c.toRoute, fromCamp: cn[c.fromCampId] || c.fromCamp, fromRoute: c.fromRoute, done: c.status === RCS.DONE }; });
    } catch (e) { out.routeChanges = []; }
    // 품앗이: 내가 뛰는 일감(수행)·맡긴 일감(맡김)·지원 중인 일감
    try { out.pumasi = pmScheduleOf_(String(s.d), dates); } catch (e) { out.pumasi = {}; }
    const fsW = function (o) { return o; };
    if (!props_().SCH_DB_ID || !schSS_().getSheetByName(SCH.SHEET)) return fsW(out);
    const h = schHeader_();
    const row = (function () {
      const sh = schSheet_(), last = sh.getLastRow();
      if (last < 2) return 0;
      const cell = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).createTextFinder(rowId).matchEntireCell(true).matchCase(true).findNext();
      return cell ? cell.getRow() : 0;
    })();
    const cols = dates.map(function (d) { return h.dates[d]; }).filter(function (c) { return c !== undefined; });
    if (!cols.length) return fsW(out);
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    if (row) {
      const vals = schSheet_().getRange(row, c0 + 1, 1, c1 - c0 + 1).getValues()[0];
      dates.forEach(function (d) { const c = h.dates[d]; if (c !== undefined) { const v = str_(vals[c - c0]); if (v) out.cells[d] = v; } });
    }
    // 추가 배정 캠프 줄: 그 캠프 칸에 적힌 것을 '캠프 노선' 으로 붙여 보여 줌 (예: 출근 → 강서1 527B)
    try {
      const me = driverById_(rowId), ex = me ? extraAssignOf_(me) : [];
      if (ex.length) {
        const sh = schSheet_(), last = sh.getLastRow(), cn = {};
        master_().camps.forEach(function (c) { cn[c.id] = String(c.name).replace(/캠프$/, ''); });
        const ids = last >= 2 ? sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); }) : [];
        ex.forEach(function (x) {
          const i = ids.indexOf(schExId_(rowId, x.c)); if (i < 0) return;
          const vals = sh.getRange(i + 2, c0 + 1, 1, c1 - c0 + 1).getValues()[0];
          dates.forEach(function (d) {
            const c = h.dates[d]; if (c === undefined) return;
            const v = str_(vals[c - c0]); if (!v) return;
            const t = (cn[x.c] || '') + ' ' + (v === '출근' ? x.r : v);
            out.cells[d] = out.cells[d] && !/휴무|휴가|병가/.test(out.cells[d]) ? out.cells[d] + ', ' + t : (out.cells[d] && /휴무|휴가|병가/.test(out.cells[d]) && v === '출근' ? t : (out.cells[d] ? out.cells[d] + ', ' + t : t));
          });
        });
      }
    } catch (e) { console.error('추가 배정 줄 읽기 실패: ' + (e && e.message)); }
    // 내 캠프에 들어오는 백업 (기사스케줄 '백업 명단' 과 같은 규칙) · 직함자(소속 = 운영자 가짜 캠프)는 백업 줄 대신 다른 직원 스케줄
    if (info.title && isStaffCamp_(info.camp)) {
      out.camp = ''; out.backup = {};
      try { out.staff = schStaffOf_(String(s.d), dates, h, c0, c1); } catch (e) { out.staff = {}; }
    } else {
      try {
        const bk = schMyCampBackup_(rowId, dates, h, c0, c1);
        out.camp = bk.camp; out.backup = bk.list;
      } catch (e) { out.backup = {}; }
    }
    // 내가 올린 품앗이가 배차 확정되고, 그날 내 스케줄 칸의 캠프·라우트와 같으면 '배차확정 완료' 표시
    try { out.pmDone = pmDoneOf_(String(s.d), out.cells, info.camp || out.camp || ''); } catch (e) { out.pmDone = {}; }
    // 관리자가 기사스케줄 칸에 적은 지시사항 (스케줄 이슈 '지시')
    out.inst = {};
    try { schIssues_(dates[0], dates[dates.length - 1]).forEach(function (x) { if (x.kind === '지시' && x.driverId === rowId && x.reason) out.inst[x.date] = x.reason; }); } catch (e) { out.inst = {}; }
    return fsW(out);
  });
}

/** 기사 앱(직함자용): 나 말고 다른 관리자·운영자·대표의 날짜별 칸 { 'yyyy-MM-dd': [{ name, title, v }] } (칸이 비면 '미정') */
function schStaffOf_(myId, dates, h, c0, c1) {
  const out = {};
  const others = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.id !== myId && o.status === ST.ACTIVE && titleOf_(o) && str_(o.workStatus) !== '퇴사'; });
  if (!others.length) return out;
  const order = { '대표': 0, '관리자': 1, '운영자': 2 };
  others.sort(function (a, b) { return (order[titleOf_(a)] || 9) - (order[titleOf_(b)] || 9) || String(a.name).localeCompare(String(b.name), 'ko'); });
  const sh = schSheet_(), last = sh.getLastRow();
  const ids = last >= 2 ? sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); }) : [];
  others.forEach(function (o) {
    const i = ids.indexOf(String(o.id));
    const vals = i >= 0 ? sh.getRange(i + 2, c0 + 1, 1, c1 - c0 + 1).getValues()[0] : null;
    dates.forEach(function (d) {
      const c = h.dates[d], v = vals && c !== undefined ? str_(vals[c - c0]) : '';
      (out[d] = out[d] || []).push({ name: o.name, title: titleOf_(o), v: v });
    });
  });
  return out;
}

/**
 * 기사 앱 '캠프전체': 내 소속 캠프 기사들의 2주 스케줄 + 내 캠프에 들어오는 백업 명단.
 * 기사 순서는 기사스케줄(관리자) 줄 순서. 연락처 등 개인정보는 보내지 않는다.
 */
function api_campSchedule(token, month, campId) {
  return run_(function () {
    const s = getSession_(token);
    const info = s ? driverInfo_(s.d) : null;
    if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) return { ok: false, code: 'EXPIRED', msg: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
    if (info.mustChange) return { ok: false, code: 'MUST_CHANGE', msg: '비밀번호를 먼저 바꿔 주세요.' };
    // 직함자(관리자·운영자·대표)는 캠프를 골라 다른 캠프도 볼 수 있다 (보기만). 일반 기사는 소속 캠프만
    const staff = !!info.title, pickCamp = staff ? str_(campId) : '';
    if (campId && !staff) fail_('소속 캠프만 볼 수 있습니다.');
    // month = 'yyyy-MM' 이면 그 달 전체, 없으면 2주
    let dates, ym = '';
    const mm = str_(month).match(/^(\d{4})-(\d{2})$/);
    if (mm) {
      const first = new Date(+mm[1], +mm[2] - 1, 1), now = new Date();
      const diff = (first.getFullYear() - now.getFullYear()) * 12 + first.getMonth() - now.getMonth();
      if (Math.abs(diff) > 12) fail_('앞뒤 12개월까지 볼 수 있습니다.');
      dates = schDateRange_(first, new Date(+mm[1], +mm[2], 0));
      ym = mm[1] + '-' + mm[2];
    } else {
      const sun = sundayOf_(new Date());
      dates = schDateRange_(sun, addDays_(sun, SCH_DAYS - 1));
    }
    const out = { ok: true, today: todayText_(), month: ym, dates: dates, holidays: {}, camp: '', drivers: [], backup: {} , campRots: campRotMap_() };
    dates.forEach(function (d) { if (HOLIDAYS[d]) out.holidays[d] = HOLIDAYS[d]; });
    try { rcApplyDue_(); } catch (e) { console.error('노선 변경 예약 적용 실패: ' + (e && e.message)); }
    const all0 = readAll_(SH.DRIVERS).filter(function (o) { return o.id; }), lk = schLinkMap_(all0);
    // 같은 근무자 연결: 명의 기사는 목록에서 빼고 (스케줄은 근무자 한 줄), 명의 계정으로 들어오면 근무자로 본다
    const all = all0.filter(function (o) { return !lk.workerOf[o.id]; });
    const me = lk.workerOf[String(s.d)] || all.filter(function (o) { return o.id === String(s.d); })[0];
    // 노선 변경 예약: 날짜마다 그날 그 캠프에 있는 기사만 (적용일부터 새 캠프 쪽에 보인다)
    let rcBy = {};
    try { rcBy = rcByDriver_(); } catch (e) { rcBy = {}; }
    const today = todayText_(), ref = dates.indexOf(today) >= 0 ? today : (today < dates[0] ? dates[0] : dates[dates.length - 1]);
    const at = function (o, d) { return rcAt_({ campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute }, rcBy[o.id], d, today); };
    const realCamps = master_().camps.filter(function (c) { return c.id && !isStaffCamp_(c.name); });
    if (staff) out.camps = realCamps.map(function (c) { return { id: c.id, name: String(c.name).replace(/\s*캠프\s*$/, '').trim() }; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    const myCampId = pickCamp || (me ? at(me, ref).campId : '');
    if (staff && !pickCamp && (!myCampId || isStaffCamp_(info.camp))) { out.noCamp = true; out.pick = true; return out; }
    if (!me) { out.noCamp = true; return out; }
    // 소속 캠프가 없는 기사(백업 계정 등): 날짜마다 '그날 가는 캠프'(내 칸의 캠프 · 받은 품앗이 캠프) 기준으로 보여 준다
    const noHome = !myCampId;
    if (noHome) out.noHome = true;
    out.campId = myCampId;
    const campNameOf = function (cid) { const c = master_().camps.filter(function (x) { return x.id === cid; })[0]; return c ? String(c.name).replace(/\s*캠프\s*$/, '').trim() : ''; };
    out.camp = noHome ? '' : campNameOf(myCampId) || (me.schCamp || '');
    // 스케줄 시트는 한 번만 읽는다 (캠프가 여러 개여도)
    let h = null, sh = null, ids = [], block = [], c0 = 0, c1 = 0, hasSheet = false;
    if (props_().SCH_DB_ID && schSS_().getSheetByName(SCH.SHEET)) {
      h = schHeader_(); sh = schSheet_();
      const last = sh.getLastRow(), cols = dates.map(function (d) { return h.dates[d]; }).filter(function (c) { return c !== undefined; });
      if (last >= 2 && cols.length) {
        c0 = Math.min.apply(null, cols); c1 = Math.max.apply(null, cols);
        ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
        block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
        hasSheet = true;
      }
    }
    let issues = [];
    try { issues = schIssues_(dates[0], dates[dates.length - 1]); } catch (e) { issues = []; }
    // 캠프 짧은 이름 → ID (칸 글자 '강서1 527B' 에서 캠프 찾기 · 긴 이름부터)
    const shortOf = {}; realCamps.forEach(function (c) { shortOf[String(c.name).replace(/\s*캠프\s*$/, '').replace(/\s+/g, '')] = c.id; });
    const shorts = Object.keys(shortOf).sort(function (a, b) { return b.length - a.length; });
    const campInCell = function (v) { const t = str_(v).replace(/\s+/g, ''); if (!t || /휴무|휴가|병가|미입차/.test(t)) return ''; for (var i = 0; i < shorts.length; i++) if (t.indexOf(shorts[i]) >= 0) return shortOf[shorts[i]]; return ''; };
    // 배차 확정 품앗이 (이 기간) → 캠프별 날짜 목록 · 내 달력 칸
    let pmJobs = [];
    try { const dset = {}; dates.forEach(function (d) { dset[d] = 1; }); pmJobs = pmData_().jobs.filter(function (j) { return j.status === PST.DONE && j.acceptedId && dset[j.date]; }); } catch (e) { pmJobs = []; }
    const rowOf = {}; ids.forEach(function (id, i) { if (rowOf[id] === undefined) rowOf[id] = i; });
    const cellAt = function (id, d) { const i = rowOf[id], c = h ? h.dates[d] : undefined; return i === undefined || c === undefined ? '' : str_(block[i][c - c0]); };
    /**
     * 한 캠프의 기사 목록(날짜별 칸·지시) + 백업 명단.
     *  - 소속 기사라도 그날 칸에 다른 캠프가 적혀 있으면 away[d] = 그 캠프 (앱에서 그날 목록에서 뺌)
     *  - 다른 캠프 소속이라도 그날 칸에 이 캠프가 적혀 있으면 guest 로 그날만 들어온다 (백업이 입차하는 캠프에 보이게)
     */
    const buildCamp = function (cid, forceMe) {
      const inCamp = {};
      all.forEach(function (o) {
        if (o.status !== ST.ACTIVE) return;
        const days = {};
        let any = false, route = '';
        dates.forEach(function (d) { const v = rcBy[o.id] ? at(o, d) : { campId: o.schCampId, baseRoute: o.baseRoute }; if (v.campId === cid) { days[d] = 1; any = true; if (!route || d === ref) route = v.baseRoute; } });
        if (any) { inCamp[o.id] = { days: days, route: route }; return; }
        if (!hasSheet) return;
        // 손님: 그달 칸에 이 캠프 이름이 적힌 날만
        const gd = {}; let g = false;
        dates.forEach(function (d) { if (campInCell(cellAt(o.id, d)) === cid) { gd[d] = 1; g = true; } });
        if (g) inCamp[o.id] = { days: gd, route: o.baseRoute || '', guest: true, home: campNameOf(o.schCampId) || str_(o.schCamp).replace(/\s*캠프\s*$/, '') };
      });
      if (forceMe && !inCamp[me.id]) { const all1 = {}; dates.forEach(function (d) { all1[d] = 1; }); inCamp[me.id] = { days: all1, route: me.baseRoute || '', guest: true, home: out.camp }; }
      const byId = {};
      all.filter(function (o) { return inCamp[o.id]; }).forEach(function (o) {
        byId[o.id] = { id: o.id, name: o.name, route: inCamp[o.id].route || '', type: o.driverType || '', loginId: str_(o.loginId), subIds: [o.subId1, o.subId2].map(str_).filter(Boolean), alias: lk.aliasOf[o.id] || [], phone: o.phone ? fmtPhone_(o.phone) : '', me: o.id === me.id, guest: !!inCamp[o.id].guest, homeCamp: inCamp[o.id].home || '', cells: {}, away: {}, order: 1e9 };
        // 노선 변경·이관으로 이 캠프에 없는 날 (예: 11/11부터 군포1로 간 기사는 그날부터 안양1 목록에서 빠짐)
        if (!inCamp[o.id].guest) { const off = {}; let n = 0; dates.forEach(function (d) { if (!inCamp[o.id].days[d]) { off[d] = 1; n++; } }); if (n) byId[o.id].off = off; }
      });
      // 이 캠프의 배차 확정 품앗이: { 날짜: [{ id, route, from, fromId, to, toId }] }
      const pm = {};
      pmJobs.forEach(function (j) {
        if (j.campId !== cid) return;
        (pm[j.date] = pm[j.date] || []).push({ id: j.id, route: j.route || '', area: j.area || '', from: j.poster || '', fromId: j.posterId || '', to: j.accepted || '', toId: j.acceptedId });
      });
      let backup = {};
      if (hasSheet) {
        ids.forEach(function (id, i) {
          const x = byId[id];
          if (!x || x.order < 1e9) return;
          x.order = i;
          dates.forEach(function (d) {
            if (!inCamp[x.id].days[d]) return;
            const c = h.dates[d]; if (c === undefined) return;
            const v = str_(block[i][c - c0]); if (!v) return;
            x.cells[d] = v;
            const oc = campInCell(v); if (oc && oc !== cid) x.away[d] = campNameOf(oc); // 소속 기사가 그날 다른 캠프로
          });
        });
        try { backup = schMyCampBackup_(me.id, dates, h, c0, c1, { drivers: all, ids: ids.map(function (x) { return [x]; }), block: block, campId: cid }).list; } catch (e) { backup = {}; }
      }
      issues.forEach(function (x) { const m = byId[x.driverId]; if (x.kind === '지시' && x.reason && m && inCamp[m.id].days[x.date]) (m.inst = m.inst || {})[x.date] = x.reason; });
      const drivers = Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name, 'ko'); }).map(function (x) { delete x.order; return x; });
      return { camp: campNameOf(cid), campId: cid, drivers: drivers, backup: backup, pm: pm };
    };
    const home = noHome ? (function () {
      // 소속 없음: 내 줄만 (그날 칸 그대로) · 갈 캠프가 없는 날은 앱이 '입차 캠프 없음'으로 보여 줌
      const cells = {};
      if (hasSheet) dates.forEach(function (d) { const v = cellAt(String(me.id), d); if (v) cells[d] = v; });
      return { drivers: [{ id: me.id, name: me.name, route: me.baseRoute || '', type: me.driverType || '', subIds: schSubIdsOf_(me), alias: lk.aliasOf[me.id] || [], me: true, guest: false, homeCamp: '', cells: cells, away: {} }], backup: {}, pm: {} };
    })() : buildCamp(myCampId, false);
    out.drivers = home.drivers; out.backup = home.backup; out.pm = home.pm;
    try { out.pumasi = pmScheduleOf_(String(me.id), dates); } catch (e) { out.pumasi = {}; }
    // 백업 기사(기본노선 없음 · 직함자 캠프 선택 아님): 내 칸에 적힌 캠프가 소속과 다른 날은 그 캠프의 기사·백업을 같이 내려준다 → 앱에서 날짜마다 '그날 입차 캠프' 기준으로 보여 줌
    //  + 다른 캠프 품앗이를 받은 날(내 칸이 비었거나 휴무)은 그 캠프가 그날 입차 캠프 (고정 기사도)
    if (!pickCamp && hasSheet) {
      const byDay = {}, need = {};
      if (noHome || !rpfBaseCodes_(me.baseRoute || '').length) dates.forEach(function (d) { const cid = campInCell(cellAt(String(me.id), d)); if (cid && cid !== myCampId) { byDay[d] = cid; need[cid] = 1; } });
      pmJobs.forEach(function (j) {
        if (j.acceptedId !== String(me.id) || !j.campId || byDay[j.date]) return;
        const mine = rcBy[me.id] ? at(me, j.date).campId : myCampId;
        const v = cellAt(String(me.id), j.date);
        if (j.campId !== mine && j.campId !== myCampId && (!v || /휴무|휴가/.test(v))) { byDay[j.date] = j.campId; need[j.campId] = 1; }
      });
      if (Object.keys(need).length) {
        const camps = {};
        Object.keys(need).forEach(function (cid) { camps[cid] = buildCamp(cid, true); });
        out.multi = { byDay: byDay, camps: camps };
      }
    }
    return out;
  });
}

/**
 * 기사 앱용: 내 캠프의 날짜별 백업 명단 { camp: '강서1', list: { 'yyyy-MM-dd': ['527B 김영환', …] } }
 * 관리자 화면 SchedCalc 의 백업 명단 계산(운영시트 updateBackupRoster)과 같은 규칙.
 * 백업 기사 = 기본노선에 백업·예비·용차, 또는 단가코드이 백업·외부용차.
 * 그 기사의 칸에서 '캠프명 + 노선' 을 찾고, 캠프명이 없으면 그 기사 소속 캠프로 본다.
 */
function schMyCampBackup_(myId, dates, h, c0, c1, pre) {
  const m = master_(), campName = {};
  m.camps.forEach(function (c) { campName[c.id] = c.name; });
  const short = function (n) { return str_(n).replace(/\s*캠프\s*$/, '').trim(); };
  // 같은 캠프 기사들은 명단이 똑같다 → 캠프·기간별로 60초 캐시 (기사마다 기사 전체·스케줄 전체를 다시 읽지 않게)
  pre = pre || {};
  const info = driverInfo_(myId), useCamp = pre.campId || (info && info.campId) || '';
  const ck = useCamp && campName[useCamp] ? 'schbk:' + useCamp + ':' + dates[0] + ':' + dates[dates.length - 1] + ':' + (c1 - c0) : '';
  if (ck) { const hit = cache_().get(ck); if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 만든다 */ } } }
  const drivers = (pre.drivers || readAll_(SH.DRIVERS)).filter(function (o) { return o.id; });
  const myCamp = campName[useCamp] ? short(campName[useCamp]) : '';
  const res = { camp: myCamp, list: {} };
  if (!myCamp) return res;
  const byId = {};
  drivers.forEach(function (o) { byId[o.id] = o; });
  const sh = schSheet_(), last = pre.ids ? pre.ids.length + 1 : sh.getLastRow();
  if (last < 2) return res;
  const ids = pre.ids || sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues();
  const block = pre.block || sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
  const campNames = m.camps.map(function (c) { return short(c.name); }).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
  const esc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  const seen = {};
  ids.forEach(function (r, i) {
    const id = str_(r[0]), o = byId[id];
    if (!o || seen[id]) return;
    seen[id] = 1;
    const ownCamp = campName[o.schCampId] ? short(campName[o.schCampId]) : '';
    const isBackup = /백업|예비|용차/.test(o.baseRoute || '') || /용차/.test(ownCamp) || o.driverType === '백업' || o.driverType === '외부용차';
    if (!isBackup) return;
    dates.forEach(function (d) {
      const c = h.dates[d];
      if (c === undefined) return;
      const cellText = str_(block[i][c - c0]);
      if (!cellText || cellText === '출근' || /휴무|휴가|퇴사/.test(cellText)) return;
      const flat = cellText.replace(/\([^)]*\)/g, '').trim();
      const hits = [];
      let found = false;
      campNames.forEach(function (tc) {
        const re = new RegExp(esc(tc) + '\\s*(\\d+[A-Za-z][A-Za-z0-9,]*)(\\s*\\[.*?\\])?', 'g');
        let mm;
        while ((mm = re.exec(flat)) !== null) { found = true; if (tc === myCamp) hits.push(mm[1] + ' ' + o.name + (mm[2] || '')); }
      });
      if (!found && ownCamp === myCamp) {
        const re = /(\d+[A-Za-z]+)(\s*\[.*?\])?/g;
        let mm;
        while ((mm = re.exec(flat)) !== null) hits.push(mm[1] + ' ' + o.name + (mm[2] || ''));
      }
      if (!hits.length) return;
      const l = res.list[d] || (res.list[d] = []);
      hits.forEach(function (x) { if (l.indexOf(x) < 0) l.push(x); });
    });
  });
  if (ck) { try { cache_().put(ck, JSON.stringify(res), 60); } catch (e) { /* 무시 */ } }
  return res;
}

// ───────────────────────── 스케줄 : 어드민 업로드 테이블 ─────────────────────────
/*
 * 운영시트 스크립트 '어드민: 업로드 테이블 생성'(generateUploadTable, 2026-10-25판)을 그대로 옮김.
 * - 2주(그 주 일요일부터 14일) 중 내일(PDD)부터의 날짜만 대상.
 * - 칸 글자를 해석해 [업무일, 사업자등록번호, 캠프명, 웨이브, 아이디, 업무상태, 회전, 업무라우트, 비고, (빈칸), 명단] 줄을 만든다.
 * - 미입차 줄(캠프·회전별로 노선 묶음), 중복 줄(같은 날 같은 캠프·노선·회전에 2명 이상)도 만든다.
 * - 결과는 스케줄 DB 파일의 '어드민 업로드' 탭에 운영시트와 같은 모양으로 써 두고(직접 고치기·복사 가능), 화면에도 돌려준다.
 */
const UPLOAD = {
  SHEET: '어드민 업로드',
  HEAD: ['업무일', '사업자등록번호', '캠프명', '웨이브', '아이디', '업무상태', '회전', '업무라우트', '비고', '', '명단'],
  COLOR: { KEY: '#E3F2FD', MI: '#FFEBEE', DUP: '#FFF8E1', SEP: '#000000' },
  LEFT_COL: 2, RIGHT_COL: 14, START_ROW: 3, GAP: 5
};
/** scope: '4w'(내일이 든 주부터 4주) · 'tomorrow'(보고 있는 2주 중 내일부터) · 'nextweek'(다음 주 일~토 전체) · 'thisweek'(이번 주 내일부터 토요일까지) · 'month'(내일부터 5주 토요일까지, 한 달치) */
function adm_schUploadTable(token, start, scope) {
  return run_(function () {
    const a = requireAdmin_(token);
    const today = new Date(), tmr = ymd_(addDays_(today, 1));
    let base = parseYmd_(start) || today;
    if (scope === 'nextweek') base = addDays_(sundayOf_(new Date(today.getFullYear(), today.getMonth(), today.getDate())), 7);
    if (scope === 'thisweek' || (scope === '4w' && !parseYmd_(start)) || (scope === 'month' && !parseYmd_(start))) base = addDays_(today, 1);
    // 4w + start: 기사스케줄 편집기에 보이는 첫 날짜부터 (지난 날도 포함)
    const from4 = scope === '4w' ? ymd_(base) : '';
    const sun = sundayOf_(new Date(base.getFullYear(), base.getMonth(), base.getDate()));
    // 한 달: 그 달(start 가 있으면 그 날짜의 달)을 덮는 주(일~토)들 → 1주차 ~ 5·6주차 (한 주 시작은 항상 일요일)
    let nDays = SCH_DAYS;
    if (scope === '4w') nDays = 28; // 시작일이 든 주(일~토)부터 4주 → 화면에서 주차별 탭
    if (scope === 'month') {
      const m0 = parseYmd_(start) || base, last = new Date(m0.getFullYear(), m0.getMonth() + 1, 0);
      const satEnd = addDays_(last, 6 - last.getDay());
      nDays = Math.max(7, Math.round((satEnd - sun) / 86400000) + 1);
    }
    const data = schRead_(sun, addDays_(sun, nDays - 1));
    const co = companyInfo_();
    const res = schBuildUpload_(data, {
      bizNo: co.branchBizNo || '654-37-01141', // company 탭 '영업점 사업자번호'
      wave: 'WAVE1',
      target: scope === '4w' ? from4 : scope === 'nextweek' ? (ymd_(sun) > tmr ? ymd_(sun) : tmr) : tmr,
      maxDays: schMaxDays_()
    });
    res.scope = scope || 'tomorrow';
    res.weekEnd = scope === 'nextweek' || scope === 'thisweek' ? ymd_(addDays_(sun, 6)) : scope === 'month' ? ymd_(addDays_(sun, nDays - 1)) : '';
    // 주 단위로 올릴 때는 그 주(일~토)의 문제만 신호등에 (2주차 출근 표는 보기용으로 남김)
    if (res.weekEnd) {
      const inWk = function (r) { return String(r[0]) <= res.weekEnd; };
      res.missing = res.missing.filter(inWk); res.dups = res.dups.filter(inWk); res.over7 = res.over7.filter(inWk);
    }
    schCheckIds_(res);
    // 쿠팡 업로드 엑셀(양식 그대로)용: 쿠팡 등록 목록(아이디 × 캠프) · 벤더명 · 사업자번호
    try { res.roster = readAll_(SH.CPROS).filter(function (o) { return o.loginId && o.camp; }).map(function (o) { return { camp: o.camp, id: o.loginId, name: o.name || '', at: o.updatedAt || '' }; }); } catch (e) { res.roster = []; }
    const aps = appSet_();
    res.cpVendor = str_(aps.cpVendor) || '러너/RUNNER';
    res.cpBizNo = (str_(aps.cpBizNo) || str_(co.branchBizNo) || '654-37-01141').replace(/\D/g, '');
    let url = '';
    const lock = scriptLock_();
    try { lock.waitLock(20000); url = schWriteUpload_(res); } catch (e) { res.sheetError = String(e && e.message || e); } finally { lock.releaseLock(); }
    res.url = url;
    res.ok = true;
    logAdmin_(a, '어드민 업로드 테이블 생성', data.dates[0] + ' ~ ' + data.dates[data.dates.length - 1],
      '출근 ' + res.weeks.reduce(function (a, w) { return a + w.length; }, 0) + '건 · 미입차 ' + res.missing.length + '건 · 중복 ' + res.dups.length + '건 · 주7일 ' + res.over7.length + '건 · 아이디 ' + res.badId.length + '건');
    return res;
  });
}

/**
 * 쿠팡 등록 목록 저장: 쿠팡 어드민에서 받은 기사스케줄 엑셀(업무일·벤더명·사업자등록번호·캠프명·웨이브·이름·아이디·…)을
 * 화면에서 읽어 (캠프명, 아이디, 이름) 목록만 보낸다 → coupang_roster 탭을 통째로 바꾼다 (시트에서 직접 고쳐도 됨).
 * p = { rows: [{ camp, id, name }], vendor, bizNo }
 */
function adm_cpRosterSave(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const seen = {}, rows = [], now = nowText_();
    (Array.isArray(p.rows) ? p.rows : []).slice(0, 3000).forEach(function (x) {
      const camp = str_(x && x.camp).replace(/\s*캠프\s*$/, '').trim(), id = str_(x && x.id).trim();
      if (!camp || !id || seen[camp + '|' + id]) return;
      seen[camp + '|' + id] = 1;
      rows.push({ camp: camp, loginId: id, name: str_(x.name).trim().slice(0, 30), updatedAt: now });
    });
    if (!rows.length) fail_('엑셀에서 캠프명·아이디를 찾지 못했습니다. 쿠팡 어드민에서 받은 기사스케줄 엑셀인지 확인해 주세요.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const sh = sheet_(SH.CPROS), last = sh.getLastRow();
      if (last >= 2) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
      appendObjs_(SH.CPROS, rows);
      if (str_(p.vendor)) appSetPut_('cpVendor', str_(p.vendor).slice(0, 40), '쿠팡 업로드 엑셀 벤더명 (쿠팡 등록 목록을 올릴 때 자동)');
      if (str_(p.bizNo)) appSetPut_('cpBizNo', str_(p.bizNo).replace(/\D/g, '').slice(0, 10), '쿠팡 업로드 엑셀 사업자등록번호 (숫자만 · 쿠팡 등록 목록을 올릴 때 자동)');
    } finally {
      lock.releaseLock();
    }
    logAdmin_(a, '쿠팡 등록 목록 올림', '', rows.length + '개 (아이디 × 캠프)');
    return { ok: true, roster: rows.map(function (o) { return { camp: o.camp, id: o.loginId, name: o.name, at: o.updatedAt }; }) };
  });
}

// ───────────────────────── 스케줄 이슈 (칸별 사유: 부상·병가·차량 등) ─────────────────────────
// 스케줄 DB 파일의 'issues' 탭. 시트에서 직접 고쳐도 된다 (이슈ID 는 비워 두면 다음에 자동으로 채워짐).
const SCH_ISSUE = { SHEET: 'issues', HEAD: ['이슈ID', '날짜', '기사ID', '이름', '구분', '사유', '조치', '작성자', '작성일시', '미입차', '미입차일수', '결과', '뺀 회전', '대체', '대체 기사', '종료일', '원래 칸', '연동', '수량'],
  // 이슈 관리의 이슈 항목 코드 (+ 지시 = 칸 편집기의 '지시사항', 기사스케줄 칸에 표시). 예전 구분(병가·차량 등)도 그대로 읽어 보여 준다
  CODES: ['질병', '부상', '사고', '고장', '물량조율', '노쇼'],
  KINDS: ['질병', '부상', '사고', '고장', '물량조율', '노쇼', '지시'],
  // 코드를 고르면 미입차 칸의 처음 값 (사무실에서 바꿀 수 있음)
  MI_DEFAULT: { '질병': true, '부상': true, '사고': true, '고장': true, '물량조율': false, '노쇼': true } };
/** 예전에 만든 issues 탭에 '미입차' 머리글이 없으면 맨 끝에 붙인다 */
function schIssueHeadFix_(sh) {
  const n = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, n).getValues()[0].map(str_);
  SCH_ISSUE.HEAD.forEach(function (h, i) {
    if (head.indexOf(h) >= 0) return;
    if (!head[i]) { sh.getRange(1, i + 1).setValue(h).setFontWeight('bold').setBackground('#f1f3f4'); head[i] = h; }
  });
}
function schIssueSheet_() {
  const book = schSS_();
  let sh = book.getSheetByName(SCH_ISSUE.SHEET);
  if (sh) return sh;
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    sh = book.getSheetByName(SCH_ISSUE.SHEET);
    if (sh) return sh;
    sh = book.insertSheet(SCH_ISSUE.SHEET);
    sh.getRange(1, 1, 1, SCH_ISSUE.HEAD.length).setValues([SCH_ISSUE.HEAD]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange(1, 1, Math.min(sh.getMaxRows(), 1000), SCH_ISSUE.HEAD.length).setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.getRange(1, 1).setNote('기사스케줄 칸의 이슈(사유). 구분: ' + SCH_ISSUE.KINDS.join(' / ') + '. 직접 고쳐도 됩니다.');
    return sh;
  } finally { lock.releaseLock(); }
}
function schAddDays_(ymd, n) { const d = parseYmd_(ymd); if (!d) return ymd; d.setDate(d.getDate() + n); return ymd_(d); }
/** 이슈 전체 (from·to 가 있으면 그 기간 · 미입차 기간이 걸치는 것 포함) */
function schIssues_(from, to) {
  const sh = schSS_().getSheetByName(SCH_ISSUE.SHEET); // 아직 없으면 (처음 기록할 때 만든다)
  if (!sh) return [];
  const vals = sh.getDataRange().getValues(); // 머리글 + 내용을 한 번에 (시트 호출 4번 → 1번)
  if (vals.length < 2) return [];
  const head = vals[0].map(str_);
  const ix = {}; SCH_ISSUE.HEAD.forEach(function (h) { ix[h] = head.indexOf(h); });
  const g = function (r, h) { const v = ix[h] >= 0 ? r[ix[h]] : ''; return v instanceof Date ? ymd_(v) : str_(v); };
  return vals.slice(1).map(function (r, i) {
    let orig = {};
    try { const t = g(r, '원래 칸'); if (t) orig = JSON.parse(t) || {}; } catch (e) { orig = {}; }
    return { row: i + 2, id: g(r, '이슈ID'), date: g(r, '날짜'), driverId: g(r, '기사ID'), name: g(r, '이름'), kind: g(r, '구분'), reason: g(r, '사유'), action: g(r, '조치'), by: g(r, '작성자'), at: g(r, '작성일시'), mi: /^(Y|O|TRUE|1|미입차)$/i.test(g(r, '미입차')),
      result: g(r, '결과'), cut: g(r, '뺀 회전'), sub: g(r, '대체'), subWho: g(r, '대체 기사'), endDate: g(r, '종료일'), orig: orig, link: g(r, '연동'), qty: g(r, '수량') };
  }).map(function (x) {
    // 기간: 종료일이 있으면 그 날까지, 없으면 예전 방식(미입차 일수: 이슈 날짜부터 며칠 · 적지 않았으면 1일)
    x.miDays = x.mi ? Math.max(1, Math.min(365, parseInt(str_(vals[x.row - 1][ix['미입차일수']] === undefined ? '' : vals[x.row - 1][ix['미입차일수']]), 10) || 1)) : 0;
    x.end = x.endDate && x.endDate >= x.date ? x.endDate : x.date && x.mi && x.miDays > 1 ? schAddDays_(x.date, x.miDays - 1) : x.date;
    delete x.endDate;
    if (x.result) { x.mi = x.result === '미입차' || x.result === '노쇼' || x.result === '병가'; x.miDays = x.mi ? issDates_(x.date, x.end).length : 0; }
    return x;
  }).filter(function (x) { return x.date && (x.driverId || x.name) && (!from || x.end >= from) && (!to || x.date <= to); });
}
/**
 * 이슈 저장. o = { id(있으면 고침), date, end, driverId, result(미입차/노쇼/물량조율), cut(뺀 회전), kind(사유), reason(상세), action(조치),
 *                 sub(대체), subWho(대체 기사), qty, force(특별한 칸 덮어쓰기 확인함) }
 * 예전 방식(kind=이슈 코드, mi, miDays)도 그대로 받는다 · 지시(kind '지시')는 칸을 바꾸지 않음
 * 2026-11-01 이후 날짜는 결과대로 기사스케줄 칸을 바꾼다 (issSyncCells_)
 */
function adm_schIssueSave(token, o) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    o = o || {};
    if (!parseYmd_(o.date)) fail_('날짜를 확인해 주세요.');
    const date = ymd_(parseYmd_(o.date));
    const drv = readAll_(SH.DRIVERS).filter(function (x) { return x.id === str_(o.driverId); })[0];
    if (!drv) fail_('기사를 찾을 수 없습니다.');
    const kind = str_(o.kind) || '기타', reason = str_(o.reason).slice(0, 200), action = str_(o.action).slice(0, 200);
    let result = str_(o.result);
    if (result && ISS.RESULTS.indexOf(result) < 0) fail_('결과는 ' + ISS.RESULTS.join(' / ') + ' 중에서 골라 주세요.');
    let cut = result === '물량조율' ? str_(o.cut).slice(0, 60) : '';
    if (result === '물량조율' && !cut) fail_('물량조율은 뺀 회전(D1·D2·F3)을 골라 주세요.');
    if (!reason && kind === '기타') fail_('사유를 적어 주세요.');
    const sh = schIssueSheet_();
    const lock = scriptLock_();
    lock.waitLock(25000);
    try {
      schIssueHeadFix_(sh);
      const list = schIssues_();
      const hit = o.id ? list.filter(function (x) { return x.id === str_(o.id); })[0] : null;
      if (o.id && !hit) fail_('이미 지워진 이슈입니다. 새로고침해 주세요.');
      // 기간: end 가 있으면 그대로, 없으면 예전 방식(mi + miDays)
      let end = parseYmd_(o.end) ? ymd_(parseYmd_(o.end)) : '';
      if (!result && kind !== '지시') {
        const mi = o.mi === undefined || o.mi === null ? !!(hit && hit.mi) : !!o.mi;
        if (hit && hit.result) { result = hit.result; cut = hit.cut || ''; }
        else if (mi) result = '';
        if (!end) end = mi ? schAddDays_(date, Math.max(1, Math.min(365, parseInt(o.miDays, 10) || (hit && hit.miDays) || 1)) - 1) : date;
        if (!result && mi) { // 예전 방식 저장: 결과 없이 미입차 체크만
          const x0 = Object.assign({}, hit || {}, { id: hit ? hit.id : issNewId_(), row: hit ? hit.row : 0, date: date, end: end, driverId: drv.id, name: drv.name, kind: kind, reason: reason, action: action,
            by: hit ? hit.by : a.name, at: hit ? hit.at : nowText_(), mi: true, result: '', link: hit ? hit.link : '' });
          issWriteRow_(sh, x0);
          logAdmin_(a, hit ? '스케줄 이슈 수정' : '스케줄 이슈 기록', drv.name + ' ' + date, kind + ' · ' + reason);
          return { ok: true, issue: issView_(x0), cells: [] };
        }
      }
      if (!end || end < date) end = date;
      if (issDates_(date, end).length > 366) fail_('기간은 1년까지 고를 수 있습니다.');
      const next = {
        id: hit ? hit.id : issNewId_(), row: hit ? hit.row : 0, date: date, end: end, driverId: drv.id, name: drv.name, kind: kind, reason: reason, action: action,
        by: hit ? hit.by : a.name, at: hit ? hit.at : nowText_(), result: result, cut: cut, sub: str_(o.sub).slice(0, 20), subWho: str_(o.subWho).slice(0, 40), qty: str_(o.qty).slice(0, 20),
        link: kind === '지시' ? '' : (hit ? (hit.link || (date >= ISS.RULE_FROM && result ? 'Y' : '')) : (result ? 'Y' : '')), orig: hit ? (hit.orig || {}) : {}
      };
      // 이슈 → 칸 (덮어쓸 특별한 칸이 있으면 먼저 확인)
      let sync = { cells: [], orig: next.orig, conflicts: [] };
      if (next.link === 'Y' || (hit && hit.link === 'Y')) {
        sync = issSyncCells_(a, drv, hit && hit.link === 'Y' ? hit : null, next.link === 'Y' ? next : null, !o.force);
        if (!o.force && sync.conflicts.length) return { ok: true, need: 'confirm', conflicts: sync.conflicts };
        if (!o.force) sync = issSyncCells_(a, drv, hit && hit.link === 'Y' ? hit : null, next.link === 'Y' ? next : null, false);
        next.orig = sync.orig;
      }
      issWriteRow_(sh, next);
      logAdmin_(a, hit ? '스케줄 이슈 수정' : '스케줄 이슈 기록', drv.name + ' ' + date + (end !== date ? '~' + end : ''), (result ? result + (cut ? '(' + cut + ')' : '') + ' · ' : '') + kind + (reason ? ' · ' + reason : '') + (sync.cells.length ? ' · 스케줄 ' + sync.cells.length + '칸' : ''));
      return { ok: true, issue: issView_(next), cells: sync.cells };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 이슈 관리 목록. f = { from, to } (없으면 이번 달)
 * 기사별 캠프·그날 스케줄 칸 글자를 같이 준다 (미입차 체크와 스케줄이 맞는지 보려고)
 */
function adm_issueList(token, f) {
  return run_(function () {
    requireAdmin_(token);
    f = f || {};
    const now = new Date();
    const from = parseYmd_(f.from) ? ymd_(parseYmd_(f.from)) : ymd_(new Date(now.getFullYear(), now.getMonth(), 1));
    const to = parseYmd_(f.to) ? ymd_(parseYmd_(f.to)) : ymd_(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    if (from > to) fail_('기간을 확인해 주세요.');
    const list = schIssues_(from, to).filter(function (x) { return x.kind !== '지시'; }).map(issView_);
    // 그날 스케줄 칸
    const cell = {};
    try {
      const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
      const ds = Object.keys(h.dates).filter(function (d) { return d >= from && d <= to; });
      if (last >= 2 && ds.length && list.length) {
        const cols = ds.map(function (d) { return h.dates[d]; });
        const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
        const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
        const block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
        const rowOf = {}; ids.forEach(function (id, i) { if (rowOf[id] === undefined) rowOf[id] = i; });
        list.forEach(function (x) {
          const i = rowOf[x.driverId], c = h.dates[x.date];
          if (i !== undefined && c !== undefined) cell[x.id] = str_(block[i][c - c0]);
        });
      }
    } catch (e) { /* 스케줄 DB 가 없으면 칸 글자 없이 */ }
    const drv = {};
    readAll_(SH.DRIVERS).forEach(function (d) { if (d.id) drv[d.id] = d; });
    list.forEach(function (x) {
      const d = drv[x.driverId] || {};
      x.cell = cell[x.id] || '';
      x.camp = d.schCamp || '';
      x.type = d.driverType || '';
      if (d.name) x.name = d.name;
    });
    list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1); });
    const drivers = readAll_(SH.DRIVERS).filter(function (d) { return d.id && d.name && d.status === ST.ACTIVE; })
      .map(function (d) { return { id: d.id, name: d.name, camp: d.schCamp || '', campId: d.schCampId || '', baseRoute: d.baseRoute || '', type: d.driverType || '' }; });
    const camps = master_().camps.map(function (c) { return { id: c.id, name: c.name, rot: c.rot }; });
    // 노선 이슈: 기사스케줄에서 [미입차로 확정]한 노선 (기사 개인 이슈가 아니라 '그날 그 노선이 비었다'는 기록)
    let routeMiss = [];
    try { routeMiss = schRmRead_().filter(function (x) { return x.date >= from && x.date <= to; }).map(function (x) { return { date: x.date, camp: x.camp, unit: x.unit, result: x.result, reason: x.reason, memo: x.memo, by: x.by }; }); } catch (e) { routeMiss = []; }
    return { ok: true, from: from, to: to, issues: list, routeMiss: routeMiss, codes: SCH_ISSUE.CODES, miDefault: SCH_ISSUE.MI_DEFAULT, drivers: drivers, camps: camps,
      results: ISS.RESULTS, reasons: ISS.REASONS, subs: ISS.SUBS, unset: ISS.UNSET, ruleFrom: ISS.RULE_FROM, today: todayText_() };
  });
}
/** 이슈 등록 창: 그 기사·날짜의 스케줄 칸 글자 (미입차 처음 값 정할 때) */
function adm_issueCell(token, driverId, date) {
  return run_(function () {
    requireAdmin_(token);
    const d = parseYmd_(date);
    if (!d) return { ok: true, cell: '' };
    try {
      const h = schHeader_(), c = h.dates[ymd_(d)];
      if (c === undefined) return { ok: true, cell: '' };
      const sh = schSheet_(), last = sh.getLastRow();
      if (last < 2) return { ok: true, cell: '' };
      const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
      const i = ids.indexOf(str_(driverId));
      return { ok: true, cell: i < 0 ? '' : str_(sh.getRange(i + 2, c + 1).getValue()) };
    } catch (e) { return { ok: true, cell: '' }; }
  });
}
function adm_schIssueDel(token, id) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    const sh = schIssueSheet_();
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const hit = schIssues_().filter(function (x) { return x.id === str_(id); })[0];
      if (!hit) fail_('이미 지워진 이슈입니다.');
      // 연동 이슈: 칸이 아직 이 이슈가 넣은 값이면 원래 값으로 되돌림
      let cells = [];
      if (hit.link === 'Y') {
        const drv = readAll_(SH.DRIVERS).filter(function (x) { return x.id === hit.driverId; })[0];
        if (drv) cells = issSyncCells_(a, drv, hit, null, false).cells;
      }
      sh.deleteRow(hit.row);
      logAdmin_(a, '스케줄 이슈 삭제', hit.name + ' ' + hit.date, (hit.result ? hit.result + ' · ' : '') + hit.kind + ' · ' + hit.reason + (cells.length ? ' · 스케줄 ' + cells.length + '칸 되돌림' : ''));
      return { ok: true, cells: cells };
    } finally { lock.releaseLock(); }
  });
}

// ───────────────────────── 연간 현황: 명절·공휴일 휴무 횟수, 이슈 ─────────────────────────
/** 공휴일을 명절(설날·추석, 붙은 연휴·대체공휴일 포함) 묶음과 나머지 공휴일로 나눈다 */
function schHolidayGroups_(from, to) {
  const ds = Object.keys(HOLIDAYS).filter(function (d) { return d >= from && d <= to; }).sort();
  const groups = [];
  ds.forEach(function (d) {
    const g = groups[groups.length - 1];
    if (g && ymd_(addDays_(parseYmd_(g.dates[g.dates.length - 1]), 1)) === d) g.dates.push(d); else groups.push({ dates: [d] });
  });
  const myeong = [], other = [];
  groups.forEach(function (g) {
    const names = g.dates.map(function (d) { return HOLIDAYS[d]; }).join(' ');
    const kind = /설날/.test(names) ? '설날' : /추석/.test(names) ? '추석' : '';
    if (kind) myeong.push({ key: g.dates[0].slice(0, 4) + ' ' + kind, kind: kind, year: g.dates[0].slice(0, 4), dates: g.dates });
    else g.dates.forEach(function (d) { other.push(d); });
  });
  return { myeong: myeong, other: other };
}
/** 출근으로 세는 칸 (화면 출근일수와 같은 규칙) / 쉰 칸 */
/**
 * 근무일 판정 하나 (정산 근무일수 · 관리자앱 출근일수 · 기사 앱 통계가 같은 규칙) — 그 기사가 그날 직접 일했는가
 *  근무 O: 출근 · 노선 글자(담당/다른 노선) · 노선·라우트 변경 · '(서브아이디) 업무등록' (그 기사에게 등록된 서브아이디로 뛴 날)
 *  근무 X: 휴무·휴가·병가·퇴사·미입차·노쇼·용차 · '(본인 아이디) 업무등록' 처럼 등록 서브가 아닌 아이디 (업체 아이디만 쓰인 날) · 추가업무등록
 *          · 규칙으로 읽을 수 없는 글자 (일정 메모는 칸이 아니라 지시사항·일정 메모 칸에)
 *  subIds = 그 기사의 서브아이디 목록 (없으면 서브아이디 업무등록을 근무로 보지 않음)
 */
function schWorkDay_(v, subIds) {
  const s = str_(v);
  if (!s) return false;
  if (/휴무|휴가|병가|퇴사|미입차|노쇼|용차/.test(s)) return false;
  if (/업무/.test(s)) {
    if (!/업무등록/.test(s) || /추가업무등록/.test(s)) return false;
    const ids = [];
    s.replace(/\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)/g, function (m0, id) { if (!/^[DF]\d$/i.test(id)) ids.push(id.toLowerCase()); return m0; });
    const subs = (subIds || []).map(function (x) { return str_(x).toLowerCase(); }).filter(Boolean);
    return ids.length > 0 && ids.some(function (id) { return subs.indexOf(id) >= 0; });
  }
  return /^출근/.test(s) || /\d{3,4}[A-Za-z]/.test(s) || /변경/.test(s);
}
/** 같은 근무자 연결 표 (기사 앱용 · schRead_ 와 같은 규칙): { workerOf: { 명의 기사ID: 근무자 }, aliasOf: { 근무자ID: [{ name, login }] } } */
function schLinkMap_(all) {
  const byId = {}, workerOf = {}, aliasOf = {};
  (all || []).forEach(function (o) { if (o.id) byId[o.id] = o; });
  (all || []).forEach(function (o) {
    const wid = str_(o.workerId), w = wid && wid !== o.id ? byId[wid] : null;
    if (!w || str_(w.workerId)) return;
    workerOf[o.id] = w;
    if (str_(o.loginId)) (aliasOf[w.id] = aliasOf[w.id] || []).push({ name: o.name, login: str_(o.loginId) });
  });
  return { workerOf: workerOf, aliasOf: aliasOf };
}
function schSubIdsOf_(o) { return o ? [o.subId1, o.subId2].map(function (x) { return str_(x); }).filter(Boolean) : []; }
function schIsWork_(v, subIds) { return schWorkDay_(v, subIds); }
function schIsRest_(v) { return /휴무|휴가|병가/.test(str_(v)); }
/** 기사 한 명의 스케줄 칸 { 날짜: 글자 } (스케줄 DB · 없으면 빈 객체) */
function schCellsOf_(driverId, dates) {
  const out = {};
  if (!dates.length || !props_().SCH_DB_ID || !schSS_().getSheetByName(SCH.SHEET)) return out;
  const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
  if (last < 2) return out;
  const cell = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).createTextFinder(String(driverId)).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return out;
  const cols = dates.map(function (d) { return h.dates[d]; }).filter(function (c) { return c !== undefined; });
  if (!cols.length) return out;
  const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
  const vals = sh.getRange(cell.getRow(), c0 + 1, 1, c1 - c0 + 1).getValues()[0];
  dates.forEach(function (d) { const c = h.dates[d]; if (c !== undefined) { const v = str_(vals[c - c0]); if (v) out[d] = v; } });
  return out;
}
/** 그 기사가 이미 근무 스케줄이 있는 날 (휴무·휴가·병가·퇴사·미입차·용차 칸은 근무 아님) */
function schWorkDates_(driverId, from, to) {
  const cells = schCellsOf_(driverId, schDateRange_(parseYmd_(from), parseYmd_(to)));
  let subs = [];
  try { subs = schSubIdsOf_(driverById_(String(driverId))); } catch (e) { subs = []; }
  return Object.keys(cells).filter(function (d) { return schIsWork_(cells[d], subs); }).sort();
}
/** year = 'yyyy' 또는 'all'(스케줄 DB 전체 기간) */
function adm_schYear(token, year) {
  return run_(function () {
    requireAdmin_(token);
    const h = schHeader_();
    const years = {};
    Object.keys(h.dates).forEach(function (d) { years[d.slice(0, 4)] = 1; });
    const yl = Object.keys(years).sort();
    if (!yl.length) return { ok: true, years: [], rows: [], cols: [] };
    const y = year === 'all' ? 'all' : (years[String(year)] ? String(year) : String(new Date().getFullYear()));
    let from = y === 'all' ? yl[0] + '-01-01' : y + '-01-01', to = y === 'all' ? yl[yl.length - 1] + '-12-31' : y + '-12-31';
    if (from < h.first) from = h.first;
    if (to > h.last) to = h.last;
    const today = todayText_();
    const sh = schSheet_(), last = sh.getLastRow();
    const c0 = h.dates[from], c1 = h.dates[to];
    const cells = {};
    if (last >= 2) {
      const fixed = sh.getRange(2, 1, last - 1, 5).getValues();
      const block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
      const dates = Object.keys(h.dates).filter(function (d) { return d >= from && d <= to; });
      fixed.forEach(function (f, i) {
        const id = str_(f[h.fixed['행ID']]);
        if (!id || str_(f[h.fixed['구분']]) === SCH.KIND_NOTE || cells[id]) return;
        const row = {};
        dates.forEach(function (d) { const v = str_(block[i][h.dates[d] - c0]); if (v) row[d] = v; });
        cells[id] = row;
      });
    }
    const hg = schHolidayGroups_(from, to);
    let issues = [];
    try { issues = schIssues_(from, to); } catch (e) { issues = []; }
    const maxD = schMaxDays_();
    const rows = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name && (o.status === ST.ACTIVE || Object.keys(cells[o.id] || {}).length); }).map(function (o) {
      const c = cells[o.id] || {};
      const st = function (d) { const v = c[d] || ''; return schIsWork_(v) ? 'w' : schIsRest_(v) ? 'r' : ''; };
      const my = {};
      let myRest = 0, myWork = 0;
      hg.myeong.forEach(function (g) {
        const x = { rest: 0, work: 0, days: g.dates.length, future: g.dates[0] > today };
        g.dates.forEach(function (d) { const k = st(d); if (k === 'w') x.work++; else if (k === 'r') x.rest++; });
        my[g.key] = x; myRest += x.rest; myWork += x.work;
      });
      let holRest = 0, holWork = 0;
      hg.other.forEach(function (d) { const k = st(d); if (k === 'w') holWork++; else if (k === 'r') holRest++; });
      // 주별(일~토) 출근 수: 쿠팡 기본 지침 주 5일 · 최대 6일
      const wk = {};
      Object.keys(c).forEach(function (d) { if (d > today || !schIsWork_(c[d])) return; const sun = ymd_(sundayOf_(parseYmd_(d))); wk[sun] = (wk[sun] || 0) + 1; });
      const wv = Object.keys(wk).map(function (k) { return wk[k]; });
      const iss = issues.filter(function (x) { return x.driverId === o.id; });
      const ik = {};
      iss.forEach(function (x) { ik[x.kind] = (ik[x.kind] || 0) + 1; });
      return {
        id: o.id, name: o.name, type: o.driverType || '', camp: o.schCamp || '', status: o.status,
        my: my, myRest: myRest, myWork: myWork, holRest: holRest, holWork: holWork,
        workDays: Object.keys(c).filter(function (d) { return d <= today && schIsWork_(c[d]); }).length,
        weeks: wv.length, w6: wv.filter(function (n) { return n >= 6; }).length, w7: wv.filter(function (n) { return n > maxD; }).length,
        avg: wv.length ? Math.round(wv.reduce(function (a, b) { return a + b; }, 0) / wv.length * 10) / 10 : 0,
        issues: iss.length, issueKinds: ik
      };
    });
    return { ok: true, year: y, years: yl, from: from, to: to, today: today, maxDays: maxD,
      cols: hg.myeong.map(function (g) { return { key: g.key, kind: g.kind, dates: g.dates, names: g.dates.map(function (d) { return HOLIDAYS[d]; }) }; }),
      holidays: hg.other.map(function (d) { return { date: d, name: HOLIDAYS[d] }; }), rows: rows };
  });
}

/** 기사코드 자동: R + 세 자리 (가장 큰 번호 다음) */
function nextDriverCode_() {
  let max = 0;
  readAll_(SH.DRIVERS).forEach(function (x) { const m = str_(x.driverCode).match(/^R(\d+)$/i); if (m && +m[1] > max) max = +m[1]; });
  return 'R' + ('00' + (max + 1)).slice(-3);
}
/** 기사코드가 빈 기사에게 가입 순서대로 번호를 준다 (잠금 안) */
function fillDriverCodes_() {
  const lock = scriptLock_();
  if (!lock.tryLock(5000)) return;
  try {
    const all = readAll_(SH.DRIVERS).filter(function (x) { return x.id && x.name; });
    let max = 0;
    all.forEach(function (x) { const m = str_(x.driverCode).match(/^R(\d+)$/i); if (m && +m[1] > max) max = +m[1]; });
    all.filter(function (x) { return !str_(x.driverCode); }).sort(function (p, q) { return str_(p.createdAt) < str_(q.createdAt) ? -1 : str_(p.createdAt) > str_(q.createdAt) ? 1 : 0; })
      .forEach(function (x) { max++; writeFields_(SH.DRIVERS, x._row, { driverCode: 'R' + ('00' + max).slice(-3) }); forgetDriver_(x); });
  } finally { lock.releaseLock(); }
}
/**
 * 서브아이디 연동: 메인 기사(o)의 서브아이디1·2
 *  - 그 아이디로 가입한 기사가 있으면 기사 앱 사용만 '정지' (근무·정산은 그대로)
 *  - 정산관리 아이디 관리: 그 아이디를 '서브', 메인 = 이 기사의 쿠팡플렉스 아이디 (없으면 새 줄)
 *  - 빠진 서브아이디(전에 있었는데 지운 것)는 아이디 관리에서 메인으로 되돌린다
 * 반환: 화면에 보여 줄 안내 글
 */
function drvLinkSubs_(a, o, before) {
  const msg = [];
  try {
    const subs = [o.subId1, o.subId2].map(str_).filter(Boolean);
    const gone = (before || []).map(str_).filter(Boolean).filter(function (x) { return subs.map(function (y) { return y.toLowerCase(); }).indexOf(x.toLowerCase()) < 0; });
    const all = readAll_(SH.DRIVERS);
    subs.forEach(function (sid) {
      const d = all.filter(function (x) { return x.id !== o.id && str_(x.loginId).toLowerCase() === sid.toLowerCase(); })[0];
      if (d && d.status !== ST.STOPPED) {
        writeFields_(SH.DRIVERS, d._row, { status: ST.STOPPED, updatedAt: nowText_() });
        forgetDriver_(d);
        logAdmin_(a, '서브아이디 연동', d.name + ' (' + d.id + ')', o.name + ' 기사님의 서브 → 기사 앱 사용 정지');
        msg.push(d.name + '(' + sid + ') 기사 앱 사용을 정지했습니다 (서브아이디)');
      }
    });
    if (typeof stlRead_ === 'function' && props_().STL_DB_ID && o.loginId && !stlIdsV2_()) {
      const rows = stlRead_('stl_ids');
      let bump = false;
      subs.forEach(function (sid) {
        const k = stlLogin_(sid), r = rows.filter(function (x) { return stlLogin_(x.cid) === k; })[0];
        const d = all.filter(function (x) { return str_(x.loginId).toLowerCase() === sid.toLowerCase(); })[0];
        if (r) {
          if (r.role !== '서브' || stlLogin_(r.main) !== stlLogin_(o.loginId)) { stlSetRow_('stl_ids', r._row, { role: '서브', main: o.loginId }); bump = true; msg.push('정산 아이디 관리: ' + sid + ' → ' + o.loginId + ' 의 서브'); }
        } else {
          stlAppend_('stl_ids', [{ cid: sid, role: '서브', main: o.loginId, owner: d ? d.name : o.name, ownerId: d ? d.id : o.id,
            type: STL_TYPES.indexOf(o.driverType) >= 0 ? o.driverType : '', mode: '', insEx: '', fbCut: '', status: '사용', memo: '기사 정보관리 서브아이디' }]);
          bump = true; msg.push('정산 아이디 관리에 ' + sid + ' (서브) 추가');
        }
      });
      gone.forEach(function (sid) {
        const k = stlLogin_(sid), r = rows.filter(function (x) { return stlLogin_(x.cid) === k; })[0];
        if (r && r.role === '서브' && stlLogin_(r.main) === stlLogin_(o.loginId)) { stlSetRow_('stl_ids', r._row, { role: '메인', main: '' }); bump = true; msg.push('정산 아이디 관리: ' + sid + ' 서브 해제 (메인으로)'); }
      });
      if (bump) stlBump_();
    }
  } catch (e) { console.error('서브아이디 연동 실패: ' + (e && e.message)); msg.push('서브아이디 연동 중 오류: ' + (e && e.message)); }
  return msg;
}

/** 백업 범위: '전지역' 또는 캠프 짧은 이름 목록 ('강서1캠프, 수원1' → '강서1,수원1') */
function normBackupArea_(v) {
  const s = str_(v);
  if (!s) return '';
  if (/전지역|전체|all/i.test(s)) return '전지역';
  return s.split(/[,\s/·]+/).map(function (x) { return x.replace(/캠프$/, '').trim(); }).filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(',');
}

/** 아이디 하나가 한 주(일~토)에 출근할 수 있는 최대 일수 (쿠팡 규칙, 스크립트 속성 SCH_MAX_DAYS, 기본 6) */
function schMaxDays_() { const v = Number(PropertiesService.getScriptProperties().getProperty('SCH_MAX_DAYS')); return v >= 1 && v <= 7 ? v : 6; }

/** 계산만 (시트·화면 공용). data = schRead_ 결과 */
function schBuildUpload_(data, opt) {
  const SCHED_WORK_WORD = '업무', KEYWORDS = ['업무', '선탑', '신규'];
  const EXCL_WORDS = ['휴무', '휴가', '고정휴무', '추가휴무', '계획된 휴무', '업체백업', '퇴사', '노선 변경'];
  const ALL = ['D1', 'D2', 'F3'];
  const short = function (n) { return str_(n).replace(/\s*캠프\s*$/, '').trim(); };
  const campRot = {};
  data.camps.forEach(function (c) {
    const r = str_(c.rot || '').split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(function (x) { return ALL.indexOf(x) >= 0; });
    campRot[short(c.name)] = r.length ? r : ALL;
  });
  const defRotArr = function (camp) { return campRot[camp] || ALL; };
  const hasWork = function (s) { return String(s || '').indexOf(SCHED_WORK_WORD) > -1; };
  const hasKeyword = function (s) { return KEYWORDS.some(function (k) { return String(s || '').indexOf(k) > -1; }); };
  const isValidRouteList = function (s) {
    const p = String(s || '').split(',').map(function (v) { return v.trim(); }).filter(Boolean);
    return !!p.length && p.every(function (x) { return /^\d+[A-Za-z]$/.test(x); });
  };
  const normRot = function (s) { return String(s || '').split(',').map(function (v) { return v.trim().toUpperCase(); }).filter(function (v) { return ALL.indexOf(v) >= 0; }); };
  const routeExpand = function (csv) {
    let lastNum = '';
    const out = [];
    String(csv || '').split(',').forEach(function (cp) {
      const t = cp.trim();
      if (!t) return;
      let m = t.match(/^(\d+)([A-Za-z]+)$/);
      if (m) { lastNum = m[1]; m[2].toUpperCase().split('').forEach(function (ch) { out.push(lastNum + ch); }); return; }
      m = t.match(/^([A-Za-z]+)$/);
      if (m && lastNum) m[1].toUpperCase().split('').forEach(function (ch) { out.push(lastNum + ch); });
    });
    return out;
  };
  // '205C(D1),205D' 처럼 노선 바로 뒤 괄호 = 그 노선만의 회전 (쿠팡은 아이디 한 줄에 회전 하나라, 내보낼 땐 합쳐짐)
  const pullRouteRots = function (s, per) {
    return String(s || '').replace(/(\d+[A-Za-z]+)\(([^)]*)\)/g, function (m, rt, ro) {
      const rr = normRot(ro); if (!rr.length) return m;
      routeExpand(rt).forEach(function (x) { per[x] = rr; }); return rt;
    });
  };
  const splitBase = function (v) {
    const per = {}, s0 = pullRouteRots(str_(v), per), m = s0.match(/\(([^)]*)\)/);
    return { routes: s0.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*]/g, '').trim(), rot: m ? m[1].replace(/\s+/g, '') : '', per: per };
  };
  const rotSort = function (arr) { return ALL.filter(function (x) { return arr.indexOf(x) >= 0; }); };

  // 아이디 → 이름 (운영시트 nameMap: 스케쥴 시트 D·E열)
  const nameMap = {}, campById = {}, campReal = {}, routeCamps = {};
  data.camps.forEach(function (c) { campById[c.id] = short(c.name); if (!isStaffCamp_(c.name)) campReal[short(c.name)] = 1; });
  Object.keys(data.routes || {}).forEach(function (cid) { const cn = campById[cid]; if (!cn) return; (data.routes[cid] || []).forEach(function (code) { routeExpand(code).forEach(function (x) { const a = routeCamps[x] || (routeCamps[x] = []); if (a.indexOf(cn) < 0) a.push(cn); }); }); });
  data.drivers.forEach(function (d) { if (d.loginId) nameMap[d.loginId.toLowerCase()] = d.name; });
  const nm = function (id) { return nameMap[String(id || '').toLowerCase()] || ''; };

  // 운영시트 C~F열에 해당하는 줄: 캠프, 이름, 아이디, 기본노선
  const info = data.drivers.filter(function (d) {
    if (str_(d.type) === '운영자' || str_(d.title) === '운영자') return false; // 운영자는 업로드 표·쿠팡 업로드에 출력하지 않음
    return d.status === ST.ACTIVE || Object.keys(data.cells[d.id] || {}).some(function (k) { return data.dates.indexOf(k) >= 0; });
  }).map(function (d) {
    // 소속 캠프가 없거나 직원(관리자·운영자·대표) 캠프인 사람은 '백업'으로 두고, 그날 칸에 적힌 캠프·노선·회전으로 출력한다
    const staff = TITLES.indexOf(str_(d.type)) >= 0 || TITLES.indexOf(str_(d.title)) >= 0 || isStaffCamp_(campById[d.campId] || d.camp || '');
    const campOf = function (id) { return staff ? '백업' : campById[id] || ((d.type === '백업' || d.type === '외부용차') ? '백업' : ''); };
    const base = { key: d.id, camp: campOf(d.campId), name: d.name, id: d.loginId, defRt: d.baseRoute || '', cells: data.cells[d.id] || {}, leaveFrom: d.leaveDate || '' };
    // 노선 변경 예약이 걸린 기사: 날짜마다 그날의 캠프·기본노선으로
    if (d.segs) base.at = function (date) {
      const sg = d.segs.filter(function (x) { return x.from <= date && date <= x.to; })[0];
      return sg ? Object.assign({}, base, { camp: campOf(sg.campId), defRt: sg.baseRoute || '' }) : base;
    };
    return base;
  });
  // 품앗이 줄(PM+기사ID): 받은 사람이 그날 그 노선을 타므로 백업 줄처럼 출력한다 (본인 줄이 휴무여도 입차로 잡힘)
  (data.pmRows || []).forEach(function (pr) {
    const d = data.drivers.filter(function (x) { return x.id === pr.driverId; })[0];
    if (!d || !d.loginId || str_(d.type) === '운영자' || str_(d.title) === '운영자') return;
    info.push({ key: pr.id, camp: '백업', name: d.name, id: d.loginId, defRt: '', cells: data.cells[pr.id] || {}, leaveFrom: d.leaveDate || '' });
  });

  const leftInfo = {};
  info.forEach(function (r) { if (r.leaveFrom) leftInfo[r.key] = { name: r.name, from: r.leaveFrom }; });
  // 일~토 한 주씩 (2주 보기 = 2주, 한 달치 올리기 = 5주)
  const issueBy = {};
  (data.issues || []).forEach(function (x) { issueBy[x.date + '|' + x.driverId] = x.name + ' ' + x.kind + (x.reason ? '(' + x.reason + ')' : ''); });
  const weeks = [];
  for (let i = 0; i < data.dates.length; i += 7) weeks.push(data.dates.slice(i, i + 7));
  while (weeks.length < 2) weeks.push([]);
  const res = { bizNo: opt.bizNo, wave: opt.wave, target: opt.target, dates: data.dates, weeks: weeks.map(function () { return []; }), keys: weeks.map(function () { return []; }), missing: [], dups: [], over7: [], badId: [] };

  weeks.forEach(function (dates, widx) {
    const baseRouteSet = {}, baseOwner = {}, vendorOwner = {}, vacant = {}, entries = [], present = {}, dupe = {}, explicitMi = [];
    // 중복 규칙: 쿠팡은 아이디 한 줄에 회전 하나라 '205C,205D' + '205C (D2,F3)' 처럼 겹쳐 올린다.
    //   회전을 좁게 적은 사람(부분)이 그 회전의 주인 → 전체 회전으로 적힌 사람은 나머지 회전만 맡은 것으로 본다.
    //   중복 = 같은 회전에 부분끼리 2명, 또는 부분 없이 전체끼리 2명
    const addPresent = function (date, camp, routes, rots, effId, effNm, per) {
      const full = defRotArr(camp).length;
      routes.forEach(function (rt) {
        const rr = per && per[rt] ? per[rt] : rots, part = rr.length < full;
        rr.forEach(function (rot) {
          const k = [date, camp, rt, rot].join('|');
          present[k] = 1;
          const dd = dupe[k] || (dupe[k] = { ids: [], names: [], pids: [], pnames: [] });
          const I = part ? dd.pids : dd.ids, N = part ? dd.pnames : dd.names;
          if (effId && I.indexOf(String(effId)) < 0) I.push(String(effId));
          if (effNm && N.indexOf(String(effNm)) < 0) N.push(String(effNm));
        });
      });
    };
    const pushEntry = function (date, camp, effId, effNm, rots, routes, missJ, priority, mark) {
      entries.push({ row: [date, opt.bizNo, camp, opt.wave, effId, '출근', rots.join(','), routes.join(','), missJ || '', '', effNm], priority: priority, mark: mark });
      const wk = idDays[String(effId).toLowerCase()] || (idDays[String(effId).toLowerCase()] = { id: effId, name: effNm, dates: {}, camps: {} });
      wk.dates[date] = 1; if (camp) wk.camps[camp] = 1;
    };
    const idDays = {};

    info.forEach(function (r0) {
      dates.forEach(function (date) {
        const r = r0.at ? r0.at(date) : r0;
        if (r0.leaveFrom && date >= r0.leaveFrom) { // 퇴사: 퇴사일 다음 날부터 입차 목록에서 빠짐 (맡던 노선은 누가 안 들어가면 미입차로 남음)
          if (date >= opt.target && r.camp && r.defRt) routeExpand(splitBase(r.defRt).routes).forEach(function (rt) { const bk = [date, r.camp, rt].join('|'); baseRouteSet[bk] = 1; (baseOwner[bk] = baseOwner[bk] || []).push(r0.key); });
          return;
        }
        const campStr = r.camp, id = r.id;
        if (!campStr || !id || campStr.indexOf('비고') >= 0 || campStr.indexOf('퇴사') >= 0) return;
        const baseCamp = campStr;
        const base = splitBase(r.defRt);
        if (date < opt.target) return;
        if (r.defRt) routeExpand(base.routes).forEach(function (rt) { const bk = [date, baseCamp, rt].join('|'); baseRouteSet[bk] = 1; (baseOwner[bk] = baseOwner[bk] || []).push(r0.key); });
        const lines = String(r.cells[date] || '').replace(/<br\s*\/?>/gi, '\n').split(/\r?\n|\r/).map(function (v) { return v.trim(); }).filter(Boolean);
        const flat = lines.join(' ').trim();
        if (!flat || flat.indexOf('비고') >= 0) return;
        const pm = flat.match(/\(([A-Za-z][A-Za-z0-9_]{2,})\)/);
        const idFromParen = pm ? pm[1] : '';
        if (/미입차/.test(flat)) { explicitMi.push({ date: date, baseCamp: baseCamp, defRt: base.routes }); return; }

        let m = flat.match(/^([0-9A-Za-z,]+)\s+업무등록$/);
        if (m) {
          const rl = routeExpand(m[1]);
          if (rl.length) {
            const effId = idFromParen || id, effNm = nm(effId) || nm(id), rots = defRotArr(baseCamp);
            addPresent(date, baseCamp, rl, rots, effId, effNm); pushEntry(date, baseCamp, effId, effNm, rots, rl, '', 1, true);
            return;
          }
        }
        if (flat.indexOf('추가업무등록') >= 0) {
          const tokens = flat.replace(/추가업무등록/g, '').trim().split(/\s+/).filter(Boolean);
          const rots = defRotArr(baseCamp);
          for (let t = 0; t < tokens.length;) {
            const mi = tokens[t].match(/^([A-Za-z][A-Za-z0-9_]{2,})$/);
            if (!mi) { t++; continue; }
            const cid = mi[1];
            t++;
            if (t >= tokens.length) break;
            const rtTok = tokens[t];
            if (!/^\d+[A-Za-z,]+$/.test(rtTok)) { t++; continue; }
            t++;
            const rl = routeExpand(rtTok);
            if (!rl.length) continue;
            addPresent(date, baseCamp, rl, rots, cid, nm(cid)); pushEntry(date, baseCamp, cid, nm(cid), rots, rl, '', 1, true);
          }
          return;
        }
        m = flat.match(/^([0-9A-Za-z,]+)\s+([A-Za-z][A-Za-z0-9_]{2,})\s+업무등록$/);
        if (m) {
          const rl = routeExpand(m[1]);
          if (rl.length) {
            const rots = defRotArr(baseCamp);
            addPresent(date, baseCamp, rl, rots, m[2], nm(m[2])); pushEntry(date, baseCamp, m[2], nm(m[2]), rots, rl, '', 1, true);
            return;
          }
        }
        if (lines.length >= 3 && lines[2].indexOf('업무등록') > -1) {
          const mi = lines[1].match(/([A-Za-z][A-Za-z0-9_]{2,})/);
          if (mi) {
            const rl = routeExpand(lines[0]);
            if (rl.length) {
              const rots = defRotArr(baseCamp);
              addPresent(date, baseCamp, rl, rots, mi[1], nm(mi[1])); pushEntry(date, baseCamp, mi[1], nm(mi[1]), rots, rl, '', 1, true);
              return;
            }
          }
        }
        if (EXCL_WORDS.some(function (w) { return flat.indexOf(w) > -1; })) return;

        let cell = flat;
        const mDyn = cell.match(/^([가-힣]+[0-9])\s*/);
        const dynCamp = mDyn ? mDyn[1] : '';
        const priority = dynCamp ? 1 : 0;
        let finalCamp = dynCamp || baseCamp;
        if (dynCamp) cell = cell.slice(mDyn[0].length).trim();
        cell = cell.replace(/\(\s*([A-Za-z][A-Za-z0-9_]{2,})\s*\)/g, '').replace(/\[[^\]]*]/g, '').trim();
        let per = {};
        cell = pullRouteRots(cell, per);
        let rotation = '';
        const mR = cell.match(/\(\s*([^)]+?)\s*\)/);
        if (mR) { rotation = mR[1].replace(/\s+/g, ''); cell = cell.replace(/\([^)]*\)/g, '').trim(); }
        cell = cell.replace(/업무등록/g, '').trim();
        let code;
        if (cell === '출근' || (/업무등록/.test(flat) && !/\d+[A-Za-z]+/.test(flat))) {
          code = base.routes; per = base.per;
          if (!rotation && base.rot) rotation = base.rot;
        } else code = cell;
        const parts = String(code).split(/\s+/);
        if ((campStr === '백업' || campStr === '운영자') && parts.length >= 2 && !dynCamp) { finalCamp = parts[0].substr(0, 3); code = parts[1]; }
        else if (parts.length >= 2 && /^\d+[A-Za-z]+$/.test(parts[1])) code = parts[1];
        let rl = routeExpand(code);
        const fromText = cell.match(/\d+[A-Za-z]+/g) || [];
        if (!rl.length && fromText.length) fromText.forEach(function (rc) { rl = rl.concat(routeExpand(rc)); });
        // 캠프를 안 적은 백업·직원 칸: 노선관리에서 그 노선이 한 캠프에만 있으면 그 캠프로
        if (!campReal[finalCamp] && rl.length) { const cs = {}; rl.forEach(function (x) { (routeCamps[x] || []).forEach(function (c) { cs[c] = 1; }); }); const k = Object.keys(cs); if (k.length === 1) finalCamp = k[0]; }
        if (!campReal[finalCamp]) return; // 캠프를 알 수 없는 칸은 업로드 줄로 만들지 않음
        const routeHasKey = hasKeyword(rl.join(','));
        let rots = normRot(rotation);
        if (!rots.length) rots = defRotArr(finalCamp);
        const include = rl.length && (hasWork(flat) || routeHasKey || isValidRouteList(rl.join(',')));
        let effId = id;
        if (idFromParen) effId = idFromParen;
        else {
          const toks = flat.split(/\s+/).filter(Boolean);
          const last = toks[toks.length - 1];
          if (toks.length && /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(last)) effId = last;
        }
        if (include) {
          const effNm = nm(effId) || nm(id);
          addPresent(date, finalCamp, rl, rots, effId, effNm, per);
          // 쿠팡 한 줄 = 회전 하나: 노선별 회전이 다르면 합집합으로 (205C(D1),205D → D1,D2,F3 / 205C,205D)
          const union = {}; rl.forEach(function (rt) { (per[rt] || rots).forEach(function (x) { union[x] = 1; }); });
          const rowRots = rotSort(Object.keys(union));
          const miss = defRotArr(finalCamp).filter(function (x) { return rowRots.indexOf(x) < 0; });
          pushEntry(date, finalCamp, effId, effNm, rowRots, rl, miss.length ? '미입차(' + miss.join(',') + ')' : '', priority, hasWork(flat) || routeHasKey);
        }
      });
    });

    entries.sort(function (p, q) {
      if (p.row[0] !== q.row[0]) return p.row[0] < q.row[0] ? -1 : 1;
      if (p.priority !== q.priority) return q.priority - p.priority;
      const c = String(p.row[2]).localeCompare(String(q.row[2])); if (c) return c;
      return String(p.row[4]).localeCompare(String(q.row[4]));
    });
    res.weeks[widx] = entries.map(function (e) { return e.row; });
    res.keys[widx] = entries.map(function (e) { return e.mark ? 1 : 0; });

    // 주 7일: 아이디 하나가 일~토 한 주에 출근 7일 (쿠팡 규칙: 주 6일까지, 일요일에 리셋)
    Object.keys(idDays).forEach(function (k) {
      const w = idDays[k], ds = Object.keys(w.dates).sort();
      if (ds.length < (opt.maxDays || 6) + 1) return;
      res.over7.push([dates[0], opt.bizNo, Object.keys(w.camps).sort().join(','), opt.wave, w.id, '주7일', '', ds.map(function (d) { return d.slice(5).replace('-', '/'); }).join(','),
        '한 주 출근 ' + ds.length + '일 · 하루는 서브 아이디로 바꾸거나 휴무', '', w.name]);
    });

    // 미입차
    const gm = {};
    const addMissing = function (t, camp, rt, rot) { const k = [t, camp, rt].join('|'); (gm[k] = gm[k] || {})[rot] = 1; };
    // 미입차 사유: 그 노선 주인(기본노선 기사)에게 그날 이슈가 있으면 비고에
    const whyOf = function (k) {
      const dt = k.split('|')[0];
      return (vendorOwner[k] || []).map(function (n) { return '용차업체 ' + n; }).concat(vacant[k] ? ['담당 없음'] : []).concat((baseOwner[k] || []).map(function (id) { return issueBy[dt + '|' + id] || (leftInfo[id] && dt >= leftInfo[id].from ? leftInfo[id].name + ' 퇴사' : ''); })).filter(Boolean);
    };
    const byRoute = {};
    Object.keys(present).forEach(function (p) {
      const s = p.split('|'), k = [s[0], s[1], s[2]].join('|');
      (byRoute[k] = byRoute[k] || {})[s[3]] = 1;
    });
    Object.keys(byRoute).forEach(function (k) {
      const s = k.split('|');
      defRotArr(s[1]).filter(function (x) { return !byRoute[k][x]; }).forEach(function (x) { addMissing(s[0], s[1], s[2], x); });
    });
    explicitMi.forEach(function (x) {
      routeExpand(x.defRt).forEach(function (rt) {
        defRotArr(x.baseCamp).forEach(function (rot) { if (!present[[x.date, x.baseCamp, rt, rot].join('|')]) addMissing(x.date, x.baseCamp, rt, rot); });
      });
    });
    // 용차업체 맡은 노선 (러너가 직접 쓰는 장기 용차): 우리 인원이 안 들어간 날은 쿠팡엔 미입차로 · 비고 '용차업체 OOO'
    (data.vendorRoutes || []).forEach(function (v) {
      const camp = short(v.camp);
      dates.forEach(function (date) {
        if (date < opt.target || (v.from && date < v.from) || (v.to && date > v.to)) return;
        v.units.forEach(function (rt) { const bk = [date, camp, rt].join('|'); baseRouteSet[bk] = 1; const a = vendorOwner[bk] || (vendorOwner[bk] = []); if (a.indexOf(v.name) < 0) a.push(v.name); });
      });
    });
    // 기사스케줄 '담당 없음' 창에서 그날만 용차업체로 지정한 노선: 비고가 '담당 없음' 대신 '용차업체 OOO' 로 나가게
    (data.vendorDays || []).forEach(function (x) {
      const camp = campById[x.campId];
      if (!camp || dates.indexOf(x.date) < 0 || x.date < opt.target) return;
      routeExpand(x.code).forEach(function (rt) { const bk = [x.date, camp, rt].join('|'); baseRouteSet[bk] = 1; const a = vendorOwner[bk] || (vendorOwner[bk] = []); if (a.indexOf(x.name) < 0) a.push(x.name); });
    });
    // 담당 없음 노선 (노선관리에 사용 중인데 그날 기본노선 주인도, 용차업체도 없음): 아무도 안 뛰면 미입차로 · 비고 '담당 없음'
    //  (화면 아래 '미입차 노선' 줄과 같게 · 이관 예약으로 그날부터 다른 캠프로 옮겨 가는 노선은 뺀다 — 적용일에 자동 정지됨)
    const movedOut = function (cid, rt, date) { return (data.rcMoves || []).some(function (m) { return m.fromCampId === cid && m.date <= date && String(rt).indexOf(String(m.fromRoute)) === 0; }); };
    Object.keys(data.routes || {}).forEach(function (cid) {
      const camp = campById[cid];
      if (!camp || !campReal[camp]) return;
      (data.routes[cid] || []).forEach(function (code) {
        routeExpand(code).forEach(function (rt) {
          dates.forEach(function (date) {
            if (date < opt.target) return;
            const bk = [date, camp, rt].join('|');
            if (baseRouteSet[bk] || movedOut(cid, rt, date)) return;
            baseRouteSet[bk] = 1; vacant[bk] = 1;
          });
        });
      });
    });
    Object.keys(baseRouteSet).forEach(function (k) {
      const s = k.split('|');
      const covered = defRotArr(s[1]).some(function (rot) { return present[[s[0], s[1], s[2], rot].join('|')]; });
      if (!covered) defRotArr(s[1]).forEach(function (rot) { addMissing(s[0], s[1], s[2], rot); });
    });
    const byRot = {};
    Object.keys(gm).forEach(function (k) {
      const s = k.split('|'), rotText = Object.keys(gm[k]).sort().join(',');
      const g = [s[0], s[1], rotText, (vendorOwner[k] || []).join(','), vacant[k] ? 'V' : ''].join('|'); // 용차업체·담당 없음 노선은 따로 한 줄 (사유가 섞이지 않게)
      const x = byRot[g] = byRot[g] || { date: s[0], camp: s[1], rotText: rotText, routes: [], why: [] };
      x.routes.push(s[2]);
      whyOf(k).forEach(function (w) { if (x.why.indexOf(w) < 0) x.why.push(w); });
    });
    Object.keys(byRot).forEach(function (g) {
      const x = byRot[g];
      res.missing.push([x.date, opt.bizNo, x.camp, opt.wave, '미입차', '미입차', x.rotText, x.routes.sort().join(','), x.why.length ? '사유: ' + x.why.join(', ') : '', '', '']);
    });

    // 중복
    const dupBy = {};
    Object.keys(dupe).forEach(function (k) {
      const d0 = dupe[k], d = d0.pids.length ? { ids: d0.pids, names: d0.pnames } : d0;
      if (d.ids.length <= 1 && d.names.length <= 1) return;
      const s = k.split('|'), g = [s[0], s[1], s[2]].join('|');
      const x = dupBy[g] || (dupBy[g] = { date: s[0], camp: s[1], route: s[2], rots: {}, ids: [], names: [] });
      x.rots[s[3]] = 1;
      d.ids.forEach(function (v) { if (x.ids.indexOf(v) < 0) x.ids.push(v); });
      d.names.forEach(function (v) { if (x.names.indexOf(v) < 0) x.names.push(v); });
    });
    Object.keys(dupBy).forEach(function (g) {
      const x = dupBy[g], pairs = [];
      for (let i = 0; i < Math.max(x.ids.length, x.names.length); i++) {
        const n = x.names[i] || '', v = x.ids[i] || '';
        pairs.push(n && v ? n + '(' + v + ')' : n || v);
      }
      res.dups.push([x.date, opt.bizNo, x.camp, opt.wave, '중복', '중복', Object.keys(x.rots).sort().join(','), x.route,
        pairs.length ? '중복: ' + pairs.join(', ') : '중복', '', x.names.join(', ')]);
    });
  });
  const sortRows = function (p, q) {
    if (p[0] !== q[0]) return p[0] < q[0] ? -1 : 1;
    const c = String(p[2]).localeCompare(String(q[2])); if (c) return c;
    const r = String(p[7]).localeCompare(String(q[7])); if (r) return r;
    return String(p[6]).localeCompare(String(q[6]));
  };
  res.missing.sort(sortRows);
  res.dups.sort(sortRows);
  res.over7.sort(sortRows);
  return res;
}

/** 아이디 확인: 출근 줄의 아이디가 정산관리 아이디 관리에 없거나(벤더 미등록) 정지면 막는다 */
function schCheckIds_(res) {
  let X;
  try { X = stlIds_(stlDrivers_()); } catch (e) { res.idCheckError = String(e && e.message || e); X = null; }
  if (!X) { res.level = (res.dups.length || res.over7.length) ? 'red' : res.missing.length ? 'orange' : 'green'; return res; }
  const seen = {};
  [].concat.apply([], res.weeks).filter(function (r) { return !res.weekEnd || String(r[0]) <= res.weekEnd; }).forEach(function (r) {
    const id = String(r[4] || ''), k = stlLogin_(id);
    if (!k) return;
    const x = X.by[k];
    const why = !x ? '미등록' : x.stopped && (!x.stopFrom || String(r[0]) >= x.stopFrom) ? '정지' : '';
    if (!why) return;
    const g = seen[k] || (seen[k] = { id: id, why: why, camps: {}, dates: {}, name: r[10] || (x ? x.ownerName : '') });
    g.dates[r[0]] = 1; if (r[2]) g.camps[r[2]] = 1;
  });
  Object.keys(seen).forEach(function (k) {
    const g = seen[k], ds = Object.keys(g.dates).sort();
    res.badId.push([ds[0], res.bizNo, Object.keys(g.camps).sort().join(','), res.wave, g.id, g.why, '', ds.map(function (d) { return d.slice(5).replace('-', '/'); }).join(','),
      g.why === '정지' ? '아이디 관리에서 정지 상태 · 정지 풀기 또는 다른 아이디로' : '정산관리 아이디 관리에 없는 아이디 · 등록 뒤 올리기', '', g.name]);
  });
  res.badId.sort(function (p, q) { return String(p[4]).localeCompare(String(q[4])); });
  // 신호등: 빨강 = 올리기 전에 고쳐야 함 (중복·주7일·아이디) / 주황 = 미입차만 / 초록
  res.level = (res.dups.length || res.over7.length || res.badId.length) ? 'red' : res.missing.length ? 'orange' : 'green';
  return res;
}

/** 스케줄 DB 파일 '어드민 업로드' 탭에 운영시트와 같은 배치로 쓴다. 반환: 탭 주소 */
function schWriteUpload_(res) {
  const book = schSS_();
  let up = book.getSheetByName(UPLOAD.SHEET);
  const W = UPLOAD.HEAD.length;
  if (!up) {
    up = book.insertSheet(UPLOAD.SHEET);
    if (up.getMaxColumns() < UPLOAD.RIGHT_COL + W) up.insertColumnsAfter(up.getMaxColumns(), UPLOAD.RIGHT_COL + W - up.getMaxColumns());
    up.getRange(1, UPLOAD.LEFT_COL, 1, 2).setValues([['주차1번', '2주 스케쥴']]);
    up.getRange(1, UPLOAD.RIGHT_COL, 1, 2).setValues([['주차2번', '확인사항']]);
    up.getRange(2, UPLOAD.LEFT_COL, 1, W).setValues([UPLOAD.HEAD]);
    up.getRange(2, UPLOAD.RIGHT_COL, 1, W).setValues([UPLOAD.HEAD]);
    up.getRange(1, 1, 2, UPLOAD.RIGHT_COL + W).setFontWeight('bold');
    up.setFrozenRows(2);
    up.getRange(1, UPLOAD.LEFT_COL).setNote('러너 올인원 기사스케줄 > "어드민 업로드 테이블" 을 누를 때마다 3행부터 새로 만들어집니다.');
  }
  const nW = res.weeks.reduce(function (a, w) { return a + w.length; }, 0);
  const need = UPLOAD.START_ROW + nW + res.missing.length + UPLOAD.GAP * (res.weeks.length + 1) + res.weeks.length;
  const needR = UPLOAD.START_ROW + res.dups.length + res.missing.length + 4;
  const rowsNeed = Math.max(need, needR);
  if (up.getMaxRows() < rowsNeed) up.insertRowsAfter(up.getMaxRows(), rowsNeed - up.getMaxRows());
  if (up.getMaxColumns() < UPLOAD.RIGHT_COL + W - 1) up.insertColumnsAfter(up.getMaxColumns(), UPLOAD.RIGHT_COL + W - 1 - up.getMaxColumns());
  const maxRows = up.getMaxRows() - 2;
  if (maxRows > 0) {
    const clr = up.getRange(UPLOAD.START_ROW, UPLOAD.LEFT_COL, maxRows, UPLOAD.RIGHT_COL + W - UPLOAD.LEFT_COL);
    clr.clearContent(); clr.clearFormat();
  }
  const put = function (row, col, rows, bg) {
    if (!rows.length) return;
    const rng = up.getRange(row, col, rows.length, W);
    rng.setNumberFormat('@').setValues(rows.map(function (r) { return r.map(safeText_); }));
    rng.setBackgrounds(bg);
  };
  let rowL = UPLOAD.START_ROW;
  res.weeks.forEach(function (rows0, w) {
    const rows = res.weeks[w];
    if (!rows.length) { rowL += UPLOAD.GAP; return; }
    if (w >= 1) { up.getRange(rowL, UPLOAD.LEFT_COL, 1, W).setBackground(UPLOAD.COLOR.SEP); rowL++; }
    put(rowL, UPLOAD.LEFT_COL, rows, res.keys[w].map(function (k) { return new Array(W).fill(k ? UPLOAD.COLOR.KEY : '#FFFFFF'); }));
    rowL += rows.length + UPLOAD.GAP;
  });
  put(rowL, UPLOAD.LEFT_COL, res.missing, res.missing.map(function () { return new Array(W).fill(UPLOAD.COLOR.MI); }));
  let rowR = UPLOAD.START_ROW;
  put(rowR, UPLOAD.RIGHT_COL, res.dups, res.dups.map(function () { return new Array(W).fill(UPLOAD.COLOR.DUP); }));
  rowR += res.dups.length;
  if (res.missing.length) {
    rowR += 3;
    put(rowR, UPLOAD.RIGHT_COL, res.missing, res.missing.map(function () { return new Array(W).fill(UPLOAD.COLOR.MI); }));
  }
  return book.getUrl() + '#gid=' + up.getSheetId();
}

// ───────────────────────── 데이터 초기화 (메뉴별) ─────────────────────────
/*
 * 관리자 화면 각 메뉴의 "데이터 초기화". 확인 문구를 그대로 입력해야만 실행된다.
 * 지우기 전에 해당 시트들을 "러너 올인원 데이터/초기화 백업" 폴더에 새 구글시트로 복사해 둔다 (되살릴 때 사용).
 * 머리글(1행)과 설정값(회사 정보 등)은 남기고, 데이터 줄만 지운다.
 */
const RESET_PHRASE = '모조리 없앤다';
const RESET_SECTIONS = {
  drivers: { label: '기사 정보관리', sheets: [SH.DRIVERS] },
  sched: { label: '기사스케줄', sheets: [] },        // 스케줄 DB 파일의 schedule 탭
  route: { label: '노선관리', sheets: [SH.CAMPS, SH.ROUTES, SH.CIMG, SH.CADDR, SH.PRICES] },
  memo: { label: '업무스케줄', sheets: [SH.MEMO] },
  notice: { label: '공지사항', sheets: [SH.NOTICE] },
  accounts: { label: '계정관리', sheets: [SH.ACC] }, // 분류 목록(account_categories)은 남긴다
  bib: { label: '배번호 관리', sheets: [SH.BIB] },
  pumasi: { label: '품앗이', sheets: [SH.PJOB, SH.PAPP, SH.PAVAIL, SH.PALERT] } // 알림은 품앗이 알림만 (게시판 알림은 남김)
};
function resetFolder_() {
  const root = DriveApp.getFolderById(props_().ROOT_FOLDER_ID), it = root.getFoldersByName('초기화 백업');
  return it.hasNext() ? it.next() : root.createFolder('초기화 백업');
}
/** 시트들을 새 파일로 복사해 두고 그 주소를 돌려준다 */
function resetBackup_(label, sheets) {
  const book = SpreadsheetApp.create('러너 올인원 초기화 백업 - ' + label + ' - ' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HHmm'));
  try { DriveApp.getFileById(book.getId()).moveTo(resetFolder_()); } catch (e) { /* 폴더 이동 실패해도 백업은 유지 */ }
  const first = book.getSheets();
  sheets.forEach(function (sh) { sh.copyTo(book).setName(sh.getName()); });
  first.forEach(function (x) { if (book.getSheets().length > 1) book.deleteSheet(x); });
  return book.getUrl();
}
/** 머리글만 남기고 데이터 칸 비우기 (서식·드롭다운은 그대로) */
function clearData_(sh) {
  const last = sh.getLastRow(), w = Math.max(sh.getLastColumn(), 1);
  if (last < 2) return 0;
  const rng = sh.getRange(2, 1, last - 1, w);
  rng.clearContent();
  try { rng.clearNote(); } catch (e) { /* 무시 */ }
  return last - 1;
}

/** section = drivers / sched / route / memo / bib, confirm = 확인 문구 */
function adm_reset(token, section, confirm) {
  return run_(function () {
    const a = requireAdmin_(token);
    const sec = RESET_SECTIONS[section];
    if (!sec) fail_('알 수 없는 메뉴입니다.');
    if (str_(confirm) !== RESET_PHRASE) fail_('확인 문구가 다릅니다. "' + RESET_PHRASE + '" 를 그대로 입력해 주세요. 아무것도 지우지 않았습니다.');
    const lock = scriptLock_();
    lock.waitLock(30000);
    let rows = 0, backupUrl = '', trashed = 0, extra = '';
    const files = [];
    try {
      const sheets = section === 'sched' ? [schSheet_()] : sec.sheets.map(function (n) { return sheet_(n); });
      backupUrl = resetBackup_(sec.label, sheets);
      if (section === 'drivers') {
        const list = readAll_(SH.DRIVERS).filter(function (o) { return o.id || o.loginId; });
        list.forEach(function (o) {
          forgetDriver_(o);
          const m = String(o.docFolder || '').match(/folders\/([A-Za-z0-9_-]{10,})/);
          if (m) files.push(m[1]);
        });
        // 기사 로그인 기록도 지운다 (관리자 로그인은 그대로)
        const ss = sheet_(SH.SESSIONS), c = cols_(SH.SESSIONS, true), last = ss.getLastRow();
        if (last >= 2) {
          const vals = ss.getRange(2, 1, last - 1, c.__w).getValues();
          const keep = vals.filter(function (v) { return String(v[c.driverId]).indexOf(ADMIN_SESSION) === 0; });
          vals.forEach(function (v) { if (String(v[c.driverId]).indexOf(ADMIN_SESSION) !== 0) cache_().remove('ss:' + str_(v[c.tokenHash])); });
          ss.getRange(2, 1, last - 1, c.__w).clearContent();
          if (keep.length) ss.getRange(2, 1, keep.length, c.__w).setNumberFormat('@').setValues(keep.map(function (r) { return r.map(str_); }));
        }
        rows = clearData_(sheet_(SH.DRIVERS));
      } else if (section === 'sched') {
        const sh = schSheet_(), h = schHeader_(true);
        rows = clearData_(sh);
        const notes = [['NOTE1', '업무 관련']].map(function (x) {
          const line = new Array(5).fill('');
          line[h.fixed['행ID']] = x[0]; line[h.fixed['구분']] = SCH.KIND_NOTE; line[h.fixed['이름']] = x[1];
          return line;
        });
        sh.getRange(2, 1, 1, 5).setNumberFormat('@').setValues(notes);
      } else if (section === 'route') {
        readAll_(SH.CIMG).forEach(function (x) { const f = fileIdOf_(x.file); if (f) files.push(f); });
        sec.sheets.forEach(function (n) { rows += clearData_(sheet_(n)); });
        // 기사의 소속캠프도 비운다 (가리킬 캠프가 없어지므로)
        const dsh = sheet_(SH.DRIVERS), dc = cols_(SH.DRIVERS, true), dl = dsh.getLastRow();
        if (dl >= 2) { dsh.getRange(2, dc.schCampId + 1, dl - 1, 1).clearContent(); dsh.getRange(2, dc.schCamp + 1, dl - 1, 1).clearContent(); extra = '기사 소속캠프 비움'; }
        bumpMaster_();
      } else if (section === 'pumasi') {
        [SH.PJOB, SH.PAPP, SH.PAVAIL].forEach(function (n) { rows += clearData_(sheet_(n)); });
        const al = readAll_(SH.PALERT).filter(function (x) { return x.id && x.kind !== 'board'; }).map(function (x) { return x._row; }).sort(function (p, q) { return q - p; });
        delRows_(sheet_(SH.PALERT), al);
        rows += al.length;
        pmTouch_();
        try { readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) pmAlertBump_(o.id); }); } catch (e) { /* 무시 */ }
        extra = '기사스케줄의 품앗이 줄 기록은 남김';
      } else {
        rows = clearData_(sheet_(sec.sheets[0]));
        if (section === 'notice') cache_().remove('nt:all');
      }
      logAdmin_(a, '데이터 초기화', sec.label, rows + '줄 삭제' + (extra ? ', ' + extra : '') + ' · 백업: ' + backupUrl);
    } finally {
      lock.releaseLock();
    }
    // 드라이브 파일(기사 서류 폴더, 캠프 사진)은 휴지통으로 — 잠금 밖에서
    if (section === 'drivers') files.forEach(function (id) {
      try {
        const f = DriveApp.getFolderById(id), ps = f.getParents();
        while (ps.hasNext()) if (ps.next().getId() === props_().DOCS_FOLDER_ID) { f.setTrashed(true); trashed++; break; }
      } catch (e) { /* 이미 없음 */ }
    });
    if (section === 'route') files.forEach(function (id) { if (trashCampFile_(id)) trashed++; });
    return { ok: true, rows: rows, backupUrl: backupUrl, trashed: trashed };
  });
}

/** 기사 정보관리: 캠프·라우트 고르기용 목록 (노선관리 데이터, 캐시 사용) */
function adm_campRoutes(token) {
  return run_(function () {
    requireAdmin_(token);
    const m = master_();
    return {
      ok: true,
      camps: m.camps.map(function (c) { return { id: c.id, name: c.name, rot: c.rot }; }),
      routes: m.routes.map(function (r) { return { campId: r.campId, code: r.code, status: r.status, g1: r.g1 }; })
    };
  });
}

/**
 * 스케줄 DB 시트를 직접 고쳤을 때 (설치형 편집 트리거)
 * - 1행(날짜) 수정 → 머리글 캐시 삭제
 * - 새 줄에 이름(필요하면 캠프도)만 쓰면 기사 정보에서 같은 이름을 찾아 행ID(기사ID)·구분·캠프·기본노선을 자동으로 채운다
 *   캠프는 노선관리의 캠프명, 이름·기본노선은 기사 정보 그대로. 못 찾거나 여러 명이면 칸 메모로 알려 준다.
 */
function onSchEdit_(e, sh) {
  fsMark_('sch');
  const r0 = e.range.getRow(), n = e.range.getNumRows();
  if (r0 === 1) { cache_().remove('sch:h'); if (n === 1) return; }
  const lock = scriptLock_();
  try { lock.waitLock(40000); } catch (err) { return; } // 스케줄 시트는 가릴 값이 없어 못 잡으면 그냥 넘긴다 (다음 편집 때 정리)
  try {
    const h = schHeader_(true);
    const start = Math.max(2, r0), end = Math.min(r0 + n - 1, start + 199);
    if (end < start) return;
    const F = h.fixed, last = sh.getLastRow();
    const all = sh.getRange(2, 1, Math.max(last - 1, 1), 5).getValues();
    const rowOfId = {};
    all.forEach(function (v, i) { const id = str_(v[F['행ID']]); if (id && !rowOfId[id]) rowOfId[id] = i + 2; });
    const camps = master_().camps, campById = {};
    camps.forEach(function (c) { campById[c.id] = c; });
    const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.name; });
    const byId = {};
    drivers.forEach(function (o) { byId[o.id] = o; });
    const key = function (v) { return str_(v).replace(/\s+/g, '').toUpperCase(); };
    const campMatch = function (txt, c) { return c && (key(c.name) === key(txt) || key(c.name).replace(/캠프$/, '') === key(txt).replace(/캠프$/, '')); };
    const cell = function (r, k) { return sh.getRange(r, F[k] + 1); };
    let noteEdited = false;
    for (let r = start; r <= end; r++) {
      const v = all[r - 2] || [];
      const id = str_(v[F['행ID']]), kind = str_(v[F['구분']]), camp = str_(v[F['캠프']]), name = str_(v[F['이름']]);
      if (/^NOTE/.test(id)) { if (kind !== SCH.KIND_NOTE) cell(r, '구분').setValue(SCH.KIND_NOTE); noteEdited = true; continue; }
      if (id.indexOf(SCH_PM_PREFIX) === 0 && byId[id.slice(SCH_PM_PREFIX.length)]) { if (kind !== SCH.KIND_PM) cell(r, '구분').setValue(SCH.KIND_PM); cell(r, '행ID').clearNote(); continue; }
      if (schExParse_(id) && byId[schExParse_(id).driverId]) { if (kind !== SCH.KIND_DRIVER) cell(r, '구분').setValue(SCH.KIND_DRIVER); cell(r, '행ID').clearNote(); continue; } // 추가 배정 줄
      if (id) {
        const o = byId[id];
        if (o) {
          if (kind !== SCH.KIND_DRIVER) cell(r, '구분').setValue(SCH.KIND_DRIVER);
          cell(r, '행ID').clearNote();
        } else cell(r, '행ID').setNote('기사 정보에 없는 기사ID 입니다. 기사 정보관리에서 확인해 주세요.');
        continue;
      }
      if (!name) continue;
      if (kind === SCH.KIND_NOTE) { // 이름만 쓴 새 비고 줄
        let k = 1; while (rowOfId['NOTE' + k]) k++;
        cell(r, '행ID').setNumberFormat('@').setValue('NOTE' + k); rowOfId['NOTE' + k] = r;
        continue;
      }
      let cand = drivers.filter(function (o) { return key(o.name) === key(name); });
      let campNote = '';
      if (camp) {
        const c = camps.filter(function (x) { return campMatch(camp, x); })[0];
        if (!c) campNote = '노선관리에 없는 캠프명입니다.';
        else if (cand.length > 1) cand = cand.filter(function (o) { return o.schCampId === c.id; });
      }
      if (campNote) cell(r, '캠프').setNote(campNote); else cell(r, '캠프').clearNote();
      if (cand.length !== 1) {
        cell(r, '이름').setNote(cand.length ? '같은 이름의 기사가 여러 명입니다. 캠프를 적거나 행ID(기사ID)를 직접 입력해 주세요.'
          : '기사 정보에 없는 이름입니다. 기사 정보관리에서 먼저 등록해 주세요.');
        continue;
      }
      const o = cand[0];
      if (rowOfId[o.id] && rowOfId[o.id] !== r) { cell(r, '이름').setNote('이 기사의 줄이 이미 ' + rowOfId[o.id] + '행에 있습니다. 그 줄에 입력해 주세요.'); continue; }
      const c = campById[o.schCampId];
      const line = new Array(5);
      line[F['행ID']] = o.id; line[F['구분']] = SCH.KIND_DRIVER; line[F['캠프']] = c ? c.name : '';
      line[F['이름']] = o.name; line[F['기본노선']] = o.baseRoute;
      sh.getRange(r, 1, 1, 5).setNumberFormat('@').setValues([line.map(function (x) { return safeText_(x || ''); })]);
      cell(r, '이름').clearNote();
      rowOfId[o.id] = r;
    }
    // 시트에서 비고 줄 칸을 직접 고치면 업무스케줄 메모로 옮긴다
    if (noteEdited) { try { schMigrateNotes_(sh, h); } catch (err) { console.error(err); } }
    try { stlBump_(); } catch (err) { /* 정산 캐시 */ } // 정산서 근무일수(기사스케줄 기준) 캐시도 새로
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── 노선 변경 예약 (날짜부터 캠프·기본노선 바꾸기 / 쿠팡 노선 이관) ─────────────────────────
/*
 * route_changes 시트 한 줄 = 변경 하나.
 *  - 종류 '기사': 그 기사의 소속캠프·기본노선을 적용일부터 바꾼다.
 *  - 종류 '노선이관': 쿠팡이 노선을 통째로 옮긴 것 (예: 안양1캠프 110 → 군포1캠프 212). 이전 노선 칸 = 숫자(구분1).
 *    그 노선을 맡은 기사들은 같은 날짜의 '기사' 줄로 같이 만들어지고(이관ID), 적용일에 옛 노선은 정지된다.
 * 날짜별 캠프·기본노선은 rcAt_ 으로 계산한다 (기사스케줄 표시, 어드민 업로드 테이블, 기사 앱).
 * 적용일이 되면 기사 정보의 소속캠프·기본노선도 바뀐다 (화면을 열 때·매일 새벽 정리 때).
 */
let _rcRows = null;
function rcRows_(fresh) {
  if (_rcRows && !fresh) return _rcRows;
  let rows = [];
  try { rows = readAll_(SH.RCHG).filter(function (o) { return o.id && o.status !== RCS.OFF; }); } catch (e) { rows = []; }
  rows.forEach(function (o) { o.date = normDate_(o.date) || o.date; });
  return (_rcRows = rows);
}
function rcTouch_() { _rcRows = null; try { cache_().remove('rc:due:' + todayText_()); } catch (e) { /* 무시 */ } try { if (typeof rpfBump_ === 'function') rpfBump_(); } catch (e) { /* 무시 */ } } // 노선 변경·이관 = 라우트 계보 → 기사앱 내 수행률 캐시도 새로
const rcSort_ = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0); };
/** 기사ID → 그 기사의 변경 목록 (적용일 순) */
function rcByDriver_() {
  const by = {};
  rcRows_().forEach(function (c) { if (c.kind !== RCK.MOVE && c.driverId) (by[c.driverId] = by[c.driverId] || []).push(c); });
  Object.keys(by).forEach(function (k) { by[k].sort(rcSort_); });
  return by;
}
/**
 * 그날 기사의 { campId, camp, baseRoute }. cur = 지금 기사 정보.
 * 오늘 이후: 지금 정보에 그날까지의 예약을 차례로 얹는다. 지난 날: 이력(그날 이전 마지막 변경의 새 값, 없으면 첫 변경의 이전 값).
 */
function rcAt_(cur, list, date, today) {
  const base = { campId: cur.campId || '', camp: cur.camp || '', baseRoute: cur.baseRoute || '' };
  if (!list || !list.length) return base;
  today = today || todayText_();
  const pick = function (c) { return { campId: c.toCampId || '', camp: c.toCamp || '', baseRoute: c.toRoute || '', change: c }; };
  if (date >= today) {
    let v = base;
    list.forEach(function (c) { if (c.status === RCS.WAIT && c.date <= date) v = pick(c); });
    return v;
  }
  let hit = null;
  list.forEach(function (c) { if (c.date <= date) hit = c; });
  if (hit) return pick(hit);
  return { campId: list[0].fromCampId || '', camp: list[0].fromCamp || '', baseRoute: list[0].fromRoute || '' };
}
/** 보는 기간 안에서 캠프·노선이 같은 구간들. 지금 정보와 하나도 다르지 않으면 null */
function rcSegs_(cur, list, dates) {
  if (!list || !list.length || !dates.length) return null;
  const today = todayText_(), segs = [];
  dates.forEach(function (d) {
    const v = rcAt_(cur, list, d, today), last = segs[segs.length - 1];
    if (last && last.campId === v.campId && last.baseRoute === v.baseRoute) { last.to = d; return; }
    segs.push({ from: d, to: d, campId: v.campId, camp: v.camp, baseRoute: v.baseRoute, changeId: v.change ? v.change.id : '' });
  });
  if (segs.length === 1 && segs[0].campId === (cur.campId || '') && segs[0].baseRoute === (cur.baseRoute || '')) return null;
  return segs;
}
function rcView_(c, campName) {
  const nm = function (id, fb) { return (campName && id && campName[id]) || fb || ''; };
  return {
    id: c.id, kind: c.kind, date: c.date, driverId: c.driverId, name: c.name, status: c.status, parentId: c.parentId, memo: c.memo,
    fromCampId: c.fromCampId, fromCamp: nm(c.fromCampId, c.fromCamp), fromRoute: c.fromRoute,
    toCampId: c.toCampId, toCamp: nm(c.toCampId, c.toCamp), toRoute: c.toRoute, admin: c.admin, createdAt: c.createdAt, appliedAt: c.appliedAt
  };
}
function rcCampNames_() { const m = {}; master_().camps.forEach(function (c) { m[c.id] = c.name; }); return m; }

/** 적용일이 된 예약을 적용한다 (기사 정보 바꾸기, 이관된 옛 노선 정지). 하루에 몇 번만 실제로 확인한다 */
function rcApplyDue_() {
  const today = todayText_(), ck = 'rc:due:' + today;
  try { if (cache_().get(ck)) return 0; } catch (e) { /* 무시 */ }
  const due = function () { return rcRows_(true).filter(function (c) { return c.status === RCS.WAIT && c.date && c.date <= today; }).sort(rcSort_); };
  if (!due().length) { try { cache_().put(ck, '1', 1800); } catch (e) { /* 무시 */ } return 0; }
  const lock = scriptLock_();
  lock.waitLock(20000);
  let n = 0;
  try {
    const now = nowText_();
    due().forEach(function (c) { rcApply_(c, now); n++; });
    if (n) { bumpMaster_(); rcTouch_(); }
  } finally { lock.releaseLock(); }
  try { cache_().put(ck, '1', 1800); } catch (e) { /* 무시 */ }
  return n;
}
/** 잠금 안에서: 변경 하나 적용 */
function rcApply_(c, now) {
  if (c.kind === RCK.MOVE) {
    readAll_(SH.ROUTES).forEach(function (r) {
      if (r.campId !== c.fromCampId || splitCode_(r.code).g1 !== c.fromRoute) return;
      writeFields_(SH.ROUTES, r._row, { status: RST.OFF, memo: (r.memo ? r.memo + ' / ' : '') + c.date + ' ' + c.toCamp + ' ' + c.toRoute + '(으)로 이관', updatedAt: now });
    });
  } else {
    const o = driverById_(c.driverId);
    if (o) {
      writeFields_(SH.DRIVERS, o._row, { schCampId: c.toCampId, schCamp: c.toCamp, baseRoute: c.toRoute, updatedAt: now });
      forgetDriver_(o);
    }
  }
  if (c._row) writeFields_(SH.RCHG, c._row, { status: RCS.DONE, appliedAt: now });
  c.status = RCS.DONE; c.appliedAt = now;
  fsMark_('sch'); // 적용일이 되어 캠프·노선이 바뀜 → 열려 있는 기사스케줄이 바로 새로 받는다
}

/** 기본노선 글자 → 노선 조각들. '110AB, 116C (F3) [B01]' → [{num:'110', letters:'AB'}, {num:'116', letters:'C'}] (백업·용차는 special) */
function rcUnits_(baseRoute) {
  const s = str_(baseRoute).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').toUpperCase();
  if (/백업|예비|용차/.test(s)) return { special: true, units: [] };
  const units = [];
  let lastNum = '';
  s.split(/[\s,]+/).forEach(function (t) {
    let m = t.match(/^(\d+)([A-Z]*)$/);
    if (m) { lastNum = m[1]; units.push({ num: m[1], letters: m[2] }); return; }
    m = t.match(/^([A-Z]+)$/);
    if (m && lastNum) units.push({ num: lastNum, letters: m[1] });
  });
  return { special: false, units: units };
}
/** 저장 전에 알려 줄 것들 (막지는 않음) */
function rcWarnings_(o, date, toCampId, toRoute, fromCampId, fromRoute, skipVacant) {
  const out = [], m = master_(), campName = {};
  m.camps.forEach(function (c) { campName[c.id] = c.name; });
  const short = function (id) { return String(campName[id] || '').replace(/\s*캠프$/, ''); };
  const u = rcUnits_(toRoute);
  const tk = { '고정': 'p2', '백업': 'p3', '품앗이': 'p4', '외부용차': 'p5' }[o.driverType] || 'p2';
  const tl = { p2: '고정단가', p3: '백업단가', p4: '품앗이단가', p5: '외부용차단가' }[tk];
  u.units.forEach(function (x) {
    const rts = m.routes.filter(function (r) { return r.campId === toCampId && r.g1 === x.num; });
    if (!rts.length) { out.push(short(toCampId) + ' ' + x.num + ' 노선이 노선관리에 없습니다.'); return; }
    String(x.letters || '').split('').forEach(function (ch) {
      if (!rts.some(function (r) { return [r.g2, r.g3, r.g4, r.g5].indexOf(ch) >= 0; })) { out.push(short(toCampId) + ' ' + x.num + ch + ' 노선이 노선관리에 없습니다.'); return; }
      const p = m.prices.filter(function (pr) { return pr.campId === toCampId && pr.num === x.num && pr.value === ch && Number(pr[tk]) > 0; });
      if (!p.length) out.push(short(toCampId) + ' ' + x.num + ch + ' ' + tl + '가 비어 있습니다 (정산 때 단가 없음).');
    });
  });
  // 기사 일시단가가 적용일 뒤까지 걸려 있으면
  try {
    if (typeof stlRead_ === 'function') stlRead_('stl_tmp').forEach(function (t) {
      if (t.driverId !== o.id) return;
      if (t.to && t.to < date) return;
      out.push('기사 일시단가(' + (t.from || '') + '~' + (t.to || '') + ' ' + (t.routes || '전체 노선') + ')가 적용일 뒤까지 걸려 있습니다. 정산관리에서 확인해 주세요.');
    });
  } catch (e) { /* 정산 DB 없음 */ }
  // 옛 노선을 이어 맡을 기사가 없으면 (업로드 테이블에서 미입차로도 안 잡히므로)
  if (!skipVacant && fromCampId && fromRoute) {
    const by = rcByDriver_(), today = todayText_();
    const covered = {};
    readAll_(SH.DRIVERS).forEach(function (d) {
      if (!d.id || d.id === o.id || d.status !== ST.ACTIVE) return;
      const v = rcAt_({ campId: d.schCampId, camp: d.schCamp, baseRoute: d.baseRoute }, by[d.id], date, today);
      if (v.campId !== fromCampId) return;
      rcUnits_(v.baseRoute).units.forEach(function (x) { String(x.letters || '').split('').forEach(function (ch) { covered[x.num + ch] = 1; }); });
    });
    const left = [];
    rcUnits_(fromRoute).units.forEach(function (x) {
      const nu = rcUnits_(toRoute).units;
      String(x.letters || '').split('').forEach(function (ch) {
        if (fromCampId === toCampId && nu.some(function (y) { return y.num === x.num && y.letters.indexOf(ch) >= 0; })) return;
        if (!covered[x.num + ch]) left.push(x.num + ch);
      });
    });
    if (left.length) out.push(date.slice(5).replace('-', '/') + '부터 ' + short(fromCampId) + ' ' + left.join(',') + ' 담당 기사가 없습니다. 다른 기사에게 넘기거나, 노선이 없어졌으면 노선관리에서 정지해 주세요.');
  }
  return out;
}
/** 잠금 안에서: 기사 한 명 변경 만들기. 같은 기사·같은 새 노선 예약이 14일 안에 이미 있으면 그것을 쓴다 */
function rcAddDriver_(a, o, date, toCampId, toRoute, memo, parentId) {
  const campName = rcCampNames_();
  if (toCampId && !campName[toCampId]) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
  toRoute = normBaseRoute_(toRoute);
  const today = todayText_(), now = nowText_();
  const list = rcByDriver_()[o.id] || [];
  const same = list.filter(function (c) {
    return c.status === RCS.WAIT && c.toCampId === toCampId && normBaseRoute_(c.toRoute) === toRoute &&
      Math.abs((parseYmd_(c.date) - parseYmd_(date)) / 864e5) <= 14;
  })[0];
  if (same) {
    if (date < same.date) { writeFields_(SH.RCHG, same._row, { date: date }); same.date = date; rcTouch_(); }
    return { change: same, dup: true };
  }
  const prev = rcAt_({ campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute }, list, ymd_(addDays_(parseYmd_(date), -1)), today);
  const row = {
    id: uniqId_('RC'), kind: RCK.DRV, date: date, driverId: o.id, name: o.name,
    fromCampId: prev.campId, fromCamp: campName[prev.campId] || prev.camp || '', fromRoute: prev.baseRoute,
    toCampId: toCampId, toCamp: campName[toCampId] || '', toRoute: toRoute, status: RCS.WAIT, parentId: parentId || '',
    memo: str_(memo).slice(0, 300), admin: a.name, createdAt: now, appliedAt: ''
  };
  // 같은 날짜의 예전 예약은 새 것으로 바꾼다 (취소)
  list.filter(function (c) { return c.status === RCS.WAIT && c.date === date; }).forEach(function (c) { writeFields_(SH.RCHG, c._row, { status: RCS.OFF, memo: (c.memo ? c.memo + ' / ' : '') + '같은 날 새 예약으로 바뀜' }); });
  row._row = appendObj_(SH.RCHG, row);
  rcTouch_();
  if (date <= today) { rcApply_(row, now); rcTouch_(); }
  return { change: row, dup: false };
}

/** 관리자: 예약 목록 (최근 300개) + 캠프 */
function adm_rcList(token) {
  return run_(function () {
    requireAdmin_(token);
    rcApplyDue_();
    const campName = rcCampNames_();
    let all = [];
    try { all = readAll_(SH.RCHG).filter(function (o) { return o.id; }); } catch (e) { all = []; }
    all.forEach(function (o) { o.date = normDate_(o.date) || o.date; });
    all.sort(function (a, b) { return rcSort_(b, a); });
    const m = master_(), nums = {};
    m.routes.forEach(function (r) { if (!r.g1) return; const l = nums[r.campId] = nums[r.campId] || []; if (!l.some(function (x) { return x.num === r.g1; })) l.push({ num: r.g1, code: r.code, off: r.status === RST.OFF }); });
    return {
      ok: true, today: todayText_(), changes: all.slice(0, 300).map(function (c) { return rcView_(c, campName); }),
      camps: m.camps.map(function (c) { return { id: c.id, name: c.name }; }), nums: nums
    };
  });
}
/** 관리자: 기사 한 명 노선 변경 예약. f = { driverId, date, toCampId, toRoute, memo } (적용일이 오늘 이전이면 바로 적용) */
function adm_rcSave(token, f) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    f = f || {};
    const date = normDate_(f.date);
    if (!date) fail_('적용일을 확인해 주세요.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const o = driverById_(str_(f.driverId));
      if (!o) fail_('기사를 찾을 수 없습니다.');
      const r = rcAddDriver_(a, o, date, str_(f.toCampId), str_(f.toRoute), f.memo, '');
      const c = r.change;
      const warnings = rcWarnings_(o, date, c.toCampId, c.toRoute, c.fromCampId, c.fromRoute, false);
      logAdmin_(a, '노선 변경 예약', o.name + ' (' + o.id + ')', date + ' ' + (c.fromCamp || '') + ' ' + (c.fromRoute || '') + ' → ' + c.toCamp + ' ' + c.toRoute + (c.status === RCS.DONE ? ' (바로 적용)' : ''));
      return { ok: true, change: rcView_(c, rcCampNames_()), dup: r.dup, warnings: warnings };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 관리자: 이미 바뀐 캠프·노선의 '적용일'을 앞당기거나 늦추기 (늦게 입력했을 때 · 지난 날짜로 정정)
 *  f = { driverId, date } → 그 기사의 가장 최근 '적용' 변경의 날짜를 date 로. 기사 정보(지금 캠프·노선)는 그대로
 *  date 는 오늘 이전·당일, 그 앞 변경의 날짜보다 뒤여야 한다. 스케줄은 그날부터 새 캠프 줄에 보인다 (정산은 아이디 기준이라 그대로)
 */
/**
 * 적용일을 앞당길 때 칸의 뜻 지키기: 그 사이 날짜 칸은 '이전 캠프·노선' 기준으로 적힌 글자라, 새 캠프 줄로 넘어가면 뜻이 바뀐다
 *  ('110CD' = 안양1 110CD 였는데 캠프 없음 줄에서는 어느 캠프인지 알 수 없음 → 미입차 계산이 틀어짐)
 *  → '출근' 은 '이전캠프 이전노선', 캠프 없이 적힌 노선은 '이전캠프 노선' 으로 바꿔 적는다. 휴무·미입차·이미 캠프가 적힌 칸은 그대로.
 * days = [{ date, campId, camp, base }] (그날의 이전 기준) → 바꾼 칸 수
 */
function rcKeepCellCamp_(driverId, days, toCampId, toRoute) {
  if (!days.length || !props_().SCH_DB_ID || !schSS_().getSheetByName(SCH.SHEET)) return 0;
  const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
  if (last < 2) return 0;
  const cell = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).createTextFinder(String(driverId)).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return 0;
  let n = 0;
  days.forEach(function (x) {
    const c = h.dates[x.date];
    if (c === undefined) return;
    const sameCamp = str_(x.campId) === str_(toCampId), base = str_(x.base);
    if (sameCamp && base === str_(toRoute)) return;
    const rng = sh.getRange(cell.getRow(), c + 1), v = str_(rng.getValue());
    if (!v) return;
    const short = str_(x.camp).replace(/\s*캠프\s*$/, '').replace(/\s+/g, ''), pre = sameCamp ? '' : (short ? short + ' ' : null), baseOk = /^\d/.test(base);
    if (pre === null) return;
    let nv = v;
    if (v === '출근') { if (baseOk) nv = pre + base; }
    else if (/^\d{3,4}[A-Za-z]/.test(v)) { if (!sameCamp) nv = pre + v; }
    else if (/^\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)\s*업무등록$/.test(v)) { if (baseOk) nv = pre + base + ' ' + v; }
    if (nv !== v) { rng.setValue(nv); n++; }
  });
  return n;
}
function adm_rcSetDate(token, f) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    f = f || {};
    const date = normDate_(f.date), today = todayText_();
    if (!date) fail_('날짜를 확인해 주세요.');
    if (date > today) fail_('앞으로의 날짜는 예약으로 넣어 주세요.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      rcTouch_();
      const list = (rcByDriver_()[str_(f.driverId)] || []).filter(function (c) { return c.status === RCS.DONE; });
      const c = list[list.length - 1];
      if (!c) fail_('이 기사는 바뀐 캠프·노선 기록이 없습니다. 캠프·노선을 고르고 날짜를 넣어 주세요.');
      // 새 적용일이 그 앞 변경들보다 앞이면: 그 사이 변경은 뜻이 없어지므로(그날부터 이미 지금 캠프·노선) 물어본 뒤 지우고 정정한다
      const over = list.slice(0, -1).filter(function (x) { return x.date >= date; });
      if (over.length && !f.force) {
        return { ok: false, need: 'merge', msg: c.name + ' 기사님은 ' + date + ' 이후에 바뀐 기록이 ' + over.length + '건 더 있습니다.\n' +
          over.map(function (x) { return ' · ' + x.date + ' → ' + ((x.toCamp || '') + ' ' + (x.toRoute || '')).trim(); }).join('\n') +
          '\n\n이 기록을 지우고, ' + date + '부터 지금 캠프·노선(' + ((c.toCamp || '') + ' ' + (c.toRoute || '')).trim() + ')인 것으로 고칠까요?\n(기사스케줄 줄 나눔만 바뀝니다 · 칸 내용과 정산은 그대로)' };
      }
      const old = c.date, first = over[0];
      // 앞당겨지는 날짜들의 '이전 기준'(캠프·노선)을 기록을 고치기 전에 구해 둔다 → 칸 글자에 이전 캠프를 붙여 뜻을 지킨다
      const keep = [];
      if (date < old) {
        for (let dd = date; dd < old; dd = addDaysText_(dd, 1)) { const x = rcAt_({}, list, dd, today); keep.push({ date: dd, campId: x.campId, camp: x.camp, base: x.baseRoute }); }
      } else if (date === old) {
        // 이미 앞당겨 둔 기록을 같은 날짜로 다시 저장: 예전에 앞당길 때 못 지킨 칸을 지금 고친다 (메모의 '적용일 A → B 정정' 으로 범위를 안다)
        let m, last0 = null; const re = /적용일 (\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2}) 정정/g;
        while ((m = re.exec(str_(c.memo)))) last0 = m;
        if (last0 && last0[2] === date && last0[1] > date) for (let dd = date; dd < last0[1]; dd = addDaysText_(dd, 1)) keep.push({ date: dd, campId: c.fromCampId, camp: c.fromCamp, base: c.fromRoute });
        let kept0 = 0;
        try { kept0 = rcKeepCellCamp_(c.driverId, keep, c.toCampId, c.toRoute); } catch (e) { console.error('칸 캠프 붙이기 실패: ' + (e && e.message)); }
        return { ok: true, change: rcView_(c, rcCampNames_()), old: old, kept: kept0, same: true };
      }
      over.forEach(function (x) { writeFields_(SH.RCHG, x._row, { status: RCS.OFF, memo: (x.memo ? x.memo + ' / ' : '') + '적용일 정정(' + date + ')으로 지움' }); });
      const fix = { date: date, memo: (c.memo ? c.memo + ' / ' : '') + '적용일 ' + old + ' → ' + date + ' 정정' + (over.length ? ' (사이 변경 ' + over.length + '건 지움)' : '') };
      if (first) ['fromCampId', 'fromCamp', 'fromRoute'].forEach(function (k) { if (first[k] !== undefined) { fix[k] = first[k]; c[k] = first[k]; } }); // 지운 변경의 '이전 캠프·노선'을 이어받는다
      writeFields_(SH.RCHG, c._row, fix);
      let kept = 0;
      try { kept = rcKeepCellCamp_(c.driverId, keep, c.toCampId, c.toRoute); } catch (e) { console.error('칸 캠프 붙이기 실패: ' + (e && e.message)); }
      rcTouch_();
      logAdmin_(a, '노선 변경 적용일 정정', c.name + ' (' + c.driverId + ')', old + ' → ' + date + ' · ' + (c.fromCamp || '') + ' ' + (c.fromRoute || '') + ' → ' + (c.toCamp || '') + ' ' + (c.toRoute || ''));
      return { ok: true, change: rcView_(Object.assign({}, c, { date: date }), rcCampNames_()), old: old, kept: kept };
    } finally { lock.releaseLock(); }
  });
}
/** 관리자: 예약 취소 (적용 전만). 노선 이관이면 같이 만든 기사 예약도 취소 */
function adm_rcCancel(token, id) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const rows = rcRows_(true);
      const c = rows.filter(function (x) { return x.id === str_(id); })[0];
      if (!c) fail_('예약을 찾을 수 없습니다. 새로고침해 주세요.');
      if (c.status === RCS.DONE) fail_('이미 적용된 변경입니다. 되돌리려면 원래 캠프·노선으로 새로 예약해 주세요.');
      writeFields_(SH.RCHG, c._row, { status: RCS.OFF });
      let n = 1;
      if (c.kind === RCK.MOVE) rows.forEach(function (x) { if (x.parentId === c.id && x.status === RCS.WAIT) { writeFields_(SH.RCHG, x._row, { status: RCS.OFF }); n++; } });
      rcTouch_();
      logAdmin_(a, '노선 변경 예약 취소', c.kind === RCK.MOVE ? c.fromCamp + ' ' + c.fromRoute + ' 이관' : c.name, c.date + (n > 1 ? ' · 기사 ' + (n - 1) + '명 같이 취소' : ''));
      return { ok: true, cancelled: n };
    } finally { lock.releaseLock(); }
  });
}
/** 관리자: '바로 변경'으로 남은 노선 변경 이력 지우기 (정정이었을 때 · 줄이 나뉘지 않게). 기사 정보는 그대로 */
function adm_rcDropHistory(token, id) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const c = rcRows_(true).filter(function (x) { return x.id === str_(id); })[0];
      if (!c) fail_('기록을 찾을 수 없습니다.');
      if (c.status !== RCS.DONE || c.memo !== '바로 변경') fail_('바로 변경 이력만 지울 수 있습니다. 예약은 취소를 써 주세요.');
      writeFields_(SH.RCHG, c._row, { status: RCS.OFF, memo: '바로 변경 (정정으로 지움)' });
      rcTouch_();
      logAdmin_(a, '노선 변경 이력 지움 (정정)', c.name, c.date + ' ' + c.fromRoute + ' → ' + c.toRoute);
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}
/**
 * 관리자: 쿠팡 노선 이관. f = { fromCampId, fromNum, toCampId 또는 toCampName(새 캠프), toNum, date, copyPrice, memo }
 * dry = true 면 미리보기만 (바뀔 기사·노선·단가·확인할 것). false 면 실제로 만든다.
 */
function adm_rcMove(token, f, dry) {
  return run_(function () {
    const a = requireAdmin_(token); fsMark_('sch', { by: a.loginId });
    f = f || {};
    const date = normDate_(f.date);
    if (!date) fail_('적용일을 확인해 주세요.');
    const fromNum = normCode_(f.fromNum).replace(/[^0-9]/g, ''), toNum = normCode_(f.toNum).replace(/[^0-9]/g, '');
    if (!fromNum || !toNum) fail_('옮기기 전·후 노선 번호(숫자)를 입력해 주세요. 예: 110 → 212');
    const m = master_();
    const fromCamp = m.camps.filter(function (c) { return c.id === str_(f.fromCampId); })[0];
    if (!fromCamp) fail_('옮기기 전 캠프를 골라 주세요.');
    let toCamp = m.camps.filter(function (c) { return c.id === str_(f.toCampId); })[0] || null;
    let newCampName = '';
    if (!toCamp) {
      let n = str_(f.toCampName).replace(/\s+/g, '');
      if (!n) fail_('옮겨 갈 캠프를 고르거나 새 캠프 이름을 입력해 주세요.');
      if (!/캠프$/.test(n)) n += '캠프';
      toCamp = m.camps.filter(function (c) { return campKey_(c.name) === campKey_(n); })[0] || null;
      if (!toCamp) newCampName = n;
    }
    if (toCamp && toCamp.id === fromCamp.id && toNum === fromNum) fail_('옮기기 전과 후가 같습니다.');
    const olds = m.routes.filter(function (r) { return r.campId === fromCamp.id && r.g1 === fromNum; });
    if (!olds.length) fail_(fromCamp.name + '에 ' + fromNum + ' 노선이 없습니다.');
    const letters = [];
    olds.forEach(function (r) { [r.g2, r.g3, r.g4, r.g5].forEach(function (ch) { if (ch && letters.indexOf(ch) < 0) letters.push(ch); }); });
    const toCampLabel = toCamp ? toCamp.name : newCampName;
    const routeExists = toCamp ? m.routes.some(function (r) { return r.campId === toCamp.id && r.g1 === toNum; }) : false;
    const priceFrom = m.prices.filter(function (p) { return p.campId === fromCamp.id && p.num === fromNum; });
    const priceTo = toCamp ? m.prices.filter(function (p) { return p.campId === toCamp.id && p.num === toNum; }) : [];
    // 바뀌는 기사: 적용일에 그 캠프에서 그 번호를 맡는 기사
    const by = rcByDriver_(), today = todayText_(), drivers = [], check = [];
    const swap = function (br) { return str_(br).replace(new RegExp('(^|[^0-9])' + fromNum + '(?=[A-Za-z])', 'g'), '$1' + toNum); };
    readAll_(SH.DRIVERS).forEach(function (d) {
      if (!d.id || !d.name) return;
      const v = rcAt_({ campId: d.schCampId, camp: d.schCamp, baseRoute: d.baseRoute }, by[d.id], date, today);
      if (v.campId !== fromCamp.id) return;
      const u = rcUnits_(v.baseRoute);
      if (!u.units.some(function (x) { return x.num === fromNum; })) return;
      drivers.push({ id: d.id, name: d.name, status: d.status, from: v.baseRoute, to: swap(v.baseRoute) });
    });
    // 확인할 것: 옛 노선에 걸린 진행 중 품앗이 일감, 일시단가
    const warn = [];
    try {
      if (typeof pmData_ === 'function') pmData_().jobs.forEach(function (j) {
        if (j.date < date || ['취소', '모집 마감'].indexOf(j.status) >= 0) return;
        if (String(j.campId || '') !== fromCamp.id || !new RegExp('^' + fromNum + '(?=[A-Z]|$)').test(normCode_(j.route))) return;
        warn.push('품앗이 일감 ' + j.date.slice(5).replace('-', '/') + ' ' + j.route + ' (' + j.status + ')이 옛 노선으로 올라와 있습니다.');
      });
    } catch (e) { /* 품앗이 없음 */ }
    try {
      if (typeof stlRead_ === 'function') stlRead_('stl_tmp').forEach(function (t) {
        if (t.to && t.to < date) return;
        if (!new RegExp('(^|[^0-9])' + fromNum + '(?=[A-Za-z]|$)').test(str_(t.routes))) return;
        warn.push('기사 일시단가 ' + (t.name || '') + ' (' + (t.routes || '') + ')가 옛 노선 번호로 되어 있습니다. 정산관리에서 확인해 주세요.');
      });
    } catch (e) { /* 정산 DB 없음 */ }
    const plan = {
      ok: true, dry: !!dry, date: date, applyNow: date <= today,
      from: { campId: fromCamp.id, camp: fromCamp.name, num: fromNum, codes: olds.map(function (r) { return r.code; }) },
      to: { campId: toCamp ? toCamp.id : '', camp: toCampLabel, newCamp: !!newCampName, num: toNum, code: toNum + letters.join(''), routeExists: routeExists },
      prices: { from: priceFrom.length, to: priceTo.length, copy: !!f.copyPrice && priceFrom.length > 0 && !priceTo.length },
      drivers: drivers, check: check, warnings: warn
    };
    // 적용일부터 스케줄 칸에 적힌 옛 번호 (백업 기사가 적어 둔 '서초1 404ABC' 등) → 새 번호로 바꿀 칸 수
    try { plan.cellFix = rcMoveFix_(a, { date: date, fromCampId: fromCamp.id, fromCamp: fromCamp.name, fromRoute: fromNum, toCampId: toCamp ? toCamp.id : '', toCamp: toCampLabel, toRoute: toNum }, true, true).cells.length; } catch (e) { plan.cellFix = 0; }
    if (dry) return plan;
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      const now = nowText_();
      // 새 캠프 (회전은 옛 캠프와 같게)
      if (!toCamp) {
        const row = appendObj_(SH.CAMPS, { id: newRid_('C'), name: newCampName, address: '', memo: fromCamp.name + ' ' + fromNum + ' 노선 이관으로 만듦', rot: fromCamp.rot || ROTS.join(','), createdAt: now, updatedAt: now });
        toCamp = campView_(readObj_(SH.CAMPS, row));
      }
      if (!routeExists) appendObj_(SH.ROUTES, routeRowObj_(toCamp.id, toCamp.name, toNum + letters.join(''), RST.ON, fromCamp.name + ' ' + fromNum + '에서 이관 (' + date + ')', now));
      let copied = 0;
      if (plan.prices.copy) {
        const add = readAll_(SH.PRICES).filter(function (p) { return p.id && p.campId === fromCamp.id && normCode_(p.num) === fromNum; }).map(function (p) {
          const x = {};
          Object.keys(RP).forEach(function (k) { x[k] = p[k]; });
          x.id = newRid_('P'); x.campId = toCamp.id; x.campName = toCamp.name; x.num = toNum; x.createdAt = now; x.updatedAt = now;
          return x;
        });
        appendObjs_(SH.PRICES, add); copied = add.length;
      }
      bumpMaster_();
      const mv = {
        id: uniqId_('RC'), kind: RCK.MOVE, date: date, driverId: '', name: '',
        fromCampId: fromCamp.id, fromCamp: fromCamp.name, fromRoute: fromNum, toCampId: toCamp.id, toCamp: toCamp.name, toRoute: toNum,
        status: RCS.WAIT, parentId: '', memo: str_(f.memo).slice(0, 300), admin: a.name, createdAt: now, appliedAt: ''
      };
      mv._row = appendObj_(SH.RCHG, mv);
      rcTouch_();
      const made = [];
      drivers.forEach(function (x) {
        const o = driverById_(x.id);
        if (!o) return;
        rcAddDriver_(a, o, date, toCamp.id, x.to, fromCamp.name + ' ' + fromNum + ' → ' + toCamp.name + ' ' + toNum + ' 이관', mv.id);
        made.push(x.name);
      });
      if (date <= today) rcApply_(mv, now);
      bumpMaster_(); rcTouch_();
      try { plan.cellFixed = rcMoveFix_(a, mv, false, true).cells.length; } catch (e) { plan.cellFixed = 0; console.error('이관 칸 맞추기 실패: ' + (e && e.message)); }
      logAdmin_(a, '노선 이관', fromCamp.name + ' ' + fromNum + ' → ' + toCamp.name + ' ' + toNum, date + ' · 기사 ' + made.length + '명' + (copied ? ' · 단가 ' + copied + '줄 복사' : '') + (newCampName ? ' · 새 캠프' : ''));
      plan.dry = false; plan.to.campId = toCamp.id; plan.made = made; plan.copied = copied; plan.moveId = mv.id;
      return plan;
    } finally { lock.releaseLock(); }
  });
}

/**
 * 노선 이관 뒤 맞추기 (잠금 안에서 · dry 면 목록만):
 *  (1) 적용일에 옛 캠프에서 옛 번호를 아직 맡고 있는 기사 → 그 번호만 새 번호로 노선 변경 (skipDrivers 면 건너뜀)
 *  (2) 적용일부터 스케줄 칸에 적힌 옛 번호 → 새 번호 ('서초1 404ABC' → '서초1 204ABC' · 캠프가 바뀌는 이관이면 캠프 이름도)
 *      품앗이 줄(일감 기준으로 잠긴 칸)과 비고 줄은 건드리지 않는다.
 * virt = { base: {기사ID: 기본노선}, cell: {'행|열': 글자} } — 미리보기에서 이관 여러 건을 차례로 겹쳐 볼 때
 * → { drivers: [{ id, name, from, to }], cells: [{ row, col, date, name, old, value }] }
 */
function rcMoveFix_(a, mv, dry, skipDrivers, virt) {
  const out = { drivers: [], cells: [] };
  const fromNum = str_(mv.fromRoute).replace(/[^0-9]/g, ''), toNum = str_(mv.toRoute).replace(/[^0-9]/g, ''), date = str_(mv.date);
  if (!fromNum || !toNum || !date || (fromNum === toNum && mv.fromCampId === mv.toCampId)) return out;
  virt = virt || { base: {}, cell: {} };
  const m = master_(), today = todayText_();
  const short = function (n) { return str_(n).replace(/\s*캠프\s*$/, '').replace(/\s+/g, ''); };
  const campName = {}; m.camps.forEach(function (c) { campName[c.id] = c.name; });
  const fromShort = short(campName[mv.fromCampId] || mv.fromCamp), toShort = short(campName[mv.toCampId] || mv.toCamp);
  const has = new RegExp('(^|[^0-9])' + fromNum + '(?=[A-Za-z])'), swap = function (t) { return str_(t).replace(new RegExp('(^|[^0-9])' + fromNum + '(?=[A-Za-z])', 'g'), '$1' + toNum); };
  const all = readAll_(SH.DRIVERS).filter(function (d) { return d.id && d.name; });
  let by = rcByDriver_();
  const at = function (d, dt) { const v = rcAt_({ campId: d.schCampId, camp: d.schCamp, baseRoute: d.baseRoute }, by[d.id], dt, today); if (virt.base[d.id] !== undefined && dt >= date) v.baseRoute = virt.base[d.id]; return v; };
  if (!skipDrivers) {
    all.forEach(function (d) {
      const v = at(d, date);
      if (v.campId !== mv.fromCampId) return;
      const u = rcUnits_(v.baseRoute);
      if (u.special || !u.units.some(function (x) { return x.num === fromNum; })) return;
      const to = swap(v.baseRoute);
      out.drivers.push({ id: d.id, name: d.name, from: v.baseRoute, to: to });
      if (dry) { virt.base[d.id] = to; return; }
      const o = driverById_(d.id);
      if (o) rcAddDriver_(a, o, date, mv.toCampId, to, fromShort + ' ' + fromNum + ' → ' + toShort + ' ' + toNum + ' 이관 (다른 번호도 맡는 기사)', mv.id || '');
    });
    if (!dry && out.drivers.length) { rcTouch_(); by = rcByDriver_(); }
  }
  if (!props_().SCH_DB_ID || !schSS_().getSheetByName(SCH.SHEET)) return out;
  const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
  const days = Object.keys(h.dates).filter(function (d) { return d >= date; });
  if (last < 2 || !days.length) return out;
  const cols = days.map(function (d) { return h.dates[d]; }), c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
  const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
  const block = sh.getRange(2, c0 + 1, last - 1, c1 - c0 + 1).getValues();
  const drv = {}; all.forEach(function (d) { drv[d.id] = d; });
  const sameCamp = mv.fromCampId === mv.toCampId;
  const toHasOld = !sameCamp && m.routes.some(function (r) { return r.campId === mv.toCampId && r.g1 === fromNum; }); // 옮겨 간 캠프에 같은 번호가 따로 있으면 캠프 이름 없는 칸은 건드리지 않는다
  ids.forEach(function (id, i) {
    if (!id || /^NOTE\d+$/.test(id) || id.indexOf(SCH_PM_PREFIX) === 0) return;
    const ex = schExParse_(id), d = drv[ex ? ex.driverId : id];
    days.forEach(function (dt) {
      const c = h.dates[dt], vk = (i + 2) + '|' + c;
      const raw = block[i][c - c0], v = virt.cell[vk] !== undefined ? virt.cell[vk] : (raw instanceof Date ? '' : str_(raw));
      if (!v || !has.test(v)) return;
      const camp = ex ? ex.campId : d ? at(d, dt).campId : '';
      const nv = v.split(/\r?\n/).map(function (ln) {
        if (!has.test(ln)) return ln;
        const pm = ln.match(/^(\s*)([가-힣]+\s?\d+)(\s+)([\s\S]*)$/);
        if (pm) return pm[2].replace(/\s+/g, '') === fromShort && has.test(pm[4]) ? pm[1] + toShort + pm[3] + swap(pm[4]) : ln; // 캠프 이름이 적힌 칸: 옛 캠프일 때만
        if (!/^\s*\d/.test(ln)) return ln; // 노선으로 시작하지 않는 글(메모 등)은 그대로
        if (camp === mv.toCampId && (sameCamp || !toHasOld)) return swap(ln);                // 같은 캠프 번호 바뀜 · 같이 옮겨 간 기사
        if (camp === mv.fromCampId && !sameCamp) return toShort + ' ' + swap(ln.trim());      // 옛 캠프에 남은 기사가 적어 둔 옛 번호 → '새캠프 새번호'
        return ln;
      }).join('\n');
      if (nv === v) return;
      out.cells.push({ row: i + 2, col: c + 1, date: dt, name: d ? d.name : id, old: v, value: nv });
      if (dry) virt.cell[vk] = nv; else sh.getRange(i + 2, c + 1).setValue(nv);
    });
  });
  return out;
}
/** 관리자: 이미 등록한 노선 이관 전부를 다시 맞춘다 (건너뛴 기사 · 옛 번호 칸). dry = true 면 미리보기 → { ok, moves: [{ label, date, drivers, cells }], drivers, cells } */
function adm_rcMoveFix(token, dry) {
  return run_(function () {
    const a = requireAdmin_(token);
    const run = function () {
      const campName = rcCampNames_(), short = function (n) { return str_(n).replace(/\s*캠프\s*$/, ''); };
      const virt = { base: {}, cell: {} }, moves = [];
      rcRows_(true).filter(function (c) { return c.kind === RCK.MOVE && c.date; }).sort(rcSort_).forEach(function (mv) {
        const r = rcMoveFix_(a, mv, !!dry, false, virt);
        if (!r.drivers.length && !r.cells.length) return;
        moves.push({ label: short(campName[mv.fromCampId] || mv.fromCamp) + ' ' + mv.fromRoute + ' → ' + short(campName[mv.toCampId] || mv.toCamp) + ' ' + mv.toRoute, date: mv.date,
          drivers: r.drivers.map(function (x) { return { name: x.name, from: x.from, to: x.to }; }),
          cells: r.cells.length, sample: r.cells.slice(0, 6).map(function (x) { return { date: x.date, name: x.name, old: x.old, value: x.value }; }) });
      });
      return moves;
    };
    let moves;
    if (dry) moves = run();
    else {
      const lock = scriptLock_();
      lock.waitLock(30000);
      try { moves = run(); bumpMaster_(); rcTouch_(); } finally { lock.releaseLock(); }
      fsMark_('sch', { by: a.loginId });
      const nd = moves.reduce(function (n, x) { return n + x.drivers.length; }, 0), nc = moves.reduce(function (n, x) { return n + x.cells; }, 0);
      if (nd || nc) logAdmin_(a, '노선 이관 뒤 맞추기', moves.map(function (x) { return x.label; }).join(', '), '기사 ' + nd + '명 · 칸 ' + nc + '개');
    }
    return { ok: true, dry: !!dry, moves: moves, drivers: moves.reduce(function (n, x) { return n + x.drivers.length; }, 0), cells: moves.reduce(function (n, x) { return n + x.cells; }, 0) };
  });
}

/**
 * 스케줄 칸 글자에 '노선변경'(띄어쓰기 무관)이 있으면 노선 변경 예약으로 읽는다.
 *   '캠프및 노선변경 군포1 212AB' / '노선 변경 군포1캠프 212CD (F3)' / '노선변경 212AB'(캠프 그대로)
 * 반환: null (해당 없음) | { err } | { campId, route }
 */
function rcParseCell_(v, curCampId) {
  const t = str_(v).replace(/\s+/g, ' ');
  if (!/노선\s*변경/.test(t)) return null;
  const rest = t.replace(/^.*?노선\s*변경\s*/, '').trim();
  const rm = rest.match(/(\d+[A-Za-z]+(?:\s*,\s*\d*[A-Za-z]+)*)(\s*\([^)]*\))?/);
  if (!rm) return { err: '바뀔 노선(예: 212AB)을 찾지 못했습니다' };
  const before = rest.slice(0, rest.indexOf(rm[0])).replace(/\s+/g, '').replace(/캠프$/, '');
  let campId = curCampId || '';
  if (before) {
    const c = master_().camps.filter(function (x) { return campKey_(String(x.name).replace(/\s*캠프$/, '')) === campKey_(before); })[0];
    if (!c) return { err: before + '캠프가 노선관리에 없습니다 (노선관리에서 캠프를 만들거나 노선 이관을 먼저 해 주세요)' };
    campId = c.id;
  }
  if (!campId) return { err: '바뀔 캠프를 알 수 없습니다' };
  return { campId: campId, route: normBaseRoute_(rm[1].replace(/\s+/g, '') + (rm[2] ? ' ' + rm[2].trim() : '')) };
}
function addDaysText_(ymd, n) { const d = parseYmd_(ymd); return d ? ymd_(addDays_(d, n)) : ymd; }
