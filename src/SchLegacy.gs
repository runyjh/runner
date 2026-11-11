// ───────────────────────── 기존 운영시트 스케줄 이식 (한 번 쓰는 기능) ─────────────────────────
// 화면(기사스케줄 → '기존 스케줄 이식')에서 고른 JSON 파일을 받아:
//  1) 기사스케줄 칸을 모두 지우고(품앗이 줄은 남김) 기존 스케줄 칸으로 채움 — 없는 기사 줄(퇴사자 등)은 새로 만듦
//  2) 비고 글은 업무스케줄(work_memo) 메모로 추가 (같은 날짜·같은 글이 이미 있으면 건너뜀)
//  3) 이슈 관리(issues 탭)에 자동 추출 이슈 추가 (작성자 '기존 스케줄 이식' · 다시 올리면 예전 이식분을 지우고 다시 넣음)
// data = { kind:'runner-legacy-schedule', from, to, rows:[{id,camp,name,base,cells:{날짜:글자}}], memos:[{date,content,cat}], issues:[{date,driverId,name,kind,reason,action,mi,miDays}] }
const SCH_LEGACY_BY = '기존 스케줄 이식';

function schLegacyCheck_(data) {
  if (!data || data.kind !== 'runner-legacy-schedule' || !Array.isArray(data.rows)) fail_('기존 스케줄 이식 파일이 아닙니다.');
  if (!parseYmd_(data.from) || !parseYmd_(data.to)) fail_('파일의 기간을 확인해 주세요.');
  const drv = {};
  readAll_(SH.DRIVERS).forEach(function (d) { if (d.id) drv[d.id] = d; });
  const bad = data.rows.filter(function (r) { return !drv[str_(r.id)]; }).map(function (r) { return r.name || r.id; });
  if (bad.length) fail_('기사 정보에 없는 기사가 있습니다: ' + bad.slice(0, 10).join(', '));
  return drv;
}
function adm_schLegacyImport(token, data, apply) {
  return run_(function () {
    const a = requireAdmin_(token);
    schLegacyCheck_(data);
    const from = ymd_(parseYmd_(data.from)), to = ymd_(parseYmd_(data.to));
    const h0 = schEnsureDates_(parseYmd_(from), parseYmd_(to));
    const sh = schSheet_();
    const read = function (h) {
      const last = sh.getLastRow();
      const fixed = last >= 2 ? sh.getRange(2, 1, last - 1, 5).getValues() : [];
      return { last: last, fixed: fixed, idx: fixed.reduce(function (m, f, i) { const id = str_(f[h.fixed['행ID']]); if (id && m[id] === undefined) m[id] = i; return m; }, {}) };
    };
    const cols = Object.keys(h0.dates).map(function (d) { return h0.dates[d]; });
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    let cur = read(h0);
    const isPm = function (f) { return str_(f[h0.fixed['구분']]) === SCH.KIND_PM; };
    // 지금 칸 수 (지울 칸)
    let wipe = 0;
    if (cur.last >= 2) {
      const blk = sh.getRange(2, c0 + 1, cur.last - 1, c1 - c0 + 1).getValues();
      blk.forEach(function (r, i) { if (isPm(cur.fixed[i])) return; r.forEach(function (v) { if (str_(v)) wipe++; }); });
    }
    const newRows = data.rows.filter(function (r) { return cur.idx[str_(r.id)] === undefined; });
    const cellN = data.rows.reduce(function (n, r) { return n + Object.keys(r.cells || {}).length; }, 0);
    const memos = readAll_(SH.MEMO);
    const have = {};
    memos.forEach(function (m) { have[m.date + '|' + str_(m.content).trim()] = 1; });
    const addMemos = (data.memos || []).filter(function (m) { return parseYmd_(m.date) && str_(m.content).trim() && !have[ymd_(parseYmd_(m.date)) + '|' + str_(m.content).trim()]; });
    const oldIss = schIssues_().filter(function (x) { return x.by === SCH_LEGACY_BY; });
    const issues = Array.isArray(data.issues) ? data.issues : [];
    const preview = { from: from, to: to, rows: data.rows.length, newRows: newRows.map(function (r) { return r.name; }), cells: cellN, wipe: wipe, memos: addMemos.length, issues: issues.length, oldIssues: oldIss.length };
    if (!apply) return { ok: true, preview: preview };

    fsMark_('sch', { by: a.loginId });
    const lock = scriptLock_();
    lock.waitLock(30000);
    try {
      // 1) 없는 기사 줄 추가
      if (newRows.length) {
        const lines = newRows.map(function (r) {
          const line = new Array(5).fill('');
          line[h0.fixed['행ID']] = str_(r.id); line[h0.fixed['구분']] = SCH.KIND_DRIVER; line[h0.fixed['캠프']] = str_(r.camp);
          line[h0.fixed['이름']] = str_(r.name); line[h0.fixed['기본노선']] = str_(r.base);
          return line.map(safeText_);
        });
        sh.getRange(sh.getLastRow() + 1, 1, lines.length, 5).setNumberFormat('@').setValues(lines);
      }
      const h = schHeader_(true);
      cur = read(h);
      // 2) 칸: 품앗이 줄만 남기고 모두 지운 뒤 채움
      const n = cur.last - 1;
      const blk = sh.getRange(2, c0 + 1, n, c1 - c0 + 1).getValues();
      blk.forEach(function (r, i) { if (isPm(cur.fixed[i])) return; for (let j = 0; j < r.length; j++) r[j] = ''; });
      let put = 0;
      data.rows.forEach(function (r) {
        const i = cur.idx[str_(r.id)];
        if (i === undefined) return;
        Object.keys(r.cells || {}).forEach(function (d) {
          const c = h.dates[d];
          if (c === undefined || d < from || d > to) return;
          blk[i][c - c0] = safeText_(str_(r.cells[d]).slice(0, SCH_MAX_TEXT)); put++;
        });
      });
      sh.getRange(2, c0 + 1, n, c1 - c0 + 1).setNumberFormat('@').setValues(blk);
      // 3) 비고 → 업무스케줄 메모
      const now = nowText_();
      if (addMemos.length) appendObjs_(SH.MEMO, addMemos.map(function (m) {
        return { id: newMemoId_(), date: ymd_(parseYmd_(m.date)), time: '', content: str_(m.content).slice(0, 2000), done: '', cat: str_(m.cat), author: SCH_NOTE_AUTHOR, createdAt: now, updatedAt: now };
      }));
      // 4) 이슈: 예전 이식분 지우고 다시
      const ish = schIssueSheet_();
      schIssueHeadFix_(ish);
      oldIss.map(function (x) { return x.row; }).sort(function (p, q) { return q - p; }).forEach(function (r) { ish.deleteRow(r); });
      if (issues.length) {
        const head = ish.getRange(1, 1, 1, ish.getLastColumn()).getValues()[0].map(str_);
        const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss');
        const rows = issues.map(function (x, k) {
          const mi = !!x.mi, days = mi ? Math.max(1, Math.min(365, parseInt(x.miDays, 10) || 1)) : 0;
          const v = { '이슈ID': 'IL' + stamp + ('000' + k).slice(-4), '날짜': ymd_(parseYmd_(x.date) || new Date()), '기사ID': str_(x.driverId), '이름': str_(x.name), '구분': str_(x.kind) || '미분류',
            '사유': str_(x.reason).slice(0, 200), '조치': str_(x.action).slice(0, 200), '작성자': SCH_LEGACY_BY, '작성일시': now, '미입차': mi ? 'Y' : '', '미입차일수': mi ? String(days) : '' };
          return head.map(function (hh) { return v.hasOwnProperty(hh) ? safeText_(v[hh]) : ''; });
        });
        ish.getRange(ish.getLastRow() + 1, 1, rows.length, head.length).setNumberFormat('@').setValues(rows);
      }
      SpreadsheetApp.flush();
      cache_().remove('sch:h');
      logAdmin_(a, '기존 스케줄 이식', from + ' ~ ' + to, '칸 ' + put + ' (지운 칸 ' + wipe + ') · 새 줄 ' + newRows.length + ' · 메모 ' + addMemos.length + ' · 이슈 ' + issues.length);
      return { ok: true, preview: preview, put: put };
    } finally { lock.releaseLock(); }
  });
}

// ───────────────────────── 기존 운영시트 스케줄 가져오기 (병행 기간용 · 누를 때마다) ─────────────────────────
// 기존 운영시트(뉴버전_운영시트 '스케쥴' 탭 · 지금 보이는 2주)를 직접 읽어 올인원 규칙으로 바꾼 뒤, 올인원과 다른 칸만 반영한다.
//  · 기존 시트가 빈 칸(또는 '-', '퇴사')이면 올인원 칸을 건드리지 않음 · 품앗이 줄·지시사항·이슈가 걸린 칸은 건드리지 않음
//  · 저장은 adm_schSave 로 (이슈 자동 연동·품앗이 잠금·실시간 알림이 그대로 동작)
//  · 올인원이 완성되면 이 기능과 기존 시트는 쓰지 않는다
const SCH_LEGACY_SHEET_ID = '1UwnMcMaS5iNwLO_n1BDkDgEnK-ru1N-HZFXhzUhAZQc', SCH_LEGACY_TAB = '스케쥴';

/** 기존 표기 한 칸 → { v: 올인원 값, kind: same(그대로) / conv(바꿈) / need(확인 필요) / skip(빈 칸 취급), why } */
function schLegacyConv_(raw, base, ownCamp) {
  const r0 = str_(raw).replace(/\r?\n/g, ' ').trim();
  let s = r0.replace(/\s+/g, ' ');
  // 소속 캠프 이름이 앞에 붙은 것은 뗀다 (올인원 저장 규칙: 소속 캠프 노선은 캠프 이름 없이)
  if (ownCamp) { const mc = s.match(/^([가-힣]+)\s?(\d+)\s+(?=\d)/); if (mc && mc[1] + mc[2] === String(ownCamp).replace(/\s/g, '')) s = s.slice(mc[0].length); }
  if (!s || s === '-' || s === '퇴사') return { v: '', kind: 'skip' };
  if (/^계획된\s*휴무$/.test(s)) return { v: '추가휴무', kind: 'conv' };
  if (['출근', '휴무', '고정휴무', '추가휴무', '병가', '휴가', '미입차', '노쇼', '용차'].indexOf(s) >= 0) return { v: s, kind: 'same' };
  // 품앗이 표기: 받은 쪽 '품앗이_103AB' = 그 노선을 뜀 → 노선으로 · 맡긴 쪽 '품앗이_김창호' = 그날 내 노선은 그 기사가 뜀 → 휴무 · 상대가 안 적힌 '품앗이' 는 알 수 없어 확인 필요
  //  (품앗이 정산·단가는 옮기지 않는다 — 필요하면 올인원에서 품앗이로 등록)
  if (/^품앗이/.test(s)) {
    const rest = s.replace(/^품앗이[\s_·:\-]*/, '').trim();
    if (!rest) return { v: '', kind: 'need', why: '품앗이 상대가 적혀 있지 않습니다 — 올인원에서 품앗이로 등록해 주세요' };
    if (/^(?:[가-힣]+\s?\d+\s+)?\d{3,4}[A-Za-z]/.test(rest)) { const r2 = schLegacyConv_(rest, base, ownCamp); return r2.kind === 'need' || r2.kind === 'skip' ? { v: '', kind: 'need', why: '품앗이 노선을 읽을 수 없습니다' } : { v: r2.v, kind: 'conv' }; }
    if (/^[가-힣A-Za-z() ]{2,20}$/.test(rest)) return { v: '휴무', kind: 'conv' };
    return { v: '', kind: 'need', why: '품앗이 표기를 읽을 수 없습니다' };
  }
  if (/용차/.test(s)) return { v: '', kind: 'need', why: '용차 표기가 섞여 있어 누가 뛰었는지 알 수 없습니다 (용차면 상태를 용차로)' };
  // (아이디) 업무등록 · 출근 (아이디) 업무등록 = 담당 노선을 그 아이디로
  let m = s.match(/^(?:출근\s*)?\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)\s*업무등록$/);
  if (m) {
    const b = /^\d/.test(str_(base)) ? str_(base).replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim() : '';
    return b ? { v: b + ' (' + m[1] + ') 업무등록', kind: 'conv' } : { v: '', kind: 'need', why: '담당 노선이 없어 어느 노선인지 알 수 없습니다' };
  }
  // 408AB (408A D1) = 408A 는 D1 만, 나머지는 전체
  m = s.match(/^(\d{3,4})([A-Za-z]+)\s*\(\s*(\d{3,4})([A-Za-z])\s+([DF]\d(?:\s*,\s*[DF]\d)*)\s*\)$/);
  if (m && m[1] === m[3] && m[2].toUpperCase().indexOf(m[4].toUpperCase()) >= 0) {
    const rest = m[2].toUpperCase().split('').filter(function (ch) { return ch !== m[4].toUpperCase(); }).join('');
    return { v: m[1] + m[4].toUpperCase() + '(' + m[5].replace(/\s+/g, '').toUpperCase() + ')' + (rest ? ',' + m[1] + rest : ''), kind: 'conv' };
  }
  if (s.indexOf('추가업무등록') >= 0) return { v: s, kind: s === r0 ? 'same' : 'conv' };
  // 읽을 수 있는 노선 값인지: [표] · (회전) · (아이디) · 업무등록 · 노선/라우트 변경 · 앞의 캠프 이름을 걷어 내고 남는 글자가 노선뿐이어야 함
  const rest = s.replace(/\[[^\]]*\]/g, ' ').replace(/\(\s*[DF]\d(?:\s*,\s*[DF]\d)*\s*\)/gi, ' ').replace(/\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)/g, ' ')
    .replace(/추가업무등록|업무등록/g, ' ').replace(/(노선|라우트)\s*변경(됨)?/g, ' ').replace(/^\s*[가-힣]+\s?\d+\s+/, ' ').replace(/\s+/g, '');
  if (rest && /^\d{3,4}[A-Za-z][0-9A-Za-z,]*$/.test(rest) && issUnits_(s.replace(/(노선|라우트)\s*변경(됨)?/g, ' '), ROTS.slice())) return { v: s, kind: s === r0 ? 'same' : 'conv' };
  return { v: '', kind: 'need', why: '올인원 규칙으로 읽을 수 없는 글자입니다 (메모는 지시사항에 적어 주세요)' };
}

/** 칸 글자의 뜻 (비교용): 상태는 그 글자, 노선은 캠프 · 노선별 회전 · 아이디 — '출근' 과 담당 노선을 적은 칸, 캠프 이름을 붙인 칸은 같은 뜻 */
function schLegacyMean_(v, cx) {
  const s = str_(v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^(휴무|고정휴무|추가휴무|병가|휴가|미입차|노쇼|용차)$/.test(s)) return 'S:' + s;
  if (/추가업무등록/.test(s)) return 'X:' + s;
  const ids = []; s.replace(/\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)/g, function (m0, id) { if (!/^[DF]\d$/i.test(id)) ids.push(id.toLowerCase()); return m0; });
  const body = s.replace(/\(\s*[A-Za-z][A-Za-z0-9_.]{2,}\s*\)/g, function (m0) { return /^\(\s*[DF]\d\s*\)$/i.test(m0) ? m0 : ' '; }).replace(/업무등록/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/(노선|라우트)\s*변경(됨)?/g, ' ').replace(/\s+/g, ' ').trim();
  const u = !body || body === '출근' ? issUnits_(cx.base, cx.rots) : issUnits_(body, cx.rots);
  if (!u) return 'R:' + s;
  const camp = u.camp || cx.camp;
  return 'W:' + camp + '|' + Object.keys(u.units).sort().map(function (k) { return k + ':' + u.units[k].slice().sort().join(''); }).join(',') + '|' + ids.sort().join(',');
}

/** 기존 시트 '스케쥴' 탭 → { from, to, dates[], rows: [{ camp, name, login, base, cells: { 날짜: 글자 } }] } */
function schLegacyRead_() {
  let book;
  try { book = SpreadsheetApp.openById(props_().SCH_LEGACY_ID || SCH_LEGACY_SHEET_ID); } catch (e) { fail_('기존 운영시트를 열 수 없습니다. 올인원을 배포한 구글 계정에 그 시트 보기 권한이 있는지 확인해 주세요.'); }
  const sh = book.getSheetByName(SCH_LEGACY_TAB);
  if (!sh) fail_("기존 운영시트에 '" + SCH_LEGACY_TAB + "' 탭이 없습니다.");
  const last = Math.min(sh.getLastRow(), 400), w = Math.min(sh.getLastColumn(), 60);
  if (last < 2) fail_('기존 스케줄이 비어 있습니다.');
  const vals = sh.getRange(1, 1, last, w).getDisplayValues();
  let hr = -1, c0 = -1;
  for (let i = 0; i < Math.min(vals.length, 40) && hr < 0; i++) { const j = vals[i].indexOf('캠프명'); if (j >= 0) { hr = i; c0 = j; } }
  if (hr < 0) fail_("기존 스케줄에서 머리글('캠프명')을 찾지 못했습니다.");
  const dcols = [];
  vals[hr].forEach(function (t, j) { const m = str_(t).match(/^(\d{4}-\d{2}-\d{2})/); if (m && j > c0 + 3) dcols.push({ j: j, d: m[1] }); });
  if (!dcols.length) fail_('기존 스케줄에서 날짜 머리글을 찾지 못했습니다.');
  const rows = [];
  for (let i = hr + 1; i < vals.length; i++) {
    const r = vals[i], camp = str_(r[c0]), name = str_(r[c0 + 1]), login = str_(r[c0 + 2]);
    if (/^비고/.test(camp)) break; // 비고 줄부터는 기사 줄이 아님
    if (!camp || !name || !login || name === '담당없음' || camp === '용차') continue;
    const cells = {};
    dcols.forEach(function (c) { const v = str_(r[c.j]); if (v) cells[c.d] = v; });
    rows.push({ camp: camp, name: name, login: login, base: str_(r[c0 + 3]), cells: cells });
  }
  const ds = dcols.map(function (c) { return c.d; }).sort();
  return { from: ds[0], to: ds[ds.length - 1], dates: ds, rows: rows };
}

/** apply = false: 미리 보기만 (무엇이 어떻게 바뀌는지) · true: 반영 */
function adm_schLegacyPull(token, apply) {
  const pre = run_(function () {
    const a = requireAdmin_(token);
    const L = schLegacyRead_();
    const h = schEnsureDates_(parseYmd_(L.from), parseYmd_(L.to));
    const sh = schSheet_(), last = sh.getLastRow();
    const ids = last >= 2 ? sh.getRange(2, h.fixed['행ID'] + 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); }) : [];
    const cols = L.dates.map(function (d) { return h.dates[d]; }), cMin = Math.min.apply(null, cols), cMax = Math.max.apply(null, cols);
    const blk = last >= 2 ? sh.getRange(2, cMin + 1, last - 1, cMax - cMin + 1).getValues() : [];
    const rowOf = {}; ids.forEach(function (id, i) { if (id && rowOf[id] === undefined) rowOf[id] = i; });
    const byLogin = {}, byName = {};
    readAll_(SH.DRIVERS).forEach(function (o) { if (!o.id) return; if (o.loginId) byLogin[stlLogin_(o.loginId)] = o; (byName[str_(o.name)] = byName[str_(o.name)] || []).push(o); });
    const issues = schIssues_().filter(function (x) { return x.link === 'Y' && x.result && x.kind !== '지시'; });
    const underIssue = function (id, d) { return issues.some(function (x) { return x.driverId === id && x.date <= d && d <= (x.end || x.date); }); };
    const ctxOf = issCtxMaker_();
    const out = { from: L.from, to: L.to, drivers: 0, total: 0, same: 0, write: [], conv: 0, need: [], kept: [], noDriver: [] };
    // 1) 기존 시트 칸 → 올인원 값 (기사 · 날짜별)
    const ent = [], has = {}; // has[기사ID|날짜] = 기존 시트에 그 기사 본인 줄의 값이 있음
    L.rows.forEach(function (r) {
      const o = byLogin[stlLogin_(r.login)] || ((byName[r.name] || []).length === 1 ? byName[r.name][0] : null);
      if (!o) { if (Object.keys(r.cells).length) out.noDriver.push(r.name + ' (' + r.login + ')'); return; }
      out.drivers++;
      Object.keys(r.cells).forEach(function (d) {
        if (h.dates[d] === undefined) return;
        const cx = ctxOf(o, d);
        // 기존 시트의 소속 캠프가 올인원과 다른 기사(백업 등): 캠프 이름 없이 적힌 노선·출근은 기존 시트 캠프의 노선이므로 캠프 이름을 붙여 넣는다
        const lc = str_(r.camp).replace(/\s*캠프\s*$/, '').replace(/\s/g, ''), diff = /^[가-힣]+\d+$/.test(lc) && lc !== String(cx.camp || '').replace(/\s/g, '');
        let cv = schLegacyConv_(r.cells[d], diff ? r.base : (cx.base || r.base), diff ? lc : cx.camp);
        if (diff && (cv.kind === 'same' || cv.kind === 'conv')) {
          if (cv.v === '출근') cv = /^\d/.test(r.base) ? { v: lc + ' ' + r.base, kind: 'conv' } : { v: '', kind: 'need', why: '소속 캠프가 올인원과 달라 어느 노선인지 알 수 없습니다' };
          else if (/^\d/.test(cv.v)) cv = { v: lc + ' ' + cv.v, kind: 'conv' };
        }
        if (cv.kind === 'skip') return;
        ent.push({ o: o, d: d, raw: r.cells[d], cv: cv, cx: cx });
        has[o.id + '|' + d] = 1;
      });
    });
    // 2) '노선 (아이디) 업무등록' 인데 그 아이디의 주인이 올인원에서 자기 줄·담당 노선이 있는 기사면 (예: 정유정 줄의 dasom1125 = 이윤형)
    //    → 그 기사 줄에 적고(담당 노선이면 출근), 줄 주인은 휴무 — 같은 일을 두 줄에 적어 '중복'이 되지 않게 (올인원 규칙: 칸 = 그 사람이 한 일)
    ent.slice().forEach(function (e) {
      if (e.cv.kind === 'need') return;
      const m = e.cv.v.match(/^(.*?)\s*\(\s*([A-Za-z][A-Za-z0-9_.]{2,})\s*\)\s*업무등록$/);
      if (!m || !m[1]) return;
      const alt = byLogin[stlLogin_(m[2])];
      if (!alt || alt.id === e.o.id || alt.status !== ST.ACTIVE || !alt.schCampId || rowOf[alt.id] === undefined || has[alt.id + '|' + e.d]) return;
      const ax = ctxOf(alt, e.d);
      if (!/^\d/.test(str_(ax.base))) return; // 담당 노선이 없는 사람(백업·서브 전용 아이디)은 지금처럼 줄 주인 칸에 아이디로 남김
      const u = issUnits_(m[1], e.cx.rots); if (!u) return;
      const camp = u.camp || e.cx.camp, text = issCompose_(u.units, ax.rots, camp !== ax.camp ? camp : '');
      const v = schLegacyMean_(text, ax) === schLegacyMean_('출근', ax) ? '출근' : text;
      ent.push({ o: alt, d: e.d, raw: e.raw + ' (' + e.o.name + ' 줄)', cv: { v: v, kind: 'conv' }, cx: ax });
      has[alt.id + '|' + e.d] = 1;
      e.cv = { v: '휴무', kind: 'conv' };
    });
    // 3) 회전을 나눠 뛰는 날: 다른 기사가 내 담당 노선의 일부 회전만 맡았으면 (예: 민경진 205C (D2,F3)) 내 '출근'에서 그 회전을 뺀다 (205C(D1),205D) — 통째로 겹치는 건 그대로 두어 중복으로 보이게 함
    const part = {}; // 날짜|캠프|노선 → [{ id, rots }]
    ent.forEach(function (e) {
      if (e.cv.kind === 'need' || !/\d{3}/.test(e.cv.v)) return;
      const u = issUnits_(e.cv.v, e.cx.rots); if (!u) return;
      const camp = u.camp || e.cx.camp;
      Object.keys(u.units).forEach(function (rt) { if (u.units[rt].length < e.cx.rots.length) (part[e.d + '|' + camp + '|' + rt] = part[e.d + '|' + camp + '|' + rt] || []).push({ id: e.o.id, rots: u.units[rt] }); });
    });
    ent.forEach(function (e) {
      if (e.cv.kind === 'need' || e.cv.v !== '출근') return;
      const b = issUnits_(e.cx.base, e.cx.rots); if (!b) return;
      let cut = false; const left = {};
      Object.keys(b.units).forEach(function (rt) {
        const others = (part[e.d + '|' + e.cx.camp + '|' + rt] || []).filter(function (x) { return x.id !== e.o.id; });
        const gone = {}; others.forEach(function (x) { x.rots.forEach(function (r) { gone[r] = 1; }); });
        const keep = b.units[rt].filter(function (r) { return !gone[r]; });
        if (keep.length < b.units[rt].length) cut = true;
        if (keep.length) left[rt] = keep;
      });
      if (cut && Object.keys(left).length) e.cv = { v: issCompose_(left, e.cx.rots, ''), kind: 'conv' };
    });
    // 4) 올인원과 견주기
    ent.forEach(function (e) {
      const o = e.o, d = e.d, c = h.dates[d], cv = e.cv, cx = e.cx;
      out.total++;
      if (cv.kind === 'need') { out.need.push({ name: o.name, date: d, raw: e.raw, why: cv.why }); return; }
      const cur = rowOf[o.id] === undefined ? '' : str_(blk[rowOf[o.id]][c - cMin]); // 줄이 아직 없는 기사는 저장할 때 줄을 만든다
      if (cur === cv.v || (cur && schLegacyMean_(cur, cx) === schLegacyMean_(cv.v, cx))) { out.same++; return; } // 글자가 달라도 뜻이 같으면 그대로 둠 (출근 = 담당 노선)
      if (underIssue(o.id, d)) { out.kept.push({ name: o.name, date: d, raw: e.raw, cur: cur }); return; }
      if (cv.kind === 'conv') out.conv++;
      out.write.push({ row: o.id, name: o.name, date: d, raw: e.raw, value: cv.v, old: cur, conv: cv.kind === 'conv' });
    });
    return { ok: true, a: a, out: out };
  });
  if (!pre.ok) return pre;
  const out = pre.out, a = pre.a;
  const view = { from: out.from, to: out.to, drivers: out.drivers, total: out.total, same: out.same, write: out.write.length, conv: out.conv,
    writeList: out.write.slice(0, 80).map(function (x) { return { name: x.name, date: x.date, raw: x.raw, value: x.value, old: x.old, conv: x.conv }; }),
    need: out.need.slice(0, 80), needN: out.need.length, kept: out.kept.slice(0, 40), keptN: out.kept.length, noDriver: out.noDriver };
  if (!apply) return { ok: true, preview: view };
  if (!out.write.length) return { ok: true, preview: view, saved: 0, conflicts: [] };
  const r = adm_schSave(token, out.write.map(function (x) { return { row: x.row, date: x.date, value: x.value, old: x.old }; }));
  if (!r.ok) return r;
  try { logAdmin_(a, '기존 스케줄 가져오기', out.from + ' ~ ' + out.to, '반영 ' + r.saved + '칸 (표기 바꿈 ' + out.conv + ') · 확인 필요 ' + out.need.length + ' · 이슈 칸 유지 ' + out.kept.length); } catch (e) { /* 기록 실패는 무시 */ }
  return { ok: true, preview: view, saved: r.saved, conflicts: r.conflicts || [], issueSync: r.issueSync, pmLocked: r.pmLocked || [] };
}
