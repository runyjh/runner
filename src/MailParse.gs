/**
 * 쿠팡 파일 읽기 (서버용) — src/Admin.html 의 parsePerfSheet · parseSlaSheet · parseFbSheet · parsePeakSheet 와 같은 코드.
 * ※ 손으로 고치지 말 것. 파서를 고치면 scripts/gen-mailparse.py 를 다시 돌려 만든다.
 */
const MailParse_ = (function () {
  const normCode = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
  const shortCamp = (n) => String(n || '').replace(/\s*캠프\s*$/, '').trim();
  const rpCamp = (name) => shortCamp(name).replace(/\s/g, '');
  function parsePerfSheet(sheets, fileName) {
    const txt = (v) => (v == null ? '' : String(v)).trim();
    let best = null;
    for (const sh of sheets) {
      const hi = sh.rows.findIndex((r) => r && r.some((v) => /^wave$/i.test(txt(v))) && r.some((v) => /^camp$/i.test(txt(v))) && r.some((v) => /^route$/i.test(txt(v))));
      if (hi >= 0) { best = { sh, hi }; break; }
    }
    if (!best) throw new Error('Wave / Camp / Route 머리글이 있는 시트를 찾지 못했습니다. 쿠팡 수행률 안내 파일(.xlsx)인지 확인해 주세요.');
    const { sh, hi } = best, head = sh.rows[hi], grp = sh.rows[hi - 1] || [];
    const title = sh.rows.slice(0, hi).map((r) => (r || []).map(txt).join(' ')).join(' ');
    const tm = title.match(/WK\s*(\d{1,2})/i), fm = String(fileName || '').match(/(20\d{2})(\d{2})(\d{2})/);
    const wkTitle = tm ? +tm[1] : 0, year = fm ? +fm[1] : new Date().getFullYear();
    const ci = {}; head.forEach((v, i) => { const t = txt(v); if (/^wave$/i.test(t)) ci.wave = i; else if (/^camp$/i.test(t)) ci.camp = i; else if (/^route$/i.test(t)) ci.code = i; else if (/위탁\s*협의/.test(t)) ci.improve = i; else if (/배송\s*수행률\s*1/.test(t.replace(/\n/g, ''))) ci.f1 = i; else if (/^반품\s*수행률/.test(t.replace(/\n/g, ''))) ci.f2 = i; else if (/^인접/.test(t)) ci.f3 = i; else if (/^parcel$/i.test(t)) ci.parcel = i; else if (/zip/i.test(t)) ci.zip = i; });
    // WKnn 열: 바로 위 줄에서 왼쪽으로 가장 가까운 묶음 이름으로 종류 판단 (등급 / 수행률 / Return 등급 / Return 수행률)
    const wkCols = [];
    head.forEach((v, i) => {
      const m = txt(v).match(/^WK\s*(\d{1,2})$/i); if (!m) return;
      let g = ''; for (let j = i; j >= 0; j--) { if (txt(grp[j])) { g = txt(grp[j]); break; } }
      const ret = /return/i.test(g), grade = /등급/.test(g);
      wkCols.push({ i, wk: +m[1], kind: (ret ? 'ret' : 'perf') + (grade ? 'G' : '') });
    });
    if (!wkCols.length) throw new Error('WK 주차 열을 찾지 못했습니다.');
    const wks = [...new Set(wkCols.map((c) => c.wk))];
    const latest = wkTitle || Math.max(...wks);
    const rows = [];
    for (let r = hi + 1; r < sh.rows.length; r++) {
      const row = sh.rows[r] || []; const camp = txt(row[ci.camp]), code = txt(row[ci.code]);
      if (!camp || !code || !/\d/.test(code)) continue;
      wks.forEach((wk) => {
        const pick = (kind) => { const c = wkCols.find((x) => x.wk === wk && x.kind === kind); return c ? row[c.i] : ''; };
        const grade = pick('perfG'), perf = pick('perf');
        if (txt(grade) === '' && txt(perf) === '') return;
        const isLatest = wk === latest;
        rows.push({ wk, wave: txt(row[ci.wave]), camp, code, perf, grade, ret: pick('ret'), retGrade: pick('retG'),
          improve: isLatest ? txt(row[ci.improve]) : '', f1: isLatest ? txt(row[ci.f1]) : '', f2: isLatest ? txt(row[ci.f2]) : '', f3: isLatest ? txt(row[ci.f3]) : '',
          parcel: isLatest ? txt(row[ci.parcel]) : '', zip: isLatest ? txt(row[ci.zip]) : '', partial: !isLatest });
      });
    }
    return { wk: latest, year, wks: wks.sort((a, b) => a - b), rows, sheet: sh.name };
  }
  function parseSlaSheet(sheets) {
    const txt = (v) => (v == null ? '' : String(v)).trim();
    const toYmd = (v) => { const m = txt(v).match(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/); return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : ''; };
    const blocks = [];
    for (const sh of sheets) {
      const rows = sh.rows;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || [], ei = r.findIndex((v) => /data\s*end\s*date/i.test(txt(v)));
        if (ei < 0) continue;
        const to = toYmd(r[ei + 1]) || toYmd(r.slice(ei + 1).find((v) => txt(v)));
        let from = '';
        for (let k = Math.max(0, i - 3); k < i; k++) { const rr = rows[k] || [], si = rr.findIndex((v) => /data\s*start\s*date/i.test(txt(v))); if (si >= 0) from = toYmd(rr[si + 1]) || toYmd(rr.slice(si + 1).find((v) => txt(v))); }
        // 머리글: Category … Camp Route … Total
        let hi = -1;
        for (let k = i + 1; k < Math.min(rows.length, i + 6); k++) { const rr = rows[k] || []; if (rr.some((v) => /^category$/i.test(txt(v))) && rr.some((v) => /^route$/i.test(txt(v)))) { hi = k; break; } }
        if (hi < 0 || !to) continue;
        const h = rows[hi], ci = {};
        h.forEach((v, c) => { const t = txt(v).replace(/\s/g, ''); if (/^category$/i.test(t)) ci.cat = c; else if (/^wave$/i.test(t)) ci.wave = c; else if (/^camp$/i.test(t)) ci.camp = c; else if (/^route$/i.test(t)) ci.route = c; else if (/^type$/i.test(t)) ci.type = c;
          else if (/total/i.test(t)) ci.total = c; else if (/미수행/.test(t)) ci.miss = c; else if (/반품/.test(t)) ci.ret = c; else if (/고객만족/.test(t)) ci.cs = c; else if (/불만/.test(t)) ci.cx = c; });
        if (ci.total === undefined || ci.camp === undefined) continue;
        const B = { from, to, vendor: null, rows: [] };
        for (let k = hi + 1; k < rows.length; k++) {
          const rr = rows[k] || [], cat = txt(rr[ci.cat]);
          if (!cat) { if (rr.some((v) => /data\s*end\s*date|sla\s*score/i.test(txt(v)))) break; if (B.rows.length) break; continue; }
          const num = (c) => (c === undefined || rr[c] == null || rr[c] === '' ? '' : String(rr[c]));
          const sc = { total: num(ci.total), miss: num(ci.miss), ret: num(ci.ret), cs: num(ci.cs), cx: num(ci.cx) };
          if (/vendor/i.test(cat)) { B.vendor = sc; continue; }
          if (!/route/i.test(cat)) continue;
          B.rows.push(Object.assign({ wave: txt(rr[ci.wave]), cpCamp: txt(rr[ci.camp]), route: txt(rr[ci.route]), type: txt(rr[ci.type]) }, sc));
        }
        if (B.rows.length || B.vendor) blocks.push(B);
        i = hi;
      }
    }
    return blocks;
  }
  function parseFbSheet(sheets) {
    const txt = (v) => (v == null ? '' : String(v)).trim();
    const dt = (s) => { const m = String(s).match(/(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/); return m ? m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0') : ''; };
    const out = [];
    for (const sh of sheets) {
      const hi = sh.rows.findIndex((r) => r && r.some((v) => /^wave$/i.test(txt(v))) && r.some((v) => /^route$/i.test(txt(v))) && r.some((v) => /가중요인\s*1/.test(txt(v).replace(/\n/g, ''))));
      if (hi < 0) continue;
      const head = sh.rows[hi];
      // 제목 줄: 머리글 위쪽에서 'Title' 또는 날짜가 든 칸
      const titleRows = sh.rows.slice(Math.max(0, hi - 4), hi);
      head.forEach((v, c) => {
        if (!/^wave$/i.test(txt(v))) return;
        const camp = c + 1, route = c + 2;
        const pct1 = /%/.test(txt(head[c + 3]).replace(/\n/g, ''));
        const ci = pct1 ? { f1pct: c + 3, f1: c + 4, f2pct: c + 5, f2: c + 6 } : { f1: c + 3, f2: c + 4 };
        // 이 블록의 제목: 같은 열 묶음(c-2 ~ c+6) 안에서 날짜가 든 글자
        let title = '';
        titleRows.forEach((r) => { for (let j = Math.max(0, c - 2); j <= c + 6; j++) { const t = txt((r || [])[j]); if (/20\d{2}\s*[.\-\/]\s*\d{1,2}/.test(t) && /가중요인|해당/.test(t)) title = t; } });
        if (!title) titleRows.forEach((r) => { for (let j = Math.max(0, c - 2); j <= c + 6; j++) { const t = txt((r || [])[j]); if (/20\d{2}\s*[.\-\/]\s*\d{1,2}/.test(t)) title = title || t; } });
        if (!title) return;
        const dates = title.match(/20\d{2}\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d{1,2}/g) || [];
        const month = /월간/.test(title), range = dates.length >= 2;
        const kind = month ? '월간' : range ? '누적' : '일별';
        const b = { kind, title, from: range ? dt(dates[0]) : '', to: range ? dt(dates[1]) : dt(dates[0]), date: kind === '일별' ? dt(dates[0]) : '', rows: [] };
        for (let r = hi + 1; r < sh.rows.length; r++) {
          const row = sh.rows[r] || []; const cp = txt(row[camp]), code = txt(row[route]);
          if (!cp || !code || !/\d/.test(code)) continue;
          b.rows.push({ wave: txt(row[c]), camp: cp, code, f1pct: ci.f1pct !== undefined ? txt(row[ci.f1pct]) : '', f1: txt(row[ci.f1]), f2pct: ci.f2pct !== undefined ? txt(row[ci.f2pct]) : '', f2: txt(row[ci.f2]) });
        }
        if (b.rows.length) out.push(b);
      });
      if (out.length) break;
    }
    return out;
  }
  function parsePeakSheet(sheets, fileName) {
    const txt = (v) => String(v == null ? '' : v).trim(), isDay = (v) => /^\d{1,2}\s*[\/.]\s*\d{1,2}\s*(\([일월화수목금토]\))?$/.test(txt(v));
    for (const sh of sheets) {
      const hi = sh.rows.slice(0, 15).findIndex((r) => r && r.some((v) => /^route$/i.test(txt(v))) && r.some((v) => /^(캠프|camp)$/i.test(txt(v))) && r.filter(isDay).length >= 3 && !r.some((v) => /등급|수행률|가중요인/.test(txt(v))));
      if (hi < 0) continue;
      const H = sh.rows[hi], ci = { camp: H.findIndex((v) => /^(캠프|camp)$/i.test(txt(v))), code: H.findIndex((v) => /^route$/i.test(txt(v))), wave: H.findIndex((v) => /야간|주간|wave/i.test(txt(v))) };
      const dc = []; H.forEach((v, i) => { if (isDay(v)) { const m = txt(v).match(/^(\d{1,2})\s*[\/.]\s*(\d{1,2})/); dc.push({ i, m: +m[1], d: +m[2] }); } });
      const rows = []; let lastCamp = '';
      for (let r = hi + 1; r < sh.rows.length; r++) {
        const row = sh.rows[r] || [], camp = txt(row[ci.camp]) || lastCamp, code = txt(row[ci.code]);
        if (txt(row[ci.camp])) lastCamp = txt(row[ci.camp]);
        if (!camp || !code || !(/^total$/i.test(code) || /\d/.test(code))) continue;
        const q = dc.map((c) => { const n = Number(String(row[c.i] == null ? '' : row[c.i]).replace(/,/g, '')); return txt(row[c.i]) === '' || isNaN(n) ? null : Math.round(n); });
        if (q.every((x) => x == null)) continue;
        rows.push({ wave: ci.wave >= 0 ? txt(row[ci.wave]) : '', camp: rpCamp(camp), code: /^total$/i.test(code) ? 'Total' : normCode(code).replace(/[^0-9A-Z]/g, ''), q });
      }
      if (!rows.length) continue;
      const fn = String(fileName || ''), now = new Date();
      const fm = fn.match(/(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(?:\d{2})?(?!\d)/) || fn.match(/(?:^|\D)(20\d{2})\D{1,2}(0?[1-9]|1[0-2])(?!\d)/);
      const near = (a, b) => { const d = Math.abs(a - b); return d <= 1 || d === 11; }; // 파일 이름의 월과 머리글 첫 날짜의 월이 같거나 이웃한 달일 때만 믿는다
      let ym = fm && near(+fm[2], dc[0].m) ? fm[1] + '-' + String(+fm[2]).padStart(2, '0') : '';
      if (!ym) { const cm = now.getMonth() + 1, y = now.getFullYear() + (dc[0].m < cm - 6 ? 1 : dc[0].m > cm + 6 ? -1 : 0); ym = y + '-' + String(dc[0].m).padStart(2, '0'); }
      return { ym, days: dc.map((c) => ({ m: c.m, d: c.d })), rows, sheet: sh.name };
    }
    return null;
  }
  const pkDate = (ym, x) => { const y = +ym.slice(0, 4), pm = +ym.slice(5, 7), yy = x.m < pm - 6 ? y + 1 : x.m > pm + 6 ? y - 1 : y; return yy + '-' + String(x.m).padStart(2, '0') + '-' + String(x.d).padStart(2, '0'); };
  return { perf: parsePerfSheet, sla: parseSlaSheet, fb: parseFbSheet, peak: parsePeakSheet, pkDate: pkDate };
})();
