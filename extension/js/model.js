// One tree, two sources: the browser's bookmarks (chrome.bookmarks) and My Shelf (local.js).
// Everything the UI does goes through here, and every mutation hands back an undo function.

import { local, isLocal, isFileUrl, blobIdOf, ROOT as SHELF_ROOT } from './local.js';
import { noteOf } from './notes.js';

const B = chrome.bookmarks;
const apiFor = (id) => (isLocal(id) ? local : B);

export { isLocal, SHELF_ROOT };
export const model = { root: null, byId: new Map() };

export async function load() {
  const [[root], shelf] = await Promise.all([B.getTree(), local.getTree()]);
  root.children.push(shelf);
  const byId = new Map();
  (function walk(n, parent) {
    n.parent = parent;
    byId.set(n.id, n);
    for (const c of n.children || []) walk(c, n);
  })(root, null);
  model.root = root;
  model.byId = byId;
  return model;
}

export const node = (id) => model.byId.get(id) || null;
export const isFolder = (n) => !!n && !n.url;
export const isFile = (n) => !!n && isFileUrl(n.url);
export const kids = (id) => node(id)?.children || [];
// The top-level folders (Bookmarks Bar, Other…, My Shelf) can't be renamed, moved or removed.
export const isLocked = (n) => !n || !n.parent || n.parent.id === model.root.id || !!n.unmodifiable;

export function pathTo(id) {
  const out = [];
  for (let n = node(id); n && n.parent; n = n.parent) out.unshift(n);
  return out;
}

export function isInside(id, ancestorId) {
  for (let n = node(id); n; n = n.parent) if (n.id === ancestorId) return true;
  return false;
}

export function countUrls(n) {
  if (n.url) return 1;
  let c = 0;
  for (const k of n.children || []) c += countUrls(k);
  return c;
}

export function firstUrls(n, max, out = []) {
  for (const k of n.children || []) {
    if (out.length >= max) break;
    if (k.url) out.push(k);
    else firstUrls(k, max, out);
  }
  return out;
}

const hasFiles = (n) => (n.url ? isFile(n) : (n.children || []).some(hasFiles));

// Files can only live in My Shelf; a folder can't go inside itself.
export function canDrop(ids, targetId) {
  if (ids.some((id) => isInside(targetId, id))) return false;
  if (!isLocal(targetId) && ids.some((id) => hasFiles(node(id)))) return false;
  return true;
}

// Folders under the same top-level source as `id` (browser bookmarks or My Shelf).
export function allFolders(sameSourceAs = null) {
  const wantLocal = sameSourceAs == null ? null : isLocal(sameSourceAs);
  const out = [];
  (function walk(n, depth) {
    for (const k of n.children || []) {
      if (k.url) continue;
      if (wantLocal != null && isLocal(k.id) !== wantLocal) continue;
      out.push({ node: k, depth });
      walk(k, depth + 1);
    }
  })(model.root, 0);
  return out;
}

export function search(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const n of model.byId.values()) {
    if (!n.parent || isLocked(n)) continue;
    const hay = `${n.title} ${isFile(n) ? n.file?.name || '' : n.url || ''} ${n.url ? noteOf(n.url) : ''}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) out.push(n);
  }
  return out.sort((a, b) => !!a.url - !!b.url || a.title.localeCompare(b.title));
}

// ---------- operations ----------

// Deep copy of a subtree, including file blobs, so it can be rebuilt after a delete or carried
// across to the other source.
async function snapshot(n) {
  const snap = { title: n.title, url: n.url, children: null };
  if (isFile(n)) {
    snap.file = { ...n.file };
    snap.blob = await local.getBlob(blobIdOf(n.url));
  } else if (!n.url) {
    snap.children = [];
    for (const c of n.children || []) snap.children.push(await snapshot(c));
  }
  return snap;
}

async function recreate(snap, parentId, index) {
  const api = apiFor(parentId);
  const made = snap.file
    ? await api.create({ parentId, index, title: snap.title, file: snap.file, blob: snap.blob })
    : await api.create({ parentId, index, title: snap.title, url: snap.url });
  for (const c of snap.children || []) await recreate(c, made.id);
  return made;
}

const destroy = (n) => (n.url ? apiFor(n.id).remove(n.id) : apiFor(n.id).removeTree(n.id));

// Both sources take the index as it is *before* the node is lifted out, so
// "put it in front of this sibling" is simply that sibling's current index.
async function indexBefore(parentId, anchorId) {
  const sibs = await apiFor(parentId).getChildren(parentId);
  const at = anchorId ? sibs.findIndex((s) => s.id === anchorId) : -1;
  return at === -1 ? sibs.length : at;
}

async function enforceOrder(parentId, wanted) {
  const api = apiFor(parentId);
  const cur = (await api.getChildren(parentId)).map((c) => c.id);
  let t = 0;
  for (const id of wanted) {
    const at = cur.indexOf(id);
    if (at === -1) continue;
    if (at !== t) {
      await api.move(id, { parentId, index: t }); // always moving toward the front: no index quirk
      cur.splice(at, 1);
      cur.splice(t, 0, id);
    }
    t++;
  }
}

// Move ids (in display order) into parentId, in front of anchorId (or to the end). Moving between
// the browser and My Shelf means rebuilding the item on the other side. Returns an undo fn.
export async function moveMany(ids, parentId, anchorId = null) {
  const parents = new Set([parentId]);
  const home = new Map(); // id -> { parentId, index }
  for (const id of ids) {
    const n = node(id);
    if (!n) continue;
    home.set(id, { parentId: n.parent.id, index: n.index });
    parents.add(n.parent.id);
  }
  const before = new Map();
  for (const p of parents) before.set(p, (await apiFor(p).getChildren(p)).map((c) => c.id));

  const carried = []; // items rebuilt on the other side: { newId, home }
  for (const id of ids) {
    if (!home.has(id)) continue;
    const index = await indexBefore(parentId, anchorId);
    if (isLocal(id) === isLocal(parentId)) {
      await apiFor(parentId).move(id, { parentId, index });
    } else {
      const n = node(id);
      const made = await recreate(await snapshot(n), parentId, index);
      await destroy(n);
      carried.push({ newId: made.id, home: home.get(id) });
      home.delete(id);
    }
  }

  return async () => {
    for (const [id, h] of home) {
      if (h.parentId !== parentId) await apiFor(h.parentId).move(id, { parentId: h.parentId }).catch(() => {});
    }
    for (const [p, order] of before) await enforceOrder(p, order).catch(() => {});
    await load();
    for (const c of carried.sort((a, b) => a.home.index - b.home.index)) {
      const n = node(c.newId);
      if (!n) continue;
      const count = (await apiFor(c.home.parentId).getChildren(c.home.parentId)).length;
      await recreate(await snapshot(n), c.home.parentId, Math.min(c.home.index, count));
      await destroy(n);
    }
  };
}

export async function removeMany(ids) {
  // Skip anything already covered by a selected ancestor.
  const top = ids.filter((id) => node(id) && !ids.some((o) => o !== id && isInside(id, o)));
  const snaps = [];
  for (const id of top) {
    const n = node(id);
    snaps.push({ snap: await snapshot(n), parentId: n.parent.id, index: n.index });
  }
  snaps.sort((a, b) => a.index - b.index);
  for (const id of top) await destroy(node(id));
  return async () => {
    for (const s of snaps) {
      const count = (await apiFor(s.parentId).getChildren(s.parentId).catch(() => null))?.length;
      if (count == null) continue;
      await recreate(s.snap, s.parentId, Math.min(s.index, count));
    }
  };
}

export async function create({ parentId, title, url, index, file, blob }) {
  const made = await apiFor(parentId).create(file ? { parentId, title, index, file, blob } : { parentId, title, url, index });
  const undo = () =>
    isLocal(made.id) ? local.removeTree(made.id) : B.remove(made.id).catch(() => B.removeTree(made.id));
  return { made, undo };
}

export async function update(id, changes) {
  const n = node(id);
  const prev = { title: n.title, ...(n.url && !isFile(n) ? { url: n.url } : {}) };
  if (isFile(n)) delete changes.url;
  await apiFor(id).update(id, changes);
  return () => apiFor(id).update(id, prev);
}
