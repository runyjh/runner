/**
 * 배포 전 문법 검사 (src/ : *.gs, *.html 안의 <script>, *.json)
 * 오류가 있으면 종료 코드 1 → GitHub Actions 배포가 멈춘다.
 * 사용: node scripts/check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failed = 0, count = 0;

function ok(label) { count++; console.log('OK   ' + label); }
function bad(label, err) { count++; failed++; console.error('FAIL ' + label + '\n     ' + err.message); }

function checkJs(label, code) {
  try { new vm.Script(code, { filename: label }); ok(label); } catch (err) { bad(label, err); }
}
function checkJson(label, text) {
  try { JSON.parse(text); ok(label); } catch (err) { bad(label, err); }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) return walk(full);
    const label = path.relative(ROOT, full);
    const ext = path.extname(ent.name);
    if (ext === '.gs' || ext === '.js') {
      checkJs(label, fs.readFileSync(full, 'utf8'));
    } else if (ext === '.json' || ext === '.webmanifest') {
      checkJson(label, fs.readFileSync(full, 'utf8'));
    } else if (ext === '.html') {
      const text = fs.readFileSync(full, 'utf8');
      const re = /<script>([\s\S]*?)<\/script>/g;
      let m, n = 0;
      while ((m = re.exec(text))) checkJs(label + ' <script #' + (++n) + '>', m[1]);
    }
  });
}

walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'site'));
checkJs('scripts/build-pages.js', fs.readFileSync(path.join(ROOT, 'scripts', 'build-pages.js'), 'utf8').replace(/^#!.*\n/, ''));

if (failed) {
  console.error('\n문법 오류 ' + failed + '건 / ' + count + '개 검사. 배포하지 않습니다.');
  process.exit(1);
}
console.log('\n' + count + '개 모두 정상');
