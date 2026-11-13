/**
 * 쿠팡 메일 자동 수집: 메일 계정 쪽의 작은 수집기(따로 설치하는 스크립트)가 새 메일의 엑셀 첨부를 올인원으로 보낸다 (api_mailFile).
 *  → 여기서 파일을 읽어 종류를 알아보고(주간 수행률 · SLA · 가중요인 · 피크 물량) 지금의 저장 함수 그대로 저장한다.
 *  - 열쇠(수집 키): 관리자가 화면에서 만들고 수집기에 붙여 넣는다. 서버에는 해시만 둔다 (스크립트 속성 MAIL_KEY_HASH).
 *  - 같은 메일의 같은 파일은 한 번만 (mail_log 의 메일ID + 파일 이름).
 *  - 기간을 분명히 읽지 못한 파일은 저장하지 않고 '확인 필요' 로 남긴다.
 */
const MAIL_ST = { SAVED: '저장', HOLD: '확인 필요', SKIP: '쿠팡 파일 아님', FAIL: '실패' };
const MAIL_KIND = { wk: '주간 수행률', sla: 'SLA 점수', fb: '가중요인', pk: '피크 물량', st: '정산서' };
const MAIL_STL_FROM = 27, MAIL_STL_TO = 5; // 정산서는 매달 27일 ~ 다음 달 5일에 온 메일만 자동 반영
var _sysAdmin = null; // 이 실행 안에서만 쓰는 '자동 수집' 관리자 (열쇠 확인 뒤에만 만들어짐 · 밖으로 나가지 않음)

function mailCfg_() { const p = props_(); return { hash: str_(p.MAIL_KEY_HASH), on: str_(p.MAIL_ON) !== '0', ping: str_(p.MAIL_PING) }; }

/** xlsx(바이트) → [{ name, rows }] — 관리자앱 readXlsx 와 같은 모양 (숫자는 Number · 글자는 String · 빈칸은 '') */
function mailXlsx_(bytes) {
  let files;
  try { files = Utilities.unzip(Utilities.newBlob(bytes, 'application/zip', 'f.zip')); } catch (e) { throw new Error('엑셀(.xlsx) 파일이 아닙니다'); }
  const by = {};
  files.forEach(function (b) { by[String(b.getName()).replace(/^\//, '')] = b; });
  const text = function (n) { return by[n] ? by[n].getDataAsString('UTF-8') : ''; };
  const ent = function (s) { return s.indexOf('&') < 0 ? s : s.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(+d); }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); };
  const tx = function (xml) { let o = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml)) !== null) o += ent(m[1]); return o; };
  const attr = function (tag, name) { const m = tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"')); return m ? ent(m[1]) : null; };
  const sst = []; { const re = /<si>([\s\S]*?)<\/si>|<si\/>/g; let m; const x = text('xl/sharedStrings.xml'); while ((m = re.exec(x)) !== null) sst.push(m[1] ? tx(m[1]) : ''); }
  const target = {}; { const re = /<Relationship\s([^>]*)>/g; let m; const x = text('xl/_rels/workbook.xml.rels'); while ((m = re.exec(x)) !== null) target[attr(m[1], 'Id')] = attr(m[1], 'Target'); }
  const colNum = function (ref) { let c = 0; for (let i = 0; i < ref.length; i++) { const k = ref.charCodeAt(i); if (k < 65 || k > 90) break; c = c * 26 + (k - 64); } return c - 1; };
  const sheets = [], wb = text('xl/workbook.xml');
  if (!wb) throw new Error('엑셀(.xlsx) 파일이 아닙니다');
  const reS = /<sheet\s([^>]*)>/g; let ms;
  while ((ms = reS.exec(wb)) !== null) {
    const t = String(target[attr(ms[1], 'r:id')] || '').replace(/^\/?xl\//, '').replace(/^\//, '');
    const doc = text('xl/' + t), rows = [];
    const reR = /<row(\s[^>]*)?>([\s\S]*?)<\/row>/g; let mr, ri = 0;
    while ((mr = reR.exec(doc)) !== null) {
      const rn = (+(attr(mr[1] || '', 'r')) || ri + 1) - 1, arr = rows[rn] = []; ri = rn + 1;
      let auto = 0;
      const reC = /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g; let mc;
      while ((mc = reC.exec(mr[2])) !== null) {
        const at = mc[1] || '', ref = attr(at, 'r'), ci = ref ? colNum(ref) : auto; auto = ci + 1;
        const typ = attr(at, 't'), body = mc[2] || '', mv = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/), v = mv ? ent(mv[1]) : '';
        let val = '';
        if (typ === 's') val = sst[+v] || '';
        else if (typ === 'inlineStr') val = tx(body);
        else if (typ === 'str' || typ === 'e') val = typ === 'e' ? '' : v;
        else if (typ === 'b') val = v === '1';
        else val = v === '' ? '' : Number(v);
        arr[ci] = val;
      }
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name: attr(ms[1], 'name'), rows: rows });
  }
  return sheets;
}

/** 시트 → 종류와 읽은 내용 (관리자앱 rpDetect 와 같은 순서). 쿠팡 파일이 아니면 null */
function mailDetect_(sheets, name) {
  const has = function (re, top) { return sheets.some(function (sh) { return (top ? sh.rows.slice(0, top) : sh.rows).some(function (r) { return r && r.some(function (v) { return re.test(String(v == null ? '' : v)); }); }); }); };
  const isSla = has(/data\s*end\s*date/i), isFb = !isSla && has(/가중요인/, 8);
  if (isSla) { const b = MailParse_.sla(sheets); if (b.length) return { kind: 'sla', blocks: b }; }
  if (isFb) { const b = MailParse_.fb(sheets); if (b.length) return { kind: 'fb', blocks: b }; } // 정산서 머리글에도 '가중요인' 글자가 있어 표가 없으면 아래로
  const pk = MailParse_.peak(sheets, name);
  if (pk) return { kind: 'pk', P: pk };
  try { const st = MailParse_.coupang(sheets); if (st && st.raw.length) return { kind: 'st', P: st }; } catch (e) { /* 정산서 아님 */ }
  try { return { kind: 'wk', P: MailParse_.perf(sheets, name) }; } catch (e) { return null; }
}

/** 읽은 파일 하나를 저장 → { status, period, detail } (관리자앱 [쿠팡 파일 올리기] 와 같은 저장 함수 · 같은 기간은 덮어씀) */
function mailSave_(U, name, sheets, f) {
  const tok = _sysAdmin.token, cnt = function (r) { return '새로 ' + r.added + ' · 바뀜 ' + r.changed + ' · 같음 ' + r.unchanged; };
  const need = function (r) { if (!r || !r.ok) throw new Error((r && r.msg) || '저장하지 못했습니다'); return r; };
  const md = function (d) { return d ? +String(d).slice(5, 7) + '/' + +String(d).slice(8, 10) : ''; };
  if (U.kind === 'wk') {
    const P = U.P;
    // 주차: 제목의 WKnn · 연도: 파일 이름의 날짜 — 둘 다 읽혔을 때만 자동 저장 (연말·연초에 연도가 틀리지 않게)
    const title = sheets.map(function (sh) { return sh.rows.slice(0, 12).map(function (r) { return (r || []).join(' '); }).join(' '); }).join(' ');
    if (!/WK\s*\d{1,2}/i.test(title) || !/20\d{6}/.test(String(name))) return { status: MAIL_ST.HOLD, period: 'WK' + P.wk, detail: '주차 · 연도를 분명히 읽지 못했습니다. 관리자앱에서 직접 올려 주세요.' };
    const rows = P.rows.map(function (r) { return Object.assign({}, r, { year: P.year, perf: r.perf === '' ? '' : String(r.perf), ret: r.ret === '' ? '' : String(r.ret) }); });
    const r = need(adm_perfSave(tok, { year: P.year, wk: P.wk, file: name, rows: rows }));
    const L = P.rows.filter(function (x) { return x.wk === P.wk; }), bad = L.filter(function (x) { return /^[34]$/.test(String(x.grade).replace(/\D/g, '')); }).length;
    return { status: MAIL_ST.SAVED, period: P.year + '년 WK' + P.wk, detail: '라우트 ' + L.length + ' · 3~4등급 ' + bad + ' · ' + cnt(r) };
  }
  if (U.kind === 'st') {
    // 쿠팡 정산서: 관리자앱 [드라이브에서 가져오기] 와 같은 순서 (정산월 = 배송일이 가장 많은 달 · 차수 = 마지막 + 1 · 마감된 달은 건너뜀)
    const P = U.P, month = P.month, won = function (n) { return Math.round(n).toLocaleString('ko-KR'); };
    const day = +(String(f.date || '').match(/^\d{4}-\d{2}-(\d{2})/) || [0, 0])[1] || +todayText_().slice(8, 10);
    const sum = '배송일 ' + P.from + '~' + P.to + ' · ' + P.raw.length + '줄 · ID ' + P.ids + ' · 공급가 ' + won(P.total);
    if (!month) return { status: MAIL_ST.HOLD, period: '', detail: '정산월을 읽지 못했습니다. 정산관리에서 직접 올려 주세요. (' + sum + ')' };
    const pd = +month.slice(0, 4) + '년 ' + +month.slice(5, 7) + '월';
    if (!(day >= MAIL_STL_FROM || day <= MAIL_STL_TO)) return { status: MAIL_ST.HOLD, period: pd, detail: '정산서 자동 반영 기간(' + MAIL_STL_FROM + '일 ~ 다음 달 ' + MAIL_STL_TO + '일) 밖에 온 메일이라 반영하지 않았습니다. 필요하면 정산관리에서 직접 올려 주세요. (' + sum + ')' };
    const sig = sha256b64_(JSON.stringify([P.raw, P.loss])).slice(0, 16);
    if (readAll_(SH.MAILLOG).some(function (o) { return o.kind === MAIL_KIND.st && o.status === MAIL_ST.SAVED && String(o.detail).indexOf('#' + sig) >= 0; })) return { status: '이미 처리', period: pd, detail: '앞서 반영한 정산서와 내용이 같아 다시 반영하지 않았습니다.' };
    const ri = need(adm_stlRoundInfo(tok, month));
    if (ri.closed && !ri.legacy) return { status: MAIL_ST.HOLD, period: pd, detail: '이미 마감된 달이라 반영하지 않았습니다. (' + sum + ')' };
    const round = Math.min(9, (ri.latest || 0) + 1);
    const sv = need(adm_stlSaveFile(tok, month, round, name, String(f.b64)));
    const r = need(adm_stlImport(tok, { month: month, round: round, file: sv.name, url: sv.url, raw: P.raw, loss: P.loss, legacy: !!ri.legacy }));
    return { status: MAIL_ST.SAVED, period: pd + ' ' + round + '차', detail: (r.legacy ? '쿠팡 매출만 반영 (기존 정산 이식 달) · ' : '') + sum + (P.loss.length ? ' · 분실파손 ' + P.loss.length + '줄 ' + won(P.lossAmt) + '원' : '') + (r.changed ? ' · 변동 ID ' + r.changed : '') + (r.newIds && r.newIds.length ? ' · 새 아이디 ' + r.newIds.length + '개 (아이디 관리에서 확인)' : '') + ' #' + sig };
  }
  if (U.kind === 'sla') {
    const out = [];
    U.blocks.forEach(function (B) { const r = need(adm_slaSave(tok, { from: B.from, to: B.to, file: name, vendor: B.vendor, rows: B.rows })); out.push('~' + md(r.period || B.to) + ' ' + cnt(r)); });
    return { status: MAIL_ST.SAVED, period: U.blocks.map(function (B) { return (B.from ? md(B.from) : '') + '~' + md(B.to); }).join(', '), detail: out.join(' / ') };
  }
  if (U.kind === 'fb') {
    const r = need(adm_fbSave(tok, { file: name, blocks: U.blocks.map(function (x) { return { kind: x.kind, from: x.from, to: x.to, date: x.date, rows: x.rows }; }) }));
    return { status: MAIL_ST.SAVED, period: U.blocks.map(function (b) { return b.kind + ' ' + (b.kind === '일별' ? md(b.date) : md(b.from) + '~' + md(b.to)); }).join(', '), detail: cnt(r) + (r.skippedOld ? ' · 더 최신 자료가 있어 건너뜀 ' + r.skippedOld : '') };
  }
  const P = U.P, ym = P.ym, rows = [];
  P.rows.forEach(function (r) { P.days.forEach(function (x, i) { if (r.q[i] != null) rows.push({ wave: r.wave, camp: r.camp, code: r.code, date: MailParse_.pkDate(ym, x), qty: r.q[i] }); }); });
  const last = MailParse_.pkDate(ym, P.days[P.days.length - 1]);
  let had = false; try { had = pkPeriods_(pkAll_()).some(function (p) { return p.period === ym; }); } catch (e) { had = false; }
  const push = !had && pkSettings_().drvOn && last >= todayText_(); // 손으로 올릴 때의 기본값과 같은 규칙
  const r = need(adm_peakSave(tok, { file: name, period: ym, rows: rows, push: push }));
  return { status: MAIL_ST.SAVED, period: +ym.slice(5, 7) + '월 (' + md(MailParse_.pkDate(ym, P.days[0])) + '~' + md(last) + ')', detail: cnt(r) + (push ? ' · 기사 알림 ' + (r.pushed || 0) + '건' : '') };
}

function mailLog_(o) {
  const lock = scriptLock_();
  lock.waitLock(20000);
  try { appendObj_(SH.MAILLOG, o); } finally { lock.releaseLock(); }
}

/**
 * 수집기 → 올인원: 메일 첨부 하나. f = { name, b64, from, subject, date, msgId }
 * → { ok, status, kind, period, detail } · 다시 보내면 안 되는 결과(저장 · 확인 필요 · 쿠팡 파일 아님 · 이미 처리)는 ok: true
 */
function api_mailFile(key, f) {
  return run_(function () {
    const cfg = mailCfg_();
    if (!cfg.hash || !key || sha256b64_(String(key)) !== cfg.hash) return { ok: false, code: 'KEY', msg: '수집 키가 맞지 않습니다.' };
    if (!cfg.on) return { ok: false, code: 'OFF', msg: '자동 수집이 꺼져 있습니다.' };
    f = f || {};
    const name = str_(f.name).slice(0, 120), msgId = str_(f.msgId).slice(0, 80);
    if (!/\.xlsx$/i.test(name) || !f.b64) return { ok: true, status: MAIL_ST.SKIP };
    if (String(f.b64).length > 14000000) return { ok: true, status: MAIL_ST.SKIP, detail: '파일이 너무 큽니다' };
    if (msgId && readAll_(SH.MAILLOG).some(function (o) { return o.msgId === msgId && o.file === name && o.status !== MAIL_ST.FAIL; })) return { ok: true, status: '이미 처리', dup: true };
    const base = { at: nowText_(), from: str_(f.from).slice(0, 120), subject: str_(f.subject).slice(0, 160), mailAt: str_(f.date).slice(0, 30), file: name, msgId: msgId };
    let U = null, sheets = null;
    try { sheets = mailXlsx_(Utilities.base64Decode(String(f.b64))); U = mailDetect_(sheets, name); }
    catch (e) { mailLog_(Object.assign(base, { status: MAIL_ST.SKIP, detail: String(e && e.message || e).slice(0, 200) })); return { ok: true, status: MAIL_ST.SKIP }; }
    if (!U) { mailLog_(Object.assign(base, { status: MAIL_ST.SKIP })); return { ok: true, status: MAIL_ST.SKIP }; }
    _sysAdmin = { token: '\u0000sys' + Utilities.getUuid(), a: { name: '메일 자동수집', loginId: 'mail', status: AST.ACTIVE } };
    try {
      const r = mailSave_(U, name, sheets, f);
      mailLog_(Object.assign(base, { kind: MAIL_KIND[U.kind], status: r.status, period: r.period, detail: r.detail }));
      return { ok: true, status: r.status, kind: MAIL_KIND[U.kind], period: r.period, detail: r.detail };
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 200);
      mailLog_(Object.assign(base, { kind: MAIL_KIND[U.kind], status: MAIL_ST.FAIL, detail: msg }));
      return { ok: false, status: MAIL_ST.FAIL, msg: msg }; // 수집기가 다음 번에 다시 보냄
    } finally { _sysAdmin = null; }
  });
}

/** 수집기 → 올인원: '살아 있음' 신호 (새 메일이 없어도 30분에 한 번) → 화면에 '수집기 마지막 확인 시각' */
function api_mailPing(key) {
  return run_(function () {
    const cfg = mailCfg_();
    if (!cfg.hash || !key || sha256b64_(String(key)) !== cfg.hash) return { ok: false, code: 'KEY', msg: '수집 키가 맞지 않습니다.' };
    PropertiesService.getScriptProperties().setProperty('MAIL_PING', nowText_()); _props = null;
    return { ok: true, on: cfg.on };
  });
}
/** 관리자: 자동 수집 상태 + 최근 기록 */
function adm_mailStatus(token) {
  return run_(function () {
    requireAdmin_(token);
    const cfg = mailCfg_();
    let rows = [];
    try { rows = readAll_(SH.MAILLOG).filter(function (o) { return o.at; }).slice(-200).reverse().map(function (o) { return { at: o.at, from: o.from, subject: o.subject, mailAt: o.mailAt, file: o.file, kind: o.kind, status: o.status, period: o.period, detail: o.detail }; }); } catch (e) { rows = []; }
    return { ok: true, hasKey: !!cfg.hash, on: cfg.on, ping: cfg.ping, now: nowText_(), rows: rows };
  });
}
/** 관리자: 수집 키 새로 만들기 (예전 키는 바로 못 쓰게 됨) → { ok, key } · 키는 이때 한 번만 보여 준다 */
function adm_mailKeyNew(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const p = PropertiesService.getScriptProperties();
    p.setProperty('MAIL_KEY_HASH', sha256b64_(key)); if (p.getProperty('MAIL_ON') == null) p.setProperty('MAIL_ON', '1');
    _props = null;
    logAdmin_(a, '메일 자동 수집 키 새로 만듦', '', '');
    return { ok: true, key: key };
  });
}
/** 관리자: 자동 수집 켜기 · 끄기 */
function adm_mailSet(token, on) {
  return run_(function () {
    const a = requireAdmin_(token);
    PropertiesService.getScriptProperties().setProperty('MAIL_ON', on ? '1' : '0'); _props = null;
    logAdmin_(a, '메일 자동 수집 ' + (on ? '켬' : '끔'), '', '');
    return { ok: true, on: !!on };
  });
}
