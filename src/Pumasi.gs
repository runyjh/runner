/**
 * 품앗이 — 기사끼리 용차 일감을 올리고(맡기고) 지원해서 대신 뛰는 기능 (바로일 '용차' 방식)
 *
 *  흐름: ① 기사가 일감 등록 (센터·라우트·단가는 노선관리에서 자동 제안)
 *        ② 다른 기사가 지원 (같은 배차일에 2번까지)
 *        ③ 등록 기사가 지원자와 통화 → '협의 중' → '배차 확정' (확정된 기사에게만 배송지코드·연락처·첨부 공개)
 *        ④ 정산은 두 기사가 협의한 방법으로 (수수료 없음)
 *  상태: 모집 중 → 배차 협의중 → 배차 확정 (배차일이 지나면 '완료한 품앗이') / 모집 마감 / 취소
 *  데이터: 러너 올인원 DB 의 pumasi_jobs(일감), pumasi_apps(지원) 탭. 시트에서 직접 고쳐도 된다.
 *
 *  품앗이 주세요: 일감을 원하는 기사가 근무 가능일을 달력에 표시(pumasi_avail) → 맡길 기사가 그 날을 골라
 *        일감을 '제안'(그 기사에게만 보이는 일감 + 지원 상태 '제안') → 제안받은 기사가 수락하면 바로 배차 확정,
 *        거절하면 일감은 모집 마감(등록 기사가 '다시 모집'을 누르면 모든 기사에게 공개)
 */
const PM_KINDS = ['주간', '야간', '일택'];
const PM_TOPS = ['탑무관', '하이탑', '로우탑', '냉탑'];
const PM_PAYS = ['러너 정산서', '당일지급', '주급', '월급', '협의'];
// 지금은 고를 수 없게 잠근 지급방법 (화면에서 회색 · 새로 고르면 서버가 막음 · 예전에 이미 저장된 일감은 그대로 둠)
const PM_PAYS_OFF = ['당일지급', '주급', '월급', '협의'];
const PM_PAY_DEF = '러너 정산서';
const PM_JOB_PRICE = 1100; // 품앗이 일감 건당 단가 기본값 (VAT 포함 · 고칠 수 있음)
/** 지급방법 확인: 잠긴 값은 '예전 값 그대로'일 때만 허용 */
function pmPayOk_(pay, old) { if (PM_PAYS.indexOf(pay) < 0) fail_('지급방법을 골라 주세요.'); if (PM_PAYS_OFF.indexOf(pay) >= 0 && pay !== old) fail_('지급방법 \'' + pay + '\' 은(는) 지금 고를 수 없습니다. 러너 정산서를 골라 주세요.'); return pay; }
const PM_RUNNER_ID = 'RUNNER', PM_RUNNER = '러너'; // 맡기는 쪽이 회사(러너)인 일감: 등록 기사ID 빈칸 · 등록 기사 '러너'
const PM_MAX_APPLY = 2; // 한 기사가 같은 배차일에 지원할 수 있는 횟수
const PM_DESC_TEMPLATE = [
  '📋 배송 정보', '벤더사명 : ', '아파트/지번 비율 : ', '평균 물량 : ', '사용 날짜 (PDD 기준) : ', '주간/야간 : ', '캠프명 : ', '캠프 주소 : ',
  '라우트(Route) 번호 : ', '지정 주차 여부 : ', '최근 마감 수량 : ', '',
  '🍀 특이사항', '고정기사 정보 (1인 / 2인 1조 / 알바 여부) : ', '하이탑·로우탑 출입 여부 : ', '프레시백 할당 수량 및 회수 여부 : ', '입차시간 (회차별) : ', '추천 인원 : ', '',
  '💰 정산 정보', '정산 방법 (당일 이체 등) : ', '세금계산서 발행 여부 : '
].join('\n');
const PM_SECRET_TEMPLATE = ['현장 담당자 연락처 : ', '배송지 코드 : ', '공동현관 비번 등 참고사항 : '].join('\n');

// ───────────────────────── 앱 설정 (app_settings 탭) ─────────────────────────
function appSet_() {
  const c = cache_(), hit = c.get('appset');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 */ } }
  const m = {};
  try { readAll_(SH.APPSET).forEach(function (o) { if (o.key) m[o.key] = str_(o.value); }); } catch (e) { /* 탭 없음 */ }
  c.put('appset', JSON.stringify(m), 300);
  return m;
}
function appSetPut_(key, value, memo) {
  const lock = scriptLock_(); // 처음 저장 두 번이 겹쳐 같은 키가 두 줄 생기지 않게 (scriptLock_ 은 겹쳐 잡아도 됨)
  lock.waitLock(20000);
  try {
    const row = findRow_(SH.APPSET, 'key', key);
    if (row) writeFields_(SH.APPSET, row, { value: value }); else appendObj_(SH.APPSET, { key: key, value: value, memo: memo || '' });
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  cache_().remove('appset');
}
/** Firestore 읽기 사본 만들기 켜짐? (app_settings 의 fsCopy 가 off 면 끔 · 기본 켬 · 실시간 갱신 신호는 이 설정과 무관하게 계속 나감) */
function fsCopyOn_() { try { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().fsCopy)); } catch (e) { return true; } }
/** 품앗이 일감 올리기 켜짐? (관리자 품앗이 관리에서 ON/OFF, 기본 ON) */
function pmPostOn_() { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().pmPostOn)); }
/** 일감 제안(품앗이 주세요 · 일할 기사 찾기에서 특정 기사에게 맡기기) 켜짐 — 자유 등록(pmPostOn)과 따로 */
function pmOfferOn_() { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().pmOfferOn)); }
/** 배송 아이디: 일감을 받은 기사 아이디로 / 일감을 준 기사 아이디로 / 협의 */
const PM_USE_IDS = ['받는 기사 아이디', '주는 기사 아이디', '협의'];

// ───────────────────────── 공용 ─────────────────────────
/** 기사 로그인 확인 → { id, info } */
function pmUser_(token) {
  const s = getSession_(token);
  const info = s ? driverInfo_(s.d) : null;
  if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) { const e = new Error('x'); e.userMsg = '로그인이 만료되었습니다. 다시 로그인해 주세요.'; e.code = 'EXPIRED'; throw e; }
  if (info.mustChange) { const e = new Error('x'); e.userMsg = '비밀번호를 먼저 바꿔 주세요.'; e.code = 'MUST_CHANGE'; throw e; }
  return { id: String(s.d), info: info };
}
function pmTouch_() { flushBeforeBump_(); fsMark_('pm'); try { cache_().put('pm:v', String(Date.now()) + Math.random().toString(36).slice(2, 5), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
function pmVer_() { return cache_().get('pm:v') || '0'; }
/** 일감·지원 전체 (1분 캐시, 쓰면 바로 버림) */
function pmData_() {
  const key = 'pm:d:' + pmVer_();
  const hit = typeof stlCGet_ === 'function' ? stlCGet_(key) : null;
  if (hit) return hit;
  const jobs = readAll_(SH.PJOB).filter(function (o) { return o.id && o.date; }).map(function (o) { delete o._row; return o; });
  const apps = readAll_(SH.PAPP).filter(function (o) { return o.id && o.jobId; }).map(function (o) { delete o._row; return o; });
  let avail = [];
  try { avail = readAll_(SH.PAVAIL).filter(function (o) { return o.driverId && o.date; }).map(function (o) { delete o._row; o.date = pmDate_(o.date); return o; }); } catch (e) { avail = []; }
  const d = { jobs: jobs, apps: apps, avail: avail };
  if (typeof stlCPut_ === 'function') stlCPut_(key, d, 60);
  return d;
}
function pmDate_(v) { const d = normDate_(v); return d || ''; }
function pmMoney_(v) { const m = normMoney_(v); return m === null ? null : m; }
function pmActiveApp_(a) { return a.status === PAST.APPLY || a.status === PAST.TALK || a.status === PAST.OK || a.status === PAST.OFFER; }
/** 제안 일감: 등록 기사·제안받은 기사 말고는 안 보임 */
function pmHidden_(j, me) { return !!j.offerToId && j.offerToId !== me && j.posterId !== me; }
/**
 * 일이 끝났나: 야간은 배차일 그 날짜 아침 7시에 무조건 끝난다 (전날 밤 입차 → 그날 7시 끝).
 * 주간·일택·무관은 배차일이 지나면(다음 날 0시) 끝. x = 일감 · 근무 가능일 { date, kind }
 */
const PM_NIGHT_END_H = 7;
function pmPast_(x, today) {
  const dt = pmDate_(x && x.date) || str_(x && x.date);
  today = today || todayText_();
  if (dt < today) return true;
  if (dt > today || str_(x && x.kind) !== '야간') return false;
  return Number(Utilities.formatDate(new Date(), CFG.TZ, 'H')) >= PM_NIGHT_END_H;
}
/** 지원 줄이 끝난 일인지 (그 일감의 구분으로) */
function pmAppPast_(a, byId, today) { return pmPast_(byId[a.jobId] || a, today); }
function pmJobMap_(d) { if (!d._byId) { d._byId = {}; d.jobs.forEach(function (j) { d._byId[j.id] = j; }); } return d._byId; }
/** 화면 상태: 배차 확정이고 배차일이 지났으면(야간은 그날 7시) '완료' */
function pmView_(j, today) {
  const known = Object.keys(PST).some(function (k) { return PST[k] === j.status; });
  const st = known ? j.status : PST.OPEN;
  return st === PST.DONE && pmPast_(j, today) ? '완료' : st;
}
/** 목록 카드 (공개 항목만) */
function pmCard_(j, me, apps, today) {
  const mine = j.posterId === me;
  const my = apps.filter(function (a) { return a.jobId === j.id && a.driverId === me && a.status !== PAST.CANCEL; })[0];
  const cnt = apps.filter(function (a) { return a.jobId === j.id && pmActiveApp_(a); }).length;
  return {
    id: j.id, status: pmView_(j, today), kind: j.kind, date: j.date, time: j.time, area: j.area, camp: j.camp, route: j.route, qty: j.qty, top: j.top,
    price: j.price, pay: j.pay, mine: mine, poster: j.poster, myApp: my ? my.status : '', applicants: mine ? cnt : undefined,
    accepted: j.acceptedId === me, hasAttach: !!j.attach, office: !!j.byOffice,
    offerToMe: j.offerToId === me && !!my && my.status === PAST.OFFER, offerTo: mine && j.offerToId ? j.offerTo : '', offered: j.offerToId === me
  };
}
/** 지원 가능한지 (안 되면 이유) */
function pmCanApply_(j, me, apps, today) {
  if (j.posterId === me) return '내가 올린 일감입니다.';
  if (j.offerToId && j.offerToId !== me) return '다른 기사님에게 제안한 일감입니다.';
  if (j.offerToId === me && apps.some(function (a) { return a.jobId === j.id && a.driverId === me && a.status === PAST.OFFER; })) return '나에게 온 제안입니다. 아래에서 수락 또는 거절해 주세요.';
  if (j.status !== PST.OPEN && j.status !== PST.TALK) return '모집이 끝난 일감입니다.';
  if (pmPast_(j, today)) return j.date < today ? '배차일이 지났습니다.' : '야간 품앗이는 그날 아침 7시에 끝났습니다.';
  if (apps.some(function (a) { return a.jobId === j.id && a.driverId === me && pmActiveApp_(a); })) return '이미 지원했습니다.';
  const n = apps.filter(function (a) { return a.driverId === me && a.date === j.date && pmActiveApp_(a); }).length;
  if (n >= PM_MAX_APPLY) return '같은 배차일에는 ' + PM_MAX_APPLY + '번까지만 지원할 수 있습니다.';
  return '';
}
function pmJobById_(id) {
  const row = findRow_(SH.PJOB, 'id', String(id || ''));
  if (!row) fail_('일감을 찾을 수 없습니다. 새로고침해 주세요.');
  return readObj_(SH.PJOB, row);
}

// ───────────────────────── 목록 · 상세 ─────────────────────────
/**
 * 품앗이 목록. f = { onlyAvail: 지원 가능 오더만, q: 배송지·센터 검색 }
 * 배차일이 오늘 이후인 일감 + 오늘 지난 내 일감(최근 3일)까지. 날짜·시간 순.
 */
function api_pmList(token, f) {
  return run_(function () {
    const u = pmUser_(token);
    pmOfficeAuto_();
    f = f || {};
    const today = todayText_(), d = pmData_();
    const q = str_(f.q).replace(/\s+/g, '').toLowerCase();
    const from = ymd_(addDays_(parseYmd_(today), -3));
    const list = d.jobs.filter(function (j) {
      if (j.status === PST.CANCEL) return false;
      if (pmHidden_(j, u.id)) return false;
      if (pmPast_(j, today) && !(j.date >= from && (j.posterId === u.id || j.acceptedId === u.id))) return false;
      if (q && (str_(j.area) + str_(j.camp) + str_(j.route)).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return false;
      if (f.onlyAvail && pmCanApply_(j, u.id, d.apps, today)) return false;
      return true;
    }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time) || a.createdAt.localeCompare(b.createdAt); })
      .map(function (j) { return pmCard_(j, u.id, d.apps, today); });
    const waiting = d.jobs.filter(function (j) { return j.posterId === u.id && (j.status === PST.OPEN || j.status === PST.TALK) && !pmPast_(j, today); })
      .reduce(function (n, j) { return n + d.apps.filter(function (a) { return a.jobId === j.id && a.status === PAST.APPLY; }).length; }, 0);
    const confirmed = d.apps.filter(function (a) { return a.driverId === u.id && a.status === PAST.OK && !pmAppPast_(a, pmJobMap_(d), today); }).length;
    // 품앗이 주세요: 근무 가능일 카드 (기사 · 날짜마다 1장)
    let gives = [];
    try {
      pmAvailDrivers_(u.id, d, today, true).forEach(function (x) {
        x.dates.forEach(function (dt) {
          if (q && (str_(x.name) + str_(x.camp) + str_(x.memo) + str_(x.info && x.info.area) + str_(x.info && x.info.camp)).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return;
          gives.push({ id: x.id, name: x.name, camp: x.camp, type: x.type, memo: x.memo, me: x.me, date: dt.date, kind: dt.kind, offered: dt.offered, info: x.info });
        });
      });
    } catch (e) { gives = []; }
    return { ok: true, today: today, jobs: list, waiting: waiting, confirmed: confirmed, gives: gives, postOn: pmPostOn_(), offerOn: pmOfferOn_() };
  });
}
/** 상세: 공개 항목 + (등록 기사·확정 기사에게만) 비공개 항목 + (등록 기사에게) 지원자 목록 */
function api_pmJob(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const today = todayText_(), d = pmData_();
    const j = d.jobs.filter(function (x) { return x.id === id; })[0];
    if (!j || j.status === PST.CANCEL && j.posterId !== u.id || pmHidden_(j, u.id)) fail_('일감을 찾을 수 없습니다. 지워졌거나 취소된 일감입니다.');
    const mine = j.posterId === u.id, accepted = j.acceptedId === u.id && j.status === PST.DONE;
    const out = pmCard_(j, u.id, d.apps, today);
    out.desc = j.desc;
    out.useId = j.useId || '';
    if (j.useId === '주는 기사 아이디') { const pd = driverById_(j.posterId); out.useLogin = pd && (j.posterId === u.id || j.acceptedId === u.id) ? pd.loginId || '' : ''; }
    out.canApply = pmCanApply_(j, u.id, d.apps, today);
    out.open = mine || accepted;
    if (out.open) {
      out.secret = j.secret;
      out.attachOk = !!j.attach;
      const poster = driverById_(j.posterId);
      out.posterPhone = poster ? poster.phone : '';
      if (accepted) out.posterName = j.poster;
      if (mine && j.acceptedId) { const a = driverById_(j.acceptedId); out.acceptedName = j.accepted; out.acceptedPhone = a ? a.phone : ''; }
    }
    if (mine) {
      out.raw = { kind: j.kind, date: j.date, time: j.time, area: j.area, campId: j.campId, camp: j.camp, route: j.route, qty: j.qty, top: j.top, price: j.price, pay: j.pay, useId: j.useId || '', desc: j.desc, secret: j.secret };
      out.rawStatus = j.status;
      out.apps = d.apps.filter(function (a) { return a.jobId === j.id && a.status !== PAST.CANCEL; }).map(function (a) {
        const o = driverById_(a.driverId) || {};
        return {
          id: a.id, name: a.name, status: a.status, memo: a.memo, at: a.createdAt, phone: o.phone || '', type: o.driverType || '', camp: o.schCamp || '',
          car: o.carNo || '', qual: !!o.docQual
        };
      }).sort(function (x, y) { return x.at.localeCompare(y.at); });
    }
    return { ok: true, today: today, job: out };
  });
}
/** 첨부(이미지) 보기: 등록 기사·확정 기사만 */
function api_pmAttach(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const j = pmJobById_(id);
    if (!(j.posterId === u.id || (j.acceptedId === u.id && j.status === PST.DONE))) fail_('배차가 확정된 기사에게만 보입니다.');
    const fid = fileIdOf_(j.attach);
    if (!fid) fail_('첨부파일이 없습니다.');
    let file;
    try { file = DriveApp.getFileById(fid); } catch (e) { fail_('첨부파일을 열 수 없습니다.'); }
    let blob = null;
    if (file.getSize() > 600 * 1024) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
    if (!blob) blob = file.getBlob();
    return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
  });
}

// ───────────────────────── 등록 · 수정 ─────────────────────────
/** 등록 화면용: 센터(캠프)·라우트 목록, 내 캠프·기본노선, 고를 값 */
/**
 * 품앗이 일감 올리기 '내 캠프': 오늘부터 60일, 기사스케줄 내 칸으로 그날 출근하는 캠프와 라우트를 찾는다.
 *  칸에 캠프가 적혀 있으면 그 캠프('군포1 212CD') · 휴무·휴가·병가·미입차·퇴사면 출근 아님 · 그 밖(출근·라우트만·빈칸)은 소속 캠프
 *  반환 { 'yyyy-MM-dd': { campId, route } }
 */
function pmWorkDays_(me) {
  const out = {};
  if (!me || !me.id || !props_().SCH_DB_ID) return out;
  const today = todayText_(), dates = issDates_(today, schAddDays_(today, 60));
  const camps = master_().camps.filter(function (c) { return !isStaffCamp_(c.name); });
  const shortOf = {}; camps.forEach(function (c) { shortOf[String(c.name).replace(/\s*캠프\s*$/, '').replace(/\s+/g, '')] = c.id; });
  const shorts = Object.keys(shortOf).sort(function (a, b) { return b.length - a.length; });
  const home = camps.some(function (c) { return c.id === me.schCampId; }) ? me.schCampId : '';
  let row = [], c0 = 0, h = null;
  try {
    h = schHeader_();
    const sh = schSheet_(), last = sh.getLastRow(), cols = dates.map(function (d) { return h.dates[d]; }).filter(function (c) { return c !== undefined; });
    if (last >= 2 && cols.length) {
      const ids = sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues();
      let ri = -1; for (let i = 0; i < ids.length; i++) if (str_(ids[i][0]) === String(me.id)) { ri = i; break; }
      c0 = Math.min.apply(null, cols);
      if (ri >= 0) row = sh.getRange(ri + 2, c0 + 1, 1, Math.max.apply(null, cols) - c0 + 1).getValues()[0];
    }
  } catch (e) { row = []; }
  const base = String(me.baseRoute || '').replace(/\(.*?\)|\[.*?\]/g, '').trim().split(/[\s,]+/)[0] || '';
  dates.forEach(function (d) {
    const c = h ? h.dates[d] : undefined, v = c === undefined ? '' : str_(row[c - c0]), t = v.replace(/\s+/g, '');
    if (/휴무|휴가|병가|미입차|퇴사/.test(t)) return;
    let cid = '', rest = v;
    for (let i = 0; i < shorts.length; i++) { const k = rest.replace(/\s+/g, '').indexOf(shorts[i]); if (k >= 0) { cid = shortOf[shorts[i]]; rest = v.replace(new RegExp(shorts[i].split('').join('\\s*')), ' '); break; } }
    if (!cid) cid = home;
    if (!cid) return;
    const codes = rest.replace(/\(.*?\)|\[.*?\]/g, ' ').toUpperCase().split(/[\s,]+/).filter(function (x) { return /^\d+[A-Z]*$/.test(x); });
    out[d] = { campId: cid, route: codes.join(',') || (cid === home ? base : '') };
  });
  return out;
}
function api_pmForm(token) {
  return run_(function () {
    const u = pmUser_(token);
    const m = master_(), me = driverById_(u.id) || {};
    const camps = m.camps.map(function (c) {
      return { id: c.id, name: c.name, routes: pmRouteCodes_(m.routes.filter(function (r) { return r.campId === c.id && r.status !== RST.OFF; })) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    const myCamp = m.camps.filter(function (c) { return (me.schCampId && c.id === me.schCampId) || (!me.schCampId && me.schCamp && c.name === me.schCamp); })[0];
    return {
      ok: true, camps: camps, myCampId: myCamp ? myCamp.id : '',
      work: isStaff_(me) ? null : pmWorkDays_(me), // 내 캠프: 배차일자에 출근하는 캠프만 (직함자는 전체) myRoute: String(me.baseRoute || '').replace(/\(.*?\)|\[.*?\]/g, '').trim().split(/[\s,]+/)[0] || '',
      kinds: PM_KINDS, tops: PM_TOPS, pays: PM_PAYS, paysOff: PM_PAYS_OFF, payDef: PM_PAY_DEF, defPrice: PM_JOB_PRICE, useIds: PM_USE_IDS, descTemplate: PM_DESC_TEMPLATE, secretTemplate: PM_SECRET_TEMPLATE, today: todayText_(), postOn: pmPostOn_(), offerOn: pmOfferOn_()
    };
  });
}
/** 노선 줄(527ABCD) → 고를 수 있는 라우트 [527A, 527B, …] */
/** 품앗이 일감 라우트 고르기: 노선관리의 노선 코드 그대로 (404ABCD · 410AB …). 한 글자만 맡길 때는 '직접 입력' */
function pmRouteCodes_(routes) {
  const seen = {}, out = [];
  routes.forEach(function (r) {
    const c = normCode_(r.code) || (r.g1 + [r.g2, r.g3, r.g4, r.g5].filter(Boolean).join(''));
    if (c && !seen[c]) { seen[c] = 1; out.push(c); }
  });
  return out.sort(function (a, b) { return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b); });
}
/** 센터 + 라우트 → 노선관리의 품앗이단가(없으면 고정단가) 제안 */
function api_pmPrice(token, campId, route) {
  return run_(function () {
    pmUser_(token);
    const camp = master_().camps.filter(function (c) { return c.id === campId; })[0];
    if (!camp || !route) return { ok: true, price: '' };
    let p = '';
    try {
      const f = stlPriceIndex_().find(camp.name, normCode_(route));
      if (f.row) p = f.row.p4 || f.row.p2 || '';
    } catch (e) { p = ''; }
    return { ok: true, price: p };
  });
}
/**
 * 일감 등록·수정. job = { id(수정 때), kind, date, time, area, campId, route, qty, top, price, pay, desc, secret, attach: { data, mime } | null, removeAttach }
 */
function api_pmSave(token, job) {
  return run_(function () {
    const u = pmUser_(token);
    job = job || {};
    const t = function (v, n, label, need) { const s = String(v == null ? '' : v).trim(); if (need && !s) fail_(label + '을(를) 입력해 주세요.'); if (s.length > n) fail_(label + '이(가) 너무 깁니다.'); return s; };
    const f = {};
    f.kind = t(job.kind, 10, '구분', true);
    if (PM_KINDS.indexOf(f.kind) < 0) fail_('구분은 ' + PM_KINDS.join(' / ') + ' 중에서 골라 주세요.');
    f.date = pmDate_(job.date);
    if (!f.date) fail_('배차일자를 입력해 주세요.');
    if (!job.id && pmPast_(f)) fail_(f.date < todayText_() ? '지난 날짜로는 올릴 수 없습니다.' : '야간 품앗이는 그날 아침 7시에 끝나 오늘 날짜로는 올릴 수 없습니다.');
    f.time = t(job.time, 20, '입차시간', true);
    f.area = t(job.area, 40, '배송지', true);
    const camp = master_().camps.filter(function (c) { return c.id === str_(job.campId); })[0];
    if (!camp) fail_('센터(캠프)를 골라 주세요.');
    f.campId = camp.id; f.camp = camp.name;
    f.route = normCode_(t(job.route, 20, '라우트'));
    f.qty = t(job.qty, 20, '평균 물량', true);
    f.top = t(job.top, 10, '탑 종류');
    if (f.top && PM_TOPS.indexOf(f.top) < 0) fail_('탑 종류를 확인해 주세요.');
    const price = pmMoney_(job.price);
    if (price === null || !price) fail_('건당 단가를 숫자로 입력해 주세요.');
    f.price = price;
    f.pay = t(job.pay, 10, '지급방법', true);
    if (PM_PAYS.indexOf(f.pay) < 0) fail_('지급방법을 골라 주세요.');
    if (!job.id) pmPayOk_(f.pay, ''); // 고칠 때는 아래에서 예전 값과 견줌
    f.useId = PM_USE_IDS.indexOf(str_(job.useId)) >= 0 ? str_(job.useId) : '';
    if (!job.id && !job.offerToId && !pmPostOn_()) fail_('지금은 사무실에서 품앗이 일감 올리기를 잠시 막아 두었습니다. 사무실에 문의해 주세요.');
    if (!job.id && job.offerToId && !pmOfferOn_()) fail_('지금은 사무실에서 품앗이 일감 제안을 잠시 막아 두었습니다. 사무실에 문의해 주세요.');
    f.desc = t(job.desc, 3000, '상세 설명');
    f.secret = t(job.secret, 1500, '비공개 정보');
    // 단가가 평소 단가보다 낮으면 먼저 확인받는다 (okLow 로 다시 보내면 그대로 등록)
    if (!job.okLow) { const low = pmLowPriceNote_(f.campId, f.route, f.price); if (low) return { ok: false, code: 'LOW', msg: low }; }
    // 첨부 (이미지 1장) — 잠금 밖에서 올린다
    let attachUrl = null;
    if (job.attach && job.attach.data) {
      if (!/^image\//.test(String(job.attach.mime))) fail_('첨부는 이미지 파일만 올릴 수 있습니다.');
      if (String(job.attach.data).length > CFG.MAX_FILE_B64) fail_('이미지가 너무 큽니다.');
      const ext = /png/.test(job.attach.mime) ? '.png' : '.jpg';
      const file = pmFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(job.attach.data), job.attach.mime, (f.date + '_' + f.camp + '_' + (f.route || f.area) + '_' + u.info.name).replace(/[\\\/:*?"<>|]/g, ' ') + ext));
      attachUrl = file.getUrl();
    }
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (job.id) {
        const row = findRow_(SH.PJOB, 'id', String(job.id));
        if (!row) fail_('일감을 찾을 수 없습니다.');
        const o = readObj_(SH.PJOB, row);
        if (o.posterId !== u.id) fail_('내가 올린 일감만 고칠 수 있습니다.');
        if (o.status !== PST.OPEN && o.status !== PST.TALK) fail_('배차가 확정되었거나 마감된 일감은 고칠 수 없습니다. 확정을 풀거나 다시 열어 주세요.');
        pmPayOk_(f.pay, str_(o.pay));
        if (attachUrl) f.attach = attachUrl; else if (job.removeAttach) f.attach = '';
        f.updatedAt = now;
        writeFields_(SH.PJOB, row, f);
        // 지원 기록의 배차일도 맞춘다 (같은 날 2회 제한 계산용)
        const oapps = readAll_(SH.PAPP).filter(function (a) { return a.jobId === o.id; });
        if (f.date !== o.date) oapps.forEach(function (a) { writeFields_(SH.PAPP, a._row, { date: f.date }); });
        oapps.forEach(function (a) { if (pmActiveApp_(a)) out.push(pmA_(a.driverId, a.name, Object.assign({}, o, f), 'edit')); });
        pmAlertAdd_(out);
        pmTouch_();
        return { ok: true, id: o.id };
      }
      const id = uniqId_('J');
      // 품앗이 주세요: 근무 가능일을 올린 기사에게 제안 → 그 기사에게만 보이는 일감 + 지원 '제안'
      let tgt = null;
      if (job.offerToId) {
        tgt = driverById_(str_(job.offerToId));
        if (!tgt || tgt.status !== ST.ACTIVE) fail_('제안할 기사를 찾을 수 없습니다.');
        if (tgt.id === u.id) fail_('나에게는 제안할 수 없습니다.');
        const busy = readAll_(SH.PJOB).some(function (x) { return x.acceptedId === tgt.id && x.status === PST.DONE && x.date === f.date; });
        if (busy) fail_(tgt.name + ' 기사님은 ' + f.date + ' 에 이미 확정된 품앗이가 있습니다.');
        f.offerToId = tgt.id; f.offerTo = tgt.name;
      }
      const row = Object.assign({ id: id, status: PST.OPEN, posterId: u.id, poster: u.info.name, attach: attachUrl || '', createdAt: now, updatedAt: now }, f);
      appendObj_(SH.PJOB, row);
      if (tgt) {
        appendObj_(SH.PAPP, { id: uniqId_('A'), jobId: id, driverId: tgt.id, name: tgt.name, date: f.date, status: PAST.OFFER, memo: str_(job.offerMemo).slice(0, 200), createdAt: now, updatedAt: now });
        out.push(pmA_(tgt.id, tgt.name, row, 'offer', u.info.name));
        pmAlertAdd_(out);
      } else {
        // 공개 일감: 러너 기사 모두에게 '새 품앗이 일감' 알림 (휴대폰 알림 포함 · 올린 기사 제외)
        try { pmNewJobAlerts_(row, u.info.name, [u.id]).forEach(function (a) { out.push(a); }); pmAlertAdd_(out); } catch (e) { errLog_('서버 오류', 'pmNewJobAlerts_', '새 일감 알림 실패: ' + String(e && e.message || e)); }
      }
      pmTouch_();
      return { ok: true, id: id, offered: tgt ? tgt.name : '' };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  });
}
function pmFolder_() {
  const p = props_();
  if (p.PM_FOLDER) { try { return DriveApp.getFolderById(p.PM_FOLDER); } catch (e) { /* 새로 */ } }
  const root = DriveApp.getFolderById(p.ROOT_FOLDER_ID), it = root.getFoldersByName ? root.getFoldersByName('품앗이 첨부') : null;
  const f = it && it.hasNext() ? it.next() : root.createFolder('품앗이 첨부');
  PropertiesService.getScriptProperties().setProperty('PM_FOLDER', f.getId());
  _props = null;
  return f;
}

// ───────────────────────── 지원 ─────────────────────────
function api_pmApply(token, id, memo) {
  return run_(function () {
    const u = pmUser_(token);
    const me = driverById_(u.id) || {};
    if (!me.docQual) fail_('화물운송 종사자격증을 등록한 기사만 지원할 수 있습니다. 사무실에 자격증 등록을 요청해 주세요.');
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const j = pmJobById_(id), today = todayText_();
      const apps = readAll_(SH.PAPP);
      const why = pmCanApply_(j, u.id, apps, today);
      if (why) fail_(why);
      const now = nowText_(), appId = uniqId_('A');
      appendObj_(SH.PAPP, { id: appId, jobId: j.id, driverId: u.id, name: u.info.name, date: j.date, status: PAST.APPLY, memo: String(memo || '').trim().slice(0, 200), createdAt: now, updatedAt: now });
      // 사무실에서 올린 일감: 지원하면 바로 배차 확정 (먼저 지원한 기사 · 잠금 안에서 처리해 두 명이 동시에 확정되지 않게)
      //  → 확정 알림(지원 기사 · 맡긴 기사) · 기사스케줄 품앗이 줄에 표시 (pmDecide_ 'accept' 와 같은 길)
      if (j.byOffice) {
        pmDecide_('', j.id, appId, 'accept');
        return { ok: true, confirmed: true };
      }
      out.push(pmA_(j.posterId, j.poster, j, 'apply', u.info.name));
      pmAlertAdd_(out);
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  });
}
function api_pmCancelApply(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const a = readAll_(SH.PAPP).filter(function (x) { return x.jobId === id && x.driverId === u.id && pmActiveApp_(x); })[0];
      if (!a) fail_('지원 기록이 없습니다.');
      const j = pmJobById_(id), row = findRow_(SH.PJOB, 'id', j.id), now = nowText_();
      writeFields_(SH.PAPP, a._row, { status: PAST.CANCEL, updatedAt: now });
      // 확정된 기사가 취소하면 일감은 다시 모집 중
      out.push(pmA_(j.posterId, j.poster, j, j.acceptedId === u.id ? 'cancelOk' : 'cancel', u.info.name));
      if (j.acceptedId === u.id && j.status === PST.DONE) pmSchOp_(out, 'clear', u.id, j);
      pmAlertAdd_(out);
      if (j.acceptedId === u.id) writeFields_(SH.PJOB, row, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now });
      else if (j.status === PST.TALK && a.status === PAST.TALK && !readAll_(SH.PAPP).some(function (x) { return x.jobId === id && x.id !== a.id && x.status === PAST.TALK; })) writeFields_(SH.PJOB, row, { status: PST.OPEN, updatedAt: now });
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  });
}

// ───────────────────────── 등록 기사: 지원자 정하기 · 마감 ─────────────────────────
/**
 * action: 'talk'(협의 중) / 'accept'(배차 확정) / 'reject'(미선정) / 'back'(지원 상태로 되돌림)
 * 확정하면 나머지 지원자는 미선정, 일감은 배차 확정.
 */
function api_pmDecide(token, jobId, appId, action) {
  return run_(function () { return pmDecide_(pmUser_(token).id, jobId, appId, action); });
}
/** posterId 가 비어 있으면 관리자 (아무 일감이나) */
function pmDecide_(posterId, jobId, appId, action) {
  {
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const j = pmJobById_(jobId), jr = findRow_(SH.PJOB, 'id', j.id);
      if (posterId && j.posterId !== posterId) fail_('내가 올린 일감만 정할 수 있습니다.');
      if (j.status === PST.CANCEL || j.status === PST.CLOSED) fail_('마감되었거나 취소된 일감입니다. 다시 열어 주세요.');
      const apps = readAll_(SH.PAPP).filter(function (a) { return a.jobId === j.id; });
      const a = apps.filter(function (x) { return x.id === appId; })[0];
      if (!a || a.status === PAST.CANCEL) fail_('지원자를 찾을 수 없습니다. 지원을 취소했을 수 있습니다.');
      const now = nowText_();
      if (action === 'talk') {
        if (j.status === PST.DONE) fail_('이미 배차가 확정되었습니다. 확정을 먼저 풀어 주세요.');
        writeFields_(SH.PAPP, a._row, { status: PAST.TALK, updatedAt: now });
        writeFields_(SH.PJOB, jr, { status: PST.TALK, updatedAt: now });
        out.push(pmA_(a.driverId, a.name, j, 'talk'));
      } else if (action === 'accept') {
        if (pmPast_(j)) fail_('배차일이 지난 일감입니다. (야간은 그날 아침 7시에 끝남)');
        apps.forEach(function (x) {
          if (x.id === a.id) { writeFields_(SH.PAPP, x._row, { status: PAST.OK, updatedAt: now }); out.push(pmA_(x.driverId, x.name, j, 'accept')); }
          else if (pmActiveApp_(x)) { writeFields_(SH.PAPP, x._row, { status: PAST.NO, updatedAt: now }); out.push(pmA_(x.driverId, x.name, j, 'lost')); }
        });
        writeFields_(SH.PJOB, jr, { status: PST.DONE, acceptedId: a.driverId, accepted: a.name, updatedAt: now });
        if (j.status === PST.DONE && j.acceptedId && j.acceptedId !== a.driverId) pmSchOp_(out, 'clear', j.acceptedId, j);
        pmSchOp_(out, 'set', a.driverId, j);
      } else if (action === 'reject') {
        writeFields_(SH.PAPP, a._row, { status: PAST.NO, updatedAt: now });
        out.push(pmA_(a.driverId, a.name, j, 'reject'));
        if (j.acceptedId === a.driverId) { writeFields_(SH.PJOB, jr, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now }); pmSchOp_(out, 'clear', a.driverId, j); }
        else if (j.status === PST.TALK && !apps.some(function (x) { return x.id !== a.id && x.status === PAST.TALK; })) writeFields_(SH.PJOB, jr, { status: PST.OPEN, updatedAt: now });
      } else if (action === 'back') {
        // 확정 풀기 / 미선정 되돌리기 → 지원 상태
        writeFields_(SH.PAPP, a._row, { status: PAST.APPLY, updatedAt: now });
        if (j.acceptedId === a.driverId) {
          out.push(pmA_(a.driverId, a.name, j, 'unaccept'));
          pmSchOp_(out, 'clear', a.driverId, j);
          apps.forEach(function (x) { if (x.id !== a.id && x.status === PAST.NO) writeFields_(SH.PAPP, x._row, { status: PAST.APPLY, updatedAt: now }); });
          writeFields_(SH.PJOB, jr, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now });
        }
      } else fail_('알 수 없는 작업입니다.');
      if (!posterId) out.push(pmA_(j.posterId, j.poster, j, 'admin', action));
      pmAlertAdd_(out);
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  }
}
/** action: 'close'(모집 마감) / 'reopen'(다시 모집) / 'cancel'(일감 취소) */
function api_pmClose(token, id, action) {
  return run_(function () { return pmClose_(pmUser_(token).id, id, action); });
}
function pmClose_(posterId, id, action) {
  {
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const j = pmJobById_(id), jr = findRow_(SH.PJOB, 'id', j.id), now = nowText_();
      if (posterId && j.posterId !== posterId) fail_('내가 올린 일감만 바꿀 수 있습니다.');
      if (action === 'close') {
        if (j.status === PST.DONE) fail_('배차가 확정된 일감입니다.');
        writeFields_(SH.PJOB, jr, { status: PST.CLOSED, updatedAt: now });
        readAll_(SH.PAPP).forEach(function (x) { if (x.jobId === j.id && (x.status === PAST.APPLY || x.status === PAST.TALK)) out.push(pmA_(x.driverId, x.name, j, 'closed')); });
      } else if (action === 'reopen') {
        if (pmPast_(j)) fail_('배차일이 지난 일감은 다시 열 수 없습니다. (야간은 그날 아침 7시에 끝남)');
        // 제안이 거절된 일감을 다시 열면 모든 기사에게 공개
        writeFields_(SH.PJOB, jr, j.offerToId ? { status: PST.OPEN, offerToId: '', offerTo: '', updatedAt: now } : { status: PST.OPEN, updatedAt: now });
        if (j.offerToId) readAll_(SH.PAPP).forEach(function (x) { if (x.jobId === j.id && x.status === PAST.OFFER) { writeFields_(SH.PAPP, x._row, { status: PAST.NO, updatedAt: now }); out.push(pmA_(x.driverId, x.name, j, 'canceled')); } });
      } else if (action === 'cancel') {
        writeFields_(SH.PJOB, jr, { status: PST.CANCEL, acceptedId: '', accepted: '', updatedAt: now });
        if (j.status === PST.DONE && j.acceptedId) pmSchOp_(out, 'clear', j.acceptedId, j);
        readAll_(SH.PAPP).forEach(function (x) { if (x.jobId === j.id && pmActiveApp_(x)) { writeFields_(SH.PAPP, x._row, { status: PAST.NO, updatedAt: now }); out.push(pmA_(x.driverId, x.name, j, 'canceled')); } });
      } else fail_('알 수 없는 작업입니다.');
      if (!posterId) out.push(pmA_(j.posterId, j.poster, j, 'admin', action));
      pmAlertAdd_(out);
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  }
}

// ───────────────────────── 마이페이지 ─────────────────────────
/** kind: 'posted'(품앗이 관리: 내가 올린 일감) / 'applied'(지원한 품앗이) / 'done'(완료한 품앗이: 확정되고 배차일 지난 것, 올린 것·뛴 것 모두) */
function api_pmMine(token, kind) {
  return run_(function () {
    const u = pmUser_(token);
    const today = todayText_(), d = pmData_();
    const byId = {};
    d.jobs.forEach(function (j) { byId[j.id] = j; });
    let list = [];
    if (kind === 'posted') {
      list = d.jobs.filter(function (j) { return j.posterId === u.id && !(j.status === PST.DONE && pmPast_(j, today)); })
        .map(function (j) {
          const c = pmCard_(j, u.id, d.apps, today);
          c.newApps = d.apps.filter(function (a) { return a.jobId === j.id && a.status === PAST.APPLY; }).length;
          c.acceptedName = j.accepted;
          return c;
        });
    } else if (kind === 'applied') {
      list = d.apps.filter(function (a) { return a.driverId === u.id && byId[a.jobId] && !(a.status === PAST.OK && pmAppPast_(a, byId, today)); })
        .map(function (a) { const c = pmCard_(byId[a.jobId], u.id, d.apps, today); c.myApp = a.status; c.appliedAt = a.createdAt; return c; });
    } else if (kind === 'done') {
      list = d.jobs.filter(function (j) { return j.status === PST.DONE && pmPast_(j, today) && (j.posterId === u.id || j.acceptedId === u.id); })
        .map(function (j) { const c = pmCard_(j, u.id, d.apps, today); c.role = j.posterId === u.id ? '맡김' : '수행'; c.partner = j.posterId === u.id ? j.accepted : j.poster; return c; });
    } else fail_('알 수 없는 목록입니다.');
    list.sort(function (a, b) { return kind === 'done' ? (b.date + b.time).localeCompare(a.date + a.time) : (a.date + a.time).localeCompare(b.date + b.time); });
    return { ok: true, today: today, jobs: list };
  });
}
/** 내 정보 (보기 전용 · 바꿀 때는 사무실로) */
function api_myInfo(token) {
  return run_(function () {
    const u = pmUser_(token);
    const o = driverById_(u.id) || {};
    const d = pmData_(), today = todayText_();
    return {
      ok: true, info: {
        name: o.name, loginId: o.loginId, phone: o.phone, type: TITLES.indexOf(str_(o.driverType)) >= 0 ? '' : (o.driverType || ''), title: titleOf_(o), code: o.driverCode || '',
        camp: isStaffCamp_(o.schCamp) ? '' : (o.schCamp || ''), baseRoute: o.baseRoute || '',
        carNo: o.carNo || '', qual: !!o.docQual, bank: o.bankName || ''
      },
      stats: {
        posted: d.jobs.filter(function (j) { return j.posterId === u.id && j.status !== PST.CANCEL; }).length,
        helped: d.jobs.filter(function (j) { return j.acceptedId === u.id && j.status === PST.DONE && pmPast_(j, today); }).length,
        giveDays: (d.avail || []).filter(function (a) { return a.driverId === u.id && !pmPast_(a, today); }).length,
        offers: d.apps.filter(function (a) { return a.driverId === u.id && a.status === PAST.OFFER && !pmAppPast_(a, pmJobMap_(d), today); }).length,
        // 내 일감에 온 지원 중 아직 답하지 않은 수 (api_pmList 의 waiting 과 같은 셈 · 마이페이지가 목록을 따로 부르지 않게)
        waiting: d.jobs.filter(function (j) { return j.posterId === u.id && (j.status === PST.OPEN || j.status === PST.TALK) && !pmPast_(j, today); })
          .reduce(function (n, j) { return n + d.apps.filter(function (a) { return a.jobId === j.id && a.status === PAST.APPLY; }).length; }, 0)
      }, postOn: pmPostOn_(), offerOn: pmOfferOn_()
    };
  });
}
/** 내 스케줄에 붙일 품앗이: { 날짜: [{ role: '수행'|'맡김'|'지원', text, status }] } (내가 뛰는 확정 일감 + 내가 맡긴 일감(모집 중·확정) + 지원·협의 중인 일감) */
function pmScheduleOf_(me, dates) {
  const out = {};
  if (!dates.length) return out;
  const set = {};
  dates.forEach(function (d) { set[d] = 1; });
  let d;
  try { d = pmData_(); } catch (e) { return out; }
  d.jobs.forEach(function (j) {
    if (!set[j.date] || j.status === PST.CANCEL) return;
    const base = (j.camp ? j.camp.replace(/\s*캠프$/, '') + ' ' : '') + (j.route || j.area) + ' · ' + j.time;
    const sc = String(j.camp || '').replace(/\s*캠프$/, ''), rt = j.route || '';
    if (j.status === PST.DONE && j.acceptedId === me) (out[j.date] = out[j.date] || []).push({ role: '수행', id: j.id, text: base + ' (' + (j.posterId ? j.poster + ' 기사님 일' : '러너 노선') + ')', status: '확정', camp: sc, route: rt, who: j.poster || '' });
    // 내가 맡긴 일감이 배차 확정됨: 달력 칸에 '맡김 → 받은 기사' (칸 노선과 같아 '배차확정 완료'로 이미 보이는 날은 앱이 겹쳐 보이지 않게 뺀다)
    else if (j.status === PST.DONE && j.posterId === me) (out[j.date] = out[j.date] || []).push({ role: '맡김', id: j.id, text: base + ' → ' + (j.accepted || '') + ' 기사님', status: '확정', camp: sc, route: rt, who: j.accepted || '' });
    // 내가 올린(맡긴) 일감: 모집 중·협의 중일 때만 보이고, 배차가 확정되면 내 스케줄에서 뺀다
    else if (j.posterId === me && (j.status === PST.OPEN || j.status === PST.TALK)) (out[j.date] = out[j.date] || []).push({ role: '맡김', id: j.id, text: base, status: j.status });
  });
  d.apps.forEach(function (a) {
    if (a.driverId !== me || !set[a.date] || (a.status !== PAST.APPLY && a.status !== PAST.TALK && a.status !== PAST.OFFER)) return;
    const j = d.jobs.filter(function (x) { return x.id === a.jobId; })[0];
    if (!j || j.status === PST.CANCEL) return;
    (out[a.date] = out[a.date] || []).push({ role: '지원', id: j.id, text: (j.camp ? j.camp.replace(/\s*캠프$/, '') + ' ' : '') + (j.route || j.area) + ' · ' + j.time, status: a.status });
  });
  return out;
}

// ───────────────────────── 품앗이 주세요 (근무 가능일 · 제안) ─────────────────────────
const PM_AVAIL_DAYS = 62;              // 오늘부터 며칠 앞까지 고를 수 있나
const PM_AVAIL_KINDS = ['무관', '주간', '야간'];
const PM_CREWS = ['1인', '2인1조'];
const PM_GIVE_PRICE = 1100; // 희망 단가 기본값
const PM_INFO_KEYS = ['area', 'campId', 'camp', 'crew', 'qty', 'top', 'price', 'pay', 'useId'];
/** 근무 가능일 줄에서 기사 기본 정보 꺼내기 */
function pmInfoOf_(a) { const o = {}; PM_INFO_KEYS.forEach(function (k) { o[k] = a ? str_(a[k]) : ''; }); return o; }
/** 내 근무 가능일 (오늘 이후) + 이미 확정된 날 */
function api_pmAvailMine(token) {
  return run_(function () {
    const u = pmUser_(token);
    const d = pmData_(), today = todayText_(), me = driverById_(u.id) || {};
    const list = d.avail.filter(function (a) { return a.driverId === u.id && !pmPast_(a, today); })
      .map(function (a) { return { date: a.date, kind: PM_AVAIL_KINDS.indexOf(a.kind) >= 0 ? a.kind : '무관' }; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    const mine = d.avail.filter(function (a) { return a.driverId === u.id; }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    const memo = (mine.filter(function (a) { return a.date >= today && a.memo; })[0] || {}).memo || '';
    const booked = d.jobs.filter(function (j) { return j.acceptedId === u.id && j.status === PST.DONE && !pmPast_(j, today); }).map(function (j) { return j.date; });
    // 기본 정보: 마지막으로 저장한 값 → 없으면 내 소속 캠프 · 희망 단가 1,100원 · 당일지급
    const info = pmInfoOf_(mine[0]);
    const myCamp = master_().camps.filter(function (c) { return (me.schCampId && c.id === me.schCampId) || (!me.schCampId && me.schCamp && c.name === me.schCamp); })[0];
    if (!mine.length) { info.campId = myCamp ? myCamp.id : ''; info.camp = myCamp ? myCamp.name : ''; info.crew = '1인'; info.price = String(PM_GIVE_PRICE); info.pay = PM_PAY_DEF; info.useId = '받는 기사 아이디'; }
    const camps = master_().camps.map(function (c) { return { id: c.id, name: c.name }; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    const until0 = ymd_(addDays_(parseYmd_(today), PM_AVAIL_DAYS));
    let busy = [];
    try { busy = schWorkDates_(u.id, today, until0); } catch (e) { busy = []; }
    return { ok: true, today: today, until: until0, list: list, memo: memo, info: info, booked: booked, busy: busy, kinds: PM_AVAIL_KINDS, qual: !!me.docQual,
      camps: camps, crews: PM_CREWS, tops: PM_TOPS, pays: PM_PAYS, paysOff: PM_PAYS_OFF, useIds: PM_USE_IDS, defPrice: PM_GIVE_PRICE, myLogin: me.loginId || '' };
  });
}
/** 내 근무 가능일 저장: list = [{ date, kind }] (오늘 이후 것을 통째로 바꾼다), memo = 한마디 */
function api_pmAvailSave(token, list, memo, info) {
  return run_(function () {
    const u = pmUser_(token);
    const me = driverById_(u.id) || {};
    if (!me.docQual) fail_('화물운송 종사자격증을 등록한 기사만 품앗이를 받을 수 있습니다. 사무실에 자격증 등록을 요청해 주세요.');
    const today = todayText_(), until = ymd_(addDays_(parseYmd_(today), PM_AVAIL_DAYS));
    if (!Array.isArray(list) || list.length > 100) fail_('날짜를 확인해 주세요.');
    const seen = {}, rows = [], now = nowText_(), m = str_(memo).slice(0, 100);
    // 기본 정보 (원하는 지역 · 캠프 · 배송 인원 · 원하는 수량 · 탑 종류 · 희망 단가 · 지급방법)
    info = info || {};
    const inf = { area: str_(info.area).slice(0, 40), crew: PM_CREWS.indexOf(str_(info.crew)) >= 0 ? str_(info.crew) : '', qty: str_(info.qty).slice(0, 20),
      top: PM_TOPS.indexOf(str_(info.top)) >= 0 ? str_(info.top) : '', pay: PM_PAYS.indexOf(str_(info.pay)) >= 0 && PM_PAYS_OFF.indexOf(str_(info.pay)) < 0 ? str_(info.pay) : '',
      useId: PM_USE_IDS.indexOf(str_(info.useId)) >= 0 ? str_(info.useId) : '' };
    const camp = master_().camps.filter(function (c) { return c.id === str_(info.campId); })[0];
    inf.campId = camp ? camp.id : ''; inf.camp = camp ? camp.name : '';
    const pr = str_(info.price) === '' ? null : pmMoney_(info.price);
    if (str_(info.price) !== '' && (pr === null || pr <= 0)) fail_('희망 단가는 숫자로 입력해 주세요.');
    inf.price = pr ? String(pr) : '';
    // 이미 근무 스케줄이 있는 날은 근무 가능일로 올릴 수 없다
    let busy = {};
    try { schWorkDates_(u.id, today, until).forEach(function (d) { busy[d] = 1; }); } catch (e) { busy = {}; }
    const busyHit = [];
    list.forEach(function (x) {
      const dt = pmDate_(x && x.date);
      if (!dt || dt > until || seen[dt] || pmPast_({ date: dt, kind: x.kind }, today)) return;
      if (busy[dt]) { busyHit.push(dt); return; }
      seen[dt] = 1;
      rows.push(Object.assign({ id: uniqId_('V'), driverId: u.id, name: u.info.name, date: dt, kind: PM_AVAIL_KINDS.indexOf(x.kind) >= 0 ? x.kind : '무관', memo: m, createdAt: now }, inf));
    });
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const old = readAll_(SH.PAVAIL).filter(function (a) { return a.driverId === u.id && (!pmDate_(a.date) || pmDate_(a.date) >= today); }).map(function (a) { return a._row; });
      delRows_(sheet_(SH.PAVAIL), old);
      if (rows.length) appendObjs_(SH.PAVAIL, rows);
      pmTouch_();
    } finally {
      lock.releaseLock();
    }
    return { ok: true, count: rows.length, busy: busyHit };
  });
}
/** 근무 가능한 다른 기사들 (오늘 이후). 이미 품앗이가 확정된 날은 뺀다 */
function api_pmAvailList(token) {
  return run_(function () {
    const u = pmUser_(token);
    const d = pmData_(), today = todayText_();
    return { ok: true, today: today, until: ymd_(addDays_(parseYmd_(today), PM_AVAIL_DAYS)), drivers: pmAvailDrivers_(u.id, d, today, false) };
  });
}
/** 근무 가능일을 올린 기사 목록 (확정된 날 빼고). withMe = 내 것도 포함 */
function pmAvailDrivers_(me, d, today, withMe) {
  {
    const booked = {};
    d.jobs.forEach(function (j) { if (j.status === PST.DONE && j.acceptedId) booked[j.acceptedId + '|' + j.date] = 1; });
    const offered = {};
    d.apps.forEach(function (a) { if (a.status === PAST.OFFER) offered[a.driverId + '|' + a.date] = (offered[a.driverId + '|' + a.date] || 0) + 1; });
    const by = {};
    d.avail.forEach(function (a) {
      if ((!withMe && a.driverId === me) || pmPast_(a, today) || booked[a.driverId + '|' + a.date]) return;
      const x = by[a.driverId] || (by[a.driverId] = { id: a.driverId, name: a.name, memo: '', dates: [], info: pmInfoOf_(a) });
      if (a.memo) x.memo = a.memo;
      x.dates.push({ date: a.date, kind: PM_AVAIL_KINDS.indexOf(a.kind) >= 0 ? a.kind : '무관', offered: offered[a.driverId + '|' + a.date] || 0 });
    });
    // 기사가 여럿이면 기사 탭을 한 번만 읽는다 (기사마다 driverById_ 로 한 줄씩 읽으면 그 수만큼 시트 호출)
    const idsNeed = Object.keys(by), dmap = {};
    if (idsNeed.length > 2) readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) dmap[o.id] = o; });
    const list = idsNeed.map(function (id) {
      const x = by[id], o = (idsNeed.length > 2 ? dmap[id] : driverById_(id)) || {};
      if (o.status && o.status !== ST.ACTIVE) return null;
      x.name = o.name || x.name; x.camp = o.schCamp || ''; x.type = o.driverType || ''; x.me = id === me;
      x.dates.sort(function (a, b) { return a.date.localeCompare(b.date); });
      return x;
    }).filter(Boolean).sort(function (a, b) { return a.dates[0].date.localeCompare(b.dates[0].date) || a.name.localeCompare(b.name, 'ko'); });
    return list;
  }
}
/** 제안받은 기사: 수락(yes = true → 바로 배차 확정) / 거절 (→ 일감 모집 마감, 등록 기사에게 알림) */
function api_pmOfferReply(token, jobId, yes) {
  return run_(function () {
    const u = pmUser_(token);
    let appId = '', j = null;
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      j = pmJobById_(jobId);
      const a = readAll_(SH.PAPP).filter(function (x) { return x.jobId === j.id && x.driverId === u.id && x.status === PAST.OFFER; })[0];
      if (!a) fail_('이미 처리된 제안입니다. 새로고침해 주세요.');
      if (j.status === PST.CANCEL || j.status === PST.CLOSED) fail_('취소되었거나 마감된 일감입니다.');
      const now = nowText_();
      if (yes) {
        if (pmPast_(j)) fail_('배차일이 지난 일감입니다. (야간은 그날 아침 7시에 끝남)');
        writeFields_(SH.PAPP, a._row, { status: PAST.APPLY, updatedAt: now });
        appId = a.id;
      } else {
        writeFields_(SH.PAPP, a._row, { status: PAST.NO, updatedAt: now });
        writeFields_(SH.PJOB, findRow_(SH.PJOB, 'id', j.id), { status: PST.CLOSED, updatedAt: now });
        out.push(pmA_(j.posterId, j.poster, j, 'offerNo', u.info.name));
        pmAlertAdd_(out);
      }
      pmTouch_();
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
    if (yes) {
      pmDecide_(j.posterId, j.id, appId, 'accept'); // 배차 확정 (확정 알림·스케줄 반영은 기존 방식 그대로)
      const o2 = [pmA_(j.posterId, j.poster, j, 'offerOk', u.info.name)];
      const lk = scriptLock_();
      lk.waitLock(20000);
      try { pmAlertAdd_(o2); } finally { lk.releaseLock(); pmAfter_(o2); }
    }
    return { ok: true };
  });
}

// ───────────────────────── 알림 (앱 안 실시간 알림 + 휴대폰 푸시) ─────────────────────────
/** 일감 짧은 이름: 11/10 강서1 527B */
function pmJobLabel_(j) {
  const p = String(j.date || '').split('-');
  return (p.length === 3 ? (+p[1]) + '/' + (+p[2]) + ' ' : '') + String(j.camp || '').replace(/\s*캠프$/, '') + ' ' + (j.route || j.area || '');
}
const PM_ALERT_TEXT = {
  offer: function (j, who) { return ['💌 품앗이 제안', who + ' 기사님이 ' + pmJobLabel_(j) + ' 일감을 제안했습니다. 수락하면 바로 배차 확정됩니다.']; },
  offerOk: function (j, who) { return ['✅ 제안 수락', who + ' 기사님이 ' + pmJobLabel_(j) + ' 제안을 수락했습니다. 배차 확정되었습니다.']; },
  offerNo: function (j, who) { return ['제안 거절', who + ' 기사님이 ' + pmJobLabel_(j) + ' 제안을 거절했습니다. 품앗이 관리에서 [다시 모집]을 누르면 모든 기사에게 공개됩니다.']; },
  apply: function (j, who) { return ['🙋 새 지원', who + ' 기사님이 ' + pmJobLabel_(j) + ' 일감에 지원했습니다. 전화로 협의해 주세요.']; },
  cancel: function (j, who) { return ['지원 취소', who + ' 기사님이 ' + pmJobLabel_(j) + ' 지원을 취소했습니다.']; },
  cancelOk: function (j, who) { return ['⚠️ 확정 기사 취소', '확정된 ' + who + ' 기사님이 ' + pmJobLabel_(j) + ' 일을 취소했습니다. 다시 모집 중입니다.']; },
  talk: function (j) { return ['📞 배차 협의 중', j.poster + ' 기사님이 ' + pmJobLabel_(j) + ' 일감을 협의 중으로 바꿨습니다. 전화를 받아 주세요.']; },
  accept: function (j) { return ['✅ 배차 확정', pmJobLabel_(j) + ' 일감이 기사님으로 확정되었습니다. 배송지코드·연락처를 확인하세요.']; },
  lost: function (j) { return ['미선정', pmJobLabel_(j) + ' 일감은 다른 기사님으로 확정되었습니다.']; },
  reject: function (j) { return ['미선정', pmJobLabel_(j) + ' 일감에 선정되지 않았습니다.']; },
  unaccept: function (j) { return ['⚠️ 배차 확정 취소', pmJobLabel_(j) + ' 일감의 배차 확정이 풀렸습니다.']; },
  closed: function (j) { return ['모집 마감', pmJobLabel_(j) + ' 일감의 모집이 마감되었습니다.']; },
  canceled: function (j) { return ['⚠️ 일감 취소', pmJobLabel_(j) + ' 일감이 취소되었습니다.']; },
  newjob: function (j, who) { return ['📢 새 품앗이 일감', (who ? who + ' 기사님이 ' : '') + pmJobLabel_(j) + ' (' + (j.kind || '') + (j.time ? ' · ' + j.time : '') + ') 일감을 올렸습니다.' + (j.price ? ' 건당 ' + String(Number(j.price)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원' : '')]; },
  edit: function (j) { return ['✏️ 일감 내용 변경', pmJobLabel_(j) + ' 일감 내용이 바뀌었습니다. 확인해 주세요.']; },
  office: function (j, how) { return ['🛠 사무실 등록', '사무실에서 기사님 이름으로 ' + pmJobLabel_(j) + ' 품앗이 일감을 ' + (how || '올렸습니다.')]; },
  admin: function (j, act) { return ['🛠 사무실 처리', pmJobLabel_(j) + ' 일감을 사무실에서 ' + ({ talk: '협의 중으로', accept: '배차 확정으로', reject: '지원자 거절로', back: '지원 상태로 되돌림으로', close: '모집 마감으로', reopen: '다시 모집으로', cancel: '취소로' }[act] || '변경') + ' 처리했습니다.']; }
};
/** 새 공개 일감 → 재직 중인 러너 기사 모두에게 알림 (올린 기사·빼 줄 기사 제외) */
function pmNewJobAlerts_(j, who, skip) {
  const no = {}; (skip || []).forEach(function (x) { if (x) no[String(x)] = 1; });
  return readAll_(SH.DRIVERS).filter(function (o) { return o.id && !no[String(o.id)] && o.status === ST.ACTIVE && str_(o.workStatus) !== '퇴사'; })
    .map(function (o) { return pmA_(o.id, o.name, j, 'newjob', who); });
}
/** 알림 1건 만들기 (아직 저장 전) */
function pmA_(driverId, name, j, kind, who) {
  const t = PM_ALERT_TEXT[kind](j, who || '');
  return { driverId: String(driverId || ''), name: name || '', jobId: j.id, kind: kind, title: t[0], text: t[1] };
}
/** 알림을 시트에 쌓고 받는 기사의 알림 버전을 올린다 (앱이 다음 확인 때 바로 가져감) */
function pmAlertAdd_(list) {
  list = (list || []).filter(function (a) { return a && a.driverId; });
  if (!list.length) return;
  const now = nowText_();
  appendObjs_(SH.PALERT, list.map(function (a) { return { id: uniqId_('N'), driverId: a.driverId, name: a.name, jobId: a.jobId, kind: a.kind, text: a.title + ' · ' + a.text, createdAt: now, readAt: '' }; }));
  const seen = {};
  list.forEach(function (a) { if (!seen[a.driverId]) { seen[a.driverId] = 1; pmAlertBump_(a.driverId); } });
}
function pmAlertBump_(driverId) {
  if (!driverId) return;
  flushBeforeBump_(); // 알림 줄이 시트에 반영된 뒤 버전을 올린다 (앱이 새 버전으로 읽었는데 줄이 아직 없는 일이 없게)
  try { cache_().put('pmn:' + driverId, String(Date.now()), CFG.CACHE_MAX); } catch (e) { /* 무시 */ }
}
function pmAlertVer_(driverId) {
  const c = cache_(), k = 'pmn:' + driverId;
  let v = c.get(k);
  if (!v) { v = 'r' + Date.now(); try { c.put(k, v, CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
  return v;
}
/**
 * 앱이 30초마다 부른다: 알림 버전이 같으면 바로 { same: true } (시트를 읽지 않음)
 * 바뀌었으면 최근 30일 내 알림 50건 + 안 읽은 수
 */
function api_pmAlerts(token, ver) {
  return run_(function () {
    const u = pmUser_(token);
    const v = pmAlertVer_(u.id);
    if (ver && ver === v) return { ok: true, same: true, ver: v };
    // 같은 버전이면 결과가 같다 → 기사별로 10분 캐시 (앱을 열 때마다 알림 탭 전체를 읽지 않게 · 버전이 바뀌면 키도 바뀜)
    const ck = 'pml:' + u.id + ':' + v, hit = cache_().get(ck);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 읽는다 */ } }
    const from = ymd_(addDays_(new Date(), -30));
    const list = readAll_(SH.PALERT).filter(function (a) { return a.driverId === u.id && a.id && String(a.createdAt).slice(0, 10) >= from; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    const out = {
      ok: true, ver: v, unread: list.filter(function (a) { return !a.readAt; }).length,
      alerts: list.slice(0, 50).map(function (a) {
        const i = String(a.text).indexOf(' · ');
        return { id: a.id, jobId: a.jobId, kind: a.kind, title: i > 0 ? a.text.slice(0, i) : a.text, text: i > 0 ? a.text.slice(i + 3) : '', at: a.createdAt, read: !!a.readAt };
      })
    };
    try { const j = JSON.stringify(out); if (j.length < 95000) cache_().put(ck, j, 600); } catch (e) { /* 무시 */ }
    return out;
  });
}
/** 읽음 표시: ids 배열, 또는 'all' */
function api_pmAlertsRead(token, ids) {
  return run_(function () {
    const u = pmUser_(token);
    const want = ids === 'all' ? null : {};
    if (want) (ids || []).forEach(function (x) { want[String(x)] = 1; });
    const now = nowText_();
    let n = 0;
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      readAll_(SH.PALERT).forEach(function (a) {
        if (a.driverId !== u.id || a.readAt || (want && !want[a.id])) return;
        writeFields_(SH.PALERT, a._row, { readAt: now }); n++;
      });
    } finally { lock.releaseLock(); }
    if (n) pmAlertBump_(u.id);
    return { ok: true, marked: n };
  });
}

/** 알림 지우기: ids 배열, 또는 'all' (내 알림만 · 시트 줄을 지운다) */
function api_pmAlertsDel(token, ids) {
  return run_(function () {
    const u = pmUser_(token);
    const want = ids === 'all' ? null : {};
    if (want) (ids || []).forEach(function (x) { want[String(x)] = 1; });
    let n = 0;
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const rows = readAll_(SH.PALERT).filter(function (a) { return a.id && a.driverId === u.id && (!want || want[a.id]); }).map(function (a) { return a._row; });
      n = rows.length;
      if (n) delRows_(sheet_(SH.PALERT), rows);
    } finally { lock.releaseLock(); }
    if (n) pmAlertBump_(u.id);
    return { ok: true, deleted: n };
  });
}

// ───── 휴대폰 푸시 (Firebase Cloud Messaging) ─────
// 파이어베이스 웹앱 설정(공개값: 앱 화면에 원래 들어가는 값, 비밀 아님) — runner-push 프로젝트.
// 다른 프로젝트로 바꾸려면 스크립트 속성 FCM_WEB 에 넣으면 그 값이 우선한다.
// 비밀 키인 서비스 계정 키는 코드에 두지 않는다 → 스크립트 속성 FCM_SA 에만 넣는다.
const PM_FCM_WEB = {
  apiKey: 'AIzaSyAvYgRGBZeHffy8XBq-zMQcAUpAEpyLmEg', authDomain: 'runner-push.firebaseapp.com', projectId: 'runner-push',
  messagingSenderId: '791109376001', appId: '1:791109376001:web:654ebd0dc879c096938800',
  vapidKey: 'BFY-VooGixSu0dK_ETxSNzvHJpjqW7JNImRah1wdXS7RBgxkjSmvKbMTmuBtdRBwDhW50vjBuwEhT8W_pm2AvS8'
};
function pmPushCfg_() {
  const p = props_();
  let web = null, sa = null;
  web = p.FCM_WEB ? pmLooseObj_(p.FCM_WEB) : JSON.parse(JSON.stringify(PM_FCM_WEB));
  if (web && !web.vapidKey && p.FCM_VAPID) web.vapidKey = String(p.FCM_VAPID).trim();
  try { sa = p.FCM_SA ? JSON.parse(p.FCM_SA) : null; } catch (e) { sa = null; }
  if (web && !(web.apiKey && web.projectId && web.messagingSenderId && web.appId && web.vapidKey)) web = null;
  if (sa && !(sa.client_email && sa.private_key)) sa = null;
  return { web: web, sa: sa };
}
/**
 * 파이어베이스 화면에서 복사한 설정을 그대로 붙여 넣어도 읽는다:
 * JSON {"apiKey":"…"} 도, 자바스크립트 모양 const firebaseConfig = { apiKey: "…", … }; 도 된다.
 */
function pmLooseObj_(txt) {
  txt = String(txt || '');
  try { const o = JSON.parse(txt); if (o && typeof o === 'object') return o; } catch (e) { /* 아래에서 */ }
  const o = {}, re = /["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(txt))) o[m[1]] = m[2].trim();
  return Object.keys(o).length ? o : null;
}
/** 앱: 푸시를 켤 수 있는지 + 파이어베이스 웹 설정 */
function api_pmPushConfig(token) {
  return run_(function () {
    pmUser_(token);
    const c = pmPushCfg_();
    if (!c.web || !c.sa) return { ok: true, on: false };
    return { ok: true, on: true, web: { apiKey: c.web.apiKey, authDomain: c.web.authDomain || '', projectId: c.web.projectId, messagingSenderId: c.web.messagingSenderId, appId: c.web.appId }, vapidKey: c.web.vapidKey };
  });
}
/** 앱: 이 기기를 푸시 받는 기기로 등록 (같은 토큰이면 기사만 바꿔 씀) */
function api_pmPushSave(token, fcmToken, device) {
  return run_(function () {
    const u = pmUser_(token);
    fcmToken = String(fcmToken || '').trim();
    if (!/^[\w:\-]{20,400}$/.test(fcmToken)) fail_('기기 정보를 확인할 수 없습니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.PPUSH, 'token', fcmToken), now = nowText_();
      const f = { driverId: u.id, name: u.info.name, device: String(device || '').slice(0, 60) };
      let prev = '';
      if (row) { prev = String(readObj_(SH.PPUSH, row).driverId || ''); writeFields_(SH.PPUSH, row, f); }
      else appendObj_(SH.PPUSH, Object.assign({ token: fcmToken, createdAt: now, lastOk: '' }, f));
      try { cache_().remove('pmt:' + u.id); if (prev && prev !== u.id) cache_().remove('pmt:' + prev); } catch (e) { /* 무시 */ } // 전 주인의 기기 목록 캐시도 비움 (그 기사 알림이 이 폰으로 오지 않게)
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}
/** 앱: 푸시 끄기·로그아웃 → 이 기기 지우기 */
function api_pmPushDel(token, fcmToken) {
  return run_(function () {
    const s = getSession_(token);
    fcmToken = String(fcmToken || '').trim();
    if (!fcmToken || !s) return { ok: true }; // 로그인한 사람이 자기 기기만 지울 수 있다
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.PPUSH, 'token', fcmToken);
      if (row) {
        const o = readObj_(SH.PPUSH, row);
        if (o.driverId === String(s.d)) { sheet_(SH.PPUSH).deleteRow(row); try { cache_().remove('pmt:' + o.driverId); } catch (e) { /* 무시 */ } }
      }
    } finally { lock.releaseLock(); }
    return { ok: true };
  });
}
/** 서비스 계정으로 FCM 접근 토큰 (50분 캐시) */
function pmFcmToken_(sa) {
  const c = cache_(), hit = c.get('fcm:at');
  if (hit) return hit;
  const b64 = function (o) { return Utilities.base64EncodeWebSafe(typeof o === 'string' ? o : JSON.stringify(o)).replace(/=+$/, ''); };
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(head + '.' + claim, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }
  });
  const j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) throw new Error('FCM 토큰 발급 실패: ' + res.getContentText().slice(0, 200));
  c.put('fcm:at', j.access_token, 3000);
  return j.access_token;
}
/** 기사의 푸시 기기 토큰 목록 (10분 캐시) */
function pmPushTokens_(driverId) {
  const c = cache_(), k = 'pmt:' + driverId, hit = c.get(k);
  if (hit) return JSON.parse(hit);
  const list = readAll_(SH.PPUSH).filter(function (o) { return o.driverId === driverId && o.token; }).map(function (o) { return o.token; });
  c.put(k, JSON.stringify(list), 600);
  return list;
}
/** 알림 목록을 휴대폰 푸시로 보낸다. 설정이 없거나 실패해도 앱 안 알림은 그대로 (조용히 넘어감) */
function pmPushSend_(list) {
  try {
    list = (list || []).filter(function (a) { return a && a.driverId; });
    if (!list.length) return 0;
    const cfg = pmPushCfg_();
    if (!cfg.sa || !cfg.web) return 0;
    const reqs = [], meta = [];
    list.forEach(function (a) {
      pmPushTokens_(a.driverId).forEach(function (t) {
        meta.push({ token: t, driverId: a.driverId });
        reqs.push({ token: t, a: a });
      });
    });
    if (!reqs.length) return 0;
    const at = pmFcmToken_(cfg.sa), url = 'https://fcm.googleapis.com/v1/projects/' + (cfg.sa.project_id || cfg.web.projectId) + '/messages:send';
    const res = UrlFetchApp.fetchAll(reqs.map(function (r) {
      return {
        url: url, method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + at },
        payload: JSON.stringify({ message: { token: r.token, data: { title: r.a.title, body: r.a.text, jobId: String(r.a.jobId || ''), kind: r.a.kind }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
      };
    }));
    let sent = 0;
    const dead = [];
    res.forEach(function (x, i) {
      const code = x.getResponseCode();
      if (code === 200) sent++;
      else if (code === 404 || (code === 400 && /UNREGISTERED|INVALID_ARGUMENT/.test(x.getContentText()))) dead.push(meta[i]);
      else if (code === 401) cache_().remove('fcm:at');
    });
    if (dead.length) { // 없어진 기기 토큰 지우기: 잠금 안에서 줄을 다시 찾는다 (다른 기기 등록·삭제로 줄이 밀렸을 수 있음)
      const gone = {};
      dead.forEach(function (d) { gone[d.token] = 1; });
      const lock = scriptLock_();
      if (lock.tryLock(5000)) {
        try {
          const rows = readAll_(SH.PPUSH).filter(function (o) { return gone[o.token]; }).map(function (o) { return o._row; }).sort(function (a, b) { return b - a; });
          delRows_(sheet_(SH.PPUSH), rows);
        } finally { lock.releaseLock(); }
      }
      dead.forEach(function (d) { cache_().remove('pmt:' + d.driverId); });
    }
    return sent;
  } catch (e) {
    console.error('푸시 전송 실패: ' + (e && e.message));
    return 0;
  }
}
/**
 * 처음 한 번: Apps Script 편집기에서 이 함수를 골라 ▶ 실행 → 권한 허용 (외부 서비스 연결 권한)
 * 설정이 맞으면 '푸시 준비 완료' 가, 틀리면 무엇이 틀렸는지 실행 로그에 나온다.
 */
function pmPushSetupCheck() {
  const c = pmPushCfg_();
  if (!c.web) {
    const w = props_().FCM_WEB ? pmLooseObj_(props_().FCM_WEB) || {} : null;
    console.log(!w ? '스크립트 속성 FCM_WEB 이 없습니다.' : 'FCM_WEB 에 빠진 값: ' + ['apiKey', 'projectId', 'messagingSenderId', 'appId', 'vapidKey'].filter(function (k) { return !w[k]; }).join(', ') +
      ' (vapidKey 는 클라우드 메시징 → 웹 푸시 인증서 키. FCM_WEB 안에 넣거나 스크립트 속성 FCM_VAPID 로 따로 넣어도 됩니다)');
    return;
  }
  if (!c.sa) { console.log('스크립트 속성 FCM_SA 가 없거나 형식이 틀립니다 (서비스 계정 키 JSON 전체를 붙여 넣어 주세요).'); return; }
  cache_().remove('fcm:at');
  pmFcmToken_(c.sa);
  console.log('푸시 준비 완료. 등록된 기기 ' + readAll_(SH.PPUSH).length + '대.');
}
/** 매일 새벽(세션 정리 때): 60일 지난 알림 줄을 지운다 */
function pmAlertCleanup_() {
  if (!sheet_(SH.PALERT)) return;
  const from = ymd_(addDays_(new Date(), -60));
  const old = function () { return readAll_(SH.PALERT).filter(function (a) { return a.createdAt && String(a.createdAt).slice(0, 10) < from; }).map(function (a) { return a._row; }); };
  if (!old().length) return;
  const lock = scriptLock_();
  lock.waitLock(30000);
  try { delRows_(sheet_(SH.PALERT), old()); } // 줄 번호는 잠금 안에서 다시 읽는다
  finally { lock.releaseLock(); }
}

/**
 * 스케줄 칸 글자(예: '527B', '강서1 527AB', '530AB (F3)')가 품앗이 일감의 캠프·라우트와 같은지.
 * 라우트: 칸에 같은 번호가 있고 그 뒤 글자에 일감 라우트 글자가 들어 있으면 같음 (527AB ⊃ 527B).
 * 캠프: 칸에 캠프명이 적혀 있으면 그 캠프, 없으면 기사 소속 캠프로 본다.
 */
function pmCellMatch_(cell, job, myCamp) {
  const short = function (v) { return String(v || '').replace(/\s+/g, '').replace(/캠프$/, '').toUpperCase(); };
  const txt = String(cell || '').toUpperCase().replace(/\(.*?\)|\[.*?\]/g, ' ');
  const jr = normCode_(job.route).replace(/-/g, ''), m = jr.match(/^(\d+)([A-Z가-힣]*)$/);
  if (!m) return false;
  const re = /(\d+)\s*-?\s*([A-Z]*)/g;
  let hit = false, g;
  while ((g = re.exec(txt))) {
    if (g[1] !== m[1]) continue;
    const letters = g[2] || '';
    if (!m[2] || !letters || m[2].split('').every(function (L) { return letters.indexOf(L) >= 0; })) { hit = true; break; }
  }
  if (!hit) return false;
  const jc = short(job.camp);
  const named = master_().camps.map(function (c) { return short(c.name); }).filter(function (n) { return n && txt.replace(/\s+/g, '').indexOf(n) >= 0; });
  if (named.length) return named.indexOf(jc) >= 0;
  return !myCamp || short(myCamp) === jc;
}
/** { 날짜: [{ id, camp, route, accepted }] } — 내가 올린 일감 중 배차 확정 + 그날 내 칸과 캠프·라우트가 같은 것 */
function pmDoneOf_(me, cells, myCamp) {
  const out = {};
  const dates = Object.keys(cells || {});
  if (!dates.length) return out;
  const set = {};
  dates.forEach(function (d) { set[d] = 1; });
  pmData_().jobs.forEach(function (j) {
    if (j.posterId !== me || j.status !== PST.DONE || !set[j.date] || !j.route) return;
    if (!pmCellMatch_(cells[j.date], j, myCamp)) return;
    (out[j.date] = out[j.date] || []).push({ id: j.id, camp: j.camp, route: j.route, accepted: j.accepted });
  });
  return out;
}

// ───────────────────────── 어드민 기사스케줄 연동 ─────────────────────────
/** 처리 뒤 (잠금을 푼 다음): 휴대폰 푸시 + 기사스케줄 품앗이 줄 반영 */
function pmAfter_(out) {
  // 기사스케줄 칸·정산 기록을 먼저 쓰고 휴대폰 알림은 그 뒤에 (알림 발송이 느려도 스케줄 반영이 늦어지지 않게)
  if (out && out.sch && out.sch.length) { pmSchApply_(out.sch); pmStlUsageApply_(out.sch); try { if (typeof stlBump_ === 'function') stlBump_(); } catch (e) { /* 무시 */ } } // 정산 품앗이 자동 줄도 다시 계산되게
  pmPushSend_(out);
}
/**
 * 정산 연동 (모두 러너 소속 기사): 배송 아이디가 '주는 기사 아이디'인 품앗이가 배차 확정되면
 * 정산 DB '아이디 사용 기록'에 (일감 준 기사 쿠팡ID · 받은 기사 · 그 날짜) 를 자동으로 넣는다 → 그날 매출이 받은 기사 정산으로 옮겨감.
 * 확정이 풀리거나 취소되면 그 줄을 지운다. '받는 기사 아이디'면 받은 기사 본인 아이디 매출이라 따로 할 일 없음.
 */
function pmStlUsageApply_(ops) {
  try {
    if (typeof stlRead_ !== 'function') return;
    const list = ops.filter(function (o) { return o.jobId && (o.op === 'clear' || o.useId === '주는 기사 아이디'); });
    if (!list.length) return;
    const tag = function (o) { return '품앗이 자동 ' + o.jobId; };
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      let rows = stlRead_('stl_usage'), changed = false;
      list.forEach(function (o) {
        const keep = rows.filter(function (r) { return !(str_(r.memo).indexOf(tag(o)) >= 0 && r.driverId === o.driverId); });
        if (keep.length !== rows.length) { rows = keep; changed = true; }
        if (o.op !== 'set') return;
        const poster = driverById_(o.posterId), doer = driverById_(o.driverId);
        if (!poster || !poster.loginId || !doer) return;
        rows.push({ cid: poster.loginId, name: doer.name, driverId: doer.id, from: o.date, to: o.date, memo: tag(o) + ' (' + poster.name + ' 아이디로 배송)' });
        changed = true;
      });
      if (changed) { stlWriteAll_('stl_usage', rows.map(function (r) { const x = Object.assign({}, r); delete x._row; return x; })); stlBump_(); }
    } finally { lock.releaseLock(); }
  } catch (e) { console.error('정산 아이디 사용 기록 연동 실패: ' + (e && e.message)); errLog_('서버 오류', 'pmStlUsageApply_', '정산 아이디 사용 기록 연동 실패: ' + String(e && e.message || e)); }
}
/** 기사스케줄 품앗이 줄 칸에 적을 글자: '강서1 527B' (라우트가 없으면 배송지) */
function pmSchText_(j) {
  return (String(j.camp || '').replace(/\s*캠프$/, '') + ' ' + (normCode_(j.route) || String(j.area || '').trim())).trim();
}
function pmSchOp_(out, op, driverId, j) {
  if (!driverId || !j || !j.date) return;
  (out.sch = out.sch || []).push({ op: op, driverId: String(driverId), date: j.date, value: pmSchText_(j), jobId: j.id || '', posterId: j.posterId || '', useId: j.useId || '' });
}
/**
 * 스케줄 DB 의 품앗이 줄에 쓰기. set = 칸에 그 글자를 넣음(이미 다른 글이 있으면 줄을 바꿔 덧붙임), clear = 그 글자만 지움.
 * 품앗이 줄이 없으면 비고 줄 바로 위에 새로 만든다. 스케줄 DB 가 없거나 실패해도 품앗이 처리는 그대로 (기록만 남김).
 */
function pmSchApply_(ops, soft) {
  try {
    if (!props_().SCH_DB_ID) return;
    const ds = ops.map(function (o) { return o.date; }).sort();
    const h0 = schEnsureDates_(parseYmd_(ds[0]), parseYmd_(ds[ds.length - 1]));
    const lock = scriptLock_();
    // soft = 스케줄을 읽다가 하는 복구: 잠금이 바로 안 잡히면 그만둔다 (화면 열기가 다른 저장을 기다리며 늦어지지 않게)
    if (soft) { if (!lock.tryLock(300)) return; } else lock.waitLock(20000);
    try {
      const sh = schSheet_(), h = schHeader_(true) || h0, F = h.fixed;
      const read = function () {
        const last = sh.getLastRow();
        return last >= 2 ? sh.getRange(2, 1, last - 1, 5).getValues() : [];
      };
      let fixed = read();
      const rowOf = function (id) { for (let i = 0; i < fixed.length; i++) if (str_(fixed[i][F['행ID']]) === id) return i + 2; return 0; };
      ops.forEach(function (o) {
        const id = SCH_PM_PREFIX + o.driverId, col = h.dates[o.date];
        if (col === undefined) return;
        let r = rowOf(id);
        if (!r) {
          if (o.op !== 'set') return;
          const d = driverById_(o.driverId);
          if (!d) return;
          let at = 0;
          for (let i = 0; i < fixed.length; i++) if (str_(fixed[i][F['구분']]) === SCH.KIND_NOTE || /^NOTE\d+$/.test(str_(fixed[i][F['행ID']]))) { at = i + 2; break; }
          if (at) sh.insertRowBefore(at); else at = fixed.length + 2;
          const line = new Array(5).fill('');
          line[F['행ID']] = id; line[F['구분']] = SCH.KIND_PM; line[F['캠프']] = SCH.KIND_PM; line[F['이름']] = d.name;
          sh.getRange(at, 1, 1, 5).setNumberFormat('@').setValues([line.map(safeText_)]);
          fixed = read(); r = at;
        }
        const c = sh.getRange(r, col + 1), cur = str_(c.getValue());
        const lines = cur ? cur.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean) : [];
        const has = lines.indexOf(o.value) >= 0;
        let next = null;
        if (o.op === 'set' && !has) next = lines.concat([o.value]).join('\n');
        if (o.op === 'clear' && has) next = lines.filter(function (x) { return x !== o.value; }).join('\n');
        if (next !== null) c.setNumberFormat('@').setValue(safeText_(next));
      });
    } finally {
      lock.releaseLock();
      fsMark_('sch'); // 품앗이 줄이 바뀜 → 관리자 기사스케줄 실시간 갱신
    }
  } catch (e) {
    console.error('기사스케줄 품앗이 반영 실패: ' + (e && e.message));
    // 오류 기록 탭에도 남긴다 (관리자가 기사스케줄을 열면 자동으로 다시 채워지지만, 실패한 사실은 알아야 함)
    errLog_('서버 오류', 'pmSchApply_', '기사스케줄 품앗이 칸 쓰기 실패 (' + (ops || []).map(function (o) { return o.op + ' ' + o.date + ' ' + o.value; }).slice(0, 3).join(' / ') + '): ' + String(e && e.message || e));
  }
}
/**
 * 일감 단가가 그 노선의 평소 단가(고정·백업단가 중 높은 쪽)보다 낮으면 안내 글, 아니면 ''.
 * 정산은 낮은 단가를 평소 단가로 올려 지급하므로(추가지급·공제 0) 등록할 때 미리 알린다. 단가를 못 찾으면 묻지 않는다.
 */
function pmLowPriceNote_(campId, route, price) {
  try {
    const pr = Number(String(price == null ? '' : price).replace(/[^\d.]/g, ''));
    if (!(pr > 0) || !campId || !route) return '';
    const units = issExpand_(normCode_(route));
    if (!units.length) return '';
    const num = function (v) { return Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')) || 0; };
    let hi = 0;
    master_().prices.forEach(function (p) {
      if (p.campId !== campId) return;
      units.forEach(function (u) { const m = u.match(/^(\d+)([A-Z])$/); if (m && String(p.num) === m[1] && String(p.value) === m[2]) hi = Math.max(hi, num(p.p2), num(p.p3)); });
    });
    if (!hi || pr >= hi) return '';
    const w = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    return '건당 단가 ' + w(pr) + '원이 이 노선 평소 단가(' + w(hi) + '원)보다 낮습니다.\n정산에서는 평소 단가로만 지급됩니다 (추가지급·맡긴 기사 공제 0원).';
  } catch (e) { return ''; }
}
/** 배차 확정 품앗이가 적힌 품앗이 줄 칸 (잠금): { 'PM기사ID': { 날짜: [{ id, text, from, to }] } } */
function pmSchLocks_(dates) {
  const set = {}, out = {};
  (dates || []).forEach(function (d) { set[d] = 1; });
  pmData_().jobs.forEach(function (j) {
    if (j.status !== PST.DONE || !j.acceptedId || !set[j.date]) return;
    const text = pmSchText_(j);
    if (!text) return;
    const m = out[SCH_PM_PREFIX + j.acceptedId] || (out[SCH_PM_PREFIX + j.acceptedId] = {});
    (m[j.date] = m[j.date] || []).push({ id: j.id, text: text, from: j.poster || '', to: j.accepted || '' });
  });
  return out;
}
/**
 * 어드민 기사스케줄: 품앗이로 맡겨 배차 확정된 칸 { 기사ID: { 날짜: '품앗이 → 이지원' } }
 * 그날 그 기사 칸의 캠프·라우트가 일감과 같을 때만 (기사 앱 '배차확정 완료' 와 같은 규칙)
 */
function pmAdminMarks_(cells, dates, byDrv, tips) {
  // 품앗이 배차 확정: 일을 준 기사 칸 = '▶ 받은 기사', 받은 기사(본인 줄) 칸 = '◀ 준 기사' (화면에는 품▶ / 품◀ 로 짧게)
  const out = {}, set = {};
  dates.forEach(function (d) { set[d] = 1; });
  const add = function (id, date, txt) { const m = out[id] || (out[id] = {}); m[date] = (m[date] ? m[date] + ', ' : '') + txt; };
  pmData_().jobs.forEach(function (j) {
    if (j.status !== PST.DONE || !set[j.date]) return;
    // 일을 준 기사: 그날 칸 글자(출근·휴무·라우트 등)와 상관없이 늘 표시
    if (j.posterId) add(j.posterId, j.date, '▶ ' + (j.accepted || ''));
    if (j.acceptedId) add(j.acceptedId, j.date, '◀ ' + (j.poster || ''));
    // 마우스를 올리면 보이는 일감 정보 (배차일 · 구분 · 입차시간 · 캠프·라우트 · 준 기사 → 받은 기사)
    if (tips) {
      const t = { id: j.id, date: j.date, kind: j.kind || '', time: str_(j.time), camp: str_(j.camp), route: str_(j.route), area: str_(j.area), from: j.poster || '', to: j.accepted || '' };
      [j.posterId, j.acceptedId].forEach(function (id) { if (!id) return; const m = tips[id] || (tips[id] = {}); (m[j.date] = m[j.date] || []).push(t); });
    }
  });
  return out;
}

/**
 * 사무실 등록 일감인데 지원만 되어 있고 확정이 안 된 것(바로 확정 기능 전에 지원했거나 처리 중 오류) → 먼저 지원한 기사로 확정.
 * 품앗이 목록·관리자 목록을 열 때 확인한다 (해당 일감이 없으면 시트를 쓰지 않음).
 */
function pmOfficeAuto_() {
  let n = 0;
  try {
    const d = pmData_();
    d.jobs.forEach(function (j) {
      if (!j.byOffice || (j.status !== PST.OPEN && j.status !== PST.TALK) || pmPast_(j)) return;
      const a = d.apps.filter(function (x) { return x.jobId === j.id && (x.status === PAST.APPLY || x.status === PAST.TALK); })
        .sort(function (x, y) { return String(x.createdAt).localeCompare(String(y.createdAt)); })[0];
      if (!a) return;
      try { pmDecide_('', j.id, a.id, 'accept'); n++; } catch (e) { console.log('사무실 품앗이 자동 확정 실패 ' + j.id + ': ' + (e && e.message)); }
    });
  } catch (e) { /* 무시 */ }
  return n;
}

// ───────────────────────── 관리자: 사무실에서 품앗이 일감 등록 (기사스케줄에서) ─────────────────────────
/** 등록 창에 필요한 목록 */
function adm_pmMeta(token) {
  return run_(function () {
    requireAdmin_(token);
    return { ok: true, kinds: PM_KINDS, tops: PM_TOPS, pays: PM_PAYS, paysOff: PM_PAYS_OFF, payDef: PM_PAY_DEF, useIds: PM_USE_IDS, defPrice: PM_JOB_PRICE };
  });
}
/**
 * 사무실 등록: 맡기는 기사(posterId) 이름으로 일감을 만든다. 일감 올리기·제안 스위치와 상관없이 된다.
 * job = { posterId, date, kind, time, campId, route, area, qty, top, price, pay, useId, desc, secret, mode, toId, memo }
 *  mode = 'open'(모든 기사에게 모집) / 'offer'(toId 기사에게 제안 → 기사 앱에서 수락) / 'confirm'(toId 기사로 바로 배차 확정 → 기사스케줄 품앗이 칸까지)
 * 입차시간·배송지·물량·단가는 비워도 된다 (배송지 비우면 캠프 이름).
 */
function adm_pmCreate(token, job) {
  return run_(function () {
    const a = requireAdmin_(token);
    job = job || {};
    const t = function (v, n, label) { const s = String(v == null ? '' : v).trim(); if (s.length > n) fail_(label + '이(가) 너무 깁니다.'); return s; };
    // 맡기는 쪽 = 러너(회사): 담당 없음 노선처럼 회사 노선을 맡길 때 · 등록 기사ID 는 비우고 이름만 '러너' (정산 차액 = 러너 부담)
    const byRunner = str_(job.posterId) === PM_RUNNER_ID;
    const poster = byRunner ? { id: '', name: PM_RUNNER } : driverById_(str_(job.posterId));
    if (!poster) fail_('맡기는 쪽을 골라 주세요.');
    const mode = ['open', 'offer', 'confirm'].indexOf(job.mode) >= 0 ? job.mode : 'open';
    const f = {};
    f.kind = PM_KINDS.indexOf(str_(job.kind)) >= 0 ? str_(job.kind) : fail_('구분(' + PM_KINDS.join('/') + ')을 골라 주세요.');
    f.date = pmDate_(job.date) || fail_('배차일자를 입력해 주세요.');
    if (pmPast_(f)) fail_(f.date < todayText_() ? '지난 날짜입니다.' : '야간 품앗이는 그날 아침 7시에 끝나 오늘 날짜로는 등록할 수 없습니다.');
    const camp = master_().camps.filter(function (c) { return c.id === str_(job.campId); })[0];
    if (!camp) fail_('캠프를 골라 주세요.');
    f.campId = camp.id; f.camp = camp.name;
    f.route = normCode_(t(job.route, 20, '라우트'));
    f.time = t(job.time, 20, '입차시간');
    f.area = t(job.area, 40, '배송지') || String(camp.name);
    f.qty = t(job.qty, 20, '평균 물량');
    f.top = PM_TOPS.indexOf(str_(job.top)) >= 0 ? str_(job.top) : '';
    const pr = str_(job.price) === '' ? null : pmMoney_(job.price);
    if (str_(job.price) !== '' && (pr === null || pr < 0)) fail_('건당 단가는 숫자로 입력해 주세요.');
    f.price = pr || '';
    f.pay = PM_PAYS.indexOf(str_(job.pay)) >= 0 && PM_PAYS_OFF.indexOf(str_(job.pay)) < 0 ? str_(job.pay) : PM_PAY_DEF;
    f.useId = PM_USE_IDS.indexOf(str_(job.useId)) >= 0 ? str_(job.useId) : '';
    if (byRunner && f.useId === '주는 기사 아이디') f.useId = '받는 기사 아이디'; // 러너는 쿠팡 아이디가 없음
    f.desc = t(job.desc, 3000, '상세 설명');
    f.secret = t(job.secret, 1500, '비공개 정보');
    f.byOffice = a.name + ' · ' + nowText_().slice(0, 16);
    if (!job.okLow) { const low = pmLowPriceNote_(f.campId, f.route, f.price); if (low) return { ok: false, code: 'LOW', msg: low }; }
    let tgt = null;
    if (mode !== 'open') {
      tgt = driverById_(str_(job.toId));
      if (!tgt || tgt.status !== ST.ACTIVE) fail_('받는 기사를 골라 주세요.');
      if (tgt.id === poster.id) fail_('맡기는 기사와 받는 기사가 같습니다.');
    }
    const lock = scriptLock_(), out = [];
    let id = '', appId = '';
    lock.waitLock(20000);
    try {
      if (tgt && readAll_(SH.PJOB).some(function (x) { return x.acceptedId === tgt.id && x.status === PST.DONE && x.date === f.date; }))
        fail_(tgt.name + ' 기사님은 ' + f.date + ' 에 이미 확정된 품앗이가 있습니다.');
      const now = nowText_();
      // 같은 일감을 2분 안에 또 보냄(화면이 끊겨 다시 누름) → 새로 만들지 않고 먼저 만든 것을 돌려준다
      const twin = readAll_(SH.PJOB).filter(function (x) {
        return str_(x.posterId) === str_(poster.id) && x.poster === poster.name && x.date === f.date && x.campId === f.campId && str_(x.route) === str_(f.route) && x.kind === f.kind &&
          (x.status === PST.OPEN || x.status === PST.TALK || x.status === PST.DONE) && Math.abs(toMs_(now) - toMs_(x.createdAt)) < 120000;
      })[0];
      if (twin) return { ok: true, id: twin.id, mode: mode, dup: true };
      id = uniqId_('J');
      if (mode === 'offer') { f.offerToId = tgt.id; f.offerTo = tgt.name; }
      const row = Object.assign({ id: id, status: PST.OPEN, posterId: poster.id, poster: poster.name, attach: '', createdAt: now, updatedAt: now }, f);
      appendObj_(SH.PJOB, row);
      if (tgt) {
        appId = uniqId_('A');
        appendObj_(SH.PAPP, { id: appId, jobId: id, driverId: tgt.id, name: tgt.name, date: f.date, status: mode === 'offer' ? PAST.OFFER : PAST.APPLY, memo: str_(job.memo).slice(0, 200) || '사무실 등록', createdAt: now, updatedAt: now });
        if (mode === 'offer') out.push(pmA_(tgt.id, tgt.name, row, 'offer', poster.name));
      }
      if (mode !== 'confirm') out.push(pmA_(poster.id, poster.name, row, 'office', mode === 'open' ? '올렸습니다. 먼저 지원한 기사님으로 바로 배차 확정됩니다.' : '올려 ' + tgt.name + ' 기사님께 제안했습니다.'));
      pmAlertAdd_(out);
      pmTouch_();
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
    // 바로 배차 확정: 기사 앱의 확정과 같은 길(알림 · 기사스케줄 품앗이 칸)
    if (mode === 'confirm') pmDecide_('', id, appId, 'accept');
    logAdmin_(a, '품앗이 사무실 등록', poster.name, f.date + ' ' + f.kind + ' ' + f.camp + ' ' + (f.route || '') + (tgt ? ' → ' + tgt.name + ' (' + (mode === 'offer' ? '제안' : '확정') + ')' : ' (모집)'));
    return { ok: true, id: id, mode: mode };
  });
}

// ───────────────────────── 관리자: 품앗이 관리 ─────────────────────────
/** 관리자 목록. f = { from, to, status, q } (배차일 기간, 상태, 기사·배송지·센터·라우트 검색) */
function adm_pmList(token, f) {
  return run_(function () {
    requireAdmin_(token);
    pmOfficeAuto_();
    f = f || {};
    const today = todayText_(), d = pmData_();
    const from = pmDate_(f.from) || ymd_(addDays_(new Date(), -14)), to = pmDate_(f.to) || ymd_(addDays_(new Date(), 30));
    const q = str_(f.q).replace(/\s+/g, '').toLowerCase();
    const apps = {};
    d.apps.forEach(function (a) { (apps[a.jobId] = apps[a.jobId] || []).push(a); });
    // 기간 안 + 기간 밖이라도 아직 안 지난 진행 중 일감(모집·협의·확정)은 늘 보인다 (예: 사무실이 몇 달 뒤 날짜로 올린 일감)
    const all = d.jobs.filter(function (j) { return (j.date >= from && j.date <= to) || (j.date > to && (j.status === PST.OPEN || j.status === PST.TALK || j.status === PST.DONE) && !pmPast_(j, today)); });
    const count = {};
    const rows = all.map(function (j) {
      const st = pmView_(j, today), list = apps[j.id] || [];
      count[st] = (count[st] || 0) + 1;
      return {
        id: j.id, status: st, kind: j.kind, date: j.date, time: j.time, area: j.area, camp: j.camp, route: j.route, qty: j.qty, top: j.top, price: j.price, pay: j.pay,
        poster: j.poster, posterId: j.posterId, accepted: j.accepted || '', apps: list.filter(pmActiveApp_).length, newApps: list.filter(function (a) { return a.status === PAST.APPLY; }).length,
        createdAt: j.createdAt, updatedAt: j.updatedAt, hasAttach: !!j.attach
      };
    }).filter(function (j) {
      if (f.status && f.status !== '전체' && j.status !== f.status) return false;
      if (q && (j.poster + j.accepted + j.area + j.camp + j.route).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    return { ok: true, today: today, from: from, to: to, jobs: rows, count: count, total: all.length, postOn: pmPostOn_(), offerOn: pmOfferOn_() };
  });
}
/** 관리자 상세: 모든 칸 + 지원자(연락처·자격증) + 첨부 링크 */
function adm_pmJob(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const d = pmData_(), today = todayText_();
    const j = d.jobs.filter(function (x) { return x.id === id; })[0];
    if (!j) fail_('일감을 찾을 수 없습니다. 새로고침해 주세요.');
    const ph = function (id2) { const o = driverById_(id2); return o ? o.phone : ''; };
    const apps = d.apps.filter(function (a) { return a.jobId === j.id; }).map(function (a) {
      const o = driverById_(a.driverId) || {};
      return { id: a.id, name: a.name, status: a.status, memo: a.memo, at: a.createdAt, phone: o.phone || '', type: o.driverType || '', camp: o.schCamp || '', car: o.carNo || '', qual: !!o.docQual };
    }).sort(function (x, y) { return String(x.at).localeCompare(String(y.at)); });
    return { ok: true, job: Object.assign({}, j, { view: pmView_(j, today), posterPhone: ph(j.posterId), acceptedPhone: j.acceptedId ? ph(j.acceptedId) : '' }), apps: apps };
  });
}
/** 관리자 처리: action = talk / accept / reject / back (지원자) · close / reopen / cancel (일감) */
function adm_pmAction(token, jobId, action, appId) {
  return run_(function () {
    const a = requireAdmin_(token);
    const r = ['close', 'reopen', 'cancel'].indexOf(action) >= 0 ? pmClose_('', jobId, action) : pmDecide_('', jobId, appId, action);
    logAdmin_(a, '품앗이 ' + action, jobId, appId || '');
    return r;
  });
}
/**
 * 관리자 일괄 삭제: 일감 줄 + 그 일감의 지원 줄을 시트에서 지운다 (되돌릴 수 없음).
 * 진행 중(모집 중·협의중·확정)이고 배차일이 지나지 않은 일감은 지원 기사에게 취소 알림, 확정된 일감은 기사스케줄 품앗이 칸도 지운다.
 */
function adm_pmDelete(token, ids) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) fail_('삭제할 일감을 골라 주세요.');
    const want = {};
    ids.forEach(function (id) { want[str_(id)] = 1; });
    const lock = scriptLock_(), out = [];
    lock.waitLock(30000);
    let n = 0;
    try {
      const today = todayText_();
      const jobs = readAll_(SH.PJOB).filter(function (j) { return want[j.id]; });
      const apps = readAll_(SH.PAPP).filter(function (x) { return want[x.jobId]; });
      jobs.forEach(function (j) {
        // 확정된 일감은 지난 날짜라도 기사스케줄 품앗이 칸(과 정산 아이디 사용 기록)을 같이 지운다 → 글자만 남지 않게
        if (j.status === PST.DONE && j.acceptedId) pmSchOp_(out, 'clear', j.acceptedId, j);
        const live = (j.status === PST.OPEN || j.status === PST.TALK || j.status === PST.DONE) && !pmPast_(j, today);
        if (!live) return;
        apps.forEach(function (x) { if (x.jobId === j.id && pmActiveApp_(x)) out.push(pmA_(x.driverId, x.name, j, 'canceled')); });
        out.push(pmA_(j.posterId, j.poster, j, 'admin', 'cancel'));
      });
      delRows_(sheet_(SH.PAPP), apps.map(function (x) { return x._row; }));
      delRows_(sheet_(SH.PJOB), jobs.map(function (j) { return j._row; }));
      n = jobs.length;
      pmAlertAdd_(out);
      pmTouch_();
      logAdmin_(a, '품앗이 일감 삭제', n + '건', jobs.map(function (j) { return j.date + ' ' + j.poster; }).slice(0, 20).join(', '));
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
    return { ok: true, deleted: n };
  });
}

/**
 * 관리자: 기사 앱 품앗이 스위치. which = 'offer' 면 일감 제안, 아니면 일감 올리기(자유 등록).
 * 끄면 그 버튼·메뉴가 기사 앱에서 숨겨진다. 이미 올린 일감·지원·확정은 그대로
 */
function adm_pmPostSet(token, on, which) {
  return run_(function () {
    const a = requireAdmin_(token);
    const offer = which === 'offer';
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      if (offer) appSetPut_('pmOfferOn', on ? 'ON' : 'OFF', '품앗이 일감 제안 (ON/OFF) — 품앗이·일할 기사 찾기에서 맡기기');
      else appSetPut_('pmPostOn', on ? 'ON' : 'OFF', '품앗이 일감 올리기 · 자유 등록 (ON/OFF) — 관리자 품앗이 관리에서 바꿈');
    } finally { lock.releaseLock(); }
    logAdmin_(a, '품앗이 ' + (offer ? '일감 제안 ' : '일감 올리기 ') + (on ? '켜기' : '끄기'), '', '');
    return { ok: true, postOn: pmPostOn_(), offerOn: pmOfferOn_() };
  });
}

/**
 * 관리자: 휴대폰 알림 점검 — 설정·인증·등록된 기기를 보고, testId(기사ID)를 주면 그 기사 기기로 시험 알림을 보낸다.
 */
function adm_pushCheck(token, testId) {
  return run_(function () {
    const a = requireAdmin_(token);
    const p = props_(), cfg = pmPushCfg_();
    const out = { ok: true, webOk: !!cfg.web, saOk: !!cfg.sa, saSet: !!p.FCM_SA, project: cfg.sa ? cfg.sa.project_id : '', webProject: cfg.web ? cfg.web.projectId : '' };
    if (cfg.sa) {
      try { cache_().remove('fcm:at'); pmFcmToken_(cfg.sa); out.auth = 'ok'; } catch (e) { out.auth = String(e && e.message).slice(0, 300); }
    }
    const drv = {};
    readAll_(SH.DRIVERS).forEach(function (o) { drv[o.id] = o; });
    out.devices = readAll_(SH.PPUSH).filter(function (o) { return o.token; }).map(function (o) {
      const d = drv[o.driverId] || {};
      return { driverId: o.driverId, name: d.name || o.name, status: d.status || '', device: o.device, createdAt: o.createdAt, lastOk: o.lastOk, tok: o.token.slice(0, 12) };
    });
    try { out.errs = JSON.parse(PropertiesService.getScriptProperties().getProperty('PUSH_ERRS') || '[]'); } catch (e) { out.errs = []; }
    if (testId && cfg.sa && cfg.web && out.auth === 'ok') {
      const toks = out.devices.filter(function (d) { return d.driverId === String(testId); }).length
        ? readAll_(SH.PPUSH).filter(function (o) { return o.driverId === String(testId) && o.token; }).map(function (o) { return o.token; }) : [];
      const at = pmFcmToken_(cfg.sa), url = 'https://fcm.googleapis.com/v1/projects/' + (cfg.sa.project_id || cfg.web.projectId) + '/messages:send';
      out.test = toks.map(function (t) {
        const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + at },
          payload: JSON.stringify({ message: { token: t, data: { title: '🔔 러너 알림 시험', body: '휴대폰 알림이 잘 옵니다. (사무실 점검)', jobId: '', kind: 'test' }, webpush: { headers: { Urgency: 'high', TTL: '600' } } } }) });
        return { tok: t.slice(0, 12), code: r.getResponseCode(), body: r.getContentText().slice(0, 300) };
      });
      logAdmin_(a, '휴대폰 알림 시험', String(testId), toks.length + '대');
    }
    return out;
  });
}
/** 앱: 휴대폰 알림 등록 실패 사유를 남긴다 (관리자 점검용 · 최근 30건) */
function api_pmPushLog(token, info) {
  return run_(function () {
    const s = getSession_(token); // 로그인한 기사만 (아무나 써서 속성 쓰기 한도를 쓰지 못하게)
    if (!s) return { ok: false, code: 'EXPIRED' };
    const c = cache_(), rk = 'pfl:' + s.th, n = +(c.get(rk) || 0);
    if (n >= 3) return { ok: true, skipped: true }; // 한 기기 10분에 3번까지
    c.put(rk, String(n + 1), 600);
    let who = '';
    try { who = (driverInfo_(s.d) || {}).name || String(s.d); } catch (e) { who = String(s.d); }
    const lock = scriptLock_();
    if (!lock.tryLock(5000)) return { ok: true, skipped: true };
    try {
      const p = PropertiesService.getScriptProperties();
      let list = [];
      try { list = JSON.parse(p.getProperty('PUSH_ERRS') || '[]'); } catch (e) { list = []; }
      list.unshift({ at: nowText_(), who: who, info: String(info || '').slice(0, 300) });
      p.setProperty('PUSH_ERRS', JSON.stringify(list.slice(0, 30)));
    } finally { lock.releaseLock(); }
    return { ok: true };
  });
}
