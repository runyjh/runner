#!/usr/bin/env python3
"""src/Admin.html 의 쿠팡 파일 읽기 함수(브라우저용)를 그대로 떠서 서버용 src/MailParse.gs 를 만든다.
파서를 고치면 이 스크립트를 다시 돌려 주세요:  python3 scripts/gen-mailparse.py"""
import re, sys, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
s = open(os.path.join(root, 'src/Admin.html'), encoding='utf-8').read()
def grab(start):
    i = s.index(start); j = s.index('{', i); d = 0; k = j
    while True:
        c = s[k]
        if c == '{': d += 1
        elif c == '}':
            d -= 1
            if d == 0: break
        k += 1
    return s[i:k + 1]
def line(start):
    i = s.index(start); return s[i:s.index('\n', i)]
parts = [grab('  function parsePerfSheet(sheets, fileName) {'), grab('  function parseSlaSheet(sheets) {'), grab('  function parseFbSheet(sheets) {'), grab('  function parsePeakSheet(sheets, fileName) {'), line('  const pkDate = (ym, x) =>')]
out = '''/**
 * 쿠팡 파일 읽기 (서버용) — src/Admin.html 의 parsePerfSheet · parseSlaSheet · parseFbSheet · parsePeakSheet 와 같은 코드.
 * ※ 손으로 고치지 말 것. 파서를 고치면 scripts/gen-mailparse.py 를 다시 돌려 만든다.
 */
const MailParse_ = (function () {
  const normCode = (v) => String(v || '').replace(/\\s+/g, '').toUpperCase();
  const shortCamp = (n) => String(n || '').replace(/\\s*캠프\\s*$/, '').trim();
  const rpCamp = (name) => shortCamp(name).replace(/\\s/g, '');
''' + '\n'.join(parts) + '''
  return { perf: parsePerfSheet, sla: parseSlaSheet, fb: parseFbSheet, peak: parsePeakSheet, pkDate: pkDate };
})();
'''
open(os.path.join(root, 'src/MailParse.gs'), 'w', encoding='utf-8').write(out)
print('MailParse.gs', len(out))
