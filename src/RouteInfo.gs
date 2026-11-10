/**
 * 노선 정보 (기사 앱 → 내 스케줄 → 내 캠프 아래 '노선 정보')
 *  - 노선관리의 캠프 참고 이미지(camp_images)를 기사도 본다 (미리보기 camp_thumbs · 누르면 큰 이미지).
 *  - 기사들이 라우트별(또는 캠프 전체) 정보를 자유롭게 쓰고 읽는다 → route_notes 탭.
 *    본인 글만 고치기·지우기. 관리자는 노선관리 → 캠프 → '기사 노선 정보'에서 숨기기/되살리기.
 *    게시판 금지어·글쓰기 정지(board_words · board_bans)를 같이 쓴다.
 *  - 로그인한 기사는 모든 캠프의 노선 정보를 볼 수 있다 (백업 기사는 날마다 다른 캠프에 들어가므로).
 */
const RN_ST = { OPEN: '공개', HIDE: '숨김' };
const RN_MAX = 1000;

function rnCampOf_(campId) {
  const c = master_().camps.filter(function (x) { return x.id === String(campId || ''); })[0];
  if (!c) fail_('캠프를 찾을 수 없습니다. 새로고침해 주세요.');
  return c;
}
/** 캠프의 라우트 코드 (사용 중 노선 · 글자별로 펼침: 527ABCD → 527A, 527B …) */
function rnRoutes_(campId) {
  const seen = {}, out = [];
  master_().routes.forEach(function (r) {
    if (r.campId !== campId || r.status === RST.OFF) return;
    const letters = [r.g2, r.g3, r.g4, r.g5].filter(Boolean);
    (letters.length && r.g1 ? letters.map(function (l) { return r.g1 + l; }) : [r.code]).forEach(function (c) { if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
  });
  return out.sort(function (a, b) { return a.localeCompare(b, 'ko', { numeric: true }); });
}
function rnView_(o, me) {
  return { id: o.id, route: o.route || '', text: o.text, author: o.author, mine: !!me && o.authorId === me, at: o.updatedAt || o.createdAt, edited: !!(o.updatedAt && o.updatedAt !== o.createdAt), hidden: o.status === RN_ST.HIDE };
}
function rnNotes_(campId) {
  let all = [];
  try { all = readAll_(SH.RNOTE); } catch (e) { all = []; }
  return all.filter(function (o) { return o.id && o.campId === campId; })
    .sort(function (a, b) { return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)); });
}

/** 기사 앱: 캠프 노선 정보 (이미지 목록 + 미리보기 + 라우트 + 기사 글) */
function api_routeInfo(token, campId) {
  return run_(function () {
    const u = pmUser_(token);
    const c = rnCampOf_(campId);
    const thumbs = {};
    try { readAll_(SH.CTHUMB).forEach(function (x) { if (x.campId === c.id && x.data) thumbs[x.id] = x.data; }); } catch (e) { /* 미리보기 없음 */ }
    const images = master_().images.filter(function (im) { return im.campId === c.id; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .map(function (im) { return { id: im.id, desc: im.desc || '', thumb: thumbs[im.id] || '' }; });
    const notes = rnNotes_(c.id).filter(function (o) { return o.status !== RN_ST.HIDE; }).slice(0, 300).map(function (o) { return rnView_(o, u.id); });
    return { ok: true, campId: c.id, camp: String(c.name).replace(/\s*캠프\s*$/, '').trim(), address: c.address || '', routes: rnRoutes_(c.id), images: images, notes: notes };
  });
}
/** 기사 앱: 참고 이미지 크게 */
function api_campImage(token, id) {
  return run_(function () {
    pmUser_(token);
    const r = campImageData_(id, true);
    delete r.url; // 드라이브 주소는 기사 앱에 주지 않는다
    return r;
  });
}
/** 기사 앱: 쓰기·고치기. n = { id?, campId, route, text } */
function api_routeNoteSave(token, n) {
  return run_(function () {
    const u = pmUser_(token);
    bdCanWrite_(u);
    n = n || {};
    const text = str_(n.text).trim();
    if (!text) fail_('내용을 입력해 주세요.');
    if (text.length > RN_MAX) fail_('내용은 ' + RN_MAX + '자까지 쓸 수 있습니다.');
    bdCheck_(text);
    const route = str_(n.route).toUpperCase().replace(/\s+/g, '').slice(0, 20);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const now = nowText_();
      if (n.id) {
        const row = findRow_(SH.RNOTE, 'id', String(n.id));
        if (!row) fail_('글을 찾을 수 없습니다. 새로고침해 주세요.');
        const o = readObj_(SH.RNOTE, row);
        if (o.authorId !== u.id) fail_('내가 쓴 글만 고칠 수 있습니다.');
        if (o.status === RN_ST.HIDE) fail_('관리자가 숨긴 글은 고칠 수 없습니다.');
        writeFields_(SH.RNOTE, row, { route: route, text: text, updatedAt: now });
        return { ok: true, note: rnView_(readObj_(SH.RNOTE, row), u.id) };
      }
      const c = rnCampOf_(n.campId);
      const r = appendObj_(SH.RNOTE, { id: uniqId_('N'), campId: c.id, campName: c.name, route: route, text: text, authorId: u.id, author: u.info.name, status: RN_ST.OPEN, createdAt: now, updatedAt: now });
      return { ok: true, note: rnView_(readObj_(SH.RNOTE, r), u.id) };
    } finally {
      lock.releaseLock();
    }
  });
}
/** 기사 앱: 내 글 지우기 */
function api_routeNoteDel(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.RNOTE, 'id', String(id || ''));
      if (!row) return { ok: true };
      if (readObj_(SH.RNOTE, row).authorId !== u.id) fail_('내가 쓴 글만 지울 수 있습니다.');
      sheet_(SH.RNOTE).deleteRow(row);
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}

/** 관리자: 캠프의 기사 노선 정보 (숨긴 글 포함) */
function adm_routeNotes(token, campId) {
  return run_(function () {
    requireAdmin_(token);
    return { ok: true, notes: rnNotes_(String(campId || '')).map(function (o) { return Object.assign(rnView_(o, ''), { authorId: o.authorId, createdAt: o.createdAt }); }) };
  });
}
/** 관리자: 숨기기·되살리기 (hide=true/false) 또는 지우기 (del=true) */
function adm_routeNoteSet(token, id, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    p = p || {};
    const lock = scriptLock_();
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.RNOTE, 'id', String(id || ''));
      if (!row) fail_('글을 찾을 수 없습니다. 새로고침해 주세요.');
      const o = readObj_(SH.RNOTE, row);
      if (p.del) { sheet_(SH.RNOTE).deleteRow(row); logAdmin_(a, '기사 노선 정보 삭제', o.author, (o.route || '캠프 전체') + ' · ' + str_(o.text).slice(0, 40)); return { ok: true }; }
      writeFields_(SH.RNOTE, row, { status: p.hide ? RN_ST.HIDE : RN_ST.OPEN });
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  });
}
