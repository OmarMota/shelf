import { $, $$, h, ICON, hostOf, hueOf, isWeb, faviconUrl, debounce, clamp, plural, SPRING, reducedMotion } from './util.js';
import * as M from './model.js';
import * as previews from './previews.js';
import { toast, openMenu, closeMenu, formDialog, folderPicker, dialogOpen } from './ui.js';
import { createQuickLook } from './quicklook.js';
import { local, blobIdOf } from './local.js';
import { classify, isPlayable, isSocialPost, isVisual, canSaveLocally, fileKind, formatBytes, extOf } from './media.js';
import { toJpeg } from './img.js';
import { tidy } from './tidy.js';
import { openDialog } from './ui.js';
import { importPosts, postsFromInstagramExport } from './social-import.js';
import { dailyBackup, takeBackup, listBackups, backupAsHtml, restoreAsCopy } from './backup.js';
import { loadNotes, onNotesChanged, noteOf, setNote, markOpened } from './notes.js';
import { review } from './review.js';
import { getRec } from './db.js';

const grid = $('#grid');
const canvas = $('#canvas');
const searchInput = $('#search');

const S = {
  folderId: null,
  query: '',
  sel: new Set(),
  lastSel: null,
  hoverId: null,
  settings: { size: 200, theme: 'auto', captureOnVisit: true, autoFile: false, expanded: [] },
};

const cards = new Map(); // id -> element
const pos = new Map(); // id -> { x, y } inside the grid
let order = []; // ids currently on the canvas, in display order
let metrics = { cols: 1, W: 220, H: 190, gap: 28, hole: null };

// Gallery view: pictures at their own proportions, in columns. The proportions are learnt as the
// images load and remembered, so a folder opens already in shape next time.
const ratios = new Map(); // url -> width / height
try {
  for (const [u, r] of Object.entries(JSON.parse(localStorage.getItem('shelf-ratios') || '{}'))) ratios.set(u, r);
} catch {}
const saveRatios = debounce(() => {
  try {
    localStorage.setItem('shelf-ratios', JSON.stringify(Object.fromEntries([...ratios].slice(-4000))));
  } catch {}
}, 1500);
let relayout = 0;

function viewMode() {
  if (S.query) return 'grid';
  const chosen = S.settings.views?.[S.folderId];
  if (chosen) return chosen;
  // Not chosen yet: a folder that is mostly pictures (pins, Instagram posts, image files) opens as a gallery.
  const links = M.kids(S.folderId).filter((n) => n.url);
  const visual = links.filter((n) => (n.file ? ['image', 'video'].includes(fileKind(n.file.mime, n.file.name)) : isVisual(classify(n.url))));
  return links.length >= 4 && visual.length / links.length >= 0.6 ? 'gallery' : 'grid';
}

function toggleView() {
  setView(viewMode() === 'gallery' ? 'grid' : 'gallery');
}

function setView(next) {
  if (S.query) return toast('Search results are always shown as a grid');
  if (next === viewMode()) return;
  S.settings.views = { ...S.settings.views, [S.folderId]: next };
  saveSettings();
  renderGrid();
}
let drag = null;
let dirty = false;
let pendingOrigin = null;
const undoStack = [];
const autoTitle = new Map(); // bookmark id -> url, for links added without a real title yet

// =====================================================================================
// settings
// =====================================================================================

const saveSettings = debounce(() => chrome.storage.local.set({ settings: S.settings }), 250);

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('#btn-theme').title = `Theme: ${t}`;
}

// =====================================================================================
// what is on the canvas
// =====================================================================================

const defaultFolder = () => M.model.root.children[0].id;

function visibleItems() {
  return S.query ? M.search(S.query) : M.kids(S.folderId);
}

function go(id, origin = null) {
  if (S.query) {
    S.query = '';
    searchInput.value = '';
  }
  pendingOrigin = origin;
  const hash = '#/f/' + id;
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}

function onRoute() {
  const id = (location.hash.match(/^#\/f\/(.+)$/) || [])[1];
  const n = M.node(id);
  const target = n && M.isFolder(n) && n.parent ? id : defaultFolder();
  const prev = S.folderId;
  S.folderId = target;
  S.sel.clear();
  for (const p of M.pathTo(target).slice(0, -1)) expand(p.id, true);
  const zoomOut = !!prev && prev !== target && M.isInside(prev, target);
  renderAll({ origin: pendingOrigin, zoomOut });
  pendingOrigin = null;
  canvas.scrollTop = 0;
  if (zoomOut) {
    const child = M.pathTo(prev).find((p) => p.parent?.id === target);
    const el = child && cards.get(child.id);
    if (el) {
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 700);
    }
  }
  if (drag) drag.gap = S.query ? null : order.filter((i) => !drag.idSet.has(i)).length;
}

function expand(id, on) {
  const set = new Set(S.settings.expanded);
  if (on ?? !set.has(id)) set.add(id);
  else set.delete(id);
  S.settings.expanded = [...set];
  saveSettings();
}

// =====================================================================================
// sidebar + breadcrumbs
// =====================================================================================

function renderTree() {
  const tree = $('#tree');
  const open = new Set(S.settings.expanded);
  const rows = [];
  (function walk(n, depth) {
    for (const k of n.children || []) {
      if (k.url) continue;
      const isShelf = k.id === M.SHELF_ROOT;
      if (depth === 0 && !isShelf && !k.children?.length && k !== n.children[0] && k !== n.children[1]) continue;
      if (depth === 0 && (isShelf || k === n.children[0])) {
        rows.push(h('div', { class: 'tree-label' }, isShelf ? 'On this Mac' : 'Browser'));
      }
      const hasSub = k.children.some((c) => !c.url);
      const row = h(
        'div',
        {
          class: 'row' + (k.id === S.folderId && !S.query ? ' active' : '') + (depth === 0 ? ' top' : '') + (drag?.idSet.has(k.id) ? ' drag-src' : ''),
          'data-drop': k.id,
          'data-folder': k.id,
          style: { paddingLeft: 6 + depth * 14 + 'px' },
          onclick: () => go(k.id),
        },
        h('button', {
          class: 'caret' + (open.has(k.id) ? ' open' : '') + (hasSub ? '' : ' none'),
          icon: 'chevron',
          tabindex: '-1',
          onclick: (e) => {
            e.stopPropagation();
            expand(k.id);
            renderTree();
          },
        }),
        h('span', { class: 'row-ico', icon: isShelf ? 'shelf' : 'folder' }),
        h('span', { class: 'row-name' }, k.title || 'Untitled'),
        h('span', { class: 'row-count' }, M.countUrls(k) || ''),
        h('button', {
          class: 'row-add',
          icon: 'plus',
          tabindex: '-1',
          title: `New folder in “${k.title || 'Untitled'}”`,
          'aria-label': `New folder in ${k.title || 'Untitled'}`,
          onclick: (e) => {
            e.stopPropagation();
            newFolder(k.id);
          },
        }),
      );
      row.style.setProperty('--indent', 26 + depth * 14 + 'px'); // where the drop line starts
      rows.push(row);
      if (hasSub && open.has(k.id)) walk(k, depth + 1);
    }
  })(M.model.root, 0);
  tree.replaceChildren(...rows);
}

function renderCrumbs(items) {
  const crumbs = $('#crumbs');
  const path = M.pathTo(S.folderId);
  if (S.query) {
    crumbs.replaceChildren(h('h1', {}, `“${S.query}”`));
  } else {
    crumbs.replaceChildren(
      ...path.slice(0, -1).flatMap((p) => [
        h('button', { class: 'crumb', 'data-drop': p.id, onclick: () => go(p.id) }, p.title),
        h('span', { class: 'crumb-sep', icon: 'chevron' }),
      ]),
      h('h1', {}, path.at(-1)?.title || 'Bookmarks'),
    );
  }
  const nb = items.filter((n) => n.url).length;
  const nf = items.length - nb;
  const noun = M.isLocal(S.folderId) && !S.query ? 'item' : 'bookmark';
  $('#count').textContent = [nb && plural(nb, noun), nf && plural(nf, 'folder')].filter(Boolean).join(' · ');
  // Back only exists where there is somewhere to go back to: inside a folder, or out of a search.
  const back = $('#btn-back');
  back.hidden = !S.query && path.length < 2;
  back.title = S.query ? 'Back to the folder' : `Back to “${path.at(-2)?.title || ''}” (⌘↑)`;
  document.title = S.query ? `Search — Shelf` : `${path.at(-1)?.title || 'Bookmarks'} — Shelf`;
}

// =====================================================================================
// cards
// =====================================================================================

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const el of $$('[data-url]', e.target)) {
        paintPreview(el);
        previews.want(el.dataset.url);
      }
    }
  },
  { root: canvas, rootMargin: '400px 0px' },
);

function toolBtn(act, icon, label) {
  return h('button', { class: 'tool', 'data-act': act, title: label, 'aria-label': label, icon, tabindex: '-1' });
}

function buildCard(n) {
  const inner = h('div', { class: 'card-in' });
  if (n.url) {
    inner.append(
      h(
        'div',
        { class: 'thumb', 'data-url': n.url },
        h('div', { class: 'fb' }, h('img', { class: 'fav fb-ico', alt: '', draggable: 'false' }), h('span', { class: 'fb-host' })),
        h('img', { class: 'shot', alt: '', draggable: 'false' }),
        h('span', { class: 'badge' }),
      ),
      h(
        'div',
        { class: 'cap' },
        h('div', { class: 'title' }),
        h('div', { class: 'host' }),
      ),
      h('div', { class: 'tools' }, toolBtn('open', 'open', 'Open in new tab'), toolBtn('edit', 'edit', 'Edit'), toolBtn('delete', 'trash', 'Delete')),
    );
  } else {
    inner.append(
      h('div', { class: 'f-back' }),
      h('div', { class: 'f-peeks' }),
      h('div', { class: 'f-front' }, h('div', { class: 'f-count' }), h('div', { class: 'f-name' })),
      h('div', { class: 'tools' }, toolBtn('edit', 'edit', 'Rename'), toolBtn('delete', 'trash', 'Delete')),
    );
  }
  const el = h('div', { class: 'card ' + (n.url ? 'bm' : 'folder'), 'data-id': n.id }, inner);
  io.observe(el);
  return el;
}

function updateCard(el, n) {
  const where = S.query ? M.pathTo(n.id).slice(0, -1).map((p) => p.title).join(' › ') : '';
  if (n.url) {
    const note = noteOf(n.url);
    const sig = [n.title, n.url, where, n.file?.name, note].join('\n');
    if (el._sig === sig) return;
    el._sig = sig;
    const file = n.file;
    const media = classify(n.url);
    const kind = file ? fileKind(file.mime, file.name) : media.type;
    const host = file ? extOf(file.name) : hostOf(n.url);
    const thumb = $('.thumb', el);
    thumb.dataset.url = n.url;
    thumb.style.setProperty('--h', hueOf(host));
    el.classList.toggle('is-file', !!file);
    $('.title', el).textContent = n.title || host;
    // Your own words say more than the hostname (which the preview already shows).
    $('.host', el).textContent = where || note || (file ? `${host} · ${formatBytes(file.size)}` : host);
    $('.host', el).title = note;
    el.classList.toggle('has-note', !!note && !where);
    $('.fb-host', el).textContent = host;
    if (!file) $('.fb-ico', el).src = faviconUrl(n.url, 64);
    delete $('.fb-ico', el).dataset.src;
    // A small mark for things that play, and for saved posts.
    const badge = $('.badge', el);
    const mark = kind === 'video' || kind === 'audio' || isPlayable(media) ? 'play' : { tweet: 'X', instagram: 'IG', pinterest: 'PIN', pdf: 'PDF' }[kind] || '';
    badge.hidden = !mark;
    if (mark === 'play') badge.innerHTML = ICON.play;
    else badge.textContent = mark;
    paintPreview(thumb);
  } else {
    const firsts = M.firstUrls(n, 3);
    const total = M.countUrls(n);
    const sig = [n.title, total, where, ...firsts.map((f) => f.url)].join('\n');
    if (el._sig === sig) return;
    el._sig = sig;
    $('.f-name', el).textContent = n.title || 'Untitled';
    $('.f-count', el).textContent = where || (total ? plural(total, 'item') : 'Empty');
    $('.f-peeks', el).replaceChildren(
      ...firsts.map((f) => {
        const p = h(
          'div',
          { class: 'peek', 'data-url': f.url },
          h('img', { class: 'fav fb-ico', alt: '', draggable: 'false', src: M.isFile(f) ? 'icons/icon48.png' : faviconUrl(f.url, 32) }),
          h('img', { class: 'shot', alt: '', draggable: 'false' }),
        );
        p.style.setProperty('--h', hueOf(hostOf(f.url)));
        paintPreview(p);
        return p;
      }),
    );
  }
}

async function paintPreview(el) {
  const url = el.dataset.url;
  const e = await previews.get(url);
  if (el.dataset.url !== url) return;
  const img = $('.shot', el);
  if (e.src) {
    if (img.dataset.src !== e.src) {
      img.dataset.src = e.src;
      img.onload = () => {
        el.classList.add('has-img');
        const r = +(img.naturalWidth / img.naturalHeight).toFixed(3);
        if (!r || !el.classList.contains('thumb') || Math.abs((ratios.get(url) || 0) - r) < 0.02) return;
        ratios.set(url, r);
        saveRatios();
        if (document.body.dataset.view !== 'gallery') return;
        cancelAnimationFrame(relayout);
        relayout = requestAnimationFrame(() => layout());
      };
      img.src = e.src;
      el.classList.toggle('is-og', e.kind === 'og'); // social images are composed for the centre
    }
  } else if (img.dataset.src) {
    delete img.dataset.src;
    img.removeAttribute('src');
    el.classList.remove('has-img');
  }
  const fav = $('.fav', el);
  if (fav && e.icon && fav.dataset.src !== e.icon) {
    fav.dataset.src = e.icon;
    fav.onerror = () => {
      fav.onerror = null;
      fav.src = faviconUrl(url, 64);
    };
    fav.src = e.icon;
  }
}

previews.onPreview((url, entry) => {
  for (const el of $$('[data-url]', grid)) if (el.dataset.url === url) paintPreview(el);
  countCaptures();
  // A pasted link was given its hostname as a title; adopt the real one once we know it.
  for (const [id, u] of autoTitle) {
    if (u !== url) continue;
    autoTitle.delete(id);
    const n = M.node(id);
    if (n && entry?.pageTitle && n.title === hostOf(url)) M.update(id, { title: entry.pageTitle }).catch(() => {});
  }
});

// =====================================================================================
// layout + render
// =====================================================================================

function slotXY(i) {
  const { cols, W, H, gap } = metrics;
  return { x: (i % cols) * (W + gap), y: Math.floor(i / cols) * (H + gap) };
}

function layout({ instant = null } = {}) {
  const avail = grid.clientWidth;
  if (!avail) return;
  const gallery = document.body.dataset.view === 'gallery';
  const size = S.settings.size;
  const gap = gallery ? clamp(Math.round(size * 0.08), 12, 22) : clamp(Math.round(size * 0.13), 20, 36);
  const cols = Math.max(1, Math.floor((avail + gap) / (size + gap)));
  const W = Math.min((avail - gap * (cols - 1)) / cols, size * 1.5);
  const H = Math.round(W * 0.625 + 52);
  metrics = { cols, W, H, gap, hole: null };

  const list = drag ? order.filter((id) => !drag.idSet.has(id)) : order;
  const holeAt = drag && drag.gap != null && !S.query ? drag.gap : -1;

  // Grid: equal slots, row by row. Gallery: each card as tall as its picture, dropped into
  // whichever column is shortest so far.
  const colH = new Array(cols).fill(0);
  let slot = 0;
  const heightOf = (id) => {
    const n = M.node(id);
    if (!gallery || !n?.url) return H;
    return Math.round(W / clamp(ratios.get(n.url) || 1.6, 0.45, 2.4));
  };
  const next = (h) => {
    if (!gallery) return slotXY(slot++);
    const c = colH.indexOf(Math.min(...colH));
    const p = { x: c * (W + gap), y: colH[c] };
    colH[c] += h + gap;
    slot++;
    return p;
  };
  const holeH = drag ? heightOf(drag.ids[0]) : H;
  for (const id of list) {
    if (slot === holeAt) metrics.hole = next(holeH);
    const h = heightOf(id);
    place(id, next(h), h, instant);
  }
  if (drag) {
    if (holeAt >= slot) metrics.hole = next(holeH); // the hole is at the very end
    // Dragged cards rest (hidden) in the hole so a cancelled drag has somewhere to fly home to.
    const rest = metrics.hole || next(holeH);
    for (const id of drag.ids) if (cards.has(id)) place(id, rest, heightOf(id), new Set([id]));
  }
  grid.style.height = (gallery ? Math.max(0, ...colH) : Math.ceil(slot / cols) * (H + gap)) + 'px';
}

function place(id, p, h, instant) {
  const el = cards.get(id);
  pos.set(id, { ...p, h });
  const snap = el._fresh || instant?.has(id);
  if (snap) el.classList.add('no-anim');
  el.style.width = metrics.W + 'px';
  el.style.height = h + 'px';
  el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  if (snap) {
    void el.offsetWidth;
    el.classList.remove('no-anim');
  }
}

function leave(el) {
  io.unobserve(el);
  el.classList.add('leaving');
  if (reducedMotion()) return el.remove();
  $('.card-in', el)
    .animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 170, easing: 'ease-out', fill: 'forwards' })
    .finished.finally(() => el.remove());
}

function enter(el, i, { origin, zoomOut }) {
  if (reducedMotion()) return;
  const delay = Math.min(i * 14, 280);
  const p = pos.get(el.dataset.id);
  if (origin && p) {
    const g = grid.getBoundingClientRect();
    const ox = origin.x + origin.width / 2 - g.x - metrics.W / 2;
    const oy = origin.y + origin.height / 2 - g.y - metrics.H / 2;
    el.animate(
      [
        { transform: `translate3d(${ox}px, ${oy}px, 0) scale(.2)`, opacity: 0 },
        { opacity: 1, offset: 0.35 },
        { transform: `translate3d(${p.x}px, ${p.y}px, 0) scale(1)`, opacity: 1 },
      ],
      { duration: SPRING.duration, easing: SPRING.easing, delay, fill: 'backwards' },
    );
  } else {
    $('.card-in', el).animate(
      [{ opacity: 0, transform: `scale(${zoomOut ? 1.07 : 0.95})` }, { opacity: 1, transform: 'none' }],
      { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)', delay, fill: 'backwards' },
    );
  }
}

function renderGrid(opts = {}) {
  const items = visibleItems();
  const mode = viewMode();
  if (document.body.dataset.view !== mode) {
    document.body.dataset.view = mode;
    opts = { ...opts, instant: new Set(items.map((n) => n.id)) }; // a change of view isn't a shuffle
  }
  for (const b of $$('.view-btn')) b.setAttribute('aria-pressed', b.dataset.view === mode);
  $('#view-seg').classList.toggle('off', !!S.query);
  order = items.map((n) => n.id);
  const keep = new Set(order);
  for (const id of [...S.sel]) if (!keep.has(id)) S.sel.delete(id);
  for (const [id, el] of cards) {
    if (keep.has(id)) continue;
    cards.delete(id);
    pos.delete(id);
    leave(el);
  }
  const fresh = [];
  for (const n of items) {
    let el = cards.get(n.id);
    if (!el) {
      el = buildCard(n);
      el._fresh = true;
      cards.set(n.id, el);
      grid.append(el);
      fresh.push(el);
    }
    updateCard(el, n);
    el.classList.toggle('sel', S.sel.has(n.id));
    el.classList.toggle('drag-src', !!drag?.idSet.has(n.id));
  }
  layout({ instant: opts.instant });
  fresh.forEach((el, i) => {
    el._fresh = false;
    if (!opts.instant?.has(el.dataset.id)) enter(el, i, opts);
  });

  const empty = $('#empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    $('#empty-title').textContent = S.query ? 'Nothing matches' : 'Nothing here yet';
    $('#empty-sub').textContent = S.query
      ? 'Try a shorter search, or part of the address.'
      : M.isLocal(S.folderId)
        ? 'Drop in videos, images, PDFs or any file — or paste a link. It all stays on this Mac.'
        : 'Drag bookmarks in, paste a link, or drop a tab here.';
  }
  renderCrumbs(items);
  countCaptures();
}

function renderAll(opts) {
  renderTree();
  renderGrid(opts);
}

function paintSelection() {
  for (const [id, el] of cards) el.classList.toggle('sel', S.sel.has(id));
}

const refresh = debounce(async () => {
  if (drag) return void (dirty = true);
  await M.load();
  if (!M.node(S.folderId)) return go(defaultFolder());
  renderAll();
  if (ql.isOpen() && !M.node(ql.currentId())) ql.close();
}, 80);

// =====================================================================================
// actions
// =====================================================================================

function pushUndo(fn) {
  undoStack.push(fn);
  if (undoStack.length > 30) undoStack.shift();
  return async () => {
    const at = undoStack.indexOf(fn);
    if (at !== -1) undoStack.splice(at, 1);
    await fn();
  };
}

async function undoLast() {
  const fn = undoStack.pop();
  if (!fn) return;
  await fn();
  toast('Undone');
}

const openUrl = (url, active = true) => chrome.tabs.create({ url, active });

// Where a node opens: its address, or Shelf's own viewer for a file kept in My Shelf.
function hrefOf(n) {
  if (!M.isFile(n)) return n.url;
  const q = new URLSearchParams({ name: n.file.name, mime: n.file.mime || '' });
  return chrome.runtime.getURL(`view.html#${blobIdOf(n.url)}?${q}`);
}

function openNode(n, active = true) {
  if (!n?.url) return;
  markOpened(n.url);
  openUrl(hrefOf(n), active);
}

function normalizeUrl(v) {
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  try {
    return new URL(v).href;
  } catch {
    return '';
  }
}

async function newBookmark() {
  const v = await formDialog({
    title: 'New bookmark',
    submit: 'Add',
    fields: [
      { name: 'url', label: 'Address', placeholder: 'https://', required: true },
      { name: 'title', label: 'Name', placeholder: 'Leave empty to use the page’s title' },
    ],
  });
  if (!v) return;
  const url = normalizeUrl(v.url);
  if (!url) return toast('That doesn’t look like a web address');
  await addLinks([{ url, title: v.title }]);
}

async function addLinks(links, parentId = S.folderId) {
  if (S.query) go(parentId);
  const undos = [];
  for (const l of links) {
    // A direct link to a video / image / PDF is best named after the file itself.
    const fileName = canSaveLocally(classify(l.url)) ? decodeURIComponent(new URL(l.url).pathname.split('/').pop()) : '';
    const { made, undo } = await M.create({ parentId, url: l.url, title: l.title || fileName || hostOf(l.url) });
    if (!l.title && !fileName) autoTitle.set(made.id, l.url);
    undos.push(undo);
    previews.want(l.url);
  }
  const undo = pushUndo(async () => {
    for (const u of undos.reverse()) await u();
  });
  toast(links.length === 1 ? 'Bookmark added' : `${links.length} bookmarks added`, { action: 'Undo', onAction: undo });
}

async function newFolder(parentId = S.folderId) {
  const v = await formDialog({ title: 'New folder', submit: 'Create', fields: [{ name: 'title', label: 'Name', value: 'New folder', required: true }] });
  if (!v?.title) return;
  const made = await makeFolder(parentId, v.title);
  pushUndo(made.undo);
}

// A new folder goes with the other folders at the top, never under hundreds of imported posts,
// and shows up straight away: open in the sidebar, selected and in view on the canvas.
async function makeFolder(parentId, title) {
  const firstLink = M.kids(parentId).findIndex((k) => k.url);
  const res = await M.create({ parentId, title, index: firstLink === -1 ? undefined : firstLink });
  expand(parentId, true);
  await M.load();
  renderAll();
  if (cards.has(res.made.id)) {
    S.sel = new Set([res.made.id]);
    S.lastSel = res.made.id;
    paintSelection();
    cards.get(res.made.id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  return res;
}

// Select some cards → "New folder with these": the quick way to carve up a big import.
async function folderFromSelection(ids) {
  ids = ids.filter((id) => !M.isLocked(M.node(id)));
  const parentId = M.node(ids[0])?.parent.id;
  if (!parentId) return;
  const v = await formDialog({ title: `New folder with ${plural(ids.length, 'item')}`, submit: 'Create', fields: [{ name: 'title', label: 'Name', value: '', placeholder: 'Folder name', required: true }] });
  if (!v?.title) return;
  const { made, undo: undoFolder } = await makeFolder(parentId, v.title);
  const undoMove = await M.moveMany(ids, made.id);
  S.sel.clear();
  const undo = pushUndo(async () => {
    await undoMove();
    await undoFolder();
  });
  toast(`Moved ${plural(ids.length, 'item')} into “${v.title}”`, { action: 'Undo', onAction: undo });
}

async function editNode(id, { focus = null } = {}) {
  const n = M.node(id);
  if (!n || M.isLocked(n)) return;
  const fields = [{ name: 'title', label: 'Name', value: n.title }];
  if (n.url && !M.isFile(n)) fields.push({ name: 'url', label: 'Address', value: n.url, required: true });
  if (n.url) fields.push({ name: 'note', label: 'Note', type: 'textarea', value: noteOf(n.url), placeholder: 'Why you saved it, what to look at… Notes are searchable.' });
  const v = await formDialog({ title: n.url ? (M.isFile(n) ? 'Edit file' : 'Edit bookmark') : 'Rename folder', fields, focus });
  if (!v) return;
  const changes = { title: v.title };
  if (v.url != null) {
    changes.url = normalizeUrl(v.url);
    if (!changes.url) return toast('That doesn’t look like a web address');
  }
  const undoEdit = await M.update(id, changes);
  if (n.url) {
    // The note lives with the address, so it follows an edited one.
    const to = changes.url || n.url;
    const oldNote = noteOf(n.url);
    const wasAtTo = await setNote(to, v.note);
    if (to !== n.url) await setNote(n.url, '');
    pushUndo(async () => {
      await undoEdit();
      await setNote(to, to === n.url ? oldNote : wasAtTo);
      if (to !== n.url) await setNote(n.url, oldNote);
    });
    renderGrid();
  } else pushUndo(undoEdit);
  if (ql.currentId() === id && changes.url && changes.url !== n.url) setTimeout(() => ql.refresh(), 150);
}

async function removeNodes(ids) {
  ids = ids.filter((id) => !M.isLocked(M.node(id)));
  if (!ids.length) return;
  const label = ids.length === 1 ? `“${M.node(ids[0]).title || hostOf(M.node(ids[0]).url)}”` : plural(ids.length, 'item');
  const undo = pushUndo(await M.removeMany(ids));
  S.sel.clear();
  toast(`Deleted ${label}`, { action: 'Undo', onAction: undo });
}

async function moveNodes(ids, parentId, anchorId = null, { quiet = false } = {}) {
  const undo = pushUndo(await M.moveMany(ids, parentId, anchorId));
  if (!quiet) {
    toast(`Moved ${ids.length === 1 ? '1 item' : ids.length + ' items'} to “${M.node(parentId)?.title}”`, { action: 'Undo', onAction: undo });
  }
}

// One level up: the items land right after the folder they came out of.
const canMoveOut = (n) => !!n && !M.isLocked(n) && !M.isLocked(n.parent);

async function moveOut(ids) {
  ids = ids.filter((id) => canMoveOut(M.node(id)));
  if (!ids.length) return;
  const from = M.node(ids[0]).parent;
  ids = ids.filter((id) => M.node(id).parent === from); // a search can select across folders
  const after = from.parent.children[from.index + 1]?.id ?? null;
  await moveNodes(ids, from.parent.id, after);
}

async function moveWithPicker(ids) {
  const folders = M.allFolders().map(({ node: f, depth }) => ({
    id: f.id,
    title: f.title || 'Untitled',
    depth,
    disabled: ids.some((id) => M.isInside(f.id, id)),
  }));
  const dest = await folderPicker({ title: `Move ${plural(ids.length, 'item')} to…`, folders, currentId: M.node(ids[0])?.parent.id });
  if (dest) await moveNodes(ids, dest);
}

// A folder as a working session: its pages in tabs here, in a window of their own, or as a named tab group.
async function openAll(n, how = 'tabs') {
  const nodes = M.firstUrls(n, 200);
  if (!nodes.length) return toast('That folder has nothing to open');
  if (nodes.length > 12) {
    const ok = await formDialog({ title: `Open ${nodes.length} tabs?`, submit: 'Open all', fields: [] });
    if (!ok) return;
  }
  nodes.forEach((b) => markOpened(b.url));
  const urls = nodes.map(hrefOf);
  if (how === 'window') return chrome.windows.create({ url: urls, focused: true });
  const tabs = [];
  for (const [i, url] of urls.entries()) tabs.push(await chrome.tabs.create({ url, active: i === 0 && how === 'tabs' }));
  if (how !== 'group') return;
  try {
    const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
    await chrome.tabGroups?.update(groupId, { title: n.title || 'Shelf' });
    await chrome.tabs.update(tabs[0].id, { active: true });
  } catch {
    toast('This browser doesn’t do tab groups, so they opened as plain tabs');
  }
}

// …and the other way round: what is open in this window becomes a folder you can come back to.
async function saveOpenTabs() {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => isWeb(t.url));
  if (!tabs.length) return toast('No web pages are open in this window besides Shelf');
  const parentId = S.query ? defaultFolder() : S.folderId;
  const day = new Date().toLocaleDateString([], { day: 'numeric', month: 'short' });
  const v = await formDialog({
    title: `Save ${plural(tabs.length, 'open tab')} as a folder`,
    submit: 'Save',
    fields: [{ name: 'title', label: `Folder name, inside “${M.node(parentId).title}”`, value: `Session · ${day}`, required: true }],
  });
  if (!v?.title) return;
  const { made, undo } = await M.create({ parentId, title: v.title });
  for (const t of tabs) {
    await M.create({ parentId: made.id, url: t.url, title: t.title || hostOf(t.url) });
    previews.want(t.url);
  }
  const u = pushUndo(undo);
  toast(`Saved ${plural(tabs.length, 'tab')} to “${v.title}”`, { action: 'Undo', onAction: u });
}

// ---------- My Shelf: files kept inside the extension ----------

const shelfTarget = () => (M.isLocal(S.folderId) && !S.query ? S.folderId : M.SHELF_ROOT);

async function videoFrame(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(blob);
  try {
    await new Promise((ok, no) => ((v.onloadeddata = ok), (v.onerror = no), setTimeout(no, 8000)));
    v.currentTime = Math.min(1.5, (v.duration || 2) / 3);
    await new Promise((ok) => ((v.onseeked = ok), setTimeout(ok, 3000)));
    return await createImageBitmap(v);
  } finally {
    URL.revokeObjectURL(v.src);
  }
}

async function makeThumb(blob, name, url) {
  try {
    const kind = fileKind(blob.type, name);
    const source = kind === 'image' ? blob : kind === 'video' ? await videoFrame(blob) : null;
    if (source) await previews.saveShot(url, (await toJpeg(source, { maxW: 960 })).blob);
  } catch {
    /* no thumbnail: the card shows the file type instead */
  }
}

// Instagram's "Download your information" export lists saved posts as JSON: import the links.
async function importInstagramExport(file) {
  try {
    const posts = postsFromInstagramExport(JSON.parse(await file.text()));
    if (!posts.length) return false;
    const res = await importPosts(posts);
    toast(res.added ? `Imported ${plural(res.added, 'saved post')} into My Shelf` : 'Those saved posts are already in My Shelf');
    return true;
  } catch {
    return false;
  }
}

function ago(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

async function addMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const { lastSync = {} } = await chrome.storage.local.get('lastSync');
  const collect = (platform) => () => {
    chrome.runtime.sendMessage({ type: 'shelf-collect', platform });
    toast('Opening it in a new tab. Look for the Shelf panel, bottom right');
  };
  openMenu(r.left, r.bottom + 6, [
    // A second run only collects what is new: it stops scrolling at the posts it already has.
    { label: lastSync.x ? 'Sync my X bookmarks…' : 'My X bookmarks…', icon: lastSync.x ? 'refresh' : 'download', hint: ago(lastSync.x), brand: 'x', run: collect('x') },
    { label: lastSync.instagram ? 'Sync my Instagram saved posts…' : 'My Instagram saved posts…', icon: lastSync.instagram ? 'refresh' : 'download', hint: ago(lastSync.instagram), brand: 'instagram', run: collect('instagram') },
    { label: lastSync.pinterest ? 'Sync my Pinterest pins…' : 'My Pinterest boards and pins…', icon: lastSync.pinterest ? 'refresh' : 'download', hint: ago(lastSync.pinterest), brand: 'pinterest', run: collect('pinterest') },
    null,
    { label: 'Files from this Mac…', icon: 'upload', run: pickFiles },
    { label: 'This window’s open tabs, as a folder…', icon: 'window', run: saveOpenTabs },
  ]);
}

async function importFiles(files, parentId = shelfTarget()) {
  files = [...files].filter(Boolean);
  if (files.length === 1 && /\.json$/i.test(files[0].name) && (await importInstagramExport(files[0]))) return;
  if (!files.length) return;
  const undos = [];
  for (const f of files) {
    const { made, undo } = await M.create({
      parentId,
      title: f.name.replace(/\.[^.]+$/, ''),
      file: { name: f.name, mime: f.type, size: f.size },
      blob: f,
    });
    undos.push(undo);
    makeThumb(f, f.name, made.url);
  }
  if (S.folderId !== parentId || S.query) go(parentId);
  const undo = pushUndo(async () => {
    for (const u of undos.reverse()) await u();
  });
  toast(`Saved ${plural(files.length, 'file')} to ${M.node(parentId)?.title || 'My Shelf'}`, { action: 'Undo', onAction: undo });
}

function pickFiles() {
  const input = h('input', { type: 'file', multiple: true });
  input.addEventListener('change', () => importFiles(input.files));
  input.click();
}

// Turn a link to a video / image / PDF into a copy that lives in My Shelf.
async function saveLocalCopy(n) {
  const dismiss = toast('Downloading…', { ms: 120_000 });
  try {
    const res = await fetch(n.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = decodeURIComponent(new URL(n.url).pathname.split('/').pop() || 'file');
    dismiss();
    await importFiles([new File([blob], name, { type: blob.type })], M.isLocal(n.parent.id) ? n.parent.id : M.SHELF_ROOT);
  } catch {
    dismiss();
    toast('That file couldn’t be downloaded');
  }
}

// ---------- a bookmark's picture: copy it, or save it ----------

const hasImage = (n) => !!n?.url && (M.isFile(n) ? fileKind(n.file.mime, n.file.name) === 'image' : !!previews.peek(n.url)?.src);

// The sharpest copy to be had: the file itself, the original the post came with (if its address
// still answers), and failing that the preview Shelf keeps.
async function imageBlobOf(n) {
  if (M.isFile(n)) return local.getBlob(blobIdOf(n.url));
  const rec = await getRec(n.url).catch(() => null);
  const sources = [classify(n.url).type === 'image' ? n.url : null, ...(rec?.ogSrc || [])].filter(Boolean);
  for (const src of sources) {
    try {
      const res = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000) });
      const blob = res.ok && (await res.blob());
      if (blob && blob.type.startsWith('image/') && blob.size > 2000) return blob;
    } catch {
      /* expired or offline: fall through to the next source */
    }
  }
  const kept = rec?.ogPinned ? rec.og : rec?.shot || rec?.og;
  if (!kept) throw new Error('no image');
  return kept;
}

async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function copyImage(n) {
  try {
    // Handing the clipboard a promise keeps this inside the click, however long the fetch takes.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageBlobOf(n).then(toPng) })]);
    toast('Image copied. Paste it into Figma, Notes, a chat…');
  } catch {
    toast('That image couldn’t be copied');
  }
}

async function downloadImage(n) {
  try {
    const blob = await imageBlobOf(n);
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[blob.type] || 'jpg';
    const name = (n.title || hostOf(n.url)).replace(/[\\/:*?"<>|\n]+/g, ' ').trim().slice(0, 80) || 'image';
    const a = h('a', { href: URL.createObjectURL(blob), download: `${name}.${ext}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch {
    toast('That image couldn’t be saved');
  }
}

async function downloadFile(n) {
  const blob = await local.getBlob(blobIdOf(n.url));
  if (!blob) return toast('This file is missing');
  const a = h('a', { href: URL.createObjectURL(blob), download: n.file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function droppedFiles(dt) {
  return [...(dt?.items || [])]
    .filter((i) => i.kind === 'file' && !i.webkitGetAsEntry?.()?.isDirectory)
    .map((i) => i.getAsFile());
}

// ---------- tidy up ----------

function tidyHere() {
  if (S.query) return toast('Open a folder to tidy it');
  const picked = [...S.sel].map(M.node).filter((n) => n?.url);
  tidy({
    items: picked.length ? picked : visibleItems().filter((n) => n.url),
    currentId: S.folderId,
    onApplied: async ({ moved, undo }) => {
      await M.load();
      renderAll();
      if (!moved) return;
      const u = pushUndo(undo);
      toast(`Tidied ${plural(moved, 'item')} into folders`, { action: 'Undo', onAction: u });
    },
  });
}

function reviewHere(tab) {
  review({
    folderId: S.query ? null : S.folderId,
    tab,
    onDelete: removeNodes,
    onOpen: (n) => openNode(n, false),
    onEditUrl: async (id, url) => {
      const n = M.node(id);
      const note = noteOf(n.url);
      const undoEdit = await M.update(id, { title: n.title, url });
      if (note) await setNote(url, note);
      pushUndo(undoEdit);
      toast('Address updated', { action: 'Undo', onAction: undoLast });
    },
  });
}

async function openSettings() {
  const st = S.settings;
  const visit = h('input', { type: 'checkbox', checked: st.captureOnVisit !== false });
  const auto = h('input', { type: 'checkbox', checked: !!st.autoFile });
  const backups = h('div', { class: 'backups' });
  const when = (id) => new Date(id).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const draw = async () => {
    const list = await listBackups();
    backups.replaceChildren(
      ...list.slice(0, 6).map((b) =>
        h(
          'div',
          { class: 'backup-row' },
          h('span', { class: 'backup-when' }, when(b.id)),
          h('span', { class: 'backup-meta' }, `${b.reason} · ${plural(b.count, 'bookmark')}`),
          h('button', {
            type: 'button',
            class: 'btn soft',
            onclick: async () => {
              const a = h('a', { href: URL.createObjectURL(await backupAsHtml(b.id)), download: `bookmarks-${new Date(b.id).toISOString().slice(0, 10)}.html` });
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
            },
          }, 'Download'),
          h('button', {
            type: 'button',
            class: 'btn soft',
            title: 'Rebuilds this snapshot inside a new folder. Nothing is replaced.',
            onclick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = 'Restoring…';
              const top = await restoreAsCopy(b.id);
              close();
              toast(`Restored into “${top.title}”`, { action: 'Show', onAction: () => go(top.id) });
            },
          }, 'Restore a copy'),
        ),
      ),
      list.length ? null : h('p', { class: 'set-note' }, 'No backups yet.'),
    );
  };
  const form = h(
    'form',
    { class: 'form settings' },
    h('h2', {}, 'Settings'),
    h('div', { class: 'set-title' }, 'Backups of your browser bookmarks'),
    h('p', { class: 'set-note' }, 'Shelf snapshots all your browser bookmarks every day it is opened and before every Tidy up, and keeps the last 20 on this Mac. Download gives a standard bookmarks file any browser can import.'),
    backups,
    h('div', {}, h('button', { type: 'button', class: 'btn soft', onclick: async () => (await takeBackup('Manual'), draw(), toast('Backup saved')) }, 'Back up now')),
    h('div', { class: 'set-title' }, 'Automation'),
    h('label', { class: 'check' }, visit, h('span', {}, 'Snapshot bookmarked pages as I browse, for their card preview')),
    h('label', { class: 'check' }, auto, h('span', {}, 'File new Instagram and X bookmarks into their own folders, ready for Tidy up to sort by topic')),
    h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    st.captureOnVisit = visit.checked;
    st.autoFile = auto.checked;
    saveSettings();
    close();
    toast('Settings saved');
  });
  const close = openDialog(form, { wide: true });
  draw();
}

// The bookmarks on the canvas whose card has no photo of the page yet.
async function needCapture() {
  const need = [];
  for (const n of visibleItems()) {
    if (!n.url || !isWeb(n.url)) continue;
    const e = await previews.get(n.url);
    const m = classify(n.url);
    // Videos already have a proper poster; posts only need a photo when nothing else turned up.
    if (m.type === 'page' ? e.kind !== 'shot' : isSocialPost(m) && !e.src) need.push(n);
  }
  return need;
}

// The number on the Capture previews button: how many are still to do here.
const countCaptures = debounce(async () => {
  const n = (await needCapture()).length;
  const badge = $('#capture-n');
  badge.hidden = !n;
  badge.textContent = n > 999 ? '999+' : n;
  $('#btn-capture').title = n
    ? `${plural(n, 'bookmark')} here ${n === 1 ? 'has' : 'have'} no photo of the page yet`
    : 'Every bookmark here already has a photo of its page';
}, 200);

async function captureHere() {
  const need = await needCapture();
  if (!need.length) return toast('Every bookmark here already has a captured preview');
  const links = visibleItems().filter((n) => n.url && isWeb(n.url)).length;
  const ok = await new Promise((resolve) => {
    let go = false;
    const close = openDialog(
      h(
        'div',
        { class: 'form' },
        h('h2', {}, 'Capture previews'),
        h(
          'section',
          { class: 'tidy-option' },
          h('span', { class: 'tidy-option-ico', icon: 'camera' }),
          h(
            'div',
            {},
            h('strong', {}, `${need.length} of ${plural(links, 'bookmark')} here ${need.length === 1 ? 'has' : 'have'} no photo yet`),
            h('p', {}, 'Shelf opens each page in a preview, one after the other, waits for it to load and photographs it for its card. Pages that never finish loading are skipped.'),
            h('p', {}, 'It takes a few seconds per page. Press Esc to stop whenever you like: what was captured so far is kept.'),
          ),
        ),
        h(
          'div',
          { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => ((go = true), close()) }, `Capture ${plural(need.length, 'preview')}`),
        ),
      ),
      { onClose: () => resolve(go) },
    );
  });
  if (!ok) return;
  const done = await ql.runBatch(need);
  toast(done < need.length ? `Captured ${done} of ${plural(need.length, 'preview')}` : `Captured ${plural(done, 'preview')}`);
  countCaptures();
}

function linksFromText(text) {
  return (text || '')
    .split(/\s+/)
    .filter((t) => /^https?:\/\/\S+\.\S+/i.test(t))
    .map((url) => ({ url: normalizeUrl(url) }))
    .filter((l) => l.url);
}

// =====================================================================================
// quick look
// =====================================================================================

const ql = createQuickLook({
  getNode: M.node,
  getNote: noteOf,
  onSeen: markOpened,
  getSiblings: visibleItems,
  rectOf: (id) => $('.card-in', cards.get(id) || document.createElement('div'))?.getBoundingClientRect() || null,
  onEdit: editNode,
  onOpen: (id) => openNode(M.node(id)),
});

// =====================================================================================
// pointer: click, select, marquee, drag
// =====================================================================================

function activate(id, e) {
  const n = M.node(id);
  if (!n) return;
  if (e.metaKey || e.ctrlKey) {
    S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
    S.lastSel = id;
  } else if (e.shiftKey && S.lastSel && order.includes(S.lastSel)) {
    const [a, b] = [order.indexOf(S.lastSel), order.indexOf(id)].sort((x, y) => x - y);
    order.slice(a, b + 1).forEach((i) => S.sel.add(i));
  } else {
    S.sel.clear();
    S.lastSel = id;
    paintSelection();
    if (n.url) ql.open(id);
    else go(id, cards.get(id)?.getBoundingClientRect());
    return;
  }
  paintSelection();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.tools')) return;
  const cardEl = e.target.closest('.card:not(.leaving)');
  if (!cardEl) return startMarquee(e);
  const id = cardEl.dataset.id;
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    stop();
    if (!M.isLocked(M.node(id))) beginDrag(ev, id);
  };
  const up = (ev) => {
    stop();
    activate(id, ev);
  };
  const stop = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', stop);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', stop);
});

canvas.addEventListener('auxclick', (e) => {
  const n = e.button === 1 && M.node(e.target.closest('.card')?.dataset.id);
  if (n?.url) openNode(n, false);
});

grid.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = e.target.closest('.card')?.dataset.id;
  if (!act || !id) return;
  if (act === 'open') openNode(M.node(id));
  if (act === 'edit') editNode(id);
  if (act === 'delete') removeNodes([id]);
});

grid.addEventListener('pointerover', (e) => (S.hoverId = e.target.closest('.card')?.dataset.id || null));
grid.addEventListener('pointerleave', () => (S.hoverId = null));

function startMarquee(e) {
  if (e.target.closest('#empty') && !order.length) return;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? new Set(S.sel) : new Set();
  if (!additive && S.sel.size) {
    S.sel.clear();
    paintSelection();
  }
  const sx = e.clientX;
  const sy = e.clientY + canvas.scrollTop;
  let box = null;
  const move = (ev) => {
    const cx = ev.clientX;
    const cy = ev.clientY + canvas.scrollTop;
    if (!box) {
      if (Math.hypot(cx - sx, cy - sy) < 4) return;
      box = h('div', { class: 'marquee' });
      canvas.append(box);
    }
    const c = canvas.getBoundingClientRect();
    const r = { l: Math.min(sx, cx), t: Math.min(sy, cy), r: Math.max(sx, cx), b: Math.max(sy, cy) };
    Object.assign(box.style, { left: r.l - c.x + 'px', top: r.t - c.y + 'px', width: r.r - r.l + 'px', height: r.b - r.t + 'px' });
    S.sel = new Set(base);
    for (const [id, el] of cards) {
      const b = el.getBoundingClientRect();
      const top = b.y + canvas.scrollTop;
      if (b.x < r.r && b.right > r.l && top < r.b && top + b.height > r.t) S.sel.add(id);
    }
    paintSelection();
  };
  const up = () => {
    box?.remove();
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// ---------- drag ----------

// rowEl: the drag started on a sidebar folder rather than a card.
function beginDrag(e, id, rowEl = null) {
  if (rowEl || !S.sel.has(id)) {
    S.sel.clear();
    paintSelection();
  }
  const ids = (S.sel.has(id) ? order.filter((i) => S.sel.has(i)) : [id]).filter((i) => !M.isLocked(M.node(i)));
  if (!ids.length) return;
  closeMenu();
  const src = rowEl || cards.get(id);
  const r = src.getBoundingClientRect();
  const ghost = h('div', { class: 'drag-ghost', style: rowEl ? {} : { width: r.width + 'px', height: r.height + 'px' } });
  if (rowEl) {
    ghost.classList.add('dg-row');
    ghost.append(h('span', { class: 'row-ico', icon: 'folder' }), h('span', { class: 'row-name' }, M.node(id).title || 'Untitled'));
  } else {
    if (ids.length > 1) ghost.append(h('div', { class: 'dg-sheet s2' }), h('div', { class: 'dg-sheet s1' }));
    // Wrapped in the card's own classes so the clone keeps its bookmark / folder styling.
    const body = $('.card-in', src).cloneNode(true);
    body.classList.add('dg-body');
    ghost.append(h('div', { class: 'dg-card ' + (M.isFolder(M.node(id)) ? 'folder' : 'bm') }, body));
    if (ids.length > 1) ghost.append(h('div', { class: 'dg-badge' }, ids.length));
  }
  ghost.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
  $('#layer').append(ghost);

  const rest = order.filter((i) => !ids.includes(i));
  drag = {
    ids,
    idSet: new Set(ids),
    ghost,
    // A sidebar folder hangs just off the pointer, so the row and drop line under it stay visible.
    offX: rowEl ? -14 : e.clientX - r.x,
    offY: rowEl ? -12 : e.clientY - r.y,
    x: e.clientX,
    y: e.clientY,
    px: e.clientX,
    tilt: 0,
    gap: S.query || rowEl ? null : clamp(order.indexOf(ids[0]), 0, rest.length),
    fromTree: !!rowEl,
    folders: ids.every((i) => M.isFolder(M.node(i))), // folders may also land *between* sidebar rows
    target: null,
    timer: 0,
    raf: 0,
    lifted: false,
  };
  for (const i of ids) cards.get(i)?.classList.add('drag-src');
  rowEl?.classList.add('drag-src');
  document.body.classList.add('dragging');
  layout();

  addEventListener('pointermove', onDragMove);
  addEventListener('pointerup', onDragUp);
  addEventListener('pointercancel', onDragCancel);
  drag.raf = requestAnimationFrame(dragFrame);
}

const onDragMove = (e) => {
  drag.x = e.clientX;
  drag.y = e.clientY;
};
const onDragUp = () => endDrag(false);
const onDragCancel = () => endDrag(true);

function dragFrame() {
  if (!drag) return;
  const d = drag;
  const vx = d.x - d.px;
  d.px = d.x;
  d.tilt += (clamp(vx * 0.9, -9, 9) - d.tilt) * 0.18;
  const s = d.target ? (d.fromTree ? 0.92 : 0.62) : 1.04;
  d.scale = (d.scale ?? 1) + (s - (d.scale ?? 1)) * 0.22;
  d.ghost.style.transformOrigin = `${d.offX}px ${d.offY}px`;
  d.ghost.style.transform = `translate3d(${d.x - d.offX}px, ${d.y - d.offY}px, 0) rotate(${d.tilt.toFixed(2)}deg) scale(${d.scale.toFixed(3)})`;
  if (!d.lifted) {
    d.lifted = true;
    d.ghost.classList.add('lifted');
  }

  // edge auto-scroll
  const c = canvas.getBoundingClientRect();
  if (d.x > c.x && d.x < c.right) {
    const edge = 70;
    if (d.y < c.y + edge) canvas.scrollTop -= ((c.y + edge - d.y) / edge) * 16;
    else if (d.y > c.bottom - edge) canvas.scrollTop += ((d.y - (c.bottom - edge)) / edge) * 16;
  }
  const tree = $('#tree');
  const t = tree.getBoundingClientRect();
  if (d.x > t.x && d.x < t.right) {
    if (d.y < t.y + 28) tree.scrollTop -= 8;
    else if (d.y > t.bottom - 28) tree.scrollTop += 8;
  }

  updateDropTarget();
  d.raf = requestAnimationFrame(dragFrame);
}

// Over a sidebar folder: its middle means "into it". For a dragged folder, its top and bottom edges
// mean "between rows", which is how a folder is re-ordered, nested, or pulled out a level.
function rowTarget(el, d) {
  const id = el.dataset.folder;
  const n = M.node(id);
  if (!n) return null;
  const r = el.getBoundingClientRect();
  const fy = (d.y - r.y) / r.height;
  if (!d.folders || M.isLocked(n) || (fy >= 0.28 && fy <= 0.72)) return { id, el, kind: 'row', key: id };
  if (d.idSet.has(id)) return null;
  if (fy < 0.5) return { id: n.parent.id, anchor: id, el, kind: 'line', edge: 'before', key: id + ':before' };
  // Under an open folder, the line sits above its first child: that is where the drop goes.
  if (S.settings.expanded.includes(id) && n.children.some((c) => !c.url)) {
    return { id, anchor: n.children[0].id, el, kind: 'line', edge: 'after', deeper: true, key: id + ':in' };
  }
  return { id: n.parent.id, anchor: n.parent.children[n.index + 1]?.id ?? null, el, kind: 'line', edge: 'after', key: id + ':after' };
}

function markTarget(t, on) {
  if (!t) return;
  if (t.kind !== 'line') return void t.el.classList.toggle('drop-hot', on);
  t.el.classList.toggle('drop-' + t.edge, on);
  t.el.classList.toggle('drop-deeper', on && !!t.deeper);
}

function updateDropTarget() {
  const d = drag;
  const under = document.elementFromPoint(d.x, d.y);
  const rest = order.filter((i) => !d.idSet.has(i));
  let target = null;
  let gap = d.gap;

  const dropEl = under?.closest('[data-drop]');
  const cardEl = under?.closest('.card:not(.leaving)');
  if (dropEl?.classList.contains('row')) {
    target = rowTarget(dropEl, d);
  } else if (dropEl) {
    target = { id: dropEl.dataset.drop, el: dropEl, kind: 'crumb', key: dropEl.dataset.drop };
  } else if (cardEl) {
    const id = cardEl.dataset.id;
    const r = cardEl.getBoundingClientRect();
    const fx = (d.x - r.x) / r.width;
    if (M.isFolder(M.node(id)) && (S.query || (fx > 0.22 && fx < 0.78))) target = { id, el: cardEl, kind: 'card', key: id };
    else if (!S.query) gap = rest.indexOf(id) + (fx < 0.5 ? 0 : 1);
  } else if (under?.closest('#canvas') && !S.query) {
    // Empty space: past the last card means "put it at the end".
    const g = grid.getBoundingClientRect();
    const { cols, W, H, gap: gp } = metrics;
    const col = clamp(Math.floor((d.x - g.x + gp / 2) / (W + gp)), 0, cols - 1);
    const rowN = Math.max(0, Math.floor((d.y - g.y + gp / 2) / (H + gp)));
    if (document.body.dataset.view === 'gallery') {
      // Below the last picture of a column: the end.
      const lowest = Math.max(0, ...rest.map((id) => (Math.abs(pos.get(id).x - col * (W + gp)) < 1 ? pos.get(id).y + pos.get(id).h : 0)));
      if (d.y - g.y > lowest) gap = rest.length;
    } else if (rowN * cols + col >= rest.length) gap = rest.length;
  }
  // A sidebar folder can be dragged while the canvas is showing its own insides.
  if (gap != null && !M.canDrop(d.ids, S.folderId)) gap = null;

  if (target) {
    const bad =
      !M.canDrop(d.ids, target.id) || // into itself, or a file into browser bookmarks
      (target.kind !== 'line' && d.ids.every((id) => M.node(id)?.parent.id === target.id)); // already lives there
    if (bad) target = null;
  }

  if (target?.key !== d.target?.key || target?.el !== d.target?.el) {
    markTarget(d.target, false);
    clearTimeout(d.timer);
    d.target = target;
    if (target) {
      markTarget(target, true);
      // Spring-loading: linger over a folder and it opens for you.
      d.timer = target.kind === 'line' ? 0 : setTimeout(() => {
        if (drag !== d || d.target !== target) return;
        if (target.kind === 'row') {
          if (!S.settings.expanded.includes(target.id) && M.kids(target.id).some((k) => !k.url)) {
            expand(target.id, true);
            renderTree();
          }
        } else {
          go(target.id, target.kind === 'card' ? target.el.getBoundingClientRect() : null);
        }
      }, 950);
    }
  }
  if (gap !== d.gap) {
    d.gap = gap;
    layout();
  }
}

async function flyGhost(ghost, to, { scale = 1, fade = false, ms = 260 } = {}) {
  if (reducedMotion()) return;
  ghost.classList.remove('lifted');
  await ghost
    .animate(
      [
        { transform: getComputedStyle(ghost).transform, opacity: 1 },
        { transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(${scale})`, opacity: fade ? 0 : 1 },
      ],
      { duration: ms, easing: 'cubic-bezier(.3,.9,.3,1)', fill: 'forwards' },
    )
    .finished.catch(() => {});
}

async function endDrag(cancelled) {
  const d = drag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  clearTimeout(d.timer);
  removeEventListener('pointermove', onDragMove);
  removeEventListener('pointerup', onDragUp);
  removeEventListener('pointercancel', onDragCancel);
  markTarget(d.target, false);
  document.body.classList.remove('dragging');
  if (d.fromTree) {
    // The click that follows this pointerup belongs to the drag, not to the row under it.
    treeDragged = true;
    setTimeout(() => (treeDragged = false));
  }

  const g = grid.getBoundingClientRect();
  const rest = order.filter((i) => !d.idSet.has(i));
  const overCanvas = !!document.elementFromPoint(d.x, d.y)?.closest('#canvas');
  let landed = null;
  let pulseRows = [];

  try {
    if (!cancelled && d.target) {
      const t = d.target;
      const r = t.el.getBoundingClientRect();
      const line = t.kind === 'line';
      const fly = flyGhost(d.ghost, { x: r.x + r.width / 2 - 20, y: (line ? (t.edge === 'before' ? r.y : r.bottom) : r.y + r.height / 2) - 16 }, { scale: 0.12, fade: true });
      const reorder = line && d.ids.every((id) => M.node(id)?.parent.id === t.id);
      await Promise.all([fly, moveNodes(d.ids, t.id, t.anchor ?? null, { quiet: reorder })]);
      if (d.folders && t.kind === 'row') expand(t.id, true); // show where the folder went
      if (line) pulseRows = d.ids;
      t.el.classList.add('pulse');
      setTimeout(() => t.el.classList.remove('pulse'), 700);
    } else if (!cancelled && d.gap != null && overCanvas) {
      const p = metrics.hole || slotXY(d.gap);
      const anchor = rest[d.gap] ?? null;
      const before = M.kids(S.folderId).map((k) => k.id).join();
      const after = [...rest.slice(0, d.gap), ...d.ids, ...rest.slice(d.gap)].join();
      const fly = flyGhost(d.ghost, { x: g.x + p.x, y: g.y + p.y });
      if (before === after) await fly;
      else await Promise.all([fly, moveNodes(d.ids, S.folderId, anchor, { quiet: true })]);
      landed = new Set(d.ids);
    } else {
      const home = pos.get(d.ids[0]);
      const homeRow = d.fromTree && $(`#tree [data-folder="${d.ids[0]}"]`)?.getBoundingClientRect();
      if (homeRow) await flyGhost(d.ghost, { x: homeRow.x, y: homeRow.y });
      else if (home && cards.has(d.ids[0])) await flyGhost(d.ghost, { x: g.x + home.x, y: g.y + home.y });
      else await flyGhost(d.ghost, { x: d.x - d.offX, y: d.y - d.offY }, { scale: 0.8, fade: true, ms: 160 });
      landed = new Set(d.ids);
    }
  } catch (err) {
    console.error(err);
    toast('That move didn’t work');
  }

  drag = null;
  dirty = false;
  await M.load();
  renderAll({ instant: landed });
  d.ghost.remove();
  for (const id of pulseRows) {
    const row = $(`#tree [data-folder="${id}"]`);
    row?.classList.add('pulse');
    row?.scrollIntoView({ block: 'nearest' });
  }
}

// Links and tabs dragged in from outside the page.
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = droppedFiles(e.dataTransfer);
  if (files.length) return importFiles(files);
  const links = linksFromText(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
  if (links.length) addLinks(links);
});

addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea') || dialogOpen()) return;
  if (e.clipboardData.files.length) return importFiles(e.clipboardData.files);
  const links = linksFromText(e.clipboardData.getData('text/plain'));
  if (links.length) addLinks(links);
});

// =====================================================================================
// context menus
// =====================================================================================

function nodeMenu(ids) {
  const nodes = ids.map(M.node).filter(Boolean);
  const one = nodes.length === 1 ? nodes[0] : null;
  const movable = nodes.filter((n) => !M.isLocked(n)).map((n) => n.id);
  const items = [];
  if (one && M.isFile(one)) {
    items.push(
      { label: 'Open in new tab', icon: 'open', run: () => openNode(one) },
      { label: 'Quick look', icon: 'search', hint: 'Space', run: () => ql.open(one.id) },
      null,
      { label: 'Rename…', icon: 'edit', hint: 'E', run: () => editNode(one.id) },
      { label: noteOf(one.url) ? 'Edit note…' : 'Add a note…', icon: 'note', hint: 'N', run: () => editNode(one.id, { focus: 'note' }) },
      { label: 'Download', icon: 'download', run: () => downloadFile(one) },
    );
    if (hasImage(one)) items.push({ label: 'Copy image', icon: 'copy', hint: '⌘C', run: () => copyImage(one) });
  } else if (one?.url) {
    items.push(
      { label: 'Open in new tab', icon: 'open', run: () => openUrl(one.url) },
      { label: 'Open in new window', icon: 'open', run: () => chrome.windows.create({ url: one.url }) },
      { label: 'Quick look', icon: 'search', hint: 'Space', run: () => ql.open(one.id) },
      null,
      { label: 'Edit…', icon: 'edit', hint: 'E', run: () => editNode(one.id) },
      { label: noteOf(one.url) ? 'Edit note…' : 'Add a note…', icon: 'note', hint: 'N', run: () => editNode(one.id, { focus: 'note' }) },
      { label: 'Copy link', icon: 'link', run: () => navigator.clipboard.writeText(one.url).then(() => toast('Link copied')) },
      { label: 'Refresh preview', icon: 'refresh', run: () => previews.resetPreview(one.url) },
    );
    if (hasImage(one)) {
      items.push(null, { label: 'Copy image', icon: 'copy', hint: '⌘C', run: () => copyImage(one) }, { label: 'Save image…', icon: 'image', run: () => downloadImage(one) });
    }
    if (canSaveLocally(classify(one.url))) items.push({ label: 'Save a local copy to My Shelf', icon: 'download', run: () => saveLocalCopy(one) });
    if (S.query) items.push({ label: 'Show in folder', icon: 'folder', run: () => reveal(one) });
  } else if (one) {
    items.push(
      { label: 'Open folder', icon: 'folder', run: () => go(one.id, cards.get(one.id)?.getBoundingClientRect()) },
      { label: `Open all ${M.countUrls(one) || ''} in tabs`.replace('  ', ' '), icon: 'open', run: () => openAll(one) },
      { label: 'Open all in a new window', icon: 'window', run: () => openAll(one, 'window') },
      ...(chrome.tabs.group ? [{ label: 'Open all as a tab group', icon: 'window', run: () => openAll(one, 'group') }] : []),
      { label: 'New folder inside…', icon: 'folderPlus', run: () => newFolder(one.id) },
    );
    if (!M.isLocked(one)) items.push(null, { label: 'Rename…', icon: 'edit', hint: 'E', run: () => editNode(one.id) });
  } else {
    const urls = nodes.filter((n) => n.url);
    if (urls.length) items.push({ label: `Open ${urls.length} in tabs`, icon: 'open', run: () => urls.forEach((n, i) => openNode(n, i === 0)) });
  }
  if (nodes.some((n) => n.url) && !S.query) items.push({ label: nodes.length > 1 ? `Tidy these ${nodes.length}…` : 'Find it a folder…', icon: 'sparkle', run: tidyHere });
  if (movable.length) {
    const outOf = M.node(movable[0]).parent;
    if (canMoveOut(M.node(movable[0]))) {
      items.push({ label: `Move out to “${outOf.parent.title}”`, icon: 'moveOut', run: () => moveOut(movable) });
    }
    if (!S.query && movable.every((id) => M.node(id).parent.id === outOf.id) && movable.some((id) => M.node(id).url)) {
      items.push({ label: movable.length > 1 ? `New folder with these ${movable.length}…` : 'New folder with this…', icon: 'folderPlus', run: () => folderFromSelection(movable) });
    }
    items.push(
      { label: 'Move to…', icon: 'move', run: () => moveWithPicker(movable) },
      null,
      { label: movable.length > 1 ? `Delete ${movable.length} items` : 'Delete', icon: 'trash', danger: true, hint: '⌫', run: () => removeNodes(movable) },
    );
  }
  return items;
}

function reveal(n) {
  go(n.parent.id);
  requestAnimationFrame(() => {
    S.sel = new Set([n.id]);
    paintSelection();
    cards.get(n.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const id = e.target.closest('.card')?.dataset.id;
  if (id) {
    if (!S.sel.has(id)) {
      S.sel = new Set([id]);
      S.lastSel = id;
      paintSelection();
    }
    return openMenu(e.clientX, e.clientY, nodeMenu([...S.sel]));
  }
  if (S.query) return;
  openMenu(e.clientX, e.clientY, [
    { label: 'New bookmark…', icon: 'plus', run: newBookmark },
    { label: 'New folder…', icon: 'folderPlus', run: () => newFolder() },
    ...(M.isLocal(S.folderId) ? [{ label: 'Add files…', icon: 'upload', run: pickFiles }] : []),
    { label: 'Save this window’s tabs as a folder…', icon: 'window', run: saveOpenTabs },
    null,
    { label: 'Tidy up this folder…', icon: 'sparkle', run: tidyHere },
    { label: 'Review: broken, duplicate, forgotten…', icon: 'review', run: () => reviewHere() },
    { label: 'Capture previews here', icon: 'camera', run: captureHere },
    { label: 'Select all', icon: 'check', hint: '⌘A', run: selectAll },
    null,
    {
      label: `Snapshot bookmarked pages as I browse: ${S.settings.captureOnVisit ? 'on' : 'off'}`,
      icon: 'camera',
      run: () => {
        S.settings.captureOnVisit = !S.settings.captureOnVisit;
        saveSettings();
        toast(S.settings.captureOnVisit ? 'Bookmarked pages get a fresh preview when you visit them' : 'Previews will only be captured from Quick Look');
      },
    },
  ]);
});

// Sidebar folders drag too: onto another folder to nest, between rows to re-order or un-nest.
let treeDragged = false;

$('#tree').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const rowEl = e.target.closest('.row');
  const id = rowEl?.dataset.folder;
  if (!id || M.isLocked(M.node(id))) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    stop();
    beginDrag(ev, id, rowEl);
  };
  const stop = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', stop);
    removeEventListener('pointercancel', stop);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', stop);
  addEventListener('pointercancel', stop);
});

$('#tree').addEventListener('click', (e) => treeDragged && e.stopPropagation(), true);

$('#tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const id = e.target.closest('[data-folder]')?.dataset.folder;
  if (id) openMenu(e.clientX, e.clientY, nodeMenu([id]));
});

// =====================================================================================
// keyboard
// =====================================================================================

function selectAll() {
  S.sel = new Set(order);
  paintSelection();
}

function moveFocus(dx, dy) {
  if (!order.length) return;
  const cur = order.indexOf(S.lastSel);
  if (dy && cur !== -1 && document.body.dataset.view === 'gallery') {
    // Columns are uneven here, so "down" is the nearest card below in the same column.
    const me = pos.get(order[cur]);
    const same = order.filter((id) => Math.abs(pos.get(id).x - me.x) < 1 && (pos.get(id).y - me.y) * dy > 0);
    same.sort((a, b) => Math.abs(pos.get(a).y - me.y) - Math.abs(pos.get(b).y - me.y));
    if (same.length) dx = order.indexOf(same[0]) - cur;
    dy = 0;
  }
  let next = cur === -1 ? 0 : cur + dx + dy * metrics.cols;
  if (cur !== -1 && (next < 0 || next >= order.length)) next = cur;
  const id = order[clamp(next, 0, order.length - 1)];
  S.sel = new Set([id]);
  S.lastSel = id;
  paintSelection();
  cards.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, [contenteditable]');
  const mod = e.metaKey || e.ctrlKey;

  if (drag) {
    if (e.key === 'Escape') endDrag(true);
    return;
  }
  if (dialogOpen()) return;

  if (ql.isOpen()) {
    if (e.key === 'Escape' || e.key === ' ') ql.close();
    else if (e.key === 'ArrowLeft') ql.step(-1);
    else if (e.key === 'ArrowRight') ql.step(1);
    else if (e.key === 'Enter') openNode(M.node(ql.currentId()));
    else if (e.key.toLowerCase() === 'e' && !mod) editNode(ql.currentId());
    else return;
    return e.preventDefault();
  }

  if (typing) {
    if (e.key === 'Escape' && e.target === searchInput) {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.blur();
    }
    return;
  }

  const sel = [...S.sel];
  const one = sel.length === 1 ? M.node(sel[0]) : null;
  const k = e.key;

  if (k === '/' || (mod && k.toLowerCase() === 'k')) searchInput.focus();
  else if (mod && k.toLowerCase() === 'a') selectAll();
  else if (mod && k.toLowerCase() === 'z') undoLast();
  else if (mod && k.toLowerCase() === 'c' && !String(getSelection())) {
    // ⌘C on a card: its picture if it has one, otherwise its address.
    const n = one?.url ? one : M.node(S.hoverId);
    if (!n?.url) return;
    if (hasImage(n)) copyImage(n);
    else navigator.clipboard.writeText(n.url).then(() => toast('Link copied'));
  }
  else if (mod && k === 'ArrowUp') $('#btn-back').click();
  else if (k === 'Escape') {
    S.sel.clear();
    paintSelection();
  } else if (k === ' ') {
    const n = one?.url ? one : M.node(S.hoverId);
    if (n?.url) ql.open(n.id);
  } else if (k === 'Enter') {
    if (one && !one.url) go(one.id, cards.get(one.id)?.getBoundingClientRect());
    else sel.map(M.node).filter((n) => n?.url).forEach((n, i) => openNode(n, i === 0));
  } else if (k === 'Backspace' || k === 'Delete') removeNodes(sel);
  else if (k.toLowerCase() === 'v' && !mod) toggleView();
  else if (k.toLowerCase() === 'e' && one && !mod) editNode(one.id);
  else if (k.toLowerCase() === 'n' && !mod && (one?.url || M.node(S.hoverId)?.url)) editNode(one?.url ? one.id : S.hoverId, { focus: 'note' });
  else if (k === 'ArrowLeft') moveFocus(-1, 0);
  else if (k === 'ArrowRight') moveFocus(1, 0);
  else if (k === 'ArrowUp') moveFocus(0, -1);
  else if (k === 'ArrowDown') moveFocus(0, 1);
  else return;
  e.preventDefault();
});

// =====================================================================================
// boot
// =====================================================================================

async function init() {
  for (const el of $$('[data-icon]')) el.innerHTML = ICON[el.dataset.icon] || '';
  document.documentElement.style.setProperty('--spring', SPRING.easing);
  document.documentElement.style.setProperty('--spring-dur', SPRING.duration + 'ms');

  const stored = (await chrome.storage.local.get('settings')).settings;
  Object.assign(S.settings, stored || {});
  delete S.settings.ai; // the API-key engine is gone; plans are imported instead
  applyTheme();
  $('#size').value = S.settings.size;

  await Promise.all([M.load(), loadNotes()]);
  onNotesChanged(() => renderGrid());
  if (!stored) S.settings.expanded = [defaultFolder()];
  if (!S.settings.shelfShown) {
    // Open My Shelf in the sidebar once, so imported folders are visible; after that it's yours.
    S.settings.shelfShown = true;
    expand(M.SHELF_ROOT, true);
  }
  addEventListener('hashchange', onRoute);
  onRoute();
  dailyBackup().catch(() => {});

  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
    chrome.bookmarks[ev].addListener(refresh);
  }
  local.onChanged(refresh);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'preview-updated') previews.refreshFromDb(msg.url);
  });

  searchInput.addEventListener('input', () => {
    S.query = searchInput.value.trim();
    S.sel.clear();
    canvas.scrollTop = 0;
    renderAll();
  });
  $('#size').addEventListener('input', (e) => {
    S.settings.size = +e.target.value;
    saveSettings();
    layout();
  });
  $('#btn-theme').addEventListener('click', () => {
    S.settings.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.settings.theme];
    saveSettings();
    applyTheme();
  });
  $('#btn-back').addEventListener('click', () => {
    if (S.query) return go(S.folderId);
    const path = M.pathTo(S.folderId);
    if (path.length > 1) go(path.at(-2).id);
  });
  $('#btn-new-bm').addEventListener('click', newBookmark);
  $('#btn-capture').addEventListener('click', captureHere);
  $('#btn-tidy').addEventListener('click', tidyHere);
  $('#btn-review').addEventListener('click', () => reviewHere());
  $('#view-seg').addEventListener('click', (e) => {
    const view = e.target.closest('.view-btn')?.dataset.view;
    if (view) setView(view);
  });
  $('#btn-files').addEventListener('click', addMenu);
  $('#btn-settings').addEventListener('click', openSettings);

  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => layout({ instant: new Set(order) }));
  }).observe(grid);
}

init();
