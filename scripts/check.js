/**
 * 배포 전 검사: 서버 코드(src/*.gs)와 화면 스크립트(src/*.html 안의 <script>)의 문법 오류를 찾는다.
 * 사용: node scripts/check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
let failed = 0;

function check(label, code) {
  try {
    new vm.Script(code, { filename: label });
    console.log('OK   ' + label);
  } catch (err) {
    failed++;
    console.error('FAIL ' + label + '\n     ' + err.message);
  }
}

fs.readdirSync(SRC).forEach(function (file) {
  const full = path.join(SRC, file);
  const text = fs.readFileSync(full, 'utf8');
  if (file.endsWith('.gs')) {
    check(file, text);
  } else if (file.endsWith('.html')) {
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(text))) check(file + ' <script #' + (++n) + '>', m[1]);
  } else if (file.endsWith('.json')) {
    try { JSON.parse(text); console.log('OK   ' + file); }
    catch (err) { failed++; console.error('FAIL ' + file + '\n     ' + err.message); }
  }
});

if (failed) {
  console.error('\n문법 오류 ' + failed + '건. 배포하지 않습니다.');
  process.exit(1);
}
console.log('\n모든 파일 문법 정상');
