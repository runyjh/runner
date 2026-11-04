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

/*
 * 품앗이 휴대폰 알림 (Firebase Cloud Messaging 의 웹 푸시).
 * 서버가 data 만 보내고, 알림 모양은 여기서 만든다. 앱이 앞에 열려 있으면 알림 대신 앱에 바로 전달.
 */
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { title: '러너', body: e.data ? e.data.text() : '' } }; }
  const d = p.data || (p.notification ? { title: p.notification.title, body: p.notification.body } : p);
  const title = d.title || '러너 품앗이', body = d.body || '', jobId = d.jobId || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const front = list.find((c) => c.visibilityState === 'visible' && c.focused);
    list.forEach((c) => c.postMessage({ type: 'pm-push', jobId: jobId }));
    if (front) return; // 앱 화면에서 바로 보여 줌
    return self.registration.showNotification(title, {
      body: body, tag: 'pm-' + (jobId || Date.now()), renotify: true, data: { jobId: jobId },
      icon: 'icons/icon-192.png', badge: 'icons/favicon-48.png', vibrate: [120, 60, 120]
    });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const jobId = (e.notification.data || {}).jobId || '';
  const url = new URL(jobId ? './?pm=' + encodeURIComponent(jobId) : './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const app = list.find((c) => new URL(c.url).pathname.indexOf(new URL(self.registration.scope).pathname) === 0 && !/\/admin\//.test(c.url));
    if (app) { app.postMessage({ type: 'pm-open', jobId: jobId }); return app.focus(); }
    return self.clients.openWindow(url);
  }));
});
