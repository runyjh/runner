/**
 * 기사앱 미리 보기 (관리자앱 › 기사 정보 › [📱 기사앱으로 보기]) — 대표 · 운영자만
 *  - 기사 비밀번호 · 기사 로그인을 쓰지 않는다. 그 기사 한 명에게만 통하는 '미리 보기 열쇠'(10분)를 캐시에만 두고, 기사앱이 그 열쇠로 자료를 받는다
 *  - 열쇠로 온 요청은 PVW.READ 에 있는 읽기 함수만 통과 (getSession_ 에서 막음 → 기사앱의 모든 함수가 여기를 거침). 저장 · 지원 · 확인 · 비밀번호 · 알림 등록은 거절
 *  - 접속 중 · 앱 접속일 · 공지 읽음 · 정산서 열람 기록에 넣지 않는다 (기사가 한 것으로 남지 않게) · 누가 언제 누구 화면을 봤는지는 관리자 기록에 남김
 *  - 새 api_ 함수를 만들면 PVW.READ(읽기) 나 PVW.WRITE(막음) 중 한 곳에 꼭 적어야 한다 — 자동 시험이 빠진 함수를 잡는다
 */
var _pv = false; // 이번 실행이 미리 보기 요청인지 (임시 비밀번호 '먼저 바꾸기' 안내를 건너뛰는 데 씀)
const PVW = {
  PREFIX: 'PV', TTL: 600, TITLES: ['대표', '운영자'], MSG: '미리 보기에서는 저장되지 않습니다.',
  READ: ['api_ping', 'api_checkSession', 'api_uiText', 'api_notices', 'api_ntPhoto', 'api_bdList', 'api_bdRecent', 'api_bdPost', 'api_bdAttach',
    'api_mySchedule', 'api_campSchedule', 'api_routeInfo', 'api_campImage', 'api_routeNotePhoto', 'api_myInfo', 'api_myPerf', 'api_myFb', 'api_myPeak',
    'api_pmList', 'api_pmJob', 'api_pmAttach', 'api_pmForm', 'api_pmPrice', 'api_pmMine', 'api_pmAvailMine', 'api_pmAvailList', 'api_pmAlerts',
    'api_mySettle', 'api_mySlip', 'api_seen', 'api_memoMonth', 'api_ntAdmList', 'api_ntAdmPhoto'],
  WRITE: ['api_checkLoginId', 'api_login', 'api_logout', 'api_signup', 'api_resetVerify', 'api_resetPassword', 'api_changePassword',
    'api_bdSave', 'api_bdDelete', 'api_bdComment', 'api_bdCommentDel', 'api_bdLike', 'api_bdReport', 'api_memoSave', 'api_memoDelete', 'api_ntAdmSave', 'api_ntAdmDelete',
    'api_fsToken', 'api_mailFile', 'api_mailPing', 'api_perf', 'api_pmSave', 'api_pmApply', 'api_pmCancelApply', 'api_pmDecide', 'api_pmClose', 'api_pmAvailSave', 'api_pmOfferReply',
    'api_pmAlertsRead', 'api_pmAlertsDel', 'api_pmPushConfig', 'api_pmPushSave', 'api_pmPushDel', 'api_pmPushLog', 'api_campImageDel', 'api_routeNoteSave', 'api_routeNoteDel', 'api_seenAck']
};
function pvKey_(token) { return 'pv:' + tokenHash_(token); }
/** 미리 보기 열쇠 → 로그인과 같은 모양 { d: 기사ID, c, e, pv: 1 } · 없거나 지났으면 null · 읽기 함수가 아니면 거절 */
function pvSession_(token) {
  let o = null;
  try { o = JSON.parse(cache_().get(pvKey_(token)) || 'null'); } catch (e) { o = null; }
  if (!o || !o.d || !(o.e > Date.now())) return null;
  if (typeof _curFn !== 'string' || PVW.READ.indexOf(_curFn) < 0) { const e = new Error('x'); e.userMsg = PVW.MSG; e.code = 'PREVIEW'; throw e; }
  _pv = true;
  return { d: o.d, c: Date.now(), e: o.e, pv: 1, by: o.a, th: '' };
}
/** 기사앱 첫 화면에 보여 줄 미리 보기 정보 (띠): 기사 이름 · 끝나는 시각 · 그 기사가 지금 접속 중인지 · 마지막 활동 */
function pvInfo_(s, info) {
  let last = 0;
  try { last = onlineMap_([String(s.d)])[String(s.d)] || 0; } catch (e) { last = 0; }
  return { name: info.name, until: s.e, online: !!last && Date.now() - last <= ONLINE.NOW_MS, lastAt: last };
}
/** 관리자: 미리 보기 열쇠 만들기 (대표 · 운영자만 · 앱 사용 중인 기사만) */
function adm_previewStart(token, driverId) {
  return run_(function () {
    const a = requireAdmin_(token);
    const me = driverByLogin_(normLoginId_(a.loginId));
    if (!me || PVW.TITLES.indexOf(titleOf_(me)) < 0) fail_('기사앱 미리 보기는 대표 · 운영자만 쓸 수 있습니다.');
    const o = driverById_(str_(driverId));
    if (!o) fail_('기사를 찾을 수 없습니다.');
    if (o.status !== ST.ACTIVE) fail_('앱 사용 중(승인)인 기사만 미리 볼 수 있습니다.');
    const tok = PVW.PREFIX + (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const e = Date.now() + PVW.TTL * 1000;
    cache_().put(pvKey_(tok), JSON.stringify({ d: String(o.id), a: a.loginId, e: e }), PVW.TTL);
    logAdmin_(a, '기사앱 미리 보기', o.name + ' (' + o.id + ')', '보기 전용 · 10분');
    return { ok: true, pv: tok, name: o.name, until: e };
  });
}
