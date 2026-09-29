// Preview pipeline for the page: cached lookups, a polite metadata fetch queue, and change events.
// Priority for the image shown on a card: captured screenshot > the site's og:image > tinted fallback.

import { getRec, patchRec, delRec } from './db.js';
import { toJpeg } from './img.js';
import { isWeb } from './util.js';
import { classify } from './media.js';
import { rulesReady } from './netrules.js';

const META_OK_TTL = 30 * 24 * 60 * 60 * 1000;
const META_FAIL_TTL = 3 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

const entries = new Map(); // url -> entry
const loading = new Map(); // url -> Promise<entry>
const listeners = new Set();
const queue = [];
const queued = new Set();
const waiters = new Map(); // url -> [resolve]
let active = 0;

export function onPreview(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function toEntry(url, rec) {
  const old = entries.get(url);
  if (old?.src) URL.revokeObjectURL(old.src);
  const blob = rec?.shot || rec?.og || null;
  const entry = {
    url,
    src: blob ? URL.createObjectURL(blob) : null,
    kind: rec?.shot ? 'shot' : rec?.og ? 'og' : null,
    icon: rec?.icon || null,
    description: rec?.description || '',
    author: rec?.author || '',
    pageTitle: rec?.title || '',
    metaAt: rec?.metaAt || 0,
    metaOk: !!rec?.metaOk,
  };
  entries.set(url, entry);
  return entry;
}

function emit(url) {
  const entry = entries.get(url);
  for (const fn of listeners) fn(url, entry);
}

export function peek(url) {
  return entries.get(url) || null;
}

export function get(url) {
  if (entries.has(url)) return Promise.resolve(entries.get(url));
  if (!loading.has(url)) {
    loading.set(
      url,
      getRec(url)
        .catch(() => null)
        .then((rec) => {
          loading.delete(url);
          return toEntry(url, rec);
        }),
    );
  }
  return loading.get(url);
}

// Ask for metadata if we don't have a fresh answer yet. Safe to call as often as you like.
export async function want(url) {
  if (!isWeb(url) || queued.has(url)) return;
  const e = await get(url);
  const ttl = e.metaOk ? META_OK_TTL : META_FAIL_TTL;
  if (e.metaAt && Date.now() - e.metaAt < ttl) return;
  if (queued.has(url)) return;
  queued.add(url);
  queue.push(url);
  pump();
}

// Like want(), but resolves once the metadata is actually in hand (or we gave up).
export async function ensure(url, timeout = 16_000) {
  if (!isWeb(url)) return get(url);
  const e = await get(url);
  if (e.metaAt && Date.now() - e.metaAt < (e.metaOk ? META_OK_TTL : META_FAIL_TTL)) return e;
  const settled = new Promise((resolve) => {
    if (!waiters.has(url)) waiters.set(url, []);
    waiters.get(url).push(resolve);
  });
  want(url);
  return Promise.race([settled, new Promise((r) => setTimeout(() => r(entries.get(url)), timeout))]);
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const url = queue.shift();
    active++;
    fetchMeta(url)
      .catch(() => patchRec(url, { metaAt: Date.now(), metaOk: false }))
      .then((rec) => {
        if (rec) {
          toEntry(url, rec);
          emit(url);
        }
      })
      .catch(() => {})
      .finally(() => {
        active--;
        queued.delete(url);
        for (const done of waiters.get(url) || []) done(entries.get(url));
        waiters.delete(url);
        pump();
      });
  }
}

async function readHead(res, cap = 400_000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = '';
  while (html.length < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

const plain = { credentials: 'omit', referrerPolicy: 'no-referrer' };

// Never hand a site's raw HTML to the parser: even in an "inert" document Chromium's preload
// scanner goes looking for its scripts, styles and fonts. Keep only the few tags we read, as text.
function skeleton(html) {
  const keep = [];
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) if (!/http-equiv/i.test(tag)) keep.push(tag);
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel\s*=\s*["']?[^"'>]*icon/i.test(tag) && !/preload|prefetch/i.test(tag)) keep.push(tag);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  return `<head><title>${title.replace(/</g, '&lt;')}</title>${keep.join('')}</head>`;
}

// For markup we do need to walk (Instagram's embed): defuse everything that could load.
const defuse = (html) =>
  html.replace(/<(script|style|link|iframe)\b[\s\S]*?(<\/\1>|>)/gi, '').replace(/\s(src|srcset|href|poster)\s*=/gi, ' data-$1=');

async function fetchImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    const ir = await fetch(imageUrl, { ...plain, signal: AbortSignal.timeout(12_000) });
    if (!ir.ok) return null;
    const out = await toJpeg(await ir.blob(), { maxW: 960 });
    return out.srcWidth >= 240 && out.srcHeight >= 120 ? out.blob : null;
  } catch {
    return null; // no usable image; the card keeps its fallback
  }
}

async function getJson(url) {
  const res = await fetch(url, { ...plain, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Posts and videos hide behind logins and consent walls, so ask their public embed endpoints
// instead of the page itself. Each returns { title, description, imageUrl, author } or throws.
const SOCIAL = {
  async youtube(url, m) {
    const j = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    return { title: j.title, description: j.author_name ? `Video by ${j.author_name}` : '', author: j.author_name, imageUrl: `https://i.ytimg.com/vi/${m.id}/hqdefault.jpg` };
  },
  async vimeo(url) {
    const j = await getJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
    return { title: j.title, description: j.description || (j.author_name ? `Video by ${j.author_name}` : ''), author: j.author_name, imageUrl: j.thumbnail_url };
  },
  async tweet(url, m) {
    const token = ((Number(m.id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    try {
      const j = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${m.id}&token=${token}&lang=en`);
      const text = (j.text || '').replace(/https:\/\/t\.co\/\w+/g, '').trim();
      const media = j.mediaDetails?.[0]?.media_url_https || j.photos?.[0]?.url || j.video?.poster || '';
      const who = j.user?.name ? `${j.user.name} (@${j.user.screen_name})` : `@${m.user}`;
      return { title: `${who}: ${text}`.slice(0, 140), description: text, author: who, imageUrl: media };
    } catch {
      const j = await getJson(`https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(url)}`);
      const text = new DOMParser().parseFromString(defuse(j.html || ''), 'text/html').querySelector('p')?.textContent?.trim() || '';
      return { title: `${j.author_name}: ${text}`.slice(0, 140), description: text, author: j.author_name, imageUrl: '' };
    }
  },
  async instagram(url, m) {
    const res = await fetch(`https://www.instagram.com/${m.reel ? 'reel' : 'p'}/${m.code}/embed/captioned/`, { ...plain, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(defuse(await res.text()), 'text/html');
    const author = doc.querySelector('.CaptionUsername, .UsernameText')?.textContent?.trim() || '';
    const cap = doc.querySelector('.Caption');
    cap?.querySelectorAll('.CaptionUsername, .CaptionComments').forEach((el) => el.remove());
    const text = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
    const imageUrl = doc.querySelector('img.EmbeddedMediaImage')?.getAttribute('data-src') || '';
    if (!author && !text && !imageUrl) throw new Error('empty embed');
    return { title: `${author ? '@' + author : 'Instagram'}${text ? ': ' + text : ''}`.slice(0, 140), description: text, author, imageUrl };
  },
};

async function fetchMeta(url) {
  await rulesReady; // so the response's preload headers are already being dropped
  const m = classify(url);
  if (m.type === 'image') {
    const og = await fetchImage(url);
    return patchRec(url, { metaAt: Date.now(), metaOk: !!og, ...(og ? { og } : {}) });
  }
  if (SOCIAL[m.type]) {
    try {
      const s = await SOCIAL[m.type](url, m);
      const patch = { metaAt: Date.now(), metaOk: true, title: s.title || '', description: (s.description || '').slice(0, 800), author: s.author || '' };
      const og = await fetchImage(s.imageUrl);
      if (og) patch.og = og;
      return patchRec(url, patch);
    } catch {
      /* fall through to reading the page like any other */
    }
  }
  // No cookies: a bookmark is just a GET, but it should never act on the user's behalf.
  const res = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) {
    return patchRec(url, { metaAt: Date.now(), metaOk: false });
  }
  const doc = new DOMParser().parseFromString(skeleton(await readHead(res)), 'text/html');
  const base = res.url || url;
  const meta = (...names) => {
    for (const n of names) {
      const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const v = el?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return '';
  };
  const abs = (v) => {
    try {
      const u = new URL(v, base);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch {
      return '';
    }
  };

  const iconEl =
    doc.querySelector('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]') ||
    [...doc.querySelectorAll('link[rel~="icon"]')].sort(
      (a, b) => (parseInt(b.getAttribute('sizes')) || 0) - (parseInt(a.getAttribute('sizes')) || 0),
    )[0];

  const patch = {
    metaAt: Date.now(),
    metaOk: true,
    title: (meta('og:title') || doc.title || '').trim().slice(0, 300),
    description: meta('og:description', 'description', 'twitter:description').slice(0, 500),
    icon: iconEl ? abs(iconEl.getAttribute('href')) : '',
  };

  // A post's picture copied from your own saved list beats whatever its login wall advertises.
  const pinned = (await getRec(url).catch(() => null))?.ogPinned;
  const og = pinned ? null : await fetchImage(abs(meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src')));
  if (og) patch.og = og;
  return patchRec(url, patch);
}

export async function saveShot(url, blob) {
  const rec = await patchRec(url, { shot: blob, shotAt: Date.now() });
  toEntry(url, rec);
  emit(url);
}

export async function resetPreview(url) {
  const old = await getRec(url).catch(() => null);
  await delRec(url);
  if (old?.ogPinned) await patchRec(url, { og: old.og, ogPinned: true }); // can't be fetched again
  toEntry(url, null);
  emit(url);
  want(url);
}

// The service worker captured a screenshot while the user was browsing.
export async function refreshFromDb(url) {
  const rec = await getRec(url).catch(() => null);
  toEntry(url, rec);
  emit(url);
}
