// Safety net: snapshots of the browser's whole bookmark tree, kept inside the extension.
// One is taken every day Shelf is opened and before every Tidy up. Any snapshot can be downloaded
// as a standard bookmarks .html file (every browser imports it) or restored as a copy.

import { open, txDone } from './db.js';

const KEEP = 20;
const DAY = 24 * 60 * 60 * 1000;

const prune = (n) => ({
  title: n.title,
  ...(n.url ? { url: n.url } : { children: (n.children || []).map(prune) }),
  ...(n.dateAdded ? { dateAdded: n.dateAdded } : {}),
});

const countUrls = (n) => (n.url ? 1 : (n.children || []).reduce((s, c) => s + countUrls(c), 0));

async function all() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('backups').objectStore('backups').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.id - a.id));
    req.onerror = () => reject(req.error);
  });
}

export async function listBackups() {
  return (await all()).map(({ id, reason, count }) => ({ id, reason, count }));
}

export async function takeBackup(reason) {
  const [root] = await chrome.bookmarks.getTree();
  const tree = prune(root);
  const json = JSON.stringify(tree);
  const existing = await all();
  if (existing[0] && JSON.stringify(existing[0].tree) === json) return existing[0].id; // nothing changed since
  const db = await open();
  const tx = db.transaction('backups', 'readwrite');
  const id = Date.now();
  tx.objectStore('backups').put({ id, reason, count: countUrls(tree), tree });
  for (const old of existing.slice(KEEP - 1)) tx.objectStore('backups').delete(old.id);
  await txDone(tx);
  return id;
}

export async function dailyBackup() {
  const [latest] = await all();
  if (!latest || Date.now() - latest.id > DAY) await takeBackup('Daily');
}

const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The classic Netscape bookmark file: what "Import bookmarks" expects in every browser.
function toHtml(tree) {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  const walk = (n, depth) => {
    const pad = '    '.repeat(depth);
    const added = n.dateAdded ? ` ADD_DATE="${Math.round(n.dateAdded / 1000)}"` : '';
    if (n.url) return lines.push(`${pad}<DT><A HREF="${esc(n.url)}"${added}>${esc(n.title)}</A>`);
    lines.push(`${pad}<DT><H3${added}>${esc(n.title)}</H3>`, `${pad}<DL><p>`);
    for (const c of n.children) walk(c, depth + 1);
    lines.push(`${pad}</DL><p>`);
  };
  for (const top of tree.children) walk(top, 1);
  lines.push('</DL><p>');
  return lines.join('\n');
}

export async function backupAsHtml(id) {
  const b = (await all()).find((x) => x.id === id);
  return b ? new Blob([toHtml(b.tree)], { type: 'text/html' }) : null;
}

// Non-destructive: rebuilds the snapshot inside a new folder instead of replacing anything.
export async function restoreAsCopy(id) {
  const b = (await all()).find((x) => x.id === id);
  if (!b) return null;
  const [root] = await chrome.bookmarks.getTree();
  const home = root.children[1] || root.children[0]; // "Other bookmarks"
  const when = new Date(b.id).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const top = await chrome.bookmarks.create({ parentId: home.id, title: `Restored backup · ${when}` });
  const build = async (n, parentId) => {
    const made = await chrome.bookmarks.create({ parentId, title: n.title, url: n.url });
    for (const c of n.children || []) await build(c, made.id);
  };
  for (const section of b.tree.children) if (section.children.length) await build(section, top.id);
  return top;
}
