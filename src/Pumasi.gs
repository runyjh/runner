/**
 * 품앗이 — 기사끼리 용차 일감을 올리고(맡기고) 지원해서 대신 뛰는 기능 (바로일 '용차' 방식)
 *
 *  흐름: ① 기사가 일감 등록 (센터·라우트·단가는 노선관리에서 자동 제안)
 *        ② 다른 기사가 지원 (같은 배차일에 2번까지)
 *        ③ 등록 기사가 지원자와 통화 → '협의 중' → '배차 확정' (확정된 기사에게만 배송지코드·연락처·첨부 공개)
 *        ④ 정산은 두 기사가 협의한 방법으로 (수수료 없음)
 *  상태: 모집 중 → 배차 협의중 → 배차 확정 (배차일이 지나면 '완료한 품앗이') / 모집 마감 / 취소
 *  데이터: 러너 올인원 DB 의 pumasi_jobs(일감), pumasi_apps(지원) 탭. 시트에서 직접 고쳐도 된다.
 */
const PM_KINDS = ['주간', '야간', '일택'];
const PM_TOPS = ['탑무관', '하이탑', '로우탑', '냉탑'];
const PM_PAYS = ['당일지급', '주급', '월급', '협의'];
const PM_MAX_APPLY = 2; // 한 기사가 같은 배차일에 지원할 수 있는 횟수
const PM_DESC_TEMPLATE = [
  '📋 배송 정보', '벤더사명 : ', '아파트/지번 비율 : ', '평균 물량 : ', '사용 날짜 (PDD 기준) : ', '주간/야간 : ', '캠프명 : ', '캠프 주소 : ',
  '라우트(Route) 번호 : ', '지정 주차 여부 : ', '최근 마감 수량 : ', '',
  '🍀 특이사항', '고정기사 정보 (1인 / 2인 1조 / 알바 여부) : ', '하이탑·로우탑 출입 여부 : ', '프레시백 할당 수량 및 회수 여부 : ', '입차시간 (회차별) : ', '추천 인원 : ', '',
  '💰 정산 정보', '정산 방법 (당일 이체 등) : ', '세금계산서 발행 여부 : '
].join('\n');
const PM_SECRET_TEMPLATE = ['현장 담당자 연락처 : ', '배송지 코드 : ', '공동현관 비번 등 참고사항 : '].join('\n');

// ───────────────────────── 공용 ─────────────────────────
/** 기사 로그인 확인 → { id, info } */
function pmUser_(token) {
  const s = getSession_(token);
  const info = s ? driverInfo_(s.d) : null;
  if (!s || !info || info.status !== ST.ACTIVE || !sessionAfterPw_(s.c, info.pwChangedAt)) { const e = new Error('x'); e.userMsg = '로그인이 만료되었습니다. 다시 로그인해 주세요.'; e.code = 'EXPIRED'; throw e; }
  if (info.mustChange) { const e = new Error('x'); e.userMsg = '비밀번호를 먼저 바꿔 주세요.'; e.code = 'MUST_CHANGE'; throw e; }
  return { id: String(s.d), info: info };
}
function pmTouch_() { try { cache_().put('pm:v', String(Date.now()) + Math.random().toString(36).slice(2, 5), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
function pmVer_() { return cache_().get('pm:v') || '0'; }
/** 일감·지원 전체 (1분 캐시, 쓰면 바로 버림) */
function pmData_() {
  const key = 'pm:d:' + pmVer_();
  const hit = typeof stlCGet_ === 'function' ? stlCGet_(key) : null;
  if (hit) return hit;
  const jobs = readAll_(SH.PJOB).filter(function (o) { return o.id && o.date; }).map(function (o) { delete o._row; return o; });
  const apps = readAll_(SH.PAPP).filter(function (o) { return o.id && o.jobId; }).map(function (o) { delete o._row; return o; });
  const d = { jobs: jobs, apps: apps };
  if (typeof stlCPut_ === 'function') stlCPut_(key, d, 60);
  return d;
}
function pmDate_(v) { const d = normDate_(v); return d || ''; }
function pmMoney_(v) { const m = normMoney_(v); return m === null ? null : m; }
function pmActiveApp_(a) { return a.status === PAST.APPLY || a.status === PAST.TALK || a.status === PAST.OK; }
/** 화면 상태: 배차 확정이고 배차일이 지났으면 '완료' */
function pmView_(j, today) {
  const known = Object.keys(PST).some(function (k) { return PST[k] === j.status; });
  const st = known ? j.status : PST.OPEN;
  return st === PST.DONE && j.date < today ? '완료' : st;
}
/** 목록 카드 (공개 항목만) */
function pmCard_(j, me, apps, today) {
  const mine = j.posterId === me;
  const my = apps.filter(function (a) { return a.jobId === j.id && a.driverId === me && a.status !== PAST.CANCEL; })[0];
  const cnt = apps.filter(function (a) { return a.jobId === j.id && pmActiveApp_(a); }).length;
  return {
    id: j.id, status: pmView_(j, today), kind: j.kind, date: j.date, time: j.time, area: j.area, camp: j.camp, route: j.route, qty: j.qty, top: j.top,
    price: j.price, pay: j.pay, mine: mine, poster: j.poster, myApp: my ? my.status : '', applicants: mine ? cnt : undefined,
    accepted: j.acceptedId === me, hasAttach: !!j.attach
  };
}
/** 지원 가능한지 (안 되면 이유) */
function pmCanApply_(j, me, apps, today) {
  if (j.posterId === me) return '내가 올린 일감입니다.';
  if (j.status !== PST.OPEN && j.status !== PST.TALK) return '모집이 끝난 일감입니다.';
  if (j.date < today) return '배차일이 지났습니다.';
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
    f = f || {};
    const today = todayText_(), d = pmData_();
    const q = str_(f.q).replace(/\s+/g, '').toLowerCase();
    const from = ymd_(addDays_(parseYmd_(today), -3));
    const list = d.jobs.filter(function (j) {
      if (j.status === PST.CANCEL) return false;
      if (j.date < today && !(j.date >= from && (j.posterId === u.id || j.acceptedId === u.id))) return false;
      if (q && (str_(j.area) + str_(j.camp) + str_(j.route)).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return false;
      if (f.onlyAvail && pmCanApply_(j, u.id, d.apps, today)) return false;
      return true;
    }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time) || a.createdAt.localeCompare(b.createdAt); })
      .map(function (j) { return pmCard_(j, u.id, d.apps, today); });
    const waiting = d.jobs.filter(function (j) { return j.posterId === u.id && (j.status === PST.OPEN || j.status === PST.TALK) && j.date >= today; })
      .reduce(function (n, j) { return n + d.apps.filter(function (a) { return a.jobId === j.id && a.status === PAST.APPLY; }).length; }, 0);
    const confirmed = d.apps.filter(function (a) { return a.driverId === u.id && a.status === PAST.OK && a.date >= today; }).length;
    return { ok: true, today: today, jobs: list, waiting: waiting, confirmed: confirmed };
  });
}
/** 상세: 공개 항목 + (등록 기사·확정 기사에게만) 비공개 항목 + (등록 기사에게) 지원자 목록 */
function api_pmJob(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const today = todayText_(), d = pmData_();
    const j = d.jobs.filter(function (x) { return x.id === id; })[0];
    if (!j || j.status === PST.CANCEL && j.posterId !== u.id) fail_('일감을 찾을 수 없습니다. 지워졌거나 취소된 일감입니다.');
    const mine = j.posterId === u.id, accepted = j.acceptedId === u.id && j.status === PST.DONE;
    const out = pmCard_(j, u.id, d.apps, today);
    out.desc = j.desc;
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
      out.raw = { kind: j.kind, date: j.date, time: j.time, area: j.area, campId: j.campId, camp: j.camp, route: j.route, qty: j.qty, top: j.top, price: j.price, pay: j.pay, desc: j.desc, secret: j.secret };
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
function api_pmForm(token) {
  return run_(function () {
    const u = pmUser_(token);
    const m = master_(), me = driverById_(u.id) || {};
    const camps = m.camps.map(function (c) {
      return { id: c.id, name: c.name, routes: pmRouteCodes_(m.routes.filter(function (r) { return r.campId === c.id && r.status !== RST.OFF; })) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    const myCamp = m.camps.filter(function (c) { return (me.schCampId && c.id === me.schCampId) || (!me.schCampId && me.schCamp && c.name === me.schCamp); })[0];
    return {
      ok: true, camps: camps, myCampId: myCamp ? myCamp.id : '', myRoute: String(me.baseRoute || '').replace(/\(.*?\)|\[.*?\]/g, '').trim().split(/[\s,]+/)[0] || '',
      kinds: PM_KINDS, tops: PM_TOPS, pays: PM_PAYS, descTemplate: PM_DESC_TEMPLATE, secretTemplate: PM_SECRET_TEMPLATE, today: todayText_()
    };
  });
}
/** 노선 줄(527ABCD) → 고를 수 있는 라우트 [527A, 527B, …] */
function pmRouteCodes_(routes) {
  const seen = {}, out = [];
  routes.forEach(function (r) {
    const ls = [r.g2, r.g3, r.g4, r.g5].filter(Boolean);
    (ls.length ? ls.map(function (L) { return r.g1 + L; }) : [r.code]).forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } });
  });
  return out.sort();
}
/** 센터 + 라우트 → 노선관리의 품앗이단가(없으면 기사단가) 제안 */
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
    if (!job.id && f.date < todayText_()) fail_('지난 날짜로는 올릴 수 없습니다.');
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
    f.desc = t(job.desc, 3000, '상세 설명');
    f.secret = t(job.secret, 1500, '비공개 정보');
    // 첨부 (이미지 1장) — 잠금 밖에서 올린다
    let attachUrl = null;
    if (job.attach && job.attach.data) {
      if (!/^image\//.test(String(job.attach.mime))) fail_('첨부는 이미지 파일만 올릴 수 있습니다.');
      if (String(job.attach.data).length > CFG.MAX_FILE_B64) fail_('이미지가 너무 큽니다.');
      const ext = /png/.test(job.attach.mime) ? '.png' : '.jpg';
      const file = pmFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(job.attach.data), job.attach.mime, (f.date + '_' + f.camp + '_' + (f.route || f.area) + '_' + u.info.name).replace(/[\\\/:*?"<>|]/g, ' ') + ext));
      attachUrl = file.getUrl();
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (job.id) {
        const row = findRow_(SH.PJOB, 'id', String(job.id));
        if (!row) fail_('일감을 찾을 수 없습니다.');
        const o = readObj_(SH.PJOB, row);
        if (o.posterId !== u.id) fail_('내가 올린 일감만 고칠 수 있습니다.');
        if (o.status !== PST.OPEN && o.status !== PST.TALK) fail_('배차가 확정되었거나 마감된 일감은 고칠 수 없습니다. 확정을 풀거나 다시 열어 주세요.');
        if (attachUrl) f.attach = attachUrl; else if (job.removeAttach) f.attach = '';
        f.updatedAt = now;
        writeFields_(SH.PJOB, row, f);
        // 지원 기록의 배차일도 맞춘다 (같은 날 2회 제한 계산용)
        if (f.date !== o.date) readAll_(SH.PAPP).forEach(function (a) { if (a.jobId === o.id) writeFields_(SH.PAPP, a._row, { date: f.date }); });
        pmTouch_();
        return { ok: true, id: o.id };
      }
      const id = uniqId_('J');
      appendObj_(SH.PJOB, Object.assign({ id: id, status: PST.OPEN, posterId: u.id, poster: u.info.name, attach: attachUrl || '', createdAt: now, updatedAt: now }, f));
      pmTouch_();
      return { ok: true, id: id };
    } finally {
      lock.releaseLock();
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
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const j = pmJobById_(id), today = todayText_();
      const apps = readAll_(SH.PAPP);
      const why = pmCanApply_(j, u.id, apps, today);
      if (why) fail_(why);
      const now = nowText_();
      appendObj_(SH.PAPP, { id: uniqId_('A'), jobId: j.id, driverId: u.id, name: u.info.name, date: j.date, status: PAST.APPLY, memo: String(memo || '').trim().slice(0, 200), createdAt: now, updatedAt: now });
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}
function api_pmCancelApply(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const a = readAll_(SH.PAPP).filter(function (x) { return x.jobId === id && x.driverId === u.id && pmActiveApp_(x); })[0];
      if (!a) fail_('지원 기록이 없습니다.');
      const j = pmJobById_(id), row = findRow_(SH.PJOB, 'id', j.id), now = nowText_();
      writeFields_(SH.PAPP, a._row, { status: PAST.CANCEL, updatedAt: now });
      // 확정된 기사가 취소하면 일감은 다시 모집 중
      if (j.acceptedId === u.id) writeFields_(SH.PJOB, row, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now });
      else if (j.status === PST.TALK && a.status === PAST.TALK && !readAll_(SH.PAPP).some(function (x) { return x.jobId === id && x.id !== a.id && x.status === PAST.TALK; })) writeFields_(SH.PJOB, row, { status: PST.OPEN, updatedAt: now });
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

// ───────────────────────── 등록 기사: 지원자 정하기 · 마감 ─────────────────────────
/**
 * action: 'talk'(협의 중) / 'accept'(배차 확정) / 'reject'(미선정) / 'back'(지원 상태로 되돌림)
 * 확정하면 나머지 지원자는 미선정, 일감은 배차 확정.
 */
function api_pmDecide(token, jobId, appId, action) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const j = pmJobById_(jobId), jr = findRow_(SH.PJOB, 'id', j.id);
      if (j.posterId !== u.id) fail_('내가 올린 일감만 정할 수 있습니다.');
      if (j.status === PST.CANCEL || j.status === PST.CLOSED) fail_('마감되었거나 취소된 일감입니다. 다시 열어 주세요.');
      const apps = readAll_(SH.PAPP).filter(function (a) { return a.jobId === j.id; });
      const a = apps.filter(function (x) { return x.id === appId; })[0];
      if (!a || a.status === PAST.CANCEL) fail_('지원자를 찾을 수 없습니다. 지원을 취소했을 수 있습니다.');
      const now = nowText_();
      if (action === 'talk') {
        if (j.status === PST.DONE) fail_('이미 배차가 확정되었습니다. 확정을 먼저 풀어 주세요.');
        writeFields_(SH.PAPP, a._row, { status: PAST.TALK, updatedAt: now });
        writeFields_(SH.PJOB, jr, { status: PST.TALK, updatedAt: now });
      } else if (action === 'accept') {
        if (j.date < todayText_()) fail_('배차일이 지난 일감입니다.');
        apps.forEach(function (x) {
          if (x.id === a.id) writeFields_(SH.PAPP, x._row, { status: PAST.OK, updatedAt: now });
          else if (pmActiveApp_(x)) writeFields_(SH.PAPP, x._row, { status: PAST.NO, updatedAt: now });
        });
        writeFields_(SH.PJOB, jr, { status: PST.DONE, acceptedId: a.driverId, accepted: a.name, updatedAt: now });
      } else if (action === 'reject') {
        writeFields_(SH.PAPP, a._row, { status: PAST.NO, updatedAt: now });
        if (j.acceptedId === a.driverId) writeFields_(SH.PJOB, jr, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now });
        else if (j.status === PST.TALK && !apps.some(function (x) { return x.id !== a.id && x.status === PAST.TALK; })) writeFields_(SH.PJOB, jr, { status: PST.OPEN, updatedAt: now });
      } else if (action === 'back') {
        // 확정 풀기 / 미선정 되돌리기 → 지원 상태
        writeFields_(SH.PAPP, a._row, { status: PAST.APPLY, updatedAt: now });
        if (j.acceptedId === a.driverId) {
          apps.forEach(function (x) { if (x.id !== a.id && x.status === PAST.NO) writeFields_(SH.PAPP, x._row, { status: PAST.APPLY, updatedAt: now }); });
          writeFields_(SH.PJOB, jr, { status: PST.OPEN, acceptedId: '', accepted: '', updatedAt: now });
        }
      } else fail_('알 수 없는 작업입니다.');
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}
/** action: 'close'(모집 마감) / 'reopen'(다시 모집) / 'cancel'(일감 취소) */
function api_pmClose(token, id, action) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const j = pmJobById_(id), jr = findRow_(SH.PJOB, 'id', j.id), now = nowText_();
      if (j.posterId !== u.id) fail_('내가 올린 일감만 바꿀 수 있습니다.');
      if (action === 'close') {
        if (j.status === PST.DONE) fail_('배차가 확정된 일감입니다.');
        writeFields_(SH.PJOB, jr, { status: PST.CLOSED, updatedAt: now });
      } else if (action === 'reopen') {
        if (j.date < todayText_()) fail_('배차일이 지난 일감은 다시 열 수 없습니다.');
        writeFields_(SH.PJOB, jr, { status: PST.OPEN, updatedAt: now });
      } else if (action === 'cancel') {
        writeFields_(SH.PJOB, jr, { status: PST.CANCEL, acceptedId: '', accepted: '', updatedAt: now });
        readAll_(SH.PAPP).forEach(function (x) { if (x.jobId === j.id && pmActiveApp_(x)) writeFields_(SH.PAPP, x._row, { status: PAST.NO, updatedAt: now }); });
      } else fail_('알 수 없는 작업입니다.');
      pmTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
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
      list = d.jobs.filter(function (j) { return j.posterId === u.id && !(j.status === PST.DONE && j.date < today); })
        .map(function (j) {
          const c = pmCard_(j, u.id, d.apps, today);
          c.newApps = d.apps.filter(function (a) { return a.jobId === j.id && a.status === PAST.APPLY; }).length;
          c.acceptedName = j.accepted;
          return c;
        });
    } else if (kind === 'applied') {
      list = d.apps.filter(function (a) { return a.driverId === u.id && byId[a.jobId] && !(a.status === PAST.OK && a.date < today); })
        .map(function (a) { const c = pmCard_(byId[a.jobId], u.id, d.apps, today); c.myApp = a.status; c.appliedAt = a.createdAt; return c; });
    } else if (kind === 'done') {
      list = d.jobs.filter(function (j) { return j.status === PST.DONE && j.date < today && (j.posterId === u.id || j.acceptedId === u.id); })
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
        name: o.name, loginId: o.loginId, phone: o.phone, type: o.driverType || '', code: o.driverCode || '', camp: o.schCamp || '', baseRoute: o.baseRoute || '',
        carNo: o.carNo || '', qual: !!o.docQual, bank: o.bankName || ''
      },
      stats: {
        posted: d.jobs.filter(function (j) { return j.posterId === u.id && j.status !== PST.CANCEL; }).length,
        helped: d.jobs.filter(function (j) { return j.acceptedId === u.id && j.status === PST.DONE && j.date < today; }).length
      }
    };
  });
}
/** 내 스케줄에 붙일 품앗이: { 날짜: [{ role: '수행'|'맡김'|'지원', text, status }] } (내가 뛰는 확정 일감 + 모집 중인 내 일감 + 지원·협의 중인 일감. 내 일감이 배차 확정되면 빼기) */
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
    if (j.status === PST.DONE && j.acceptedId === me) (out[j.date] = out[j.date] || []).push({ role: '수행', id: j.id, text: base + ' (' + j.poster + ' 기사님 일)', status: '확정' });
    // 내가 올린(맡긴) 일감: 모집 중·협의 중일 때만 보이고, 배차가 확정되면 내 스케줄에서 뺀다
    else if (j.posterId === me && (j.status === PST.OPEN || j.status === PST.TALK)) (out[j.date] = out[j.date] || []).push({ role: '맡김', id: j.id, text: base, status: j.status });
  });
  d.apps.forEach(function (a) {
    if (a.driverId !== me || !set[a.date] || (a.status !== PAST.APPLY && a.status !== PAST.TALK)) return;
    const j = d.jobs.filter(function (x) { return x.id === a.jobId; })[0];
    if (!j || j.status === PST.CANCEL) return;
    (out[a.date] = out[a.date] || []).push({ role: '지원', id: j.id, text: (j.camp ? j.camp.replace(/\s*캠프$/, '') + ' ' : '') + (j.route || j.area) + ' · ' + j.time, status: a.status });
  });
  return out;
}
