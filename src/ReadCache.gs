/**
 * 읽기 캐시 (버전 방식) — 자주 읽고 가끔 쓰는 시트를 매번 다시 읽지 않게.
 *  - 쓰는 쪽: rcvBump_(영역) — 쓰기 시작할 때 한 번, 그리고 그 실행이 끝날 때(run_) 한 번 더 버전을 올린다
 *    (쓰는 도중 다른 실행이 읽어 저장한 값도 끝에서 버려지게)
 *  - 같은 실행 안에서 이미 쓴 영역은 캐시를 쓰지 않고 시트를 바로 읽는다 (방금 쓴 것이 보이게)
 *  - 시트를 손으로 고친 경우에 대비해 영역마다 짧은 유효 시간(ttl)
 * 영역: memo(업무스케줄 메모) · iss(기사스케줄 이슈)
 */
const RCV = { dirty: {} };
function rcvVer_(area) {
  const k = 'rcv:' + area;
  let v = cache_().get(k);
  if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); try { cache_().put(k, v, CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
  return v;
}
function rcvBump_(area) {
  RCV.dirty[area] = 1;
  try { cache_().put('rcv:' + area, Date.now().toString(36) + Math.random().toString(36).slice(2, 6), CFG.CACHE_MAX); } catch (e) { /* 무시 */ }
}
/** run_ 끝에서: 이 실행이 쓴 영역의 버전을 한 번 더 올린다 */
function rcvEnd_() {
  const ks = Object.keys(RCV.dirty);
  if (!ks.length) return;
  RCV.dirty = {};
  try { SpreadsheetApp.flush(); } catch (e) { /* 무시 */ }
  ks.forEach(function (a) { try { cache_().put('rcv:' + a, Date.now().toString(36) + Math.random().toString(36).slice(2, 6), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } });
}
/** 캐시에 있으면 그것, 없으면 build() 를 불러 저장 (읽는 동안 버전이 바뀌었으면 저장하지 않음) */
function rcvGet_(area, key, ttl, build) {
  if (RCV.dirty[area]) return build();
  const v0 = rcvVer_(area), ck = 'rcv:' + area + ':' + v0 + ':' + key;
  const hit = stlCGet_(ck);
  if (hit !== null && hit !== undefined) return hit;
  const val = build();
  if (cache_().get('rcv:' + area) === v0) stlCPut_(ck, val, ttl);
  return val;
}
