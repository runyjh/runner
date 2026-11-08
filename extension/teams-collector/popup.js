const $ = (s) => document.querySelector(s);
const ago = (t) => { if (!t) return '없음'; const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? '방금' : m < 60 ? m + '분 전' : Math.floor(m / 60) + '시간 ' + (m % 60) + '분 전'; };
const chips = (el, list, empty) => { el.innerHTML = ''; if (!list || !list.length) { el.innerHTML = '<span class="sub">' + empty + '</span>'; return; } list.forEach((x) => { const s = document.createElement('span'); s.className = 'chip'; s.textContent = x; el.appendChild(s); }); };
const send = (msg) => new Promise((ok) => chrome.runtime.sendMessage(msg, (r) => ok(r || {})));

async function paint() {
  const s = await send({ t: 'state' });
  $('#ver').textContent = 'v' + (s.ver || '');
  const st = s.st || {};
  $('#connForm').classList.toggle('hidden', !!s.connected);
  $('#connBtns').classList.toggle('hidden', !s.connected);
  $('#connState').innerHTML = s.connected ? '<span class="ok">● 연결됨</span>' : '<span class="bad">연결 전</span> — 아래에 연결 코드를 넣어 주세요.';
  $('#stBox').classList.toggle('hidden', !s.connected);
  if (s.connected) {
    $('#on').innerHTML = st.on === false ? '<span class="bad">관리자가 꺼 둠</span>' : '<span class="ok">켜짐</span>';
    $('#lastOk').textContent = ago(st.lastOk);
    $('#sentTotal').textContent = (st.sentTotal || 0) + '건';
    $('#lastErr').innerHTML = st.lastErr ? '<span class="bad"></span>' : '없음';
    if (st.lastErr) $('#lastErr span').textContent = st.lastErr;
    chips($('#kw'), s.cfg && s.cfg.keywords, '없음 (볼 채널의 모든 메시지)');
    chips($('#ch'), s.cfg && s.cfg.channels, '없음 (모든 채널)');
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isTeams = tab && /^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com)\//.test(tab.url || '');
  $('#noTab').classList.toggle('hidden', !!isTeams);
  $('#tabBox').classList.toggle('hidden', !isTeams);
  if (!isTeams) return;
  chrome.tabs.sendMessage(tab.id, { t: 'diag' }, (d) => {
    if (chrome.runtime.lastError || !d) { $('#tCh').textContent = '이 탭을 새로고침해 주세요 (F5)'; return; }
    $('#tCh').textContent = d.channel + (d.channelOk ? '' : ' (볼 채널 아님)');
    $('#tFound').textContent = d.found + '개';
    $('#tMatched').textContent = d.matched + '개';
    $('#tPending').textContent = d.pending + '개';
    $('#tWarn').textContent = d.warn || d.lastErr || '없음';
    const box = $('#tSample'); box.innerHTML = '';
    (d.sample || []).forEach((m) => { const div = document.createElement('div'); div.className = 'smp'; const b = document.createElement('b'); b.textContent = (m.author || '(작성자 없음)') + ' · ' + (m.at || ''); div.appendChild(b); div.appendChild(document.createElement('br')); div.appendChild(document.createTextNode(m.text)); box.appendChild(div); });
    if (!(d.sample || []).length) box.innerHTML = '<span class="sub">화면에서 읽은 메시지가 없습니다.</span>';
  });
}

$('#connect').addEventListener('click', async () => {
  $('#connect').disabled = true;
  const r = await send({ t: 'connect', code: $('#code').value });
  $('#connect').disabled = false;
  if (!r.ok) { $('#connState').innerHTML = '<span class="bad"></span>'; $('#connState span').textContent = r.msg || '연결 실패'; return; }
  $('#code').value = '';
  paint();
});
$('#reconnect').addEventListener('click', () => { $('#connForm').classList.remove('hidden'); $('#code').focus(); });
$('#reloadCfg').addEventListener('click', async () => { await send({ t: 'cfg', force: true }); paint(); });
$('#sendNow').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { t: 'sendNow' }, () => { void chrome.runtime.lastError; setTimeout(paint, 2500); });
});
$('#forget').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { t: 'forget' }, () => { void chrome.runtime.lastError; setTimeout(paint, 2500); });
});
paint();
