/**
 * 나중 처리 (저장 응답을 빨리 돌려주기)
 *  - 저장한 사람이 기다릴 필요가 없는 일(관리자 작업 기록 · 기사앱 '스케줄 변경 확인' 기록)을 스크립트 속성에 한 건씩 적어 두고,
 *    1분 작업(fsSync)이 모아서 시트에 쓴다. 최대 1분 늦게 남을 뿐 빠지는 것은 없다 (속성은 지워지지 않는 저장소).
 *  - 1분 작업이 안 돌고 있으면(표시 pq:alive 없음) 미루지 않고 지금처럼 바로 쓴다.
 *  - 속성 이름: LQ_<시각36진수>_<순번><난수> → 이름순 = 적힌 순서.  값: { k: 종류, d: 내용 }
 */
const LQ = { PRE: 'LQ_', HAS: 'lq:has', MAXLEN: 8000, MAXN: 300 };
let _lqSeq = 0;
/** 미뤄 적기. 적었으면 true, 못 미루면(1분 작업 멈춤 · 너무 큼 · 너무 많이 쌓임) false → 부른 쪽이 바로 처리 */
function laterAdd_(kind, data) {
  try {
    const c = cache_();
    if (!c.get(PUSH_Q.ALIVE)) return false;
    const n = +c.get(LQ.HAS) || 0;
    if (n >= LQ.MAXN) return false;
    const j = JSON.stringify({ k: kind, d: data });
    if (j.length > LQ.MAXLEN) return false;
    const key = LQ.PRE + ('00000000000' + Date.now().toString(36)).slice(-11) + '_' + ('00' + (_lqSeq++ % 1000)).slice(-3) + Math.random().toString(36).slice(2, 6);
    PropertiesService.getScriptProperties().setProperty(key, j);
    c.put(LQ.HAS, String(n + 1), 21600);
    return true;
  } catch (e) { return false; }
}
/** 미뤄 둔 일 처리 (1분 작업 · 확인 기록을 읽기 직전). 다른 실행이 잠금을 쥐고 있으면 다음 번에 */
function laterFlush_() {
  let done = 0;
  try {
    const sp = PropertiesService.getScriptProperties();
    const keys = sp.getKeys().filter(function (k) { return k.indexOf(LQ.PRE) === 0; }).sort();
    try { cache_().remove(LQ.HAS); } catch (e) { /* 무시 */ }
    if (!keys.length) return 0;
    const lock = scriptLock_();
    if (!lock.tryLock(8000)) { try { cache_().put(LQ.HAS, String(keys.length), 21600); } catch (e) { /* 무시 */ } return 0; }
    try {
      const all = sp.getProperties();
      const jobs = keys.filter(function (k) { return all[k] !== undefined && all[k] !== null; }) // 그 사이 다른 실행이 처리했으면 없음
        .map(function (k) { let o = null; try { o = JSON.parse(all[k]); } catch (e) { o = null; } return { key: k, o: o }; });
      // 1) 관리자 작업 기록: 한 번에 붙인다 (붙이기에 실패하면 지우지 않고 다음 번에 다시)
      const logs = jobs.filter(function (x) { return x.o && x.o.k === 'log' && Array.isArray(x.o.d); });
      if (logs.length) {
        laterLogRows_(logs.map(function (x) { return x.o.d; }));
        logs.forEach(function (x) { sp.deleteProperty(x.key); });
        done += logs.length;
      }
      // 2) 그 밖: 적힌 순서대로
      jobs.filter(function (x) { return logs.indexOf(x) < 0; }).forEach(function (x) {
        try {
          if (x.o && x.o.k === 'seen' && typeof seenSchChanges_ === 'function') seenSchChanges_(x.o.d.a || {}, x.o.d.list || []);
        } catch (e) { softFail_('미뤄 둔 일 처리 실패 (' + (x.o && x.o.k) + ')', e); }
        sp.deleteProperty(x.key); done++;
      });
    } finally { lock.releaseLock(); }
  } catch (e) { softFail_('미뤄 둔 일 처리 실패', e); }
  return done;
}
/** 미뤄 둔 일이 있을 때만 처리 (확인 기록 화면처럼 방금 저장한 것을 바로 봐야 하는 곳에서) */
function laterFlushIf_() {
  try { if (cache_().get(LQ.HAS)) return laterFlush_(); } catch (e) { /* 무시 */ }
  return 0;
}
/** 관리자 작업 기록 여러 줄을 한 번에 붙이기 */
function laterLogRows_(rows) {
  if (!rows.length) return;
  const sh = sheet_(SH.ALOG), r = sh.getLastRow() + 1;
  const fit = rows.map(function (x) { const y = x.slice(0, 5); while (y.length < 5) y.push(''); return y; });
  if (r + fit.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), fit.length + 500);
  sh.getRange(r, 1, fit.length, 5).setValues(fit);
}

/**
 * 읽기 묶음: 화면을 열 때 동시에 나가는 읽기 요청 여러 개를 한 번에 받는다 (관리자앱 gsCall0 이 30ms 안에 모인 것을 묶어 보냄).
 *  - 왕복 한 번 · 같은 실행 안에서 시트 열기·기사 목록 같은 공통 읽기를 한 번만 (동시 실행 여러 개가 서로 막던 것도 없어짐)
 *  - 읽기 전용 함수만 (BATCH_OK). 하나가 실패해도 나머지는 그대로 · 결과는 보낸 순서대로
 *  calls = [{ fn, args }] (args 는 그 함수에 그대로 넘김 · 맨 앞이 토큰)
 */
const BATCH_OK = ['adm_uiText', 'adm_check', 'adm_peakMap', 'adm_memoMonth', 'adm_schRange', 'adm_schWeek', 'adm_pmList', 'adm_issueList', 'adm_listDrivers', 'adm_home', 'adm_homeStl',
  'adm_live', 'adm_routeAll', 'adm_routeNotes', 'adm_campThumbs', 'adm_pmMeta', 'adm_rcList', 'adm_noticeList', 'adm_seenList', 'adm_stlMonth', 'adm_stlDrivers', 'adm_dash', 'adm_dashStl',
  'adm_perfList', 'adm_slaList', 'adm_lineageList', 'adm_fbList', 'adm_peakList', 'adm_routeVolumes', 'adm_companyGet', 'adm_einvList', 'adm_insRepList', 'adm_tiList', 'adm_accCats', 'adm_bdList', 'adm_mailStatus', 'adm_memoPastUndone'];
const BATCH_MAX = 12;
function adm_batch(token, calls) {
  const t0 = Date.now();
  calls = Array.isArray(calls) ? calls.slice(0, BATCH_MAX) : [];
  const res = calls.map(function (c) {
    const fn = String(c && c.fn || '');
    if (BATCH_OK.indexOf(fn) < 0 || typeof GLOBAL_[fn] !== 'function') return { ok: false, code: 'NOBATCH', msg: '묶어 보낼 수 없는 요청' };
    _curFn = fn;
    try { const r = GLOBAL_[fn].apply(null, Array.isArray(c.args) ? c.args : [token]); return r === undefined ? null : r; }
    catch (e) { try { errLog_('서버 오류', fn, '묶음: ' + String(e && e.message || e)); } catch (x) { /* 무시 */ } return { ok: false, msg: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }; }
  });
  _curFn = 'adm_batch';
  return { ok: true, res: res, _ms: Date.now() - t0 };
}
