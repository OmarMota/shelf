import { getRec, patchRec } from './js/db.js';
import { dataUrlToBlob, toJpeg } from './js/img.js';
import { classify, isSocialPost, PLATFORM_FOLDER } from './js/media.js';
import { importPosts, knownPosts } from './js/social-import.js';
import { ruleIds } from './js/ruleids.js';

const APP_URL = chrome.runtime.getURL('index.html');
const SHOT_MAX_AGE = 14 * 24 * 60 * 60 * 1000;

// ---------- open / focus the manager ----------

async function openShelf(hash = '') {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url || t.pendingUrl || '').startsWith(APP_URL));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash ? { url: APP_URL + hash } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL + hash });
  }
}

chrome.action.onClicked.addListener(() => openShelf());
chrome.commands.onCommand.addListener((cmd) => cmd === 'open-shelf' && openShelf());

// ---------- live-preview header rule hygiene ----------
// The manager page installs a session rule (id = its tab id) that lets sites render inside its
// Quick Look iframe. Make sure that rule never outlives the page it was made for.

function dropRule(tabId) {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(tabId) }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(dropRule);

// ---------- capture a preview when a bookmarked page is visited ----------

// A bookmark often redirects (godly.website -> recent.design), so remember where each
// navigation started and file the screenshot under the address that is actually bookmarked.
const startedAt = new Map(); // tabId -> url
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) startedAt.set(d.tabId, d.url);
});
chrome.tabs.onRemoved.addListener((tabId) => startedAt.delete(tabId));

async function bookmarkedUrl(candidates) {
  for (const url of new Set(candidates)) {
    if (!/^https?:/.test(url || '')) continue;
    if ((await chrome.bookmarks.search({ url })).length) return url;
  }
  return null;
}

async function captureOnVisit(tabId, tab) {
  if (!/^https?:/.test(tab.url)) return;
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && settings.captureOnVisit === false) return;
  const url = await bookmarkedUrl([tab.url, startedAt.get(tabId)]);
  if (!url) return;
  const rec = await getRec(url);
  if (rec?.shot && Date.now() - (rec.shotAt || 0) < SHOT_MAX_AGE) return;

  // Let the page paint, then make sure the user is still looking at it.
  await new Promise((r) => setTimeout(r, 1800));
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (!now || !now.active || now.url !== tab.url || now.status !== 'complete') return;

  const dataUrl = await chrome.tabs.captureVisibleTab(now.windowId, { format: 'jpeg', quality: 90 });
  const src = await dataUrlToBlob(dataUrl);
  const bmp = await createImageBitmap(src);
  const crop = { x: 0, y: 0, w: bmp.width, h: Math.min(bmp.height, bmp.width * 0.625) };
  const { blob } = await toJpeg(bmp, { crop, maxW: 960 });
  await patchRec(url, { shot: blob, shotAt: Date.now() });
  chrome.runtime.sendMessage({ type: 'preview-updated', url }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && !info.url.startsWith(APP_URL)) dropRule(tabId);
  if (info.status === 'complete' && tab.active && tab.url) {
    captureOnVisit(tabId, tab).catch(() => {});
  }
});

// ---------- file new Instagram / X bookmarks into their own folders (opt-in) ----------
// Only touches a bookmark that was just dropped loose into a top-level folder, and only after a
// pause, so it never fights with the browser's own "choose a folder" bubble.

chrome.bookmarks.onCreated.addListener(async (id, bm) => {
  if (!bm.url) return;
  const m = classify(bm.url);
  if (!isSocialPost(m)) return;
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.autoFile) return;

  await new Promise((r) => setTimeout(r, 20_000));
  const [now] = await chrome.bookmarks.get(id).catch(() => []);
  if (!now || now.parentId !== bm.parentId) return; // already moved or removed by hand
  const [parent] = await chrome.bookmarks.get(now.parentId);
  if (parent.parentId !== '0') return; // it was put in a folder on purpose

  const name = PLATFORM_FOLDER[m.platform];
  const [tree] = await chrome.bookmarks.getTree();
  const bar = tree.children[0];
  const folder =
    (await chrome.bookmarks.search({ title: name })).find((f) => !f.url) ||
    (await chrome.bookmarks.create({ parentId: bar.id, title: name }));
  await chrome.bookmarks.move(id, { parentId: folder.id });
});

// ---------- collecting your saved posts from X / Instagram ----------
// Shelf opens the page in a normal tab (your login, your session, untouched) and drops a small
// collector panel into it. The tab ids are remembered so the panel survives a login redirect.

const COLLECT_URL = { x: 'https://x.com/i/bookmarks', instagram: 'https://www.instagram.com/', pinterest: 'https://www.pinterest.com/' };

async function collectTabs() {
  return (await chrome.storage.session.get('collectTabs')).collectTabs || [];
}

function inject(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, files: ['js/collector.js'] }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'shelf-collect') {
    (async () => {
      const tab = await chrome.tabs.create({ url: msg.url || COLLECT_URL[msg.platform] });
      await chrome.storage.session.set({ collectTabs: [...(await collectTabs()), tab.id] });
    })();
  } else if (msg?.type === 'shelf-import') {
    importPosts(msg.items || []).then(reply, () => reply({ added: 0, skipped: 0, previews: 0, folders: [], folderIds: [] }));
    return true; // async reply
  } else if (msg?.type === 'shelf-known') {
    knownPosts().then(reply, () => reply({ known: [], noPic: [] }));
    return true;
  } else if (msg?.type === 'shelf-synced') {
    chrome.storage.local.get('lastSync').then(({ lastSync = {} }) => chrome.storage.local.set({ lastSync: { ...lastSync, [msg.platform]: Date.now() } }));
  } else if (msg?.type === 'shelf-open') {
    openShelf(msg.folderId ? '#/f/' + msg.folderId : '');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'complete' && (await collectTabs()).includes(tabId)) inject(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await collectTabs();
  if (tabs.includes(tabId)) chrome.storage.session.set({ collectTabs: tabs.filter((t) => t !== tabId) });
});
