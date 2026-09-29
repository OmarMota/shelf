// "My Shelf": a personal library that lives inside the extension (IndexedDB), because browser
// bookmarks can only hold URLs. It deliberately speaks the same dialect as chrome.bookmarks
// (getTree / getChildren / create / move / update / remove / removeTree, same index rules), so the
// model layer can treat both trees alike.

import { open, txDone } from './db.js';

export const ROOT = 's:root';
export const FILE_SCHEME = 'shelf-file:'; // a file's "url" — also the key of its thumbnail
export const isLocal = (id) => typeof id === 'string' && id.startsWith('s:');
export const isFileUrl = (url) => (url || '').startsWith(FILE_SCHEME);
export const blobIdOf = (url) => url.slice(FILE_SCHEME.length);

let cache = null; // Map id -> record, the whole tree (records are tiny; blobs live elsewhere)
const listeners = new Set();
const channel = new BroadcastChannel('shelf-local');
channel.onmessage = () => {
  cache = null; // another Shelf tab changed things
  for (const fn of listeners) fn();
};

function announce() {
  channel.postMessage(1);
  for (const fn of listeners) fn();
}

async function all() {
  if (cache) return cache;
  const db = await open();
  const recs = await new Promise((resolve, reject) => {
    const req = db.transaction('items').objectStore('items').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return (cache = new Map(recs.map((r) => [r.id, r])));
}

const siblings = (items, parentId) =>
  [...items.values()].filter((r) => r.parentId === parentId).sort((a, b) => a.index - b.index);

async function persist({ put = [], del = [], putBlobs = [], delBlobs = [] }) {
  const db = await open();
  const tx = db.transaction(['items', 'blobs'], 'readwrite');
  for (const r of put) tx.objectStore('items').put(r);
  for (const id of del) tx.objectStore('items').delete(id);
  for (const b of putBlobs) tx.objectStore('blobs').put(b);
  for (const id of delBlobs) tx.objectStore('blobs').delete(id);
  await txDone(tx);
}

// Re-number a list of siblings in the given order; returns the records whose index changed.
function renumber(list) {
  const changed = [];
  list.forEach((r, i) => {
    if (r.index !== i) {
      r.index = i;
      changed.push(r);
    }
  });
  return changed;
}

const view = (r) => ({ ...r, dateAdded: r.createdAt });

export const local = {
  onChanged(fn) {
    listeners.add(fn);
  },

  async getTree() {
    const items = await all();
    const build = (parentId) =>
      siblings(items, parentId).map((r) => (r.url ? view(r) : { ...view(r), children: build(r.id) }));
    return { id: ROOT, title: 'My Shelf', children: build(ROOT) };
  },

  async getChildren(parentId) {
    return siblings(await all(), parentId).map(view);
  },

  // file: { name, mime, size, blobId? } + blob → stored locally; url → a link; neither → a folder
  async create({ parentId, index, title, url, file, blob }) {
    const items = await all();
    const sibs = siblings(items, parentId);
    const at = Math.min(index ?? sibs.length, sibs.length);
    const rec = { id: 's:' + crypto.randomUUID(), parentId, title: title || '', createdAt: Date.now() };
    const putBlobs = [];
    if (file) {
      const blobId = file.blobId || crypto.randomUUID();
      rec.file = { name: file.name, mime: file.mime, size: file.size, blobId };
      rec.url = FILE_SCHEME + blobId;
      if (blob) putBlobs.push({ id: blobId, blob });
    } else if (url) {
      rec.url = url;
    }
    sibs.splice(at, 0, rec);
    items.set(rec.id, rec);
    renumber(sibs);
    await persist({ put: sibs, putBlobs });
    announce();
    return view(rec);
  },

  // Many links at once (an import): one write instead of one per item. They go in at `index`
  // (default: the end), in the order given.
  async createMany(parentId, list, index = null) {
    const items = await all();
    const sibs = siblings(items, parentId);
    const made = list.map((l, i) => ({ id: 's:' + crypto.randomUUID(), parentId, title: l.title || '', url: l.url, createdAt: Date.now() + i }));
    for (const r of made) items.set(r.id, r);
    sibs.splice(Math.min(index ?? sibs.length, sibs.length), 0, ...made);
    await persist({ put: [...new Set([...made, ...renumber(sibs)])] });
    announce();
    return made.map(view);
  },

  // Same contract as chrome.bookmarks.move: `index` counts positions before the node is lifted out.
  async move(id, { parentId, index }) {
    const items = await all();
    const rec = items.get(id);
    if (!rec) throw new Error('No such item');
    const from = rec.parentId;
    parentId ??= from;
    for (let p = items.get(parentId); p; p = items.get(p.parentId)) {
      if (p.id === id) throw new Error('A folder can’t be moved into itself');
    }
    const src = siblings(items, from);
    const oldAt = src.indexOf(rec);
    src.splice(oldAt, 1);
    const dest = parentId === from ? src : siblings(items, parentId);
    let at = index ?? dest.length;
    if (parentId === from && index != null && index > oldAt) at--;
    at = Math.max(0, Math.min(at, dest.length));
    rec.parentId = parentId;
    dest.splice(at, 0, rec);
    const changed = new Set([rec, ...renumber(dest), ...(dest === src ? [] : renumber(src))]);
    await persist({ put: [...changed] });
    announce();
    return view(rec);
  },

  async update(id, changes) {
    const rec = (await all()).get(id);
    if (!rec) throw new Error('No such item');
    if (changes.title != null) rec.title = changes.title;
    if (changes.url != null && !rec.file) rec.url = changes.url;
    await persist({ put: [rec] });
    announce();
    return view(rec);
  },

  async removeTree(id) {
    const items = await all();
    const rec = items.get(id);
    if (!rec) return;
    const doomed = [];
    (function collect(r) {
      doomed.push(r);
      for (const c of siblings(items, r.id)) collect(c);
    })(rec);
    for (const r of doomed) items.delete(r.id);
    const stillUsed = new Set([...items.values()].map((r) => r.file?.blobId).filter(Boolean));
    const delBlobs = doomed.map((r) => r.file?.blobId).filter((b) => b && !stillUsed.has(b));
    const rest = siblings(items, rec.parentId);
    await persist({ put: renumber(rest), del: doomed.map((r) => r.id), delBlobs });
    announce();
  },

  remove(id) {
    return this.removeTree(id);
  },

  async getBlob(blobId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('blobs').objectStore('blobs').get(blobId);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error);
    });
  },
};
