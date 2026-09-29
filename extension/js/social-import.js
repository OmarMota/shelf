// Files a batch of collected posts into My Shelf. Runs in the service worker (from the collector)
// and in the page (from an Instagram data export).

import { local, ROOT } from './local.js';
import { getRec, patchRec } from './db.js';
import { toJpeg } from './img.js';

export const IMPORT_FOLDER = { x: 'X bookmarks', instagram: 'Instagram saved', pinterest: 'Pinterest' };

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Keep a copy of the picture the page was showing for a post. It is marked `ogPinned` so a later
// metadata fetch that only reaches a login wall can't replace it with the site's logo.
async function keepPicture(p) {
  try {
    const rec = await getRec(p.url);
    if (rec?.shot || rec?.ogPinned) return !!rec;
    const res = await fetch(p.image, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const out = await toJpeg(await res.blob(), { maxW: 960 });
    if (out.srcWidth < 120 || out.srcHeight < 120) return false;
    // ogSrc: where a sharper copy might still be had later ("Copy image"); the blob is what is certain.
    await patchRec(p.url, { og: out.blob, ogPinned: true, ogSrc: [p.full, p.image].filter((u) => /^https:\/\//.test(u || '')) });
    chrome.runtime.sendMessage({ type: 'preview-updated', url: p.url }).catch(() => {});
    return true;
  } catch {
    return false; // the card falls back to whatever the public embed offers
  }
}

async function keepPictures(posts) {
  const todo = posts.filter((p) => /^https:\/\//.test(p.image || ''));
  let kept = 0;
  const worker = async () => {
    for (let p; (p = todo.shift()); ) if (await keepPicture(p)) kept++;
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return kept;
}

// What a re-sync needs to know up front: which posts My Shelf already holds (so scrolling can stop
// when it reaches them) and which of those never got a picture (so they can be given one).
export async function knownPosts() {
  const known = [];
  (function walk(n) {
    if (n.url && /^https:\/\/(x\.com|www\.instagram\.com|www\.pinterest\.com\/pin)\//.test(n.url)) known.push(n.url);
    (n.children || []).forEach(walk);
  })(await local.getTree());
  const noPic = [];
  for (const url of known) {
    const rec = await getRec(url).catch(() => null);
    if (!rec?.shot && !rec?.og) noPic.push(url);
  }
  return { known, noPic };
}

const TITLE_FALLBACK = { x: 'Post', instagram: 'Instagram post', pinterest: 'Pin' };

function titleOf(p) {
  const text = (p.text || '').replace(/\s+/g, ' ').trim();
  const who = p.author ? '@' + p.author : '';
  return clip([who, text].filter(Boolean).join(': ') || TITLE_FALLBACK[p.platform], 140);
}

// The folder a post belongs in: the platform's own, then any path the collector read off the page
// (a Pinterest board, and a section inside it). Made on the way if missing.
async function folderFor(platform, path, cache) {
  let parentId = ROOT;
  let key = '';
  for (const name of [IMPORT_FOLDER[platform], ...path]) {
    key += '\n' + name;
    if (!cache.has(key)) {
      const kids = await local.getChildren(parentId);
      const hit = kids.find((k) => !k.url && k.title === name) || (await local.create({ parentId, title: name, index: kids.findIndex((k) => k.url) === -1 ? kids.length : kids.findIndex((k) => k.url) }));
      cache.set(key, hit.id);
    }
    parentId = cache.get(key);
  }
  return parentId;
}

export async function importPosts(items) {
  const have = new Set();
  (function walk(n) {
    if (n.url) have.add(n.url);
    (n.children || []).forEach(walk);
  })(await local.getTree());

  const out = { added: 0, skipped: 0, previews: 0, folders: [], folderIds: [] };
  const cache = new Map();
  for (const platform of Object.keys(IMPORT_FOLDER)) {
    const posts = items.filter((p) => p.platform === platform && /^https:\/\//.test(p.url || ''));
    if (!posts.length) continue;
    const fresh = posts.filter((p) => !have.has(p.url));
    out.skipped += posts.length - fresh.length;
    // Group by destination, keeping the order the page showed them in (newest first).
    const groups = new Map();
    for (const p of fresh) {
      have.add(p.url);
      const path = (Array.isArray(p.folder) ? p.folder : []).map((f) => clip(String(f).trim(), 80)).filter(Boolean).slice(0, 2);
      const k = path.join('\n');
      if (!groups.has(k)) groups.set(k, { path, posts: [] });
      groups.get(k).posts.push(p);
      // What the page showed us is kept as the description, so Tidy up can sort by content even
      // if the public embed endpoints later refuse. (No metaAt: the image still gets fetched.)
      const text = (p.text || '').replace(/\s+/g, ' ').trim();
      if (text) await patchRec(p.url, { title: titleOf(p), description: clip(text, 800), author: p.author || '' });
    }
    for (const g of groups.values()) {
      const folderId = await folderFor(platform, g.path, cache);
      // Newest on top, under any folders you have made in there.
      const kids = await local.getChildren(folderId);
      const firstLink = kids.findIndex((k) => k.url);
      await local.createMany(folderId, g.posts.map((p) => ({ url: p.url, title: titleOf(p) })), firstLink === -1 ? kids.length : firstLink);
      const label = [IMPORT_FOLDER[platform], ...g.path].join(' › ');
      if (!out.folders.includes(label)) out.folders.push(label);
      out.folderIds.push(folderId);
    }
    out.added += fresh.length;
    const fresher = new Set(fresh);
    out.previews += await keepPictures(fresh);
    const before = await keepPictures(posts.filter((p) => !fresher.has(p)));
    if (!fresh.length) out.previews += before; // a run that only back-filled pictures reports those
  }
  return out;
}

// Instagram's own "Download your information" export: saved_posts.json / saved_collections.json
export function postsFromInstagramExport(json) {
  const posts = [];
  (function walk(v, title = '') {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, title));
    if (!v || typeof v !== 'object') return;
    const t = typeof v.title === 'string' ? v.title : title;
    if (typeof v.href === 'string') {
      const m = /instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(v.href);
      if (m) posts.push({ url: `https://www.instagram.com/${m[1] === 'p' ? 'p' : 'reel'}/${m[2]}/`, platform: 'instagram', author: t, text: '' });
    }
    for (const k of Object.keys(v)) walk(v[k], t);
  })(json);
  return posts;
}
