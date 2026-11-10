/**
 * 없는 함수 부르기 검사 (배포 전 · scripts/check.js 가 부름)
 * "부르기만 하고 어디에도 선언·대입이 없는 이름" 을 찾는다 — 함수를 지우면서 부르는 줄을 남긴 실수(예: loadCond)를 배포 전에 잡는다.
 * 문자열·주석·정규식은 지우고 본다. 브라우저·앱스 스크립트가 주는 이름은 KNOWN 에.
 */
const fs = require('fs');
const path = require('path');
const KNOWN = new Set(('if for while switch catch function return typeof new delete void await async super import do else in of instanceof throw yield ' +
  'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame requestIdleCallback fetch alert confirm prompt parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape atob btoa ' +
  'String Number Boolean Array Object Date Math JSON RegExp Error TypeError Promise Map Set WeakMap Symbol Blob File FileReader FormData URL URLSearchParams Image Event CustomEvent AbortController TextEncoder TextDecoder Uint8Array Uint16Array Uint32Array Int32Array Float64Array ArrayBuffer DataView Intl Notification ' +
  'getComputedStyle matchMedia structuredClone queueMicrotask open close print focus scrollTo postMessage importScripts require ResizeObserver IntersectionObserver MutationObserver DOMParser XMLSerializer Worker BigInt Function eval Proxy Reflect DecompressionStream CompressionStream Response Request Headers ' +
  'DataTransfer ClipboardItem firebase daum google').split(/\s+/));
/** 문자열·템플릿·주석·정규식 글자를 공백으로 (줄 수는 유지) */
function strip(src) {
  let out = '', i = 0, n = src.length, prev = '';
  const blank = function (s) { return s.replace(/[^\n]/g, ' '); };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = c; continue; }
    if (c === '`') { // 템플릿: ${ } 안은 코드로 남긴다
      let j = i + 1, buf = '`';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { buf += '  '; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { let depth = 1, k = j + 2; while (k < n && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; } buf += '  ' + strip(src.slice(j + 2, k - 1)) + ' '; j = k; continue; }
        buf += src[j] === '\n' ? '\n' : ' '; j++;
      }
      out += buf + '`'; i = j + 1; prev = '`'; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};\n]|^$/.test(prev) ) { // 정규식 (앞이 연산자·여는 괄호일 때)
      let j = i + 1, cls = false, ok = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) { ok = true; break; } j++; }
      if (ok) { out += '/' + blank(src.slice(i + 1, j)) + '/'; i = j + 1; prev = '/'; continue; }
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}
function find(code) {
  const s = strip(code), all = {}, calls = {};
  let m;
  const reId = /(?<![\w$])[A-Za-z_$][\w$]*/g;
  while ((m = reId.exec(s))) {
    const name = m[0], before = s.slice(Math.max(0, m.index - 1), m.index), after = s.slice(m.index + name.length).match(/^\s*(.)/);
    all[name] = (all[name] || 0) + 1;
    if (before !== '.' && after && after[1] === '(') {
      // name(...) { 모양은 객체 안의 함수 선언 → 부르기가 아님
      let k = s.indexOf('(', m.index + name.length), depth = 1; k++;
      while (k < s.length && depth) { if (s[k] === '(') depth++; else if (s[k] === ')') depth--; k++; }
      const nx = s.slice(k).match(/^\s*(.)/);
      if (nx && nx[1] === '{') continue;
      (calls[name] = calls[name] || []).push(s.slice(0, m.index).split('\n').length);
    }
    else if (before === '.' && !/(window|self|globalThis)\.$/.test(s.slice(Math.max(0, m.index - 11), m.index))) all[name]--; // 속성 이름은 선언이 아님 (window.x = … 는 선언으로 침)
  }
  return Object.keys(calls).filter(function (k) { return !KNOWN.has(k) && all[k] === calls[k].length && !new RegExp('function\\s+' + k.replace(/\$/g, '\\$') + '\\s*\\(').test(s); })
    .map(function (k) { return { name: k, lines: calls[k] }; });
}
function run(root) {
  const out = [], src = path.join(root, 'src');
  // 서버: 모든 .gs 가 한 공간을 쓴다 → 합쳐서 본다
  const gs = fs.readdirSync(src).filter(function (f) { return f.endsWith('.gs'); });
  const GS_KNOWN = ['SpreadsheetApp', 'Utilities', 'CacheService', 'LockService', 'PropertiesService', 'ContentService', 'UrlFetchApp', 'DriveApp', 'ScriptApp', 'HtmlService', 'Session', 'Logger', 'console', 'Sheets', 'Drive'];
  GS_KNOWN.forEach(function (k) { KNOWN.add(k); });
  find(gs.map(function (f) { return fs.readFileSync(path.join(src, f), 'utf8'); }).join('\n;\n')).forEach(function (x) { out.push('서버(.gs): ' + x.name + '()'); });
  fs.readdirSync(src).filter(function (f) { return f.endsWith('.html'); }).forEach(function (f) {
    const text = fs.readFileSync(path.join(src, f), 'utf8'), re = /<script>([\s\S]*?)<\/script>/g;
    let m, code = '', pos = 0;
    while ((m = re.exec(text))) { code += text.slice(pos, m.index).replace(/[^\n]/g, '') + ';' + m[1]; pos = re.lastIndex; }
    find(code).forEach(function (x) { out.push(f + ' ' + x.lines.slice(0, 3).join(',') + '줄: ' + x.name + '()'); });
  });
  return out;
}
module.exports = { run: run, find: find };
if (require.main === module) { const r = run(path.join(__dirname, '..')); r.forEach(function (x) { console.log(x); }); console.log(r.length + '건'); }
