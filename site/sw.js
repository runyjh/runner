/*
 * 러너 앱 서비스 워커 — '앱 설치'(홈 화면 아이콘·전체 화면)를 위한 최소 구성.
 * 화면·데이터는 캐시하지 않는다 (항상 최신 코드, 데이터는 구글 시트에서 바로).
 * 인터넷이 끊겼을 때만 안내 화면을 보여 준다.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // 서버 호출(POST)·그림 등은 건드리지 않음
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:sans-serif;text-align:center;padding:30vh 24px;color:#333"><h2>인터넷 연결이 없습니다</h2>' +
    '<p>연결을 확인한 뒤 다시 열어 주세요.</p><button onclick="location.reload()" style="font-size:16px;padding:10px 20px">다시 시도</button></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
