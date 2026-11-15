/**
 * 처음 가는 캠프 · 노선 알림 (PDD 전날 저녁)
 *  - 매일 18시쯤: 내일(PDD) 기사스케줄 칸을 보고, 그 기사가 기사스케줄 기록에서 한 번도 간 적 없는 캠프 · 노선이면
 *    ① 기사에게 기사앱 알림 + 휴대폰 푸시 ("내일 처음 가는 노선") ② 관리자 업무스케줄에 한 줄 ("내일 처음 가는 기사 N명")
 *  - 기사 칸 · 품앗이 줄 · 추가 배정 줄을 모두 본다. '출근' 은 그날 담당 노선(노선 변경 예약 포함)
 *  - 노선은 글자 하나씩 본다 (212AB = 212A · 212B) — 212A 만 가 본 기사가 212AB 에 들어가면 212B 가 처음
 *  - 하루에 한 번만 (FIRST_RUN_DONE = 마지막으로 알린 PDD). 트리거는 관리자 화면을 열 때 없으면 설치
 */
const FR = { HOUR: 18, DONE: 'FIRST_RUN_DONE', TRG: 'firstRunNotify', SKIP: /휴무|휴가|병가|퇴사|미입차|노쇼|용차|비고/ };

/** 트리거 함수 (매일 18시쯤) */
function firstRunNotify() {
  try { frRun_(false); } catch (e) { softFail_('처음 가는 노선 알림 실패', e); }
}
/** 트리거 설치 (없으면 · 관리자 화면 열 때 6시간에 한 번 확인) */
function frEnsureTrigger_() {
  if (cache_().get('fr:trg')) return;
  try {
    const have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === FR.TRG; });
    if (!have) ScriptApp.newTrigger(FR.TRG).timeBased().everyDays(1).atHour(FR.HOUR).create();
    cache_().put('fr:trg', '1', 21600);
  } catch (e) { softFail_('처음 가는 노선 알림 트리거 설치 실패', e); }
}

/** 칸 글자 → 노선 글자 단위 ['212A', '212B'] (괄호 · 대괄호 안은 뺌. 글자 없는 '708' 은 그대로) */
function frUnits_(text) {
  return rpfBaseCodes_(str_(text).replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
}
/** 캠프 이름 목록 (긴 이름 먼저: 칸 글자 안에서 찾기용) [{ key: '군포1', name: '군포1캠프' }] */
function frCamps_() {
  return (master_().camps || []).filter(function (c) { return c.name && !isStaffCamp_(c.name); })
    .map(function (c) { return { id: c.id, key: campKey_(String(c.name).replace(/\s*캠프\s*$/, '')), name: String(c.name) }; })
    .filter(function (c) { return c.key; })
    .sort(function (a, b) { return b.key.length - a.key.length; });
}
function frCampKey_(name) { return campKey_(str_(name).replace(/\s*캠프\s*$/, '')); }
/**
 * 칸 하나 → 그날 간 곳 { camp: '군포1', units: ['212C', '212D'] } (모르면 null)
 *  def = { camp, route } 그 줄의 기본 캠프 · 노선 ('출근' 이면 이 노선)
 */
function frCell_(v, def, camps) {
  const s = str_(v);
  if (!s || FR.SKIP.test(s)) return null;
  const up = campKey_(s);
  let camp = def.camp || '';
  for (let i = 0; i < camps.length; i++) { if (up.indexOf(camps[i].key) >= 0) { camp = camps[i].key; break; } }
  let units = frUnits_(s);
  if (!units.length && /^출근/.test(s)) units = frUnits_(def.route);
  if (!camp || !units.length) return null;
  return { camp: camp, units: units };
}
/**
 * 내일(또는 date) 처음 가는 기사 목록 [{ id, name, camp, campName, units: ['212D'], newCamp, cell }]
 *  기록 = 기사스케줄에서 date 전날까지 그 기사의 모든 줄 (기사 줄 · 품앗이 줄 · 추가 배정 줄)
 */
function frFind_(date) {
  if (!props_().SCH_DB_ID || !schSS_().getSheetByName(SCH.SHEET)) return [];
  const h = schHeader_(), sh = schSheet_(), last = sh.getLastRow();
  const cT = h.dates[date];
  if (last < 2 || cT === undefined) return [];
  const F = h.fixed, w = cT + 1;
  const vals = sh.getRange(2, 1, last - 1, w).getValues();
  const camps = frCamps_(), today = todayText_(), rcBy = rcByDriver_();
  const drv = {};
  readAll_(SH.DRIVERS).forEach(function (o) { if (o.id) drv[o.id] = o; });
  const dcols = Object.keys(h.dates).filter(function (d) { return d < date && h.dates[d] < w; }).sort().map(function (d) { return { d: d, c: h.dates[d] }; });
  const campNameOf = {}; camps.forEach(function (c) { campNameOf[c.key] = c.name; });
  const campKeyOfId = {}; camps.forEach(function (c) { campKeyOfId[c.id] = c.key; });
  // 기사별 기록 · 내일 칸
  const P = {};
  vals.forEach(function (row) {
    const rid = str_(row[F['행ID']]);
    if (!rid) return;
    let id = rid, kind = 'main', exCamp = '';
    if (rid.indexOf(SCH_PM_PREFIX) === 0 && drv[rid.slice(SCH_PM_PREFIX.length)]) { id = rid.slice(SCH_PM_PREFIX.length); kind = 'pm'; }
    else { const ex = schExParse_(rid); if (ex) { id = ex.driverId; kind = 'ex'; exCamp = campKeyOfId[ex.campId] || ''; } }
    const o = drv[id];
    if (!o) return;
    const p = P[id] || (P[id] = { o: o, seen: {}, seenCamp: {}, tom: [] });
    const cur = { campId: o.schCampId, camp: o.schCamp, baseRoute: o.baseRoute };
    const defOf = function (d) {
      if (kind === 'pm') return { camp: '', route: '' };
      if (kind === 'ex') return { camp: exCamp, route: str_(row[F['기본노선']]) };
      const v = rcAt_(cur, rcBy[id], d, today);
      return { camp: frCampKey_(v.camp), route: v.baseRoute };
    };
    dcols.forEach(function (x) {
      const r = frCell_(row[x.c], defOf(x.d), camps);
      if (!r) return;
      p.seenCamp[r.camp] = 1;
      r.units.forEach(function (u) { p.seen[r.camp + '|' + u] = 1; }); // 글자 없이 '708' 만 적힌 날은 '708' 로 남아 708C · 708D 를 모두 가 본 것으로 본다
    });
    const tv = str_(row[cT]);
    if (!tv) return;
    if (kind !== 'pm' && !schWorkDay_(tv, schSubIdsOf_(o))) return;
    const r = frCell_(tv, defOf(date), camps);
    if (r) p.tom.push({ r: r, cell: tv });
  });
  const out = [];
  Object.keys(P).forEach(function (id) {
    const p = P[id], o = p.o;
    if (o.status !== ST.ACTIVE || str_(o.workStatus) === '퇴사') return;
    p.tom.forEach(function (t) {
      const camp = t.r.camp, newCamp = !p.seenCamp[camp];
      const fresh = t.r.units.filter(function (u) { return !p.seen[camp + '|' + u] && !p.seen[camp + '|' + u.replace(/[A-Z]+$/, '')]; });
      if (!newCamp && !fresh.length) return;
      out.push({ id: id, name: o.name, camp: camp, campName: campNameOf[camp] || camp, units: fresh, all: t.r.units, newCamp: newCamp, cell: t.cell });
    });
  });
  return out.sort(function (a, b) { return a.camp.localeCompare(b.camp, 'ko') || a.name.localeCompare(b.name, 'ko'); });
}
/** 노선 글자 단위를 다시 묶어 보이기: ['212C', '212D'] → '212CD' */
function frJoin_(units) {
  const by = {}, order = [];
  units.forEach(function (u) { const m = u.match(/^(\d+)([A-Z]*)$/); if (!m) return; if (!by[m[1]]) { by[m[1]] = ''; order.push(m[1]); } by[m[1]] += m[2]; });
  return order.map(function (n) { return n + by[n]; }).join(', ');
}
function frDayText_(date) { const d = parseYmd_(date); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + '일월화수목금토'[d.getDay()] + ')'; }
/**
 * 알림 보내기. dry = true 면 보내지 않고 목록만 (관리자 미리 보기 · 시험용)
 *  같은 PDD 는 한 번만 (다시 보내려면 force)
 */
function frRun_(dry, force, date) {
  date = date || schAddDays_(todayText_(), 1);
  const sp = PropertiesService.getScriptProperties();
  if (!dry && !force && sp.getProperty(FR.DONE) === date) return { date: date, list: [], skipped: true };
  const list = frFind_(date);
  if (dry) return { date: date, list: list };
  sp.setProperty(FR.DONE, date);
  if (!list.length) return { date: date, list: list };
  const day = frDayText_(date);
  const alerts = list.map(function (x) {
    const rt = frJoin_(x.all), cp = String(x.campName).replace(/\s*캠프$/, '');
    return {
      driverId: x.id, name: x.name, jobId: 'SC-' + date, kind: 'first',
      title: '내일 처음 가는 ' + (x.newCamp ? '캠프' : '노선') + '입니다',
      text: day + ' ' + cp + ' ' + rt + (x.newCamp ? ' — 처음 가는 캠프예요.' : ' — ' + frJoin_(x.units) + ' 처음이에요.') + ' 캠프 위치와 노선을 미리 확인해 주세요.'
    };
  });
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    pmAlertAdd_(alerts);
    frMemo_(date, list);
  } finally { lock.releaseLock(); }
  try { pmPushSend_(alerts); } catch (e) { softFail_('처음 가는 노선 푸시 실패', e); }
  return { date: date, list: list };
}
/** 관리자 업무스케줄 (오늘 날짜 · 미완료): '내일 11/17(화) 처음 가는 기사 2명 — 강준길 군포1 212CD(처음 캠프) · …' */
function frMemo_(date, list) {
  try {
    const today = todayText_(), now = nowText_();
    const title = '내일 ' + frDayText_(date) + ' 처음 가는 기사 ' + list.length + '명';
    const body = list.map(function (x) { return x.name + ' ' + String(x.campName).replace(/\s*캠프$/, '') + ' ' + frJoin_(x.all) + (x.newCamp ? '(처음 캠프)' : '(' + frJoin_(x.units) + ' 처음)'); }).join(' · ');
    const content = (title + ' — ' + body).slice(0, 900);
    const key = '내일 ' + frDayText_(date) + ' 처음 가는 기사';
    const same = readAll_(SH.MEMO).filter(function (m) { return (normDate_(m.date) || m.date) === today && str_(m.content).indexOf(key) === 0; })[0];
    if (same) { if (str_(same.content) !== content) writeFields_(SH.MEMO, same._row, { content: content, done: '', updatedAt: now }); return; }
    appendObj_(SH.MEMO, { id: newMemoId_(), date: today, time: '', content: content, done: '', cat: '', author: '자동 알림', createdAt: now, updatedAt: now });
  } catch (e) { softFail_('처음 가는 노선 업무스케줄 메모 실패', e); }
}
