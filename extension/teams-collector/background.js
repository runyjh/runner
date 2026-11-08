/**
 * 러너 팀즈 수집기 — 백그라운드: 러너 올인원 서버(웹앱 /exec)와 주고받는 일만 한다.
 *  - 연결 코드(관리자 화면에서 만든 것) = 웹앱 주소 + 수집 키
 *  - 설정(키워드·볼 채널)은 10분마다, 그리고 서버가 '설정이 바뀜'이라고 알려 주면 바로 다시 받는다.
 *  - 아이콘 배지: 비어 있음 = 정상 · ! = 연결 안 됨/오류 · 끔 = 관리자가 수집을 꺼 둠
 */
const CFG_TTL = 10 * 60 * 1000;
const TEAMS_URLS = ['https://teams.microsoft.com/*', 'https://teams.cloud.microsoft/*', 'https://teams.live.com/*'];
const VER = chrome.runtime.getManifest().version;

const get = (keys) => new Promise((ok) => chrome.storage.local.get(keys, ok));
const set = (o) => new Promise((ok) => chrome.storage.local.set(o, ok));

async function installId() {
  const o = await get(['installId']);
  if (o.installId) return o.installId;
  const id = Math.random().toString(36).slice(2, 8);
  await set({ installId: id });
  return id;
}

function badge(state) {
  const m = { ok: ['', '#1b64da'], err: ['!', '#e03131'], off: ['끔', '#868e96'], none: ['!', '#f59f00'] }[state] || ['', '#1b64da'];
  try { chrome.action.setBadgeText({ text: m[0] }); chrome.action.setBadgeBackgroundColor({ color: m[1] }); } catch (e) { /* 무시 */ }
}

async function call(fn, args) {
  const o = await get(['api', 'key']);
  if (!o.api || !o.key) return { ok: false, code: 'NO_CONN', msg: '연결 코드를 넣어 주세요 (확장 아이콘 → 연결).' };
  let r;
  try {
    const res = await fetch(o.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn, args: [o.key].concat(args || []) }), redirect: 'follow', cache: 'no-store' });
    const txt = await res.text();
    try { r = JSON.parse(txt); } catch (e) { r = { ok: false, msg: '서버 응답을 읽지 못함 (웹앱 주소 확인) · HTTP ' + res.status }; }
  } catch (e) {
    r = { ok: false, code: 'NET', msg: '인터넷 또는 서버 연결 실패' };
  }
  return r || { ok: false, msg: '빈 응답' };
}

async function status(patch) {
  const o = await get(['st']);
  const st = Object.assign({}, o.st || {}, patch);
  await set({ st });
  badge(st.code === 'NO_CONN' ? 'none' : st.lastErr ? 'err' : st.on === false ? 'off' : 'ok');
  return st;
}

async function getCfg(force) {
  const o = await get(['cfg']);
  if (!force && o.cfg && Date.now() - o.cfg.at < CFG_TTL) return { ok: true, cfg: o.cfg };
  const r = await call('api_teamsConfig', []);
  if (!r.ok) { await status({ lastErr: r.msg, code: r.code || '' }); return o.cfg ? { ok: true, cfg: o.cfg, stale: true } : r; }
  const cfg = { on: r.on, keywords: r.keywords || [], channels: r.channels || [], ver: r.ver, at: Date.now() };
  await set({ cfg });
  await status({ on: cfg.on, cfgAt: cfg.at, code: '' });
  return { ok: true, cfg };
}

async function broadcast(cfg) {
  try {
    const tabs = await chrome.tabs.query({ url: TEAMS_URLS });
    tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { t: 'cfgChanged', cfg }, () => void chrome.runtime.lastError));
  } catch (e) { /* 무시 */ }
}

async function push(p, tabId) {
  p.tab = (await installId()) + '-' + tabId;
  p.ver = VER;
  const r = await call('api_teamsPush', [p]);
  if (!r.ok) { await status({ lastErr: r.msg, code: r.code || '', errAt: Date.now() }); return r; }
  const o = await get(['cfg', 'st']);
  const st = o.st || {};
  await status({ lastErr: '', code: '', lastOk: Date.now(), on: r.on, sentTotal: (st.sentTotal || 0) + (r.added || 0), lastAdded: r.added ? Date.now() : st.lastAdded || 0 });
  if (!o.cfg || String(o.cfg.ver) !== String(r.ver)) {
    const c = await getCfg(true);
    if (c.ok) { broadcast(c.cfg); r.cfg = c.cfg; }
  }
  return r;
}

/** 연결 코드: RTC1.<base64url(JSON {a: 웹앱 주소, k: 수집 키})> */
function parseCode(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  const m = /^RTC1\.([A-Za-z0-9_\-]+=*)$/.exec(s);
  if (!m) return null;
  try {
    const b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b))));
    if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w\-]+\/exec$/.test(j.a) || !j.k) return null;
    return { api: j.a, key: j.k };
  } catch (e) { return null; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  (async () => {
    if (msg.t === 'cfg') return reply(await getCfg(msg.force));
    if (msg.t === 'push') return reply(await push(msg.p || {}, sender.tab ? sender.tab.id : 0));
    if (msg.t === 'connect') {
      const c = parseCode(msg.code);
      if (!c) return reply({ ok: false, msg: '연결 코드 형식이 다릅니다. 관리자 화면에서 복사한 코드를 그대로 붙여 넣어 주세요.' });
      await set({ api: c.api, key: c.key, cfg: null });
      const r = await getCfg(true);
      if (r.ok && !r.stale) { await status({ lastErr: '', code: '' }); broadcast(r.cfg); }
      return reply(r.ok && !r.stale ? { ok: true, cfg: r.cfg } : { ok: false, msg: r.msg || '서버 확인 실패' });
    }
    if (msg.t === 'state') { const o = await get(['api', 'st', 'cfg']); return reply({ ok: true, connected: !!o.api, st: o.st || {}, cfg: o.cfg || null, ver: VER }); }
    if (msg.t === 'disconnect') { await set({ api: '', key: '', cfg: null }); await status({ code: 'NO_CONN', lastErr: '' }); return reply({ ok: true }); }
    reply({ ok: false });
  })();
  return true;
});

// 설치·업데이트 직후: 이미 열려 있는 팀즈 탭에도 바로 붙인다 (새로고침 안 해도 됨)
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('cfg', { periodInMinutes: 10 });
  try {
    const tabs = await chrome.tabs.query({ url: TEAMS_URLS });
    tabs.forEach((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {}));
  } catch (e) { /* 무시 */ }
  const o = await get(['api']);
  badge(o.api ? 'ok' : 'none');
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('cfg', { periodInMinutes: 10 }); });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'cfg') return;
  const o = await get(['cfg']);
  const r = await getCfg(true);
  if (r.ok && !r.stale && (!o.cfg || String(o.cfg.ver) !== String(r.cfg.ver))) broadcast(r.cfg);
});
