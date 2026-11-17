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
