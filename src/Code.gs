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
const SH = { DRIVERS: 'drivers', SESSIONS: 'sessions', ADMINS: 'admins', ALOG: 'admin_log' };

// drivers 시트 열 정의. 값 = 시트 머리글 (머리글 이름은 바꾸지 말 것, 순서는 자유)
const D = {
  id: '기사ID', loginId: '쿠팡플렉스 아이디', name: '이름', phone: '연락처', status: '상태',
  birthDate: '생년월일', rrn: '주민등록번호', address: '주소(주민등록상)',
  qualDate: '화물운송 종사자격 취득일', qualNo: '화물운송 종사자격증 번호',
  licenseNo: '운전면허번호', licenseType: '운전면허 종류',
  carName: '차명', carYear: '연식', maxLoad: '최대적재량(kg)',
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
const D_AUTO_ADD = ['pwMustChange'];
const D_HIDDEN = ['rrnEnc', 'rrnIndex', 'licenseNoEnc', 'accountEnc', 'pwHash', 'pwSalt'];
const D_NOTES = {
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

const SCHEMA = {};
SCHEMA[SH.DRIVERS] = D;
SCHEMA[SH.SESSIONS] = S;
SCHEMA[SH.ADMINS] = A;
SCHEMA[SH.ALOG] = L;
const HIDDEN = {};
HIDDEN[SH.DRIVERS] = D_HIDDEN;
HIDDEN[SH.ADMINS] = ['pwHash', 'pwSalt'];

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
  ensureTools_();
  installTriggers_();
  Logger.log('설정 완료. DB: ' + ss_().getUrl());
}

/** 빠진 머리글을 오른쪽 끝에 추가하고 서식·숨김·드롭다운·설명을 다시 적용한다. */
function ensureColumns() {
  try { ss_().setSpreadsheetTimeZone(CFG.TZ); } catch (e) { /* 권한 문제 시 무시 */ }
  Object.keys(SCHEMA).forEach(function (name) {
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
      Object.keys(D_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(D_NOTES[k]); });
      sh.getRange(1, c.pwReset + 1).setBackground('#fff4e5');
    } else if (name === SH.ADMINS) {
      const rule = SpreadsheetApp.newDataValidation().requireValueInList([AST.ACTIVE, AST.STOPPED], true).build();
      sh.getRange(2, c.status + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
      Object.keys(A_NOTES).forEach(function (k) { sh.getRange(1, c[k] + 1).setNote(A_NOTES[k]); });
      sh.getRange(1, c.pwReset + 1).setBackground('#fff4e5');
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
  const sh = ss_().getSheetByName(name);
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
  const autoable = name === SH.DRIVERS && missing.length &&
    missing.every(function (label) { return D_AUTO_ADD.some(function (k) { return D[k] === label; }); });
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
function writeFields_(name, row, fields) {
  const c = cols_(name, true), sh = sheet_(name);
  Object.keys(fields).forEach(function (k) {
    sh.getRange(row, c[k] + 1).setNumberFormat('@').setValue(fields[k]);
  });
}
/** 잠금 안에서만 호출: 마지막 행 다음 줄에 객체를 한 번에 쓴다 */
function appendObj_(name, obj) {
  const c = cols_(name, true), sh = sheet_(name);
  const arr = new Array(c.__w).fill('');
  Object.keys(obj).forEach(function (k) { arr[c[k]] = obj[k]; });
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
    if (n === 1) return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const c = cols_(name, true);
    const start = Math.max(2, r0), end = Math.min(r0 + n - 1, start + 199);
    if (end < start) return;
    const block = sh.getRange(start, 1, end - start + 1, c.__w).getValues();
    block.forEach(function (v, i) {
      const o = { _row: start + i };
      Object.keys(SCHEMA[name]).forEach(function (k) { o[k] = str_(v[c[k]]); });
      if (name === SH.DRIVERS) fixDriverRow_(sh, c, o);
      else if (name === SH.ADMINS) fixAdminRow_(sh, c, o);
      else if (name === SH.SESSIONS) cache_().remove('ss:' + o.tokenHash);
    });
  } finally {
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
  if (!o.id && lid) { set('id', newDriverId_()); if (!o.createdAt) set('createdAt', nowText_()); }
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
  ['phone', 'rrn', 'licenseNo', 'account', 'pwReset'].forEach(function (k) {
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
  qualDate: '자격 취득일', qualNo: '자격증 번호', licenseType: '면허 종류', carName: '차명', carYear: '연식',
  maxLoad: '최대적재량', bankName: '은행명', accountHolder: '예금주', memo: '관리자 메모',
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
    createdAt: o.createdAt, approvedAt: o.approvedAt, carName: o.carName, carYear: o.carYear,
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
      if (!o.id && !o.loginId) return;
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
            const lid = normLoginId_(v);
            if (lid !== o.loginId.toLowerCase()) {
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
          case 'memo': f.memo = opt(v, '관리자 메모', 2000); break;
          case 'address': f.address = opt(v, '주소', 200); break;
          case 'qualNo': f.qualNo = opt(v, '자격증 번호', 30); break;
          case 'carName': f.carName = opt(v, '차명', 40); break;
          case 'bankName': f.bankName = opt(v, '은행명', 20); break;
          case 'accountHolder': f.accountHolder = opt(v, '예금주', 30); break;
        }
        changed.push(D_EDIT_LABEL[k]);
      });
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

// ───────────────────────── 서류 일괄 연결 ─────────────────────────
/**
 * 사용법
 *  1) 구글 드라이브 "러너 올인원 데이터/서류 올리기" 폴더에 서류 파일을 한꺼번에 올린다.
 *     파일 이름 = "기사구분_서류종류.확장자"
 *       기사구분 : 쿠팡플렉스 아이디, 연락처, 기사ID, 이름(동명이인 없을 때) 중 하나
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
    sh.getRange('A2').setValue('① "서류 올리기" 폴더에 서류 파일을 한꺼번에 올립니다. 파일 이름: 기사구분_서류종류  (예: kim@flex.com_면허증.jpg)');
    sh.getRange('A3').setValue('   기사구분 = 쿠팡플렉스 아이디 / 연락처 / 기사ID / 이름(동명이인 없을 때),  서류종류 = 자격증 / 면허증 / 사업자 / 자동차');
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
      if (cut < 1) { fail('파일 이름이 "기사구분_서류종류" 형식이 아닙니다. (예: kim@flex.com_면허증.jpg)'); continue; }
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
