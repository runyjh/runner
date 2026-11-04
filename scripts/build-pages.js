/**
 * 깃허브 페이지용 화면 만들기: src/Index.html, src/Admin.html → _site/index.html, _site/admin.html
 * - 화면 파일은 구글 앱스크립트용과 같은 것을 그대로 쓰고, <head> 에 설정(웹앱 주소)·아이콘·앱 설치 정보만 넣는다.
 * - 웹앱 주소는 환경변수 RUNNER_API_URL (깃허브 저장소 Settings → Variables 의 RUNNER_API_URL)
 * 사용: RUNNER_API_URL=https://script.google.com/macros/s/…/exec node scripts/build-pages.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const api = String(process.env.RUNNER_API_URL || '').trim();

if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(api)) {
  console.error('RUNNER_API_URL 이 없거나 형식이 다릅니다.\n' +
    '깃허브 저장소 Settings → Secrets and variables → Actions → Variables 에\n' +
    'RUNNER_API_URL = https://script.google.com/macros/s/(배포ID)/exec 를 넣어 주세요. (README 참고)');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach((ent) => {
    const a = path.join(from, ent.name), b = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  });
}
copyDir(path.join(ROOT, 'site'), OUT);

const ver = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 7);
const common = [
  '<script>window.RUNNER_CONFIG = ' + JSON.stringify({ api: api, ver: ver }) + ';</script>',
  '<link rel="preconnect" href="https://script.google.com">',
  '<link rel="preconnect" href="https://script.googleusercontent.com" crossorigin>',
  '<link rel="icon" type="image/png" href="icons/favicon-48.png">',
  '<meta name="theme-color" content="#1b64da">',
  '<meta name="referrer" content="no-referrer">'
];
const SW = '<script>if (\'serviceWorker\' in navigator) addEventListener(\'load\', function () { navigator.serviceWorker.register(\'sw.js\').catch(function () {}); });</script>';
const pages = [
  {
    src: 'Index.html', out: 'index.html', title: '러너 올인원',
    head: common.concat([
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<link rel="manifest" href="manifest.webmanifest">',
      '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="러너">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
      SW
    ])
  },
  {
    src: 'Admin.html', out: 'admin.html', title: '러너 올인원 관리자',
    head: common.concat([
      '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="robots" content="noindex">',
      '<link rel="manifest" href="admin.webmanifest">',
      '<link rel="apple-touch-icon" href="icons/admin-apple-touch-icon.png">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="러너 관리자">',
      SW,
      // 관리자 화면 보안 정책: 서버(구글 웹앱) 외의 곳으로는 데이터를 보낼 수 없고, 다른 곳의 스크립트도 실행되지 않는다
      '<meta http-equiv="Content-Security-Policy" content="' + [
        "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "font-src 'self' https://cdn.jsdelivr.net data:", "img-src 'self' data: blob:", "manifest-src 'self'",
        "connect-src 'self' https://script.google.com https://script.googleusercontent.com",
        "frame-src 'self' blob: data:", "worker-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"
      ].join('; ') + '">'
    ])
  }
];

pages.forEach((p) => {
  let html = fs.readFileSync(path.join(ROOT, 'src', p.src), 'utf8');
  if (!/<meta charset="utf-8">/.test(html)) throw new Error(p.src + ': <meta charset="utf-8"> 를 찾지 못했습니다.');
  // 앱스크립트는 setTitle 로 제목을 붙이므로, 페이지용에는 <title> 을 직접 넣는다
  html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<title>' + p.title + '</title>\n' + p.head.join('\n'));
  fs.writeFileSync(path.join(OUT, p.out), html);
  console.log('OK   _site/' + p.out);
});
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('\n깃허브 페이지용 화면을 만들었습니다 (웹앱: ' + api.replace(/\/s\/(.{6}).*\/exec/, '/s/$1…/exec') + ')');
