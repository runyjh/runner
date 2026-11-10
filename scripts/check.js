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
walk(path.join(ROOT, 'extension'));
checkJs('scripts/build-pages.js', fs.readFileSync(path.join(ROOT, 'scripts', 'build-pages.js'), 'utf8').replace(/^#!.*\n/, ''));

// 정산 계산 시험: 금액이 기대값과 다르면 배포하지 않는다 (scripts/test-settle.js)
if (!failed) {
  try {
    const t = require('./test-settle.js');
    count += t.count;
    if (t.failed) { console.error('\n자동 시험 실패 ' + t.failed + '건. 배포하지 않습니다. (규칙을 일부러 바꿨으면 scripts/test-settle.js 의 기대값도 고쳐 주세요)'); process.exit(1); }
    console.log('OK   자동 시험 ' + t.count + '개');
  } catch (e) { console.error('\n자동 시험을 돌리지 못했습니다: ' + (e && e.stack || e)); process.exit(1); }
}

if (failed) {
  console.error('\n문법 오류 ' + failed + '건 / ' + count + '개 검사. 배포하지 않습니다.');
  process.exit(1);
}
console.log('\n' + count + '개 모두 정상');
