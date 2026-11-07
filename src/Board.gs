/**
 * 자유게시판 — 기사끼리 글·댓글을 나누는 공간 (회사 공지는 공지사항에서)
 *
 *  말머리: 자유 / 정보 / 질문 / 중고·나눔. 작성자는 실명(기사 이름). 쓰면 바로 공개.
 *  신고 3건이면 자동 숨김 → 관리자가 '게시판 관리'에서 복구·삭제. 관리자는 기사 글쓰기 정지도 할 수 있다.
 *  금칙어(board_words 탭 + 기본 목록)가 들어간 글·댓글은 저장하지 않는다.
 *  데이터: 러너 올인원 DB 의 board_posts · board_comments · board_reports · board_bans · board_words 탭 (시트에서 직접 고쳐도 됨)
 */
const BD_CATS = ['자유', '정보', '질문', '중고·나눔'];
const BD_ST = { OPEN: '공개', HIDE: '숨김', DEL: '삭제' };
const BD_REPORT_HIDE = 3;      // 신고가 이만큼 쌓이면 자동 숨김
const BD_PAGE = 20;
const BD_WORDS_DEFAULT = ['씨발', '시발', '병신', '개새끼', '좆', '지랄', '미친놈', '미친년', '꺼져', '새끼야'];

function bdTouch_() { fsMark_('nb'); try { cache_().put('bd:v', String(Date.now()) + Math.random().toString(36).slice(2, 5), CFG.CACHE_MAX); } catch (e) { /* 무시 */ } }
function bdVer_() { return cache_().get('bd:v') || '0'; }
/** 글·댓글 전체 (1분 캐시, 쓰면 바로 버림) */
function bdData_() {
  const key = 'bd:d:' + bdVer_();
  const hit = typeof stlCGet_ === 'function' ? stlCGet_(key) : null;
  if (hit) return hit;
  const posts = readAll_(SH.BPOST).filter(function (o) { return o.id; }).map(function (o) { delete o._row; return o; });
  const cmts = readAll_(SH.BCMT).filter(function (o) { return o.id && o.postId; }).map(function (o) { delete o._row; return o; });
  const d = { posts: posts, cmts: cmts };
  if (typeof stlCPut_ === 'function') stlCPut_(key, d, 60);
  return d;
}
function bdLikes_(p) { return str_(p.likes).split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
function bdStatus_(o) { return o.status === BD_ST.HIDE || o.status === BD_ST.DEL ? o.status : BD_ST.OPEN; }
/** 글쓰기 정지 중인지 → 정지 정보 또는 null */
function bdBanOf_(driverId) {
  const today = todayText_();
  return readAll_(SH.BBAN).filter(function (b) { return b.driverId === driverId && (!b.until || normDate_(b.until) >= today); })[0] || null;
}
function bdWords_() {
  const list = BD_WORDS_DEFAULT.slice();
  try { readAll_(SH.BWORD).forEach(function (w) { if (str_(w.word)) list.push(str_(w.word)); }); } catch (e) { /* 탭 없음 */ }
  return list;
}
/** 글·댓글 내용 검사: 금칙어 · 너무 긺 */
function bdCheck_(text) {
  const flat = str_(text).replace(/\s+/g, '');
  const hit = bdWords_().filter(function (w) { return w && flat.indexOf(w.replace(/\s+/g, '')) >= 0; })[0];
  if (hit) fail_('쓸 수 없는 말이 들어 있습니다 ("' + hit.slice(0, 1) + '…"). 고친 뒤 다시 올려 주세요.');
}
function bdCanWrite_(u) {
  const b = bdBanOf_(u.id);
  if (b) fail_('게시판 글쓰기가 정지되었습니다' + (b.until ? ' (' + normDate_(b.until) + '까지)' : '') + '. 사무실에 문의해 주세요.');
}
function bdPostById_(id) {
  const row = findRow_(SH.BPOST, 'id', String(id || ''));
  if (!row) fail_('글을 찾을 수 없습니다. 지워진 글일 수 있습니다.');
  return { row: row, p: readObj_(SH.BPOST, row) };
}
/** 목록 카드 */
function bdCard_(p, me) {
  const likes = bdLikes_(p);
  return {
    id: p.id, cat: p.cat, title: p.title, author: p.author, mine: p.authorId === me, at: p.createdAt, edited: p.updatedAt && p.updatedAt !== p.createdAt,
    cmts: Number(p.cmts) || 0, likes: likes.length, liked: likes.indexOf(me) >= 0, hasAttach: !!p.attach, status: bdStatus_(p),
    snippet: str_(p.body).replace(/\s+/g, ' ').slice(0, 80)
  };
}
/** 알림 1건 (품앗이 알림·휴대폰 푸시를 그대로 씀). jobId = 'BD-글ID' → 앱에서 그 글을 연다 */
function bdA_(driverId, name, postId, title, text) {
  return { driverId: String(driverId || ''), name: name || '', jobId: 'BD-' + postId, kind: 'board', title: title, text: text };
}

// ───────────────────────── 기사 앱 ─────────────────────────
/** 목록. f = { cat, q, page, mine } */
function api_bdList(token, f) {
  return run_(function () {
    const u = pmUser_(token);
    f = f || {};
    const d = bdData_(), q = str_(f.q).replace(/\s+/g, '').toLowerCase();
    const order = {};
    d.posts.forEach(function (p, i) { order[p.id] = i; });
    const list = d.posts.filter(function (p) {
      const st = bdStatus_(p);
      if (st === BD_ST.DEL) return false;
      if (st === BD_ST.HIDE && p.authorId !== u.id) return false;
      if (f.cat && f.cat !== '전체' && p.cat !== f.cat) return false;
      if (f.mine && p.authorId !== u.id) return false;
      if (q && (str_(p.title) + str_(p.body) + str_(p.author)).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) || order[b.id] - order[a.id]; });
    const page = Math.max(0, Number(f.page) || 0);
    const ban = bdBanOf_(u.id);
    return {
      ok: true, cats: BD_CATS, total: list.length, page: page, more: list.length > (page + 1) * BD_PAGE,
      posts: list.slice(page * BD_PAGE, (page + 1) * BD_PAGE).map(function (p) { return bdCard_(p, u.id); }),
      banned: ban ? (ban.until ? normDate_(ban.until) + '까지' : '정지 중') : ''
    };
  });
}
/** 홈 화면: 최근 글 3개 (공개 글만) */
function api_bdRecent(token) {
  return run_(function () {
    const u = pmUser_(token);
    const d = bdData_(), order = {};
    d.posts.forEach(function (p, i) { order[p.id] = i; });
    const list = d.posts.filter(function (p) { return bdStatus_(p) === BD_ST.OPEN; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) || order[b.id] - order[a.id]; })
      .slice(0, 3).map(function (p) { return bdCard_(p, u.id); });
    return { ok: true, posts: list };
  });
}
/** 글 하나 + 댓글 */
function api_bdPost(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const d = bdData_();
    const p = d.posts.filter(function (x) { return x.id === id; })[0];
    if (!p || bdStatus_(p) === BD_ST.DEL || (bdStatus_(p) === BD_ST.HIDE && p.authorId !== u.id)) fail_('글을 찾을 수 없습니다. 지워졌거나 가려진 글입니다.');
    const out = bdCard_(p, u.id);
    out.body = p.body;
    const reported = {};
    try { readAll_(SH.BREP).forEach(function (r) { if (r.reporterId === u.id) reported[r.kind + '|' + r.targetId] = 1; }); } catch (e) { /* 무시 */ }
    out.reported = !!reported['글|' + p.id];
    out.comments = d.cmts.filter(function (c) { return c.postId === p.id && bdStatus_(c) !== BD_ST.DEL; })
      .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
      .map(function (c) {
        const hid = bdStatus_(c) === BD_ST.HIDE;
        return { id: c.id, parentId: c.parentId || '', author: c.author, mine: c.authorId === u.id, at: c.createdAt, body: hid && c.authorId !== u.id ? '' : c.body, hidden: hid, reported: !!reported['댓글|' + c.id] };
      });
    return { ok: true, post: out, cats: BD_CATS };
  });
}
/** 글쓰기·수정. post = { id, cat, title, body, attach: { data, mime } | null, removeAttach } */
function api_bdSave(token, post) {
  return run_(function () {
    const u = pmUser_(token);
    bdCanWrite_(u);
    post = post || {};
    const f = { cat: str_(post.cat), title: str_(post.title).trim(), body: str_(post.body).trim() };
    if (BD_CATS.indexOf(f.cat) < 0) fail_('말머리를 골라 주세요.');
    if (!f.title) fail_('제목을 입력해 주세요.');
    if (f.title.length > 60) fail_('제목은 60자까지 쓸 수 있습니다.');
    if (!f.body) fail_('내용을 입력해 주세요.');
    if (f.body.length > 3000) fail_('내용은 3,000자까지 쓸 수 있습니다.');
    bdCheck_(f.title + ' ' + f.body);
    let attachUrl = null;
    if (post.attach && post.attach.data) {
      if (!/^image\//.test(String(post.attach.mime))) fail_('사진(이미지)만 올릴 수 있습니다.');
      if (String(post.attach.data).length > CFG.MAX_FILE_B64) fail_('사진이 너무 큽니다.');
      const ext = /png/.test(post.attach.mime) ? '.png' : '.jpg';
      const file = bdFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(post.attach.data), post.attach.mime, (todayText_() + '_' + u.info.name + '_' + f.title).replace(/[\\\/:*?"<>|]/g, ' ').slice(0, 80) + ext));
      attachUrl = file.getUrl();
    }
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (post.id) {
        const x = bdPostById_(post.id);
        if (x.p.authorId !== u.id) fail_('내가 쓴 글만 고칠 수 있습니다.');
        if (bdStatus_(x.p) === BD_ST.DEL) fail_('지워진 글입니다.');
        if (attachUrl) f.attach = attachUrl; else if (post.removeAttach) f.attach = '';
        f.updatedAt = now;
        writeFields_(SH.BPOST, x.row, f);
        bdTouch_();
        return { ok: true, id: x.p.id };
      }
      const id = uniqId_('P');
      appendObj_(SH.BPOST, Object.assign({ id: id, authorId: u.id, author: u.info.name, attach: attachUrl || '', status: BD_ST.OPEN, likes: '', cmts: '0', reports: '0', createdAt: now, updatedAt: now }, f));
      bdTouch_();
      return { ok: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}
function bdFolder_() {
  const p = props_();
  if (p.BD_FOLDER) { try { return DriveApp.getFolderById(p.BD_FOLDER); } catch (e) { /* 새로 */ } }
  const root = DriveApp.getFolderById(p.ROOT_FOLDER_ID), it = root.getFoldersByName ? root.getFoldersByName('자유게시판 첨부') : null;
  const f = it && it.hasNext() ? it.next() : root.createFolder('자유게시판 첨부');
  PropertiesService.getScriptProperties().setProperty('BD_FOLDER', f.getId());
  _props = null;
  return f;
}
/** 내 글 지우기 (상태만 '삭제' — 시트에는 남음) */
function api_bdDelete(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const x = bdPostById_(id);
      if (x.p.authorId !== u.id) fail_('내가 쓴 글만 지울 수 있습니다.');
      writeFields_(SH.BPOST, x.row, { status: BD_ST.DEL, updatedAt: nowText_() });
      bdTouch_();
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}
/** 첨부 사진 보기 */
function api_bdAttach(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const p = bdData_().posts.filter(function (x) { return x.id === id; })[0];
    if (!p || bdStatus_(p) === BD_ST.DEL || (bdStatus_(p) === BD_ST.HIDE && p.authorId !== u.id)) fail_('글을 찾을 수 없습니다.');
    const fid = fileIdOf_(p.attach);
    if (!fid) fail_('사진이 없습니다.');
    let file;
    try { file = DriveApp.getFileById(fid); } catch (e) { fail_('사진을 열 수 없습니다.'); }
    let blob = null;
    if (file.getSize() > 600 * 1024) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
    if (!blob) blob = file.getBlob();
    return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
  });
}
/** 댓글 (parentId = 답글 대상 댓글) → 글쓴이·원댓글 작성자에게 알림 */
function api_bdComment(token, postId, body, parentId) {
  return run_(function () {
    const u = pmUser_(token);
    bdCanWrite_(u);
    body = str_(body).trim();
    if (!body) fail_('댓글을 입력해 주세요.');
    if (body.length > 500) fail_('댓글은 500자까지 쓸 수 있습니다.');
    bdCheck_(body);
    const lock = scriptLock_(), out = [];
    lock.waitLock(20000);
    try {
      const x = bdPostById_(postId);
      if (bdStatus_(x.p) !== BD_ST.OPEN) fail_('댓글을 달 수 없는 글입니다.');
      let parent = null;
      if (parentId) {
        const pr = findRow_(SH.BCMT, 'id', String(parentId));
        parent = pr ? readObj_(SH.BCMT, pr) : null;
        if (!parent || parent.postId !== x.p.id) parentId = '';
        else if (parent.parentId) parentId = parent.parentId; // 답글의 답글은 같은 묶음으로
      }
      const now = nowText_();
      appendObj_(SH.BCMT, { id: uniqId_('C'), postId: x.p.id, parentId: parentId || '', authorId: u.id, author: u.info.name, body: body, status: BD_ST.OPEN, reports: '0', createdAt: now, updatedAt: now });
      writeFields_(SH.BPOST, x.row, { cmts: String((Number(x.p.cmts) || 0) + 1) });
      const short = (x.p.title || '').slice(0, 20);
      if (x.p.authorId !== u.id) out.push(bdA_(x.p.authorId, x.p.author, x.p.id, '💬 새 댓글', u.info.name + ' 기사님이 "' + short + '" 글에 댓글을 달았습니다: ' + body.slice(0, 40)));
      if (parent && parent.authorId !== u.id && parent.authorId !== x.p.authorId) out.push(bdA_(parent.authorId, parent.author, x.p.id, '↪️ 새 답글', u.info.name + ' 기사님이 내 댓글에 답글을 달았습니다: ' + body.slice(0, 40)));
      pmAlertAdd_(out);
      bdTouch_();
      return { ok: true };
    } finally {
      lock.releaseLock();
      pmAfter_(out);
    }
  });
}
function api_bdCommentDel(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.BCMT, 'id', String(id || ''));
      const c = row ? readObj_(SH.BCMT, row) : null;
      if (!c || c.authorId !== u.id) fail_('내가 쓴 댓글만 지울 수 있습니다.');
      if (bdStatus_(c) !== BD_ST.DEL) {
        writeFields_(SH.BCMT, row, { status: BD_ST.DEL, updatedAt: nowText_() });
        const pr = findRow_(SH.BPOST, 'id', c.postId);
        if (pr) { const p = readObj_(SH.BPOST, pr); writeFields_(SH.BPOST, pr, { cmts: String(Math.max(0, (Number(p.cmts) || 0) - 1)) }); }
      }
      bdTouch_();
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}
/** 좋아요 (한 번 더 누르면 취소) */
function api_bdLike(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const x = bdPostById_(id);
      const likes = bdLikes_(x.p), i = likes.indexOf(u.id);
      if (i >= 0) likes.splice(i, 1); else likes.push(u.id);
      writeFields_(SH.BPOST, x.row, { likes: likes.join(',') });
      bdTouch_();
      return { ok: true, liked: i < 0, likes: likes.length };
    } finally { lock.releaseLock(); }
  });
}
/** 신고: kind = '글' | '댓글'. 한 사람 한 번. 3건이면 자동 숨김 */
function api_bdReport(token, kind, id, reason) {
  return run_(function () {
    const u = pmUser_(token);
    if (kind !== '글' && kind !== '댓글') fail_('신고할 대상을 확인해 주세요.');
    reason = str_(reason).trim().slice(0, 200);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const sh = kind === '글' ? SH.BPOST : SH.BCMT;
      const row = findRow_(sh, 'id', String(id || ''));
      const o = row ? readObj_(sh, row) : null;
      if (!o || bdStatus_(o) === BD_ST.DEL) fail_('지워진 글입니다.');
      if (o.authorId === u.id) fail_('내 글은 신고할 수 없습니다.');
      if (readAll_(SH.BREP).some(function (r) { return r.reporterId === u.id && r.kind === kind && r.targetId === o.id; })) fail_('이미 신고했습니다.');
      appendObj_(SH.BREP, { id: uniqId_('R'), kind: kind, targetId: o.id, postId: kind === '글' ? o.id : o.postId, reporterId: u.id, reporter: u.info.name, reason: reason, status: '대기', createdAt: nowText_() });
      const n = (Number(o.reports) || 0) + 1, f = { reports: String(n) };
      if (n >= BD_REPORT_HIDE && bdStatus_(o) === BD_ST.OPEN) f.status = BD_ST.HIDE;
      writeFields_(sh, row, f);
      bdTouch_();
      return { ok: true, hidden: !!f.status };
    } finally { lock.releaseLock(); }
  });
}

// ───────────────────────── 관리자: 게시판 관리 ─────────────────────────
/** 목록. f = { status: 전체|공개|숨김|삭제|신고, q } + 대기 중인 신고 · 글쓰기 정지 목록 */
function adm_bdList(token, f) {
  return run_(function () {
    requireAdmin_(token);
    f = f || {};
    const d = bdData_(), q = str_(f.q).replace(/\s+/g, '').toLowerCase();
    const reps = readAll_(SH.BREP).filter(function (r) { return r.id; });
    const waitBy = {};
    reps.forEach(function (r) { if (r.status !== '처리') waitBy[r.postId] = (waitBy[r.postId] || 0) + 1; });
    const count = { 전체: d.posts.length, 공개: 0, 숨김: 0, 삭제: 0, 신고: 0 };
    d.posts.forEach(function (p) { count[bdStatus_(p)]++; if (waitBy[p.id]) count.신고++; });
    const list = d.posts.filter(function (p) {
      const st = bdStatus_(p);
      if (f.status === '신고') { if (!waitBy[p.id]) return false; }
      else if (f.status && f.status !== '전체' && st !== f.status) return false;
      if (q && (str_(p.title) + str_(p.body) + str_(p.author)).replace(/\s+/g, '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 500).map(function (p) {
      return { id: p.id, cat: p.cat, title: p.title, author: p.author, authorId: p.authorId, status: bdStatus_(p), cmts: Number(p.cmts) || 0, likes: bdLikes_(p).length, reports: Number(p.reports) || 0, wait: waitBy[p.id] || 0, at: p.createdAt, hasAttach: !!p.attach };
    });
    const today = todayText_();
    const bans = readAll_(SH.BBAN).filter(function (b) { return b.driverId && (!b.until || normDate_(b.until) >= today); })
      .map(function (b) { return { driverId: b.driverId, name: b.name, until: b.until ? normDate_(b.until) : '', memo: b.memo, at: b.createdAt }; });
    const drivers = readAll_(SH.DRIVERS).filter(function (o) { return o.id && o.status === ST.ACTIVE; }).map(function (o) { return { id: o.id, name: o.name }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
    return { ok: true, posts: list, count: count, bans: bans, drivers: drivers, cats: BD_CATS, words: bdWords_().length };
  });
}
/** 글 상세: 모든 댓글(숨김·삭제 포함) + 신고 + 첨부 링크 */
function adm_bdPost(token, id) {
  return run_(function () {
    requireAdmin_(token);
    const d = bdData_();
    const p = d.posts.filter(function (x) { return x.id === id; })[0];
    if (!p) fail_('글을 찾을 수 없습니다.');
    const reps = readAll_(SH.BREP).filter(function (r) { return r.postId === p.id; }).map(function (r) { return { id: r.id, kind: r.kind, targetId: r.targetId, reporter: r.reporter, reason: r.reason, status: r.status || '대기', at: r.createdAt }; });
    return {
      ok: true, post: Object.assign({}, p, { status: bdStatus_(p), likes: bdLikes_(p).length }),
      comments: d.cmts.filter(function (c) { return c.postId === p.id; }).sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
        .map(function (c) { return { id: c.id, parentId: c.parentId, author: c.author, authorId: c.authorId, body: c.body, status: bdStatus_(c), reports: Number(c.reports) || 0, at: c.createdAt }; }),
      reports: reps
    };
  });
}
/** 처리: kind = '글'|'댓글', action = hide / show / delete. 그 대상의 신고는 '처리'로 */
function adm_bdAction(token, kind, id, action) {
  return run_(function () {
    const a = requireAdmin_(token);
    const st = { hide: BD_ST.HIDE, show: BD_ST.OPEN, delete: BD_ST.DEL }[action];
    if (!st || (kind !== '글' && kind !== '댓글')) fail_('알 수 없는 작업입니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const sh = kind === '글' ? SH.BPOST : SH.BCMT;
      const row = findRow_(sh, 'id', String(id || ''));
      if (!row) fail_('찾을 수 없습니다. 새로고침해 주세요.');
      const o = readObj_(sh, row), was = bdStatus_(o);
      const f = { status: st, updatedAt: nowText_() };
      if (action === 'show') f.reports = '0';
      writeFields_(sh, row, f);
      if (kind === '댓글' && (was === BD_ST.DEL) !== (st === BD_ST.DEL)) {
        const pr = findRow_(SH.BPOST, 'id', o.postId);
        if (pr) { const p = readObj_(SH.BPOST, pr); writeFields_(SH.BPOST, pr, { cmts: String(Math.max(0, (Number(p.cmts) || 0) + (st === BD_ST.DEL ? -1 : 1))) }); }
      }
      readAll_(SH.BREP).forEach(function (r) { if (r.kind === kind && r.targetId === o.id && r.status !== '처리') writeFields_(SH.BREP, r._row, { status: '처리' }); });
      bdTouch_();
      logAdmin_(a, '게시판 ' + kind + ' ' + ({ hide: '숨김', show: '공개', delete: '삭제' }[action]), o.id, String(o.title || o.body || '').slice(0, 40));
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}
/** 글쓰기 정지: days = 0 이면 계속, 해제는 unban */
function adm_bdBan(token, driverId, days, memo, unban) {
  return run_(function () {
    const a = requireAdmin_(token);
    const o = driverById_(str_(driverId));
    if (!o) fail_('기사를 찾을 수 없습니다.');
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const rows = readAll_(SH.BBAN).filter(function (b) { return b.driverId === o.id; }).map(function (b) { return b._row; }).sort(function (x, y) { return y - x; });
      delRows_(sheet_(SH.BBAN), rows);
      if (!unban) {
        const n = Number(days) || 0;
        appendObj_(SH.BBAN, { driverId: o.id, name: o.name, until: n > 0 ? ymd_(addDays_(new Date(), n - 1)) : '', memo: str_(memo).slice(0, 200), admin: a.name, createdAt: nowText_() });
      }
      bdTouch_();
      logAdmin_(a, unban ? '게시판 글쓰기 정지 해제' : '게시판 글쓰기 정지', o.name, unban ? '' : (Number(days) ? days + '일' : '계속') + ' ' + str_(memo));
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}
