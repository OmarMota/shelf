// Injected by Shelf into a tab YOU opened and are logged into (X bookmarks, Instagram saved,
// your Pinterest boards…).
// It only reads the post links the page is already showing you, and hands them to Shelf on this
// Mac. No password, cookie or token is read, and nothing is sent to any server.
(() => {
  if (window.__shelfCollector) return window.__shelfCollector.show();

  const SITE = /(^|\.)(x|twitter)\.com$/.test(location.hostname) ? 'x' : /(^|\.)pinterest\.[a-z.]+$/.test(location.hostname) ? 'pinterest' : /(^|\.)instagram\.com$/.test(location.hostname) ? 'instagram' : '';
  if (!SITE) return; // never on any other site

  const found = new Map(); // canonical url -> { url, platform, author, text, image, full, folder }
  const onX = SITE === 'x';

  // The picture the page is already showing for a post. Shelf keeps a copy as the card's preview,
  // because these addresses expire and the posts themselves sit behind a login.
  const srcOf = (img) => {
    const src = img?.currentSrc || img?.src || img?.poster || '';
    return /^https:\/\//.test(src) ? src : '';
  };
  const bigEnough = (img) => (img.naturalWidth || img.width || 0) >= 120;
  const TWEET = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  const IGPOST = /^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
  const PIN = /^\/pin\/(?:[^/]*--)?(\d+)\/?$/;
  // Pinterest pages that aren't somebody's boards or pins.
  const PIN_RESERVED = new Set(['pin', 'search', 'ideas', 'today', 'explore', 'settings', 'business', 'login', 'signup', 'notifications', 'videos', 'shopping', 'homefeed', 'following', 'topics', 'discover', 'about', 'resource', '_', 'oauth', 'password', 'idea-pins']);
  const pinPath = () => location.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  // On a board (…/<you>/<board>/, or a section inside it) pins are filed under that board's name,
  // so your boards come across as folders. "All pins" (…/<you>/pins/) files them loose.
  function boardFolder() {
    const parts = pinPath();
    if (parts.length < 2 || PIN_RESERVED.has(parts[0]) || /^_|^pins$/.test(parts[1])) return [];
    const pretty = (slug) => slug.replace(/-+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const title = document.querySelector('h1')?.textContent?.trim();
    // The heading names the deepest level you are on; the address names the rest.
    const names = parts.slice(1, 3).map(pretty);
    if (title) names[names.length - 1] = title;
    return names;
  }

  function read(a) {
    let u;
    try {
      u = new URL(a.href);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^(www|m|mobile)\./, '');
    if (SITE === 'pinterest') {
      const m = /(^|\.)pinterest\.[a-z.]+$/.test(host) && PIN.exec(u.pathname);
      const img = m && [...a.querySelectorAll('img')].find(bigEnough);
      if (!img) return null; // the pin's tile, not the small links around it
      // Tiles are served 236px wide; the same picture exists at 736px, and as the original upload.
      const src = srcOf(img);
      const sized = (size) => src.replace(/(\/\/i\.pinimg\.com\/)[^/]+\//, `$1${size}/`);
      const text = (img.alt || a.getAttribute('aria-label') || '').replace(/^This (may )?contains?:?\s*/i, '').trim();
      return { url: `https://www.pinterest.com/pin/${m[1]}/`, platform: 'pinterest', author: '', text, image: sized('736x'), full: sized('originals'), folder: boardFolder() };
    }
    if (host === 'x.com' || host === 'twitter.com') {
      const m = TWEET.exec(u.pathname);
      if (!m || m[1] === 'i') return null;
      const article = a.closest('article');
      // Inside a post, only the timestamp link is the post itself (others are quotes, photos, stats).
      if (article && !a.querySelector('time')) return null;
      const text = article?.querySelector('[data-testid="tweetText"]')?.innerText || '';
      const pic =
        article?.querySelector('[data-testid="tweetPhoto"] img, [data-testid^="card."] img') ||
        article?.querySelector('video[poster]');
      // Photos are served small in the timeline; the same address hands out a larger one.
      const image = srcOf(pic).replace(/([?&]name=)(small|360x360|240x240|120x120)\b/, '$1medium');
      return { url: `https://x.com/${m[1]}/status/${m[2]}`, platform: 'x', author: m[1], text, image };
    }
    if (host === 'instagram.com') {
      const m = IGPOST.exec(u.pathname);
      if (!m) return null;
      const kind = m[1] === 'p' ? 'p' : 'reel';
      const img = [...a.querySelectorAll('img')].find(bigEnough);
      const text = img?.alt || '';
      return { url: `https://www.instagram.com/${kind}/${m[2]}/`, platform: 'instagram', author: '', text, image: srcOf(img) };
    }
    return null;
  }

  // Only the page that lists *your* saved posts is read, unless you say otherwise: on any other
  // page the same links would be somebody's timeline.
  let anyPage = false;
  let state = 'collect'; // collect | saving | saved
  let savedAt = '';
  const onSavedPage = () => {
    if (onX) return /^\/i\/bookmarks/.test(location.pathname);
    if (SITE === 'instagram') return /\/saved(\/|$)/.test(location.pathname);
    // Pinterest: a board, a board section, or "all pins". Not the home feed, a search, or the list of boards.
    const parts = pinPath();
    return parts.length >= 2 && parts.length <= 3 && !PIN_RESERVED.has(parts[0]) && !/^_/.test(parts[1]);
  };

  // Instagram has no address for "my saved posts" without the username, so look for the profile
  // link in the site's own navigation (the only nav link drawn with a picture instead of an icon).
  function savedPageUrl() {
    if (onX) return 'https://x.com/i/bookmarks';
    if (SITE === 'pinterest') {
      // Your own profile: on a page under it already, or from the header's profile button.
      const parts = pinPath();
      const mine = parts.length && !PIN_RESERVED.has(parts[0]) ? '/' + parts[0] + '/' : document.querySelector('[data-test-id="header-profile"] a[href], a[data-test-id="header-profile"]')?.getAttribute('href');
      return mine ? new URL(mine.replace(/\/?$/, '/') + 'pins/', location.origin).href : '';
    }
    const direct = document.querySelector('a[href$="/saved/"]');
    if (direct) return direct.href;
    const mine = [...document.querySelectorAll('a[href^="/"]')].filter(
      (a) => /^\/[A-Za-z0-9._]+\/$/.test(a.getAttribute('href')) && a.querySelector('img') && !a.closest('article, main'),
    );
    return mine.length ? new URL(mine.at(-1).getAttribute('href') + 'saved/all-posts/', location.origin).href : '';
  }

  // Instagram opens on its home page, since the address of "Saved" has your username in it. As
  // soon as the navigation shows which account is signed in, go there: once per tab, so that
  // walking back to the home page afterwards stays your choice.
  function goToSaved() {
    if (SITE !== 'instagram' || location.pathname !== '/') return false;
    try {
      if (sessionStorage.getItem('shelfWentToSaved')) return false;
      const url = savedPageUrl();
      if (!url) return false;
      sessionStorage.setItem('shelfWentToSaved', '1');
      location.href = url;
      return true;
    } catch {
      return false;
    }
  }

  let arrived = false;
  function scan() {
    if (state === 'saved' && location.pathname !== savedAt) startOver(); // moved on to another board
    if (!anyPage && !onSavedPage()) return goToSaved() || paint();
    if (!arrived && onSavedPage()) {
      arrived = true;
      chrome.runtime.sendMessage({ type: 'shelf-collect-arrived' }).catch(() => {});
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const post = read(a);
      if (!post) continue;
      const had = found.get(post.url);
      if (!had) found.set(post.url, post);
      else {
        // The same post is seen many times while scrolling; keep the most complete reading.
        if (!had.text && post.text) had.text = post.text;
        if (!had.image && post.image) had.image = post.image;
      }
    }
    paint();
  }

  // ----- a small panel, sealed in a shadow root so the site's styles can't touch it -----
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .box{width:300px;padding:14px;border-radius:16px;background:#15181c;color:#f1f3f5;font:13px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4),0 0 0 .5px rgba(255,255,255,.14)}
      .top{display:flex;align-items:center;gap:8px;font-weight:650}
      .top span{flex:1}
      .n{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:8px 0 0}
      .hint{color:#9aa1a9;margin:2px 0 12px}
      .bar{height:4px;border-radius:2px;background:rgba(255,255,255,.12);margin:-4px 0 12px;overflow:hidden}
      .bar i{display:block;height:100%;width:0;background:#f1f3f5;transition:width .3s}
      .row{display:flex;gap:8px}
      button{flex:1;height:32px;border:0;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;color:#f1f3f5;background:rgba(255,255,255,.12)}
      button:hover{background:rgba(255,255,255,.18)}
      button.go{background:#f1f3f5;color:#15181c}
      button:disabled{opacity:.5;cursor:default}
      .x{flex:none;width:24px;height:24px;border-radius:8px;background:none;color:#9aa1a9}
      [hidden]{display:none}
    </style>
    <div class="box">
      <div class="top"><span>Shelf</span><button class="x" title="Close">✕</button></div>
      <div class="n">0 posts</div>
      <div class="hint"></div>
      <div class="bar" hidden><i></i></div>
      <div class="row"><button class="auto">Auto-scroll</button><button class="go" disabled>Save to Shelf</button></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const LIST = { x: 'X bookmarks', instagram: 'Instagram “Saved” page', pinterest: 'Pinterest boards and pins' }[SITE];
  const GO = { x: 'Go to bookmarks', instagram: 'Go to Saved', pinterest: 'Go to my pins' }[SITE];
  const HOWTO = { x: 'Go there', instagram: 'Open your profile, then “Saved”', pinterest: 'Open your profile, then a board (it becomes a folder) or “All pins”' }[SITE];
  let scrolling = 0;
  let idle = 0;
  let result = null;

  // Re-sync: My Shelf says what it already holds. Both lists are newest-first, so once scrolling
  // only turns up posts from an earlier import, everything further down is already saved.
  let known = new Set();
  let noPic = new Set();
  let caughtUp = false;
  let keepGoing = false; // "Auto-scroll" pressed again after catching up: go to the very end
  chrome.runtime.sendMessage({ type: 'shelf-known' }).then((res) => {
    known = new Set(res?.known || []);
    noPic = new Set(res?.noPic || []);
    paint();
  }, () => {});
  const fresh = () => [...found.values()].filter((p) => !known.has(p.url));
  const fixable = () => [...found.values()].filter((p) => p.image && noPic.has(p.url)); // saved before, without a picture

  // Pinterest: say where this board's pins will be filed.
  const filing = () => {
    if (SITE !== 'pinterest') return '';
    const f = boardFolder();
    return f.length ? ` Filing under Pinterest › ${f.join(' › ')}.` : ' Open a board instead to file its pins in a folder of that name.';
  };

  // After a save you can walk on to the next board (or page) and collect again in the same tab.
  function startOver() {
    for (const p of found.values()) known.add(p.url);
    found.clear();
    caughtUp = keepGoing = false;
    state = 'collect';
    result = null;
    $('.go').disabled = $('.auto').disabled = false;
  }

  function paint() {
    if (state !== 'collect') return;
    const away = !anyPage && !onSavedPage();
    const news = fresh();
    const fix = fixable().length;
    const old = found.size - news.length;
    const withPic = news.filter((p) => p.image).length;
    const already = old ? ` ${old} further down ${old === 1 ? 'is' : 'are'} already in Shelf${fix ? ` (${fix} will get the picture they were missing)` : ''}.` : '';
    $('.n').textContent = away && !found.size ? 'Not there yet' : old && !news.length ? 'Up to date' : `${news.length} new`;
    $('.hint').textContent = away
      ? `Shelf only reads your ${LIST}. ${SITE !== 'pinterest' && savedPageUrl() ? 'Go there' : HOWTO}, and it picks up the posts as they appear.`
      : caughtUp
        ? `Caught up with your last import.${already}`
        : found.size
          ? `${news.length ? `${withPic} with a picture for their preview.` : 'Nothing new so far.'}${filing()}${already} Scroll to load more, or let Shelf scroll for you.`
          : 'Scroll, and Shelf picks up the posts as they appear.';
    $('.auto').textContent = away ? 'Use this page' : scrolling ? 'Stop scrolling' : caughtUp ? 'Scroll to the end' : 'Auto-scroll';
    $('.go').textContent = away && !found.size ? GO : 'Save to Shelf';
    $('.go').disabled = away && !found.size ? !savedPageUrl() : !(news.length + fix);
  }

  function stopScrolling() {
    clearInterval(scrolling);
    scrolling = 0;
    paint();
  }

  $('.auto').onclick = () => {
    if (state === 'saved') return chrome.runtime.sendMessage({ type: 'shelf-open', folderId: result?.folderIds?.[0] });
    if (!anyPage && !onSavedPage()) {
      anyPage = true;
      return scan();
    }
    if (scrolling) return stopScrolling();
    if (caughtUp) keepGoing = true;
    caughtUp = false;
    idle = 0;
    let stale = 0; // scrolls in a row that only turned up posts Shelf already has
    scrolling = setInterval(() => {
      const before = found.size;
      const beforeNew = fresh().length;
      window.scrollBy({ top: innerHeight * 0.85, behavior: 'smooth' }); // an unhurried, human pace
      setTimeout(() => {
        scan();
        idle = found.size === before ? idle + 1 : 0;
        stale = found.size > before && fresh().length === beforeNew ? stale + 1 : fresh().length > beforeNew ? 0 : stale;
        if (!keepGoing && stale >= 3 && found.size - fresh().length >= 8) {
          caughtUp = true;
          return stopScrolling();
        }
        if (idle >= 6) stopScrolling(); // nothing new for a while: that's the end of the list
      }, 900);
    }, 1400);
    paint();
  };

  // Sent in small batches: each one is filed and its pictures copied before the next, so a long
  // list shows progress and never asks the extension to hold one very long request open.
  async function save() {
    const items = [...fresh(), ...fixable()];
    const total = { added: 0, skipped: 0, previews: 0, folders: new Set(), folderIds: [] };
    state = 'saving';
    $('.go').disabled = $('.auto').disabled = true;
    $('.go').textContent = 'Saving…';
    $('.bar').hidden = false;
    for (let i = 0; i < items.length; i += 24) {
      const res = await chrome.runtime.sendMessage({ type: 'shelf-import', items: items.slice(i, i + 24) });
      if (!res) throw new Error('no reply');
      total.added += res.added;
      total.skipped += res.skipped;
      total.previews += res.previews || 0;
      res.folders.forEach((f) => total.folders.add(f));
      total.folderIds.push(...(res.folderIds || []));
      const n = Math.min(i + 24, items.length);
      $('.n').textContent = `${n} / ${items.length}`;
      $('.hint').textContent = 'Filing the posts and copying their pictures…';
      $('.bar i').style.width = (n / items.length) * 100 + '%';
    }
    chrome.runtime.sendMessage({ type: 'shelf-synced', platform: SITE }).catch(() => {});
    return total;
  }

  $('.go').onclick = async () => {
    if (!anyPage && !onSavedPage() && !found.size) return void (location.href = savedPageUrl());
    stopScrolling();
    try {
      result = await save();
      state = 'saved';
      savedAt = location.pathname;
      $('.n').textContent = result.added ? `${result.added} saved` : 'Up to date';
      $('.hint').textContent =
        (result.added
          ? `In My Shelf → ${[...result.folders].join(' and ')}, ${result.previews} with a preview picture.`
          : result.previews
            ? `${result.previews} earlier post${result.previews === 1 ? '' : 's'} got the picture they were missing.`
            : 'Everything here was already in My Shelf.') +
        (result.added && result.skipped ? ` ${result.skipped} were already there.` : '') +
        (SITE === 'pinterest' ? ' Open another board to carry on.' : ' Tidy up can sort them by topic.');
      $('.go').textContent = 'Done';
      $('.auto').textContent = 'Open Shelf';
      $('.auto').disabled = false;
    } catch (err) {
      state = 'collect';
      $('.hint').textContent = 'Shelf couldn’t be reached. Reload the extension, then this page, and try again.';
      $('.go').disabled = $('.auto').disabled = false;
      $('.go').textContent = 'Save to Shelf';
    }
    $('.bar').hidden = true;
  };

  const timer = setInterval(scan, 1000);
  $('.x').onclick = () => {
    stopScrolling();
    clearInterval(timer);
    host.remove();
    window.__shelfCollector = null;
    chrome.runtime.sendMessage({ type: 'shelf-collect-close' }).catch(() => {}); // closed means closed: don't come back on the next page
  };

  window.__shelfCollector = { show: () => document.documentElement.append(host) };
  document.documentElement.append(host);
  scan();
})();
