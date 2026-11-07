/**
 * 올인원 설정 · 화면 문구
 *  관리자가 메뉴·탭·화면 제목·설명서 글자를 직접 바꾼다. 기능·계산은 그대로, 보이는 글자만 바뀜.
 *  DB 시트 "ui_text" : 키 · 구분 · 위치 · 기본 문구 · 바꾼 문구 · 메모 · 바꾼 사람 · 바꾼 때
 *  DB 시트 "ui_text_log" : 때 · 사람 · 키 · 기본 문구 · 이전 · 이후
 *  바꾼 문구가 비어 있으면 기본 문구가 나온다 (줄을 지워도 됨).
 */
const UIT = {
  SHEET: 'ui_text', LOG: 'ui_text_log', CACHE: 'uitext:v1',
  HEAD: ['키', '구분', '위치', '기본 문구', '바꾼 문구', '메모', '바꾼 사람', '바꾼 때'],
  LHEAD: ['때', '사람', '키', '기본 문구', '이전', '이후']
};

function uitSheet_(name, head, note) {
  const book = ss_();
  let sh = book.getSheetByName(name);
  if (sh) return sh;
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    sh = book.getSheetByName(name);
    if (sh) return sh;
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange(1, 1, Math.min(sh.getMaxRows(), 1000), head.length).setNumberFormat('@');
    sh.setFrozenRows(1);
    if (note) sh.getRange(1, 1).setNote(note);
    return sh;
  } finally { lock.releaseLock(); }
}
function uitRows_() {
  const sh = uitSheet_(UIT.SHEET, UIT.HEAD, '관리자앱 → 올인원 설정 → 화면 문구에서 바꾼 글자. 바꾼 문구를 비우면 기본 문구가 나옵니다.');
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, UIT.HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, key: str_(r[0]), kind: str_(r[1]), where: str_(r[2]), def: str_(r[3]), text: str_(r[4]), memo: str_(r[5]), by: str_(r[6]), at: str_(r[7]) };
  }).filter(function (x) { return x.key; });
}
function uitMap_() {
  const c = cache_().get(UIT.CACHE);
  if (c) return JSON.parse(c);
  const m = {};
  uitRows_().forEach(function (x) { if (x.text || x.memo) m[x.key] = { text: x.text, memo: x.memo, by: x.by, at: x.at, def: x.def, kind: x.kind, where: x.where }; });
  try { cache_().put(UIT.CACHE, JSON.stringify(m), 21600); } catch (e) {}
  return m;
}
function uitLog_(limit) {
  const sh = ss_().getSheetByName(UIT.LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(limit || 100, sh.getLastRow() - 1), from = sh.getLastRow() - n + 1;
  return sh.getRange(from, 1, n, UIT.LHEAD.length).getValues().map(function (r) {
    return { at: str_(r[0]), by: str_(r[1]), key: str_(r[2]), def: str_(r[3]), before: str_(r[4]), after: str_(r[5]) };
  }).reverse();
}

/** 화면 문구 읽기 (관리자앱이 열릴 때) */
function adm_uiText(token, withLog) {
  return run_(function () {
    requireAdmin_(token);
    return { ok: true, map: uitMap_(), log: withLog ? uitLog_(100) : null };
  });
}

/** 화면 문구 저장. list = [{ key, kind, where, def, text, memo }] — text·memo 둘 다 비우면 그 줄을 지운다(기본값) */
function adm_uiTextSave(token, list) {
  return run_(function () {
    const a = requireAdmin_(token);
    if (!Array.isArray(list) || !list.length) fail_('바꾼 내용이 없습니다.');
    if (list.length > 500) fail_('한 번에 500개까지 저장할 수 있습니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    const who = a.name, at = nowText_(), logs = [];
    try {
      const sh = uitSheet_(UIT.SHEET, UIT.HEAD);
      const rows = uitRows_(), byKey = {};
      rows.forEach(function (x) { byKey[x.key] = x; });
      const del = [];
      list.forEach(function (it) {
        const key = str_(it && it.key).slice(0, 200);
        if (!key) return;
        const text = String(it.text == null ? '' : it.text).slice(0, 5000).trim(), memo = str_(it.memo).slice(0, 300);
        const old = byKey[key];
        if (old && old.text === text && old.memo === memo) return;
        if (!old && !text && !memo) return;
        if (old && old.text !== text) logs.push([at, who, key, str_(it.def || old.def).slice(0, 500), old.text, text]);
        if (!old && text) logs.push([at, who, key, str_(it.def).slice(0, 500), '', text]);
        if (!text && !memo) { if (old) del.push(old.row); return; }
        const v = [key, str_(it.kind || (old && old.kind)).slice(0, 30), str_(it.where || (old && old.where)).slice(0, 200), str_(it.def || (old && old.def)).slice(0, 5000), text, memo, who, at];
        if (old) sh.getRange(old.row, 1, 1, v.length).setValues([v]);
        else { sh.appendRow(v); byKey[key] = { row: sh.getLastRow(), key: key, text: text, memo: memo }; }
      });
      del.sort(function (x, y) { return y - x; }).forEach(function (r) { sh.deleteRow(r); });
      if (logs.length) {
        const lg = uitSheet_(UIT.LOG, UIT.LHEAD, '화면 문구 변경 기록');
        lg.getRange(lg.getLastRow() + 1, 1, logs.length, UIT.LHEAD.length).setValues(logs);
      }
      cache_().remove(UIT.CACHE);
    } finally { lock.releaseLock(); }
    if (logs.length) logAdmin_(a, '화면 문구 변경', logs.length + '개', logs.slice(0, 5).map(function (l) { return (l[4] || l[3]) + ' → ' + (l[5] || '(기본)'); }).join(' · '));
    return { ok: true, map: uitMap_(), changed: logs.length, log: uitLog_(100) };
  });
}

/** 기사앱 화면 문구 (로그인 없이 읽음 · 글자만 있으므로 공개해도 됨). 키는 "d:화면id:기본 문구" */
function api_uiText() {
  return run_(function () {
    const m = uitMap_(), out = {};
    Object.keys(m).forEach(function (k) { if (k.indexOf('d:') === 0 && m[k].text) out[k] = m[k].text; });
    return { ok: true, map: out };
  });
}
