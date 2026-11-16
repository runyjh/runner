/**
 * 기사앱 내 스케줄 '예정' 표시 (관리자가 아직 적지 않은 오늘 이후 빈칸)
 *  - 기사스케줄 표는 건드리지 않는다. 기사앱 한 달 달력에만 점선(예정)으로 보여 준다 — 관리자가 칸을 적으면 그 값이 우선
 *  - 고정 · 품앗이 기사(기본노선 있음): 고정휴무 요일 = '고정휴무', 나머지 = '출근'(그날 담당 노선 · 노선 변경 예약 반영은 앱이 함)
 *  - 백업 기사: 고정휴무 요일만 '고정휴무', 나머지는 '미정' (어느 노선에 들어갈지 그날그날 정해짐)
 *  - 기사별 스위치 '예정 패턴 표시'(planPat = Y): 최근 3주 같은 요일이 똑같았던 요일만 그 값으로 예정 (규칙적으로 도는 백업용)
 *  - 고정휴무일을 요일로 적지 않은 기사('조정 백업에 맞춰서' 등)는 알 수 없으므로 '미정'
 *  규칙은 관리자앱 [빈칸 자동 채우기] 와 같다 (Admin.html #sFill)
 */
const SPL = { WEEKS: 3, DOW: '일월화수목금토' };

/** 고정휴무일 글자 → 요일 번호 배열. 비어 있으면 [] · 요일로 적지 않았으면 null */
function splOffDows_(s) {
  const t = str_(s).replace(/요일/g, '').replace(/\s+/g, '');
  if (!t) return [];
  if (!/^[일월화수목금토]([,./][일월화수목금토])*$/.test(t)) return null;
  return t.split(/[,./]/).map(function (x) { return SPL.DOW.indexOf(x); });
}
function splIsBackup_(o) { return str_(o.driverType) === '백업' || /백업/.test(str_(o.baseRoute)) || !str_(o.baseRoute); }
/** 칸 글자 → 비교용 (휴무류 = OFF · 병가 · 미입차 · 용차 등 예외는 '' = 패턴으로 안 침) */
function splNorm_(v) {
  const s = splClean_(v);
  if (!s) return '';
  if (/휴가|병가|퇴사|미입차|노쇼|용차|지원/.test(s)) return '';
  if (/휴무/.test(s) && !/\d/.test(s)) return 'OFF';
  return s.replace(/\s+/g, '').toUpperCase();
}
/** 보여 줄 글자: 대괄호 메모 · '(아이디) 업무등록' 은 뺌 */
function splClean_(v) { return str_(v).replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)\s*업무등록/g, ' ').replace(/\s+/g, ' ').trim(); }

/**
 * 예정 만들기 → { 'yyyy-MM-dd': { v: '출근' | '고정휴무' | '휴무' | '강서1 529B' | '', k: 'fix' | 'pat' | 'tbd' } }
 *  o = 기사(근무자) 줄 · cells = 이미 적힌 칸 · valAt(date) = 그 기사 줄의 지난 칸 글자 (패턴용)
 */
function splPlan_(o, dates, cells, today, valAt) {
  const out = {};
  if (!o || o.status !== ST.ACTIVE || titleOf_(o) || /용차/.test(str_(o.baseRoute))) return out;
  const backup = splIsBackup_(o), type = str_(o.driverType);
  if (!backup && type !== '고정' && type !== '품앗이') return out;
  const leave = schLeaveFrom_(o), off = splOffDows_(o.fixedOff), patOn = str_(o.planPat) === 'Y', pat = {};
  const patOf = function (dow) {
    if (dow in pat) return pat[dow];
    let d = schAddDays_(today, -1), g = 0;
    while (parseYmd_(d).getDay() !== dow && g++ < 7) d = schAddDays_(d, -1);
    let key = null, raw = '';
    for (let i = 0; i < SPL.WEEKS; i++) {
      const v = str_(valAt(schAddDays_(d, -7 * i))), n = splNorm_(v);
      if (!n || (key !== null && n !== key)) return (pat[dow] = '');
      if (key === null) { key = n; raw = splClean_(v); }
    }
    return (pat[dow] = key === 'OFF' ? '휴무' : raw);
  };
  dates.forEach(function (d) {
    if (d < today || str_(cells[d]) || (leave && d >= leave)) return;
    const dow = parseYmd_(d).getDay();
    if (off && off.indexOf(dow) >= 0) { out[d] = { v: '고정휴무', k: 'fix' }; return; }
    if (patOn) { const p = patOf(dow); if (p) { out[d] = { v: p, k: 'pat' }; return; } }
    if (!backup && off !== null) { out[d] = { v: '출근', k: 'fix' }; return; }
    out[d] = { v: '', k: 'tbd' };
  });
  return out;
}

/** api_mySchedule 결과에 예정을 붙인다 (실패해도 스케줄은 그대로) · rowVals = 이미 읽은 내 줄 (없으면 패턴이 필요할 때만 읽음) */
function splAttach_(out, o, rowId, rowVals, h) {
  try {
    if (!out || out.ok === false || !o) return;
    let vals = rowVals, tried = false;
    const valAt = function (d) {
      if (!h) return '';
      const c = h.dates[d];
      if (c === undefined) return '';
      if ((!vals || c >= vals.length) && !tried) { tried = true; vals = splReadRow_(rowId, h) || vals; }
      return vals && c < vals.length ? str_(vals[c]) : '';
    };
    out.plan = splPlan_(o, out.dates, out.cells, out.today, valAt);
    out.planCamp = isStaffCamp_(o.schCamp) ? '' : str_(o.schCamp).replace(/\s*캠프\s*$/, '');
  } catch (e) { out.plan = {}; softFail_('스케줄 예정 표시 실패', e); }
}
function splReadRow_(rowId, h) {
  const sh = schSheet_(), last = sh.getLastRow();
  if (last < 2) return null;
  const cell = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).createTextFinder(rowId).matchEntireCell(true).matchCase(true).findNext();
  return cell ? sh.getRange(cell.getRow(), 1, 1, sh.getLastColumn()).getValues()[0] : null;
}
