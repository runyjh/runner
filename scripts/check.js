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

// 없는 함수 부르기: 선언이 어디에도 없는 이름을 부르면 배포하지 않는다 (scripts/check-names.js)
try {
  const miss = require('./check-names.js').run(ROOT);
  if (miss.length) miss.forEach(function (x) { bad('없는 함수 부르기 · ' + x, new Error('이 이름의 함수·변수가 어디에도 없습니다. 지운 함수를 아직 부르고 있지 않은지 확인하세요.')); });
  else ok('없는 함수 부르기 없음 (서버 · 관리자앱 · 기사앱)');
} catch (e) { bad('없는 함수 부르기 검사', e); }

// 정산 계산 시험: 금액이 기대값과 다르면 배포하지 않는다 (scripts/test-settle.js)
// 연결 안 된 버튼 찾기: 화면에 id 가 있는 버튼인데 코드 어디에서도 그 id 를 쓰지 않으면 눌러도 아무 일이 없다 (#475 에서 [달력으로 보기] 연결이 빠졌던 일)
//  + 서버에 기사 정보를 통째로 보내는 실수 (ID 만 보내야 함 · 기사앱 미리 보기)
(function () {
  const SKIP = ['askOk', 'edAdd']; // 폼 제출 · class 로 연결
  ['Admin.html', 'Index.html'].forEach(function (f) {
    const s = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const ids = Array.from(new Set((s.match(/<button[^>]*\bid="[A-Za-z0-9_-]+"/g) || []).map(function (m) { return /id="([^"]+)"/.exec(m)[1]; })));
    const dead = ids.filter(function (id) {
      if (SKIP.indexOf(id) >= 0) return false;
      const esc = id.replace(/[-]/g, '\\-');
      const all = (s.match(new RegExp('(^|[^A-Za-z0-9_-])' + esc + '(?![A-Za-z0-9_-])', 'g')) || []).length;
      const decl = (s.match(new RegExp('id="' + esc + '"', 'g')) || []).length;
      const css = (s.match(new RegExp('#' + esc + '\\s*[{,]', 'g')) || []).length;
      return all - decl - css <= 0;
    });
    if (dead.length) bad(f + ' 버튼 연결', new Error('눌러도 아무 일이 없는 버튼: ' + dead.join(', '))); else ok(f + ' 버튼 연결 (' + ids.length + '개)');
    const whole = s.match(/api\('adm_previewStart', cur\)/);
    if (whole) bad(f + ' 미리 보기 호출', new Error('기사 ID 가 아니라 기사 정보 전체를 보내고 있음')); else ok(f + ' 미리 보기 호출');
  });
})();

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
