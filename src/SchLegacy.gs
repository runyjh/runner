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
