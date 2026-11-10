/**
 * 노선 정보 (기사 앱 → 내 스케줄 → 내 캠프 아래 '노선 정보')
 *  - 노선관리의 캠프 참고 이미지(camp_images)를 기사도 본다 (미리보기 camp_thumbs · 누르면 큰 이미지).
 *  - 기사들이 라우트별(또는 캠프 전체) 정보를 자유롭게 쓰고 읽는다 → route_notes 탭.
 *    본인 글만 고치기·지우기. 관리자는 노선관리 → 캠프 → '기사 노선 정보'에서 숨기기/되살리기.
 *    게시판 금지어·글쓰기 정지(board_words · board_bans)를 같이 쓴다.
 *  - 글마다 사진 4장까지 (드라이브 '노선 정보 사진' 폴더). photos 칸 = JSON [{ f: 파일ID, t: 작은 미리보기 base64 }].
 *    고칠 때 사진을 빼면 그 파일은 드라이브 휴지통으로. 글을 지워도 같이 휴지통으로.
 *  - 로그인한 기사는 모든 캠프의 노선 정보를 볼 수 있다 (백업 기사는 날마다 다른 캠프에 들어가므로).
 */
const RN_ST = { OPEN: '공개', HIDE: '숨김' };
const RN_MAX = 1000, RN_PH_MAX = 4;

function rnPhotos_(o) {
  try { const a = JSON.parse(str_(o.photos) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && x.f; }) : []; } catch (e) { return []; }
}
function rnFolder_() {
  const p = props_();
  if (p.RN_FOLDER) { try { const f = DriveApp.getFolderById(p.RN_FOLDER); if (!f.isTrashed()) return f; } catch (e) { /* 새로 */ } }
  const f = DriveApp.getFolderById(p.ROOT_FOLDER_ID).createFolder('노선 정보 사진');
  PropertiesService.getScriptProperties().setProperty('RN_FOLDER', f.getId());
  _props = null;
  return f;
}
/** 앱이 올린 사진(노선 정보 사진 폴더 안)만 휴지통으로 */
function rnTrash_(fileIds) {
  const folderId = props_().RN_FOLDER;
  (fileIds || []).forEach(function (fid) {
    if (!fid || !folderId) return;
    try {
      const file = DriveApp.getFileById(fid), ps = file.getParents();
      while (ps.hasNext()) if (ps.next().getId() === folderId) { file.setTrashed(true); return; }
    } catch (e) { /* 이미 없음 */ }
  });
}
/** 새 사진 올리기 (잠금 밖에서): 올린 것 [{ f, t }] */
function rnUpload_(items, camp, route, name) {
  return items.map(function (x, i) {
    if (!/^image\//.test(str_(x.mime))) fail_('사진(이미지)만 올릴 수 있습니다.');
    if (String(x.data).length > CFG.MAX_FILE_B64) fail_('사진이 너무 큽니다.');
    const fname = (todayText_() + '_' + camp + '_' + (route || '캠프전체') + '_' + name + '_' + (i + 1)).replace(/[\\\/:*?"<>|]/g, ' ') + (/png/.test(x.mime) ? '.png' : '.jpg');
    const file = rnFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(x.data), x.mime, fname));
    const t = str_(x.thumb);
    return { f: file.getId(), t: t.length <= 12000 && /^[A-Za-z0-9+/=]+$/.test(t) ? t : '' };
  });
}
/** photos 칸에 넣을 글자 (칸 한 개 5만 자 안쪽 — 넘치면 미리보기를 뺀다) */
function rnPhotoCell_(list) {
  let j = JSON.stringify(list);
  if (j.length > 45000) j = JSON.stringify(list.map(function (x) { return { f: x.f, t: '' }; }));
  return list.length ? j : '';
}

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
  return { id: o.id, route: o.route || '', text: o.text, photos: rnPhotos_(o), author: o.author, mine: !!me && o.authorId === me, at: o.updatedAt || o.createdAt, edited: !!(o.updatedAt && o.updatedAt !== o.createdAt), hidden: o.status === RN_ST.HIDE };
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
/**
 * 기사 앱: 쓰기·고치기. n = { id?, campId, route, text, photos: [{ f }(그대로 둘 사진) | { data, mime, thumb }(새 사진)] }
 * photos 를 안 보내면(undefined) 고칠 때 사진은 그대로.
 */
function api_routeNoteSave(token, n) {
  return run_(function () {
    const u = pmUser_(token);
    bdCanWrite_(u);
    n = n || {};
    const text = str_(n.text).trim();
    const ph = Array.isArray(n.photos) ? n.photos.slice(0, RN_PH_MAX + 1) : null;
    if (ph && ph.length > RN_PH_MAX) fail_('사진은 ' + RN_PH_MAX + '장까지 붙일 수 있습니다.');
    if (!text && !(ph && ph.length)) fail_('내용이나 사진을 넣어 주세요.');
    if (text.length > RN_MAX) fail_('내용은 ' + RN_MAX + '자까지 쓸 수 있습니다.');
    if (text) bdCheck_(text);
    const route = str_(n.route).toUpperCase().replace(/\s+/g, '').slice(0, 20);
    // 고칠 글 먼저 확인 (사진 올리기 전에)
    let old = null;
    if (n.id) {
      const row = findRow_(SH.RNOTE, 'id', String(n.id));
      if (!row) fail_('글을 찾을 수 없습니다. 새로고침해 주세요.');
      old = readObj_(SH.RNOTE, row);
      if (old.authorId !== u.id) fail_('내가 쓴 글만 고칠 수 있습니다.');
      if (old.status === RN_ST.HIDE) fail_('관리자가 숨긴 글은 고칠 수 없습니다.');
    }
    const c = old ? { id: old.campId, name: old.campName } : rnCampOf_(n.campId);
    const before = old ? rnPhotos_(old) : [];
    let photos = before, added = [];
    if (ph) {
      const keepIds = {}; ph.forEach(function (x) { if (x && x.f && !x.data) keepIds[String(x.f)] = 1; });
      const fresh = ph.filter(function (x) { return x && x.data; });
      added = fresh.length ? rnUpload_(fresh, String(c.name).replace(/\s*캠프\s*$/, ''), route, u.info.name) : [];
      let ai = 0;
      photos = ph.map(function (x) { return x && x.data ? added[ai++] : before.filter(function (b) { return b.f === String(x && x.f); })[0]; }).filter(Boolean);
    }
    const removed = before.filter(function (b) { return !photos.some(function (x) { return x.f === b.f; }); }).map(function (b) { return b.f; });
    const lock = scriptLock_();
    lock.waitLock(20000);
    let out;
    try {
      const now = nowText_();
      if (old) {
        const row = findRow_(SH.RNOTE, 'id', String(n.id));
        if (!row || readObj_(SH.RNOTE, row).authorId !== u.id) fail_('글을 찾을 수 없습니다. 새로고침해 주세요.');
        writeFields_(SH.RNOTE, row, { route: route, text: text, photos: rnPhotoCell_(photos), updatedAt: now });
        out = rnView_(readObj_(SH.RNOTE, row), u.id);
      } else {
        const r = appendObj_(SH.RNOTE, { id: uniqId_('N'), campId: c.id, campName: c.name, route: route, text: text, photos: rnPhotoCell_(photos), authorId: u.id, author: u.info.name, status: RN_ST.OPEN, createdAt: now, updatedAt: now });
        out = rnView_(readObj_(SH.RNOTE, r), u.id);
      }
    } catch (e) {
      rnTrash_(added.map(function (x) { return x.f; })); // 저장 실패 → 방금 올린 사진 정리
      throw e;
    } finally {
      lock.releaseLock();
    }
    rnTrash_(removed);
    return { ok: true, note: out };
  });
}
/** 기사 앱: 노선 정보 사진 크게 (그 글에 붙은 사진만) */
function api_routeNotePhoto(token, noteId, fileId) {
  return run_(function () {
    const u = pmUser_(token);
    const row = findRow_(SH.RNOTE, 'id', String(noteId || ''));
    const o = row ? readObj_(SH.RNOTE, row) : null;
    if (!o || (o.status === RN_ST.HIDE && o.authorId !== u.id)) fail_('글을 찾을 수 없습니다.');
    if (!rnPhotos_(o).some(function (x) { return x.f === String(fileId); })) fail_('사진을 찾을 수 없습니다.');
    let file;
    try { file = DriveApp.getFileById(String(fileId)); } catch (e) { fail_('사진을 열 수 없습니다.'); }
    let blob = null;
    if (file.getSize() > 1500 * 1024) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
    if (!blob) blob = file.getBlob();
    return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) };
  });
}
/** 기사 앱: 내 글 지우기 */
function api_routeNoteDel(token, id) {
  return run_(function () {
    const u = pmUser_(token);
    const lock = scriptLock_();
    let fids = [];
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.RNOTE, 'id', String(id || ''));
      if (!row) return { ok: true };
      const o = readObj_(SH.RNOTE, row);
      if (o.authorId !== u.id) fail_('내가 쓴 글만 지울 수 있습니다.');
      sheet_(SH.RNOTE).deleteRow(row);
      fids = rnPhotos_(o).map(function (x) { return x.f; });
    } finally {
      lock.releaseLock();
    }
    rnTrash_(fids);
    return { ok: true };
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
    let fids = [];
    lock.waitLock(20000);
    try {
      const row = findRow_(SH.RNOTE, 'id', String(id || ''));
      if (!row) fail_('글을 찾을 수 없습니다. 새로고침해 주세요.');
      const o = readObj_(SH.RNOTE, row);
      if (p.del) { sheet_(SH.RNOTE).deleteRow(row); logAdmin_(a, '기사 노선 정보 삭제', o.author, (o.route || '캠프 전체') + ' · ' + str_(o.text).slice(0, 40)); fids = rnPhotos_(o).map(function (x) { return x.f; }); return { ok: true }; }
      writeFields_(SH.RNOTE, row, { status: p.hide ? RN_ST.HIDE : RN_ST.OPEN });
      return { ok: true };
    } finally {
      lock.releaseLock();
      rnTrash_(fids);
    }
  });
}
