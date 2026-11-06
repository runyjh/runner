/**
 * 속도 측정 (화면별 서버 호출 횟수 · 걸리는 시간)
 *  - 모든 서버 함수(run_)는 결과에 서버 처리 시간 _ms 를 붙인다.
 *  - 관리자 앱 · 기사 앱은 호출마다 [화면, 함수, 왕복 시간, 서버 시간]을 모아 1분마다 perf_log 탭에 한 줄씩(화면·함수별 합계) 보낸다.
 *  - 관리자 [⏱ 속도 측정 → 지금 측정]: 화면을 열 때 부르는 함수를 차례로 실제 호출해 왕복 시간을 잰다.
 *    기사 앱 함수는 관리자가 대신 부른다 (adm_perfDrv: 이 실행 안에서만 쓰는 임시 세션 · 결과 내용은 돌려주지 않음).
 */
// perf_log 탭 열 정의(PF)는 Code.gs (파일 읽는 순서와 상관없게)

/** 측정용 임시 세션: 이 실행 안에서만 (무작위 글자 · 화면에서 맞힐 수 없음) */
var PERF_BENCH_ = null;

function perfRows_(rows, app, who) {
  if (!Array.isArray(rows)) return 0;
  const now = nowText_();
  const out = rows.slice(0, 120).map(function (r) {
    return { at: now, app: app, view: str_(r && r.v).slice(0, 40), fn: str_(r && r.f).replace(/[^\w]/g, '').slice(0, 40),
      n: Math.max(0, Math.min(9999, Math.round(+r.n || 0))), rt: Math.max(0, Math.round(+r.rt || 0)), rtMax: Math.max(0, Math.round(+r.mx || 0)),
      srv: Math.max(0, Math.round(+r.sv || 0)), who: str_(who).slice(0, 40) };
  }).filter(function (o) { return o.fn && o.n; });
  if (!out.length) return 0;
  const c = cols_(SH.PERF, true), sh = sheet_(SH.PERF);
  const r = sh.getLastRow() + 1;
  if (r > 30000) { console.warn('perf_log 가 3만 줄을 넘어 더 기록하지 않습니다 (지우면 다시 기록).'); return 0; } // 시트가 끝없이 커지지 않게
  // 글자는 글자 서식(@)으로 · '=' '+' 로 시작하면 앞에 공백 (시트 수식으로 실행되지 않게)
  const vals = out.map(function (o) { const a = new Array(c.__w).fill(''); Object.keys(o).forEach(function (k) { a[c[k]] = typeof o[k] === 'string' ? safeText_(o[k]) : o[k]; }); return a; });
  if (r + vals.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, vals.length));
  sh.getRange(r, 1, vals.length, c.__w).setNumberFormat('@').setValues(vals);
  return out.length;
}
/** 기사 앱: 측정값 보내기 (로그인한 기사만 · 기사 이름은 남기지 않음) */
function api_perf(token, rows) {
  return run_(function () {
    const s = getSession_(token);
    if (!s) return { ok: true, n: 0 };
    // 한 기기에서 1분에 3번까지만 (앱은 1분에 1번 보냄 · 마구 보내 시트를 키우지 못하게)
    const k = 'pf:' + s.th, c = cache_(), n = +(c.get(k) || 0);
    if (n >= 3) return { ok: true, n: 0 };
    c.put(k, String(n + 1), 60);
    return { ok: true, n: perfRows_(rows, '기사앱', '') };
  });
}
/** 관리자 앱: 측정값 보내기 */
function adm_perf(token, rows, bench) {
  return run_(function () {
    const a = requireAdmin_(token);
    return { ok: true, n: perfRows_(rows, bench ? '측정' : '관리자앱', a.name) };
  });
}
/** 측정용: 기사 앱 화면 함수를 관리자가 대신 부른다 (처리 시간만 돌려줌) */
const PERF_DRV_FNS = ['api_checkSession', 'api_notices', 'api_bdRecent', 'api_pmAlerts', 'api_mySchedule', 'api_campSchedule', 'api_mySettle', 'api_mySlip', 'api_pmList', 'api_pmAvailList', 'api_pmMine', 'api_myInfo', 'api_bdList'];
function adm_perfDrv(token, fn, args, driverId) {
  return run_(function () {
    requireAdmin_(token);
    if (PERF_DRV_FNS.indexOf(fn) < 0) fail_('측정할 수 없는 함수입니다.');
    let d = driverId ? driverById_(driverId) : null;
    if (!d) d = readAll_(SH.DRIVERS).filter(function (o) { return o.status === ST.ACTIVE && o.loginId && !o.mustChange && o.workStatus !== '퇴사'; })[0];
    if (!d) fail_('측정에 쓸 승인된 기사가 없습니다.');
    PERF_BENCH_ = { tok: Utilities.getUuid() + Utilities.getUuid(), s: { d: String(d.id), c: Date.now(), e: Date.now() + 60000, a: 0, th: 'bench' } };
    const t0 = Date.now();
    let r;
    const F = { api_checkSession: api_checkSession, api_notices: api_notices, api_bdRecent: api_bdRecent, api_pmAlerts: api_pmAlerts, api_mySchedule: api_mySchedule,
      api_campSchedule: api_campSchedule, api_mySettle: api_mySettle, api_mySlip: api_mySlip, api_pmList: api_pmList, api_pmAvailList: api_pmAvailList,
      api_pmMine: api_pmMine, api_myInfo: api_myInfo, api_bdList: api_bdList };
    try { r = F[fn].apply(null, [PERF_BENCH_.tok].concat(Array.isArray(args) ? args : [])); } finally { PERF_BENCH_ = null; }
    const ms = Date.now() - t0;
    let size = 0;
    try { size = JSON.stringify(r).length; } catch (e) { size = 0; }
    return { ok: true, fnOk: !!(r && r.ok), ms: ms, size: size, driver: d.name };
  });
}
/** 측정 결과 모아 보기: 최근 N일 화면·함수별 (횟수/일 · 평균 왕복 · 평균 서버) */
function adm_perfStats(token, days) {
  return run_(function () {
    requireAdmin_(token);
    days = Math.max(1, Math.min(30, +days || 7));
    const from = Utilities.formatDate(new Date(Date.now() - days * 864e5), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    let rows = [];
    try { rows = readAll_(SH.PERF); } catch (e) { rows = []; }
    const by = {}, dayset = {};
    rows.forEach(function (r) {
      const at = str_(r.at); if (!at || at < from) return;
      dayset[at.slice(0, 10)] = 1;
      const k = r.app + '|' + r.view + '|' + r.fn, o = by[k] || (by[k] = { app: r.app, view: r.view, fn: r.fn, n: 0, rt: 0, mx: 0, srv: 0, last: '' });
      o.n += +r.n || 0; o.rt += +r.rt || 0; o.srv += +r.srv || 0; o.mx = Math.max(o.mx, +r.rtMax || 0); if (at > o.last) o.last = at;
    });
    const list = Object.keys(by).map(function (k) { const o = by[k]; return { app: o.app, view: o.view, fn: o.fn, n: o.n, avg: o.n ? Math.round(o.rt / o.n) : 0, srv: o.n ? Math.round(o.srv / o.n) : 0, max: o.mx, last: o.last }; });
    return { ok: true, days: Object.keys(dayset).length, list: list };
  });
}
