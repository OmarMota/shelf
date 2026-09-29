// Quick Look: a card zooms open into whatever it really is — a live, scrollable page, a playing
// video, a tweet or Instagram post, an image, a PDF, or a file kept in My Shelf.
// The same stage doubles as the screenshot booth that gives cards their thumbnails.

import { $, h, hostOf, hueOf, isWeb, faviconUrl, sleep, SPRING, reducedMotion, isDark } from './util.js';
import { dataUrlToBlob, toJpeg } from './img.js';
import * as previews from './previews.js';
import { classify, embedUrl, fileKind, formatBytes, extOf, isSocialPost } from './media.js';
import { local, blobIdOf } from './local.js';
import * as net from './netrules.js';

const rulesReady = net.rulesReady;
const myTabId = () => net.tabId;

const VIRTUAL_W = 1280; // sites lay out as if on a desktop-width window, then get scaled to fit
const SETTLE_MS = 1800;
const LOAD_TIMEOUT = 15_000;
// YouTube's player only starts when it was reached from a web page (it reads document.referrer,
// which is empty under an extension page). So the frame first lands on this tiny neutral page and
// is sent on to the player from there.
const HOP = 'https://example.com/';

export function createQuickLook({ getNode, getNote, getSiblings, rectOf, onEdit, onOpen, onSeen }) {
  let root = null;
  let current = null; // { id, url, status: 'loading' | 'ready' | 'failed', waiters: [] }
  let batch = null;
  let lastCapture = 0;
  let pointerInFrame = false;
  let lastNavAt = 0;
  let objectUrl = null; // blob: URL of the local file on stage

  function dropObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  // A framed page that grabs focus (an auto-focused search box, say) would swallow Esc and the
  // arrow keys. Take focus back unless the person plausibly clicked into the page themselves.
  function reclaimFocus() {
    if (root && document.activeElement?.tagName === 'IFRAME') $('.ql-panel', root).focus({ preventScroll: true });
  }
  addEventListener('blur', () => {
    if (!root) return;
    setTimeout(() => {
      if (!pointerInFrame || Date.now() - lastNavAt < 2500) reclaimFocus();
    }, 0);
  });

  // ----- hear how the framed page's navigation went -----
  const ruleReady = rulesReady.then(() => {
    const tabId = myTabId();
    if (tabId == null) return;
    chrome.webNavigation.onCompleted.addListener((d) => {
      if (d.tabId !== tabId || d.parentFrameId !== 0 || d.frameId === 0) return;
      if (current?.hop || d.url.startsWith(HOP)) return; // only the stepping stone has loaded
      settle('ready');
    });
    chrome.webNavigation.onErrorOccurred.addListener((d) => {
      if (d.tabId !== tabId || d.parentFrameId !== 0 || d.frameId === 0) return;
      if (d.error === 'net::ERR_ABORTED') return; // redirects and re-navigations
      settle('failed');
    });
  });

  function settle(status) {
    lastNavAt = Date.now();
    if (!current || current.status !== 'loading') return;
    current.status = status;
    root?.classList.toggle('is-ready', status === 'ready');
    root?.classList.toggle('is-failed', status === 'failed');
    current.waiters.splice(0).forEach((fn) => fn(status));
    if (status === 'ready' && !batch) autoCapture(current);
  }

  const whenSettled = (c) =>
    c.status !== 'loading'
      ? Promise.resolve(c.status)
      : Promise.race([new Promise((r) => c.waiters.push(r)), sleep(LOAD_TIMEOUT).then(() => 'timeout')]);

  // ----- DOM -----
  function build() {
    const btn = (icon, label, run, cls = '') =>
      h('button', { class: 'icon-btn ' + cls, title: label, 'aria-label': label, icon, onclick: run });
    root = h(
      'div',
      { class: 'ql' },
      h('div', { class: 'ql-backdrop', onclick: () => close() }),
      h(
        'div',
        { class: 'ql-panel', tabindex: '-1' },
        h(
          'div',
          { class: 'ql-bar' },
          h('img', { class: 'ql-fav', alt: '' }),
          h('div', { class: 'ql-titles' }, h('div', { class: 'ql-title' }), h('div', { class: 'ql-url' })),
          h('div', { class: 'ql-batch' }),
          btn('left', 'Previous (←)', () => step(-1), 'ql-nav'),
          btn('right', 'Next (→)', () => step(1), 'ql-nav'),
          btn('camera', 'Use this view as the card preview', () => capture(current, true), 'ql-nav'),
          btn('edit', 'Edit (E)', () => current && onEdit(current.id), 'ql-nav'),
          h(
            'button',
            { class: 'btn primary ql-open', onclick: () => current && onOpen(current.id) },
            'Open',
            h('span', { icon: 'open' }),
          ),
          btn('close', 'Close (Esc)', () => close()),
        ),
        h(
          'div',
          { class: 'ql-stage' },
          h('div', { class: 'ql-ph' }, h('img', { class: 'ql-ph-ico', alt: '' }), h('span', { class: 'ql-ph-host' })),
          h('img', { class: 'ql-shot', alt: '' }),
          h('div', { class: 'ql-frame' }),
          h(
            'div',
            { class: 'ql-msg' },
            h('strong', { class: 'ql-msg-title' }, 'This page won’t show inside a preview'),
            h('span', { class: 'ql-msg-sub' }, 'Some sites refuse to load anywhere but their own tab.'),
          ),
          h('div', { class: 'ql-spinner' }),
        ),
      ),
    );
    $('#layer').append(root);
    const stage = $('.ql-stage', root);
    stage.addEventListener('pointerenter', () => (pointerInFrame = true));
    stage.addEventListener('pointerleave', () => {
      pointerInFrame = false;
      reclaimFocus();
    });
  }

  function fitFrame() {
    const stage = $('.ql-stage', root);
    const frame = $('.ql-frame', root);
    if (!stage || !frame) return;
    if (current?.mode !== 'page') {
      Object.assign(frame.style, { width: '100%', height: '100%', transform: 'none' });
      return;
    }
    const w = stage.clientWidth;
    const scale = Math.min(1, w / VIRTUAL_W);
    frame.style.width = w / scale + 'px';
    frame.style.height = stage.clientHeight / scale + 'px';
    frame.style.transform = `scale(${scale})`;
  }
  addEventListener('resize', () => root && fitFrame());

  function modeOf(n) {
    const m = classify(n.url);
    if (m.type === 'file') return { m, mode: fileKind(n.file?.mime, n.file?.name) };
    if (embedUrl(m)) return { m, mode: 'embed' };
    if (['video', 'audio', 'image'].includes(m.type)) return { m, mode: m.type };
    return { m, mode: isWeb(n.url) ? 'page' : 'other' };
  }

  function fail(title, sub) {
    $('.ql-msg-title', root).textContent = title;
    $('.ql-msg-sub', root).textContent = sub;
    settle('failed');
  }

  async function show(id, { delayFrame = 0 } = {}) {
    const n = getNode(id);
    if (!n?.url) return null;
    const { m, mode } = modeOf(n);
    const me = (current = { id, url: n.url, mode, media: m, status: 'loading', waiters: [] });
    const host = n.file ? extOf(n.file.name) : hostOf(n.url);
    root.classList.remove('is-ready', 'is-failed');
    root.dataset.mode = mode;
    root.dataset.media = m.type;
    $('.ql-title', root).textContent = n.title || host;
    if (!batch) onSeen?.(n.url); // looking at it counts as using it; a capture run doesn't
    const note = getNote?.(n.url) || '';
    $('.ql-url', root).textContent = note || (n.file ? `${n.file.name} · ${formatBytes(n.file.size)}` : n.url);
    $('.ql-url', root).title = note ? `${note}\n\n${n.url}` : '';
    $('.ql-url', root).classList.toggle('is-note', !!note);
    $('.ql-fav', root).src = n.file ? 'icons/icon48.png' : faviconUrl(n.url, 32);
    $('.ql-ph-ico', root).src = n.file ? 'icons/icon48.png' : faviconUrl(n.url, 64);
    $('.ql-ph-host', root).textContent = host;
    $('.ql-stage', root).style.setProperty('--h', hueOf(host));
    const shot = $('.ql-shot', root);
    shot.removeAttribute('src');
    previews.get(n.url).then((e) => current === me && e.src && (shot.src = e.src));

    const frame = $('.ql-frame', root);
    frame.replaceChildren();
    dropObjectUrl();
    fitFrame();
    await ruleReady;
    if (delayFrame) await sleep(delayFrame);
    if (current !== me) return me;

    let src = n.url;
    if (n.file) {
      const blob = await local.getBlob(blobIdOf(n.url)).catch(() => null);
      if (current !== me) return me;
      if (!blob) return fail('This file is missing', 'Its data is no longer in My Shelf.'), me;
      src = objectUrl = URL.createObjectURL(blob);
    }
    const ready = () => current === me && settle('ready');
    const broken = () => current === me && fail('This couldn’t be loaded', 'Open it in a tab to try again.');

    if (mode === 'page' || mode === 'embed') {
      const iframe = h('iframe', {
        // No top-navigation: a framed page can never take over the manager tab.
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
        referrerpolicy: 'no-referrer',
        allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
        loading: 'eager',
        title: 'Live preview',
      });
      const target = mode === 'embed' ? embedUrl(m, { dark: isDark() }) : n.url;
      me.hop = m.type === 'youtube';
      iframe.addEventListener('load', async () => {
        if (!me.hop) return setTimeout(ready, 250);
        me.hop = false;
        try {
          const tabId = myTabId();
          const frames = await chrome.webNavigation.getAllFrames({ tabId });
          const fr = frames.find((x) => x.parentFrameId === 0 && x.url.startsWith(HOP));
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [fr.frameId] }, func: (u) => location.replace(u), args: [target] });
        } catch {
          broken();
        }
      });
      iframe.src = me.hop ? HOP : target;
      frame.append(iframe);
      setTimeout(() => current === me && me.status === 'loading' && fail('This page won’t show inside a preview', 'Some sites refuse to load anywhere but their own tab.'), LOAD_TIMEOUT);
    } else if (mode === 'video' || mode === 'audio') {
      const el = h(mode, { controls: true, autoplay: true, playsinline: true, src });
      el.addEventListener(mode === 'video' ? 'loadeddata' : 'loadedmetadata', ready);
      el.addEventListener('error', broken);
      frame.append(el);
    } else if (mode === 'image') {
      const el = h('img', { class: 'ql-image', alt: n.title || '', src, draggable: 'false' });
      el.addEventListener('load', ready);
      el.addEventListener('error', broken);
      frame.append(el);
    } else if (mode === 'pdf') {
      // Chrome's PDF viewer won't start inside a sandboxed frame; this one only ever shows a local blob.
      const el = h('iframe', { title: n.title || 'PDF', src });
      el.addEventListener('load', ready);
      frame.append(el);
    } else if (mode === 'text') {
      const blob = await local.getBlob(blobIdOf(n.url));
      frame.append(h('pre', { class: 'ql-text' }, (await blob.slice(0, 400_000).text()) || ''));
      ready();
    } else {
      fail('No preview for this kind of file', 'Open it to view or download it.');
    }
    return me;
  }

  // ----- capture -----
  async function capture(c, force = false) {
    if (!c || c !== current || document.visibilityState !== 'visible') return false;
    if (c.status !== 'ready' && !force) return false;
    const wait = 600 - (Date.now() - lastCapture); // captureVisibleTab is rate limited
    if (wait > 0) await sleep(wait);
    if (c !== current) return false;
    // A post sits in a narrow column: photograph the post, not the empty stage around it.
    const post = c.mode === 'embed' && isSocialPost(c.media) && $('.ql-frame iframe', root);
    const r = (post || $('.ql-stage', root)).getBoundingClientRect();
    lastCapture = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 });
    const bmp = await createImageBitmap(await dataUrlToBlob(dataUrl));
    const k = bmp.width / innerWidth;
    const crop = { x: r.x * k, y: r.y * k, w: r.width * k, h: Math.min(r.height, r.width * 0.625) * k };
    const { blob } = await toJpeg(bmp, { crop, maxW: 960 });
    await previews.saveShot(c.url, blob);
    root?.classList.add('flash');
    setTimeout(() => root?.classList.remove('flash'), 400);
    return true;
  }

  async function autoCapture(c) {
    const e = await previews.get(c.url);
    // Pages get a real screenshot; posts only when nothing better turned up; players and files never.
    if (c.mode === 'embed' ? !isSocialPost(c.media) || e.src : c.mode !== 'page' || e.kind === 'shot') return;
    await sleep(SETTLE_MS);
    if ($('.dialog-wrap') || $('.menu')) return;
    capture(c).catch(() => {});
  }

  // ----- open / close -----
  function zoom(fromRect, reverse) {
    const panel = $('.ql-panel', root);
    if (!fromRect || reducedMotion()) {
      return panel.animate({ opacity: reverse ? [1, 0] : [0, 1] }, { duration: 160, fill: 'both' }).finished;
    }
    const to = panel.getBoundingClientRect();
    const from = `translate(${fromRect.x - to.x}px, ${fromRect.y - to.y}px) scale(${fromRect.width / to.width}, ${fromRect.height / to.height})`;
    const frames = [
      { transform: from, opacity: 0.4, borderRadius: '40px' },
      { transform: 'none', opacity: 1, borderRadius: '18px' },
    ];
    return panel.animate(reverse ? frames.reverse() : frames, {
      duration: reverse ? 260 : SPRING.duration,
      easing: reverse ? 'cubic-bezier(.4,0,.2,1)' : SPRING.easing,
      fill: 'both',
    }).finished;
  }

  function open(id) {
    if (root) return show(id);
    build();
    document.body.classList.add('ql-open');
    show(id, { delayFrame: 320 });
    zoom(rectOf(id), false);
  }

  async function close() {
    if (!root) return;
    if (batch) batch.cancelled = true;
    const el = root;
    const from = current && rectOf(current.id);
    root = null;
    current = null;
    document.body.classList.remove('ql-open');
    el.classList.add('closing');
    $('.ql-frame', el).replaceChildren();
    dropObjectUrl();
    const panel = $('.ql-panel', el);
    const to = panel.getBoundingClientRect();
    if (from && !reducedMotion()) {
      await panel
        .animate(
          [
            { transform: 'none', opacity: 1 },
            {
              transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`,
              opacity: 0,
            },
          ],
          { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' },
        )
        .finished.catch(() => {});
    } else {
      await sleep(140);
    }
    el.remove();
  }

  function step(dir) {
    if (!current || batch) return;
    const list = getSiblings().filter((n) => n.url);
    const at = list.findIndex((n) => n.id === current.id);
    const next = list[(at + dir + list.length) % list.length];
    if (next && next.id !== current.id) show(next.id);
  }

  // ----- batch: walk through bookmarks and photograph each one -----
  async function runBatch(nodes) {
    if (batch || !nodes.length) return 0;
    if (!root) {
      build();
      document.body.classList.add('ql-open');
      zoom(null, false);
    }
    const job = (batch = { cancelled: false });
    root.classList.add('is-batch');
    let done = 0;
    for (let i = 0; i < nodes.length && !job.cancelled && root; i++) {
      $('.ql-batch', root).textContent = `Capturing ${i + 1} of ${nodes.length} · Esc to stop`;
      const c = await show(nodes[i].id);
      if (!c) continue;
      const status = await whenSettled(c);
      if (job.cancelled || !root) break;
      if (status !== 'ready') continue;
      await sleep(SETTLE_MS);
      if (job.cancelled || !root) break;
      if (await capture(c).catch(() => false)) done++;
    }
    batch = null;
    if (root) close();
    return done;
  }

  return {
    open,
    close,
    step,
    runBatch,
    isOpen: () => !!root,
    currentId: () => current?.id || null,
    refresh: () => current && root && show(current.id),
  };
}
