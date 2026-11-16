// ───────────────────────── 기사앱 메뉴 켜기 · 끄기 (올인원 설정 › 📱 기사앱) ─────────────────────────
// app_settings: appMenu = {"sched":1,"settle":1,"pm":1,"my":1} (없으면 모두 켬) · appMenuEx = ["기사ID", …] (꺼도 그대로 쓰는 사람)
// 끈 메뉴: 기사앱에 「준비 중」 · 그 메뉴의 자료 요청은 서버에서도 막음 · 그 메뉴 알림(휴대폰 포함)도 보내지 않음

const APP_MENUS = [['sched', '스케줄'], ['settle', '정산서'], ['pm', '품앗이'], ['my', '마이페이지']];
/** 서버 함수 → 메뉴 (끈 메뉴면 pmUser_ 에서 막음) */
const APP_MENU_FN = {
  api_mySettle: 'settle', api_mySlip: 'settle',
  api_pmList: 'pm', api_pmJob: 'pm', api_pmApply: 'pm', api_pmSave: 'pm', api_pmDecide: 'pm', api_pmAvailSave: 'pm', api_pmMine: 'pm',
  api_myPerf: 'my', api_myFb: 'my'
};
const APP_MENU_OFF_MSG = '해당 메뉴는 준비 중입니다.';

/** 전체 설정 { menu: {sched:true,…}, ex: [기사ID] } */
function appMenuCfg_() {
  const s = appSet_(), menu = {};
  let m = {}, ex = [];
  try { m = JSON.parse(s.appMenu || '{}') || {}; } catch (e) { m = {}; }
  try { ex = JSON.parse(s.appMenuEx || '[]') || []; } catch (e) { ex = []; }
  APP_MENUS.forEach(function (x) { menu[x[0]] = m[x[0]] === undefined ? true : !!m[x[0]]; });
  return { menu: menu, ex: ex.map(String) };
}
/** 이 기사에게 꺼진 메뉴 목록 (예외 기사는 없음) — ['settle', 'pm'] */
function appMenuOffFor_(driverId) {
  const c = appMenuCfg_();
  if (c.ex.indexOf(String(driverId)) >= 0) return [];
  return APP_MENUS.map(function (x) { return x[0]; }).filter(function (k) { return !c.menu[k]; });
}
/** 끈 메뉴의 자료 요청이면 막음 */
function menuGate_(driverId, k) {
  if (!k) return;
  if (appMenuOffFor_(driverId).indexOf(k) >= 0) { const e = new Error('x'); e.userMsg = APP_MENU_OFF_MSG; e.code = 'MENU_OFF'; throw e; }
}
/** 알림 받을 사람 걸러내기: 그 알림의 메뉴가 꺼진 기사는 뺌 (정산 알림 = settle · 나머지 품앗이 알림 = pm) */
/** 알림이 어느 메뉴 것인가: 정산서 · 기사스케줄(처음 가는 노선) · 게시판('') · 그 밖은 품앗이 */
function alertMenuOf_(a) { return a.kind === 'slip' ? 'settle' : a.kind === 'first' ? 'sched' : String(a.jobId || '').indexOf('BD-') === 0 ? '' : 'pm'; }
function menuAlertFilter_(list) {
  const c = appMenuCfg_();
  if (APP_MENUS.every(function (x) { return c.menu[x[0]]; })) return list;
  return (list || []).filter(function (a) {
    const k = alertMenuOf_(a);
    return !k || c.menu[k] || c.ex.indexOf(String(a.driverId)) >= 0;
  });
}

/** 관리자: 📱 기사앱 탭 읽기 */
function adm_appCfg(token) {
  return run_(function () {
    requireAdmin_(token);
    const c = appMenuCfg_();
    let cfg = {}; try { if (props_().STL_DB_ID) cfg = stlCfg_(); } catch (e) { cfg = {}; }
    const today = todayText_();
    let pmDone = [];
    try {
      pmDone = pmData_().jobs.filter(function (j) { return j.status === PST.DONE && pmDate_(j.date) >= today; })
        .map(function (j) { return { date: pmDate_(j.date), from: j.poster || '', to: j.accepted || '', route: str_(j.route) }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    } catch (e) { pmDone = []; }
    const drivers = readAll_(SH.DRIVERS).filter(function (d) { return d.id && d.status === ST.ACTIVE && !/퇴사/.test(str_(d.workStatus)); })
      .map(function (d) { return { id: d.id, name: d.name, title: d.title || '', loginId: d.loginId || '' }; });
    return {
      ok: true, menus: APP_MENUS, menu: c.menu, ex: c.ex, drivers: drivers, offMsg: APP_MENU_OFF_MSG,
      postOn: pmPostOn_(), offerOn: pmOfferOn_(), pmDone: pmDone,
      appShow: !!cfg.appOpen, appRange: str_(cfg.appRange || '전부'), ranges: typeof STL_APP_RANGES !== 'undefined' ? STL_APP_RANGES : []
    };
  });
}
/** 관리자: 메뉴 켜기·끄기 / 예외 기사 / 정산서 '마감 전 달도' 저장 — patch = { menu?, ex?, appShow? } */
function adm_appCfgSet(token, patch) {
  return run_(function () {
    const a = requireAdmin_(token);
    patch = patch || {};
    const c = appMenuCfg_(), done = [];
    if (patch.menu) {
      const m = {};
      APP_MENUS.forEach(function (x) { m[x[0]] = patch.menu[x[0]] === undefined ? (c.menu[x[0]] ? 1 : 0) : (patch.menu[x[0]] ? 1 : 0); });
      appSetPut_('appMenu', JSON.stringify(m), '기사앱 메뉴 켜기·끄기 (1 = 켬 · 0 = 준비 중) — 올인원 설정 › 기사앱');
      APP_MENUS.forEach(function (x) { if (!!m[x[0]] !== !!c.menu[x[0]]) done.push(x[1] + (m[x[0]] ? ' 켬' : ' 끔(준비 중)')); });
    }
    if (patch.ex) {
      const ids = patch.ex.map(String).filter(function (id) { return !!driverById_(id); });
      appSetPut_('appMenuEx', JSON.stringify(ids), '기사앱 메뉴를 꺼도 그대로 쓰는 기사ID — 올인원 설정 › 기사앱');
      done.push('예외 ' + ids.length + '명');
    }
    if (patch.appShow !== undefined && props_().STL_DB_ID) {
      const label = STL_CFG.filter(function (d) { return d[0] === 'appShow'; })[0][1], v = patch.appShow ? '계산 중인 달도' : '마감한 달만';
      const lock = scriptLock_();
      lock.waitLock(20000);
      try {
        stlCfg_();
        const rows = stlRead_('stl_config'), r = rows.filter(function (x) { return x.label === label; })[0];
        if (r) stlSetRow_('stl_config', r._row, { value: v }); else stlAppend_('stl_config', [{ label: label, value: v, desc: '' }]);
        stlBump_();
      } finally { lock.releaseLock(); }
      done.push('정산서 ' + v);
    }
    logAdmin_(a, '기사앱 메뉴 설정', done.join(', ').slice(0, 200), '');
    const n = appMenuCfg_();
    return { ok: true, menu: n.menu, ex: n.ex };
  });
}
