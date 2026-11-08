/**
 * 팀즈 소식 — 크롬 확장 '러너 팀즈 수집기'(extension/teams-collector)가 팀즈 웹 화면의 메시지를 보내면
 * 키워드에 걸린 것만 teams_msgs 탭에 쌓고, 관리자 대시보드 '팀즈 소식' 카드에 보여 준다.
 *
 *  - 확장은 관리자 로그인 대신 '수집 키'로 들어온다 (관리자가 팀즈 소식 → 설정 → [연결 코드 만들기]).
 *    키는 스크립트 속성 TEAMS_KEY_HASH 에 해시로만 둔다. 새로 만들면 예전 키는 바로 막힌다.
 *  - 설정(app_settings): teamsOn(켬/끔) · teamsKeywords(한 줄에 하나) · teamsChannels(비우면 모든 채널)
 *    키워드가 비어 있으면 볼 채널의 모든 메시지를 저장한다.
 *  - 확장은 키워드로 먼저 거르고 보내지만, 서버가 지금 설정으로 한 번 더 거른다 (설정이 바뀐 직후에도 맞게).
 *  - 같은 메시지ID는 한 번만 저장 (팀즈에서 고친 글은 처음 내용 그대로).
 *  - 수집기 상태(어느 탭이 언제 마지막으로 보냈는지)는 캐시(6시간) — 대시보드의 '수집 중 / 멈춤' 표시용.
 *  - 줄이 8,000을 넘으면 오래된 줄부터 지워 6,000줄로 맞춘다.
 */
const TM_ST = { NEW: '새 글', OK: '확인', HIDE: '숨김' };
const TM_MAX_ROWS = 8000, TM_KEEP_ROWS = 6000, TM_STALE_MIN = 10;

function tmOn_() { return !/^(off|n|no|false|0|끔|꺼짐)$/i.test(str_(appSet_().teamsOn)); }
function tmList_(v) {
  const seen = {};
  return String(v || '').split(/[\n,，]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { const k = x.toLowerCase(); if (!x || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 100);
}
function tmCfg_() {
  const s = appSet_();
  return { on: tmOn_(), keywords: tmList_(s.teamsKeywords), channels: tmList_(s.teamsChannels), ver: str_(s.teamsCfgVer) || '0' };
}
function tmNorm_(v) { return String(v == null ? '' : v).normalize('NFC').toLowerCase(); }
/** 그 메시지에 걸린 키워드 (키워드가 없으면 ['(전체)']) · 안 걸리면 [] */
function tmMatch_(cfg, m) {
  if (cfg.channels.length) {
    const ch = tmNorm_(m.channel);
    if (!cfg.channels.some(function (c) { return ch.indexOf(tmNorm_(c)) >= 0; })) return [];
  }
  if (!cfg.keywords.length) return ['(전체)'];
  const t = tmNorm_(m.text + ' ' + m.author);
  return cfg.keywords.filter(function (k) { return t.indexOf(tmNorm_(k)) >= 0; });
}
function tmHash_(key) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'runner-teams:' + String(key), Utilities.Charset.UTF_8));
}
/** 수집 키 확인 (틀린 키가 반복되면 15분 막음) */
function tmAuth_(key) {
  const c = cache_(), bad = Number(c.get('tm:bad') || 0);
  if (bad >= 30) fail_('수집 키 확인 실패가 반복되어 잠시 막혔습니다. 15분 뒤 다시 시도합니다.');
  const want = str_(PropertiesService.getScriptProperties().getProperty('TEAMS_KEY_HASH'));
  if (!want || !key || tmHash_(key) !== want) {
    c.put('tm:bad', String(bad + 1), 900);
    const e = new Error('수집 키가 맞지 않습니다. 관리자 화면 → 대시보드 → 팀즈 소식 → 설정에서 연결 코드를 다시 만들어 넣어 주세요.');
    e.userMsg = e.message; e.code = 'BAD_KEY'; throw e;
  }
}
/** 수집기 상태 (탭별 마지막 신호) */
function tmHbRead_() {
  let m = {};
  try { m = JSON.parse(cache_().get('tm:hb') || '{}') || {}; } catch (e) { m = {}; }
  return m;
}
function tmHbPut_(tab, info) {
  try {
    const m = tmHbRead_(), now = Date.now();
    Object.keys(m).forEach(function (k) { if (now - (m[k].at || 0) > 6 * 3600 * 1000) delete m[k]; });
    m[tab] = Object.assign({}, m[tab] || {}, info, { at: now });
    const keys = Object.keys(m).sort(function (a, b) { return m[b].at - m[a].at; }).slice(0, 20), out = {};
    keys.forEach(function (k) { out[k] = m[k]; });
    cache_().put('tm:hb', JSON.stringify(out), CFG.CACHE_MAX);
  } catch (e) { /* 무시 */ }
}
function tmHbView_() {
  const m = tmHbRead_(), now = Date.now();
  const tabs = Object.keys(m).map(function (k) { const o = m[k]; return { tab: k, channel: o.channel || '', found: o.found || 0, ver: o.ver || '', at: o.at, min: Math.floor((now - o.at) / 60000), sentAt: o.sentAt || 0, warn: o.warn || '' }; })
    .sort(function (a, b) { return b.at - a.at; });
  const last = tabs.length ? tabs[0].at : 0;
  return { tabs: tabs, last: last, min: last ? Math.floor((now - last) / 60000) : null, stale: !last || (now - last) > TM_STALE_MIN * 60000, staleMin: TM_STALE_MIN };
}
function tmView_(o) {
  return { id: o.id, postedAt: o.postedAt, channel: o.channel, author: o.author, text: o.text, keywords: o.keywords ? o.keywords.split(/\s*,\s*/) : [],
    status: o.status || TM_ST.NEW, by: o.by, checkedAt: o.checkedAt, collectedAt: o.collectedAt, url: o.url, memo: o.memo };
}
function tmBump_() { try { fsMark_('tm'); } catch (e) { /* 무시 */ } }

// ───────────────────────── 크롬 확장이 부르는 것 ─────────────────────────
/** 확장: 지금 설정 받기 */
function api_teamsConfig(key) {
  return run_(function () {
    tmAuth_(key);
    const cfg = tmCfg_();
    return { ok: true, on: cfg.on, keywords: cfg.keywords, channels: cfg.channels, ver: cfg.ver };
  });
}
/**
 * 확장: 메시지 보내기 (메시지가 없어도 '살아 있음' 신호로 부른다)
 * p = { tab, ver, channel, found, warn, msgs: [{ id, at, channel, author, text, url }] }
 */
function api_teamsPush(key, p) {
  return run_(function () {
    tmAuth_(key);
    p = p || {};
    const cfg = tmCfg_();
    const msgs = (Array.isArray(p.msgs) ? p.msgs : []).slice(0, 300);
    const tab = str_(p.tab).slice(0, 60) || 'tab';
    let added = 0, skipped = 0;
    if (cfg.on && msgs.length) {
      const rows = [];
      msgs.forEach(function (m) {
        const o = { id: str_(m && m.id).replace(/[^\w:.\-@]/g, '').slice(0, 80), postedAt: str_(m && m.at).slice(0, 19), channel: str_(m && m.channel).slice(0, 120),
          author: str_(m && m.author).slice(0, 60), text: str_(m && m.text).slice(0, 3000), url: str_(m && m.url).slice(0, 300) };
        if (!o.id || !o.text) { skipped++; return; }
        const hit = tmMatch_(cfg, o);
        if (!hit.length) { skipped++; return; }
        o.keywords = hit.join(', ');
        rows.push(o);
      });
      if (rows.length) {
        const lock = scriptLock_();
        lock.waitLock(20000);
        try {
          const sh = sheet_(SH.TEAMS), c = cols_(SH.TEAMS, true), last = sh.getLastRow();
          const have = {};
          if (last >= 2) sh.getRange(2, c.id + 1, last - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = 1; });
          const now = nowText_();
          const add = rows.filter(function (o) { if (have[o.id]) return false; have[o.id] = 1; return true; }).map(function (o) {
            const arr = new Array(c.__w).fill('');
            Object.assign(o, { status: TM_ST.NEW, collectedAt: now });
            Object.keys(o).forEach(function (k) { if (c[k] !== undefined) arr[c[k]] = safeText_(o[k]); });
            return arr;
          });
          skipped += rows.length - add.length;
          if (add.length) {
            const r0 = last + 1;
            if (r0 + add.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, add.length));
            sh.getRange(r0, 1, add.length, c.__w).setNumberFormat('@').setValues(add);
            added = add.length;
            const total = r0 + add.length - 2;
            if (total > TM_MAX_ROWS) sh.deleteRows(2, total - TM_KEEP_ROWS);
          }
        } finally { lock.releaseLock(); }
        if (added) tmBump_();
      }
    }
    tmHbPut_(tab, { channel: str_(p.channel).slice(0, 120), found: Number(p.found) || 0, ver: str_(p.ver).slice(0, 20), warn: str_(p.warn).slice(0, 120), sentAt: added ? Date.now() : (tmHbRead_()[tab] || {}).sentAt || 0 });
    return { ok: true, on: cfg.on, added: added, skipped: skipped, ver: cfg.ver };
  });
}

// ───────────────────────── 관리자 ─────────────────────────
/** 목록 + 설정 + 수집기 상태. q = { status: '새 글'|'전체'|'숨김', limit } */
function adm_teamsList(token, q) {
  return run_(function () {
    requireAdmin_(token);
    q = q || {};
    const limit = Math.max(10, Math.min(1000, Number(q.limit) || 300));
    let all = [];
    try { all = readAll_(SH.TEAMS).filter(function (o) { return o.id; }); } catch (e) { all = []; }
    const counts = { all: all.length, new: 0, ok: 0, hide: 0 };
    all.forEach(function (o) { const s = o.status || TM_ST.NEW; if (s === TM_ST.NEW) counts.new++; else if (s === TM_ST.HIDE) counts.hide++; else counts.ok++; });
    const want = str_(q.status);
    const rows = all.filter(function (o) {
      const s = o.status || TM_ST.NEW;
      if (want === TM_ST.HIDE) return s === TM_ST.HIDE;
      if (want === TM_ST.NEW) return s === TM_ST.NEW;
      return s !== TM_ST.HIDE;
    }).sort(function (a, b) { return String(b.postedAt || b.collectedAt).localeCompare(String(a.postedAt || a.collectedAt)); })
      .slice(0, limit).map(tmView_);
    const cfg = tmCfg_();
    return { ok: true, rows: rows, counts: counts, cfg: cfg, hb: tmHbView_(), keySet: !!PropertiesService.getScriptProperties().getProperty('TEAMS_KEY_HASH') };
  });
}
/** 설정 저장: { on, keywords: '한 줄에 하나', channels } */
function adm_teamsSet(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const kw = tmList_(p.keywords), ch = tmList_(p.channels);
    appSetPut_('teamsOn', p.on === false ? '끔' : '켬', '팀즈 소식 수집 (켬/끔)');
    appSetPut_('teamsKeywords', kw.join('\n'), '팀즈 소식 키워드 (한 줄에 하나 · 비우면 볼 채널의 모든 메시지)');
    appSetPut_('teamsChannels', ch.join('\n'), '팀즈 소식 볼 채널 (채널 이름 일부 · 비우면 모든 채널)');
    appSetPut_('teamsCfgVer', String(Date.now()), '팀즈 수집기 설정 버전 (자동)');
    logAdmin_(a, '팀즈 소식 설정', '', (p.on === false ? '끔' : '켬') + ' · 키워드 ' + kw.length + ' · 채널 ' + ch.length);
    return { ok: true, cfg: tmCfg_() };
  });
}
/** 새 수집 키 (한 번만 보여 줌 · 예전 키는 바로 막힘) */
function adm_teamsKey(token) {
  return run_(function () {
    const a = requireAdmin_(token);
    const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    PropertiesService.getScriptProperties().setProperty('TEAMS_KEY_HASH', tmHash_(key));
    cache_().remove('tm:bad');
    logAdmin_(a, '팀즈 수집 키 새로 만듦', '', '');
    let url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    return { ok: true, key: key, url: url };
  });
}
/** 상태 바꾸기: ids 여러 개 · status = '확인' | '새 글' | '숨김' · all=true 면 지금 '새 글' 전부 */
function adm_teamsMark(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const st = [TM_ST.NEW, TM_ST.OK, TM_ST.HIDE].indexOf(p.status) >= 0 ? p.status : TM_ST.OK;
    const ids = {}; (Array.isArray(p.ids) ? p.ids : []).forEach(function (x) { ids[String(x)] = 1; });
    const lock = scriptLock_();
    lock.waitLock(20000);
    let n = 0;
    try {
      const sh = sheet_(SH.TEAMS), c = cols_(SH.TEAMS, true), last = sh.getLastRow();
      if (last >= 2) {
        const now = nowText_(), cnt = last - 1;
        const col = function (k) { return sh.getRange(2, c[k] + 1, cnt, 1); };
        const idV = col('id').getValues(), stR = col('status'), byR = col('by'), atR = col('checkedAt');
        const stV = stR.getValues(), byV = byR.getValues(), atV = atR.getValues();
        idV.forEach(function (r, i) {
          const id = String(r[0]); if (!id) return;
          const cur = String(stV[i][0] || '') || TM_ST.NEW;
          const hit = p.all ? cur === TM_ST.NEW : ids[id];
          if (!hit || cur === st) return;
          stV[i][0] = st; byV[i][0] = st === TM_ST.NEW ? '' : a.name; atV[i][0] = st === TM_ST.NEW ? '' : now;
          n++;
        });
        if (n) { stR.setValues(stV); byR.setValues(byV); atR.setValues(atV); }
      }
    } finally { lock.releaseLock(); }
    if (n) tmBump_();
    return { ok: true, changed: n };
  });
}
