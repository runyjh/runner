/**
 * 러너 팀즈 수집기 — 팀즈 웹 화면에 들어 있는 메시지 글자를 읽는다 (화면을 찍는 OCR 이 아님).
 *  - 새 메시지가 화면에 붙는 순간을 감지(MutationObserver)하고, 1분마다 한 번 더 살핀다 (뒤에 있는 탭은 타이머가 느려지므로 둘 다).
 *  - 볼 채널·키워드에 맞는 것만 백그라운드(background.js)로 넘긴다 → 러너 올인원 서버로 전송.
 *  - 한 번 보낸 메시지ID는 기억해 두고 다시 보내지 않는다. 키워드에 안 맞은 것은 기억하지 않는다
 *    (나중에 키워드를 추가하면 화면에 남아 있는 메시지는 다시 살펴 보낸다).
 *  - 팀즈 화면 구조가 바뀌면 SEL 의 선택자만 고치면 된다.
 */
(() => {
  if (window.__runnerTeams) return;
  window.__runnerTeams = true;

  const SEL = {
    // 메시지 본문: 팀즈는 본문 칸 id 를 content-<메시지ID(숫자)> 로 둔다
    body: ['[id^="content-"]', '[data-tid="message-body-content"]', '[data-tid="messageBodyContent"]', '[data-tid="message-content"]'],
    author: ['[data-tid="message-author-name"]', '[data-tid="threadBodyDisplayName"]', '[data-tid="message-author"]'],
    time: ['time[datetime]'],
    skip: '[contenteditable="true"], [role="textbox"], [data-tid="ckeditor"], [data-tid="message-compose"]'
  };
  const HB_MS = 2 * 60 * 1000; // 메시지가 없어도 2분마다 '살아 있음' 신호
  const SENT_MAX = 5000;

  const S = { cfg: null, sent: new Set(), sentOrder: [], pending: new Map(), found: 0, matched: 0, lastScan: 0, lastSend: 0, lastErr: '', sentTotal: 0, channel: '', sample: [], busy: false, warn: '' };

  const norm = (v) => String(v == null ? '' : v).normalize('NFC').toLowerCase();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

  function channelName() {
    let t = String(document.title || '');
    t = t.replace(/^\(\d+\)\s*/, '').replace(/\s*[|\-–]\s*Microsoft Teams.*$/i, '').trim();
    return t || '(이름 모름)';
  }
  function channelOk(ch) {
    const list = (S.cfg && S.cfg.channels) || [];
    if (!list.length) return true;
    const c = norm(ch);
    return list.some((x) => c.indexOf(norm(x)) >= 0);
  }
  function keywordsOf(m) {
    const list = (S.cfg && S.cfg.keywords) || [];
    if (!list.length) return ['(전체)'];
    const t = norm(m.text + ' ' + m.author);
    return list.filter((k) => t.indexOf(norm(k)) >= 0);
  }

  function bodyNodes() {
    const set = new Set();
    SEL.body.forEach((sel) => document.querySelectorAll(sel).forEach((el) => {
      if (sel.indexOf('content-') >= 0 && !/^content-\d{6,}$/.test(el.id)) return; // content-area 같은 다른 칸 제외
      if (el.closest(SEL.skip)) return;
      set.add(el);
    }));
    // 안쪽(인용한 답글 등)은 빼고 바깥 본문만
    return [...set].filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
  }
  function idOf(el) {
    const m = /^content-(\d{6,})$/.exec(el.id || '');
    if (m) return m[1];
    for (let p = el, i = 0; p && i < 8; p = p.parentElement, i++) {
      const v = p.getAttribute && (p.getAttribute('data-mid') || p.getAttribute('data-message-id'));
      if (v) return String(v);
      const m2 = /(\d{12,14})/.exec(p.id || '');
      if (m2) return m2[1];
    }
    return '';
  }
  function textOf(el) {
    let t = '';
    try { t = el.innerText || ''; } catch (e) { t = ''; }
    if (!t.trim()) t = el.textContent || '';
    t = t.replace(/ /g, ' ').split('\n').map((x) => x.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const imgs = [...el.querySelectorAll('img')].filter((im) => {
      const alt = im.getAttribute('alt') || '', cls = String(im.className || ''), it = im.getAttribute('itemtype') || '';
      return !/emoji|emoticon/i.test(cls + ' ' + it) && !/^(\p{Extended_Pictographic}|\(.*\)$)/u.test(alt) && (im.naturalWidth || im.width || 40) > 30;
    }).length;
    if (imgs) t += (t ? '\n' : '') + '[이미지 ' + imgs + '장 — 이미지 안 글자는 못 읽음]';
    return t.slice(0, 3000);
  }
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36); }

  /** 화면의 메시지 목록 (작성자·시각이 생략된 연속 메시지는 바로 앞 메시지의 작성자를 이어 받음) */
  function readMessages() {
    const bodies = bodyNodes();
    const marks = [];
    bodies.forEach((el) => marks.push({ k: 'b', el }));
    SEL.author.forEach((sel) => document.querySelectorAll(sel).forEach((el) => { if (!el.closest(SEL.skip)) marks.push({ k: 'a', el }); }));
    SEL.time.forEach((sel) => document.querySelectorAll(sel).forEach((el) => marks.push({ k: 't', el })));
    marks.sort((x, y) => (x.el === y.el ? 0 : x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const ch = channelName(), out = [];
    let author = '', time = '';
    marks.forEach((m) => {
      if (m.k === 'a') { const v = (m.el.innerText || m.el.textContent || '').trim(); if (v) author = v.split('\n')[0].slice(0, 60); return; }
      if (m.k === 't') { const d = new Date(m.el.getAttribute('datetime')); if (!isNaN(d)) time = fmt(d); return; }
      if (bodies.indexOf(m.el) < 0) return; // 본문 안의 작성자·시각은 위에서 처리됨
      const text = textOf(m.el);
      if (!text) return;
      let id = idOf(m.el), at = time;
      if (/^\d{13}$/.test(id)) { const d = new Date(Number(id)); if (!isNaN(d) && d.getFullYear() > 2015) at = fmt(d); } // 팀즈 메시지ID = 올린 시각(ms)
      if (!id) id = hash(ch + '|' + author + '|' + at + '|' + text.slice(0, 200));
      out.push({ id, at, channel: ch, author, text, url: location.href.slice(0, 300) });
    });
    return out;
  }

  function scan() {
    S.lastScan = Date.now();
    S.channel = channelName();
    let list = [];
    try { list = readMessages(); S.warn = ''; } catch (e) { S.warn = '읽기 오류: ' + (e && e.message || e); }
    S.found = list.length;
    S.sample = list.slice(-3).map((m) => ({ at: m.at, author: m.author, text: m.text.slice(0, 80) }));
    if (!list.length && document.readyState === 'complete' && Date.now() - START > 60000) S.warn = S.warn || '메시지를 찾지 못함 (채널·채팅을 열어 두세요. 계속이면 팀즈 화면 구조가 바뀐 것)';
    if (!S.cfg || !S.cfg.on || !channelOk(S.channel)) { S.matched = 0; return; }
    let n = 0;
    list.forEach((m) => {
      const kw = keywordsOf(m);
      if (!kw.length) return;
      n++;
      if (!S.sent.has(m.id)) S.pending.set(m.id, m);
    });
    S.matched = n;
  }

  function remember(ids) {
    ids.forEach((id) => { if (!S.sent.has(id)) { S.sent.add(id); S.sentOrder.push(id); } });
    while (S.sentOrder.length > SENT_MAX) S.sent.delete(S.sentOrder.shift());
    try { chrome.storage.local.set({ sentIds: S.sentOrder }); } catch (e) { /* 확장을 새로 고친 직후 */ }
  }

  function send(force) {
    if (S.busy) return;
    const msgs = [...S.pending.values()].slice(0, 200);
    if (!msgs.length && !force && Date.now() - S.lastSend < HB_MS) return;
    S.busy = true;
    const p = { channel: S.channel, found: S.found, warn: S.warn, msgs };
    try {
      chrome.runtime.sendMessage({ t: 'push', p }, (r) => {
        S.busy = false;
        if (chrome.runtime.lastError) { S.lastErr = '확장 연결 끊김 — 이 탭을 새로고침하세요'; return; }
        S.lastSend = Date.now();
        if (r && r.ok) {
          S.lastErr = '';
          remember(msgs.map((m) => m.id));
          msgs.forEach((m) => S.pending.delete(m.id));
          S.sentTotal += r.added || 0;
          if (r.cfg) { S.cfg = r.cfg; scan(); }
          if (S.pending.size) setTimeout(() => send(true), 3000);
        } else S.lastErr = (r && r.msg) || '보내기 실패';
      });
    } catch (e) { S.busy = false; S.lastErr = '확장 연결 끊김 — 이 탭을 새로고침하세요'; }
  }

  function loadCfg(force, cb) {
    try {
      chrome.runtime.sendMessage({ t: 'cfg', force: !!force }, (r) => {
        if (chrome.runtime.lastError) return cb && cb();
        if (r && r.ok) S.cfg = r.cfg; else S.lastErr = (r && r.msg) || '';
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  // 팀즈는 화면을 계속 조금씩 바꾸므로(입력 중 표시 등) 2초에 한 번까지만 살핀다
  let dT = 0;
  const later = () => { if (dT) return; dT = setTimeout(() => { dT = 0; scan(); if (S.pending.size) send(); }, 2000); };
  const START = Date.now();

  chrome.storage.local.get(['sentIds'], (o) => {
    (o && o.sentIds || []).forEach((id) => { S.sent.add(id); S.sentOrder.push(id); });
    loadCfg(false, () => {
      scan(); send(true);
      new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      setInterval(() => { scan(); send(); }, 60000);
      document.addEventListener('visibilitychange', later);
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.t === 'cfgChanged') { S.cfg = msg.cfg || S.cfg; scan(); send(true); return; }
    if (msg.t === 'diag') {
      scan();
      reply({ ok: true, channel: S.channel, found: S.found, matched: S.matched, pending: S.pending.size, sentTotal: S.sentTotal, remembered: S.sent.size,
        lastSend: S.lastSend, lastErr: S.lastErr, warn: S.warn, sample: S.sample, on: !!(S.cfg && S.cfg.on), channelOk: channelOk(S.channel) });
      return;
    }
    if (msg.t === 'sendNow') { loadCfg(true, () => { scan(); send(true); reply({ ok: true, pending: S.pending.size }); }); return true; }
    if (msg.t === 'forget') { S.sent.clear(); S.sentOrder = []; chrome.storage.local.set({ sentIds: [] }); scan(); send(true); reply({ ok: true }); }
  });
})();
