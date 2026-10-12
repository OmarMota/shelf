// Review: the housekeeping pass. Four questions about the bookmarks you already have —
//   · does it still exist?        (broken links)
//   · has it moved?               (updated links: the address gets corrected, nothing is deleted)
//   · do I have it twice?         (duplicates)
//   · do I still care about it?   (saved long ago, never opened since)
// Nothing is removed until you tick it and press Delete, and the app's normal Undo covers it.

import { h, hostOf, faviconUrl, isWeb, plural } from './util.js';
import * as M from './model.js';
import { openDialog, toast } from './ui.js';
import { getRec, patchRec } from './db.js';
import { rulesReady } from './netrules.js';
import { noteOf, openedAt, keptAt, markKept } from './notes.js';

const DAY = 86_400_000;
const CHECK_FRESH = 7 * DAY; // a link check is trusted this long
const HISTORY_REACH = 90 * DAY; // browsers keep about three months of history

// ---------- helpers ----------

// Two addresses that are the same page: ignore www, the #fragment, a trailing slash and tracking tags.
export function normUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const social = /^(x|twitter)\.com$/.test(host);
    const keep = [...u.searchParams].filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igsh$|igshid$)/i.test(k) && !(social && /^(s|t)$/.test(k)));
    keep.sort(([a], [b]) => a.localeCompare(b));
    return host + u.pathname.replace(/\/+$/, '') + (keep.length ? '?' + new URLSearchParams(keep) : '');
  } catch {
    return url;
  }
}

const folderPath = (n) => M.pathTo(n.parent.id).map((p) => p.title).join(' › ');
const monthYear = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', year: 'numeric' });

function since(ts) {
  const days = Math.floor((Date.now() - ts) / DAY);
  if (days < 1) return 'today';
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.round(days / 30)} mo ago`;
  return `${Math.round(days / 365)} yr ago`;
}

function linksUnder(scopeId) {
  const out = [];
  (function walk(n) {
    if (n.url) return void (isWeb(n.url) && out.push(n));
    (n.children || []).forEach(walk);
  })(scopeId ? M.node(scopeId) : M.model.root);
  return out;
}

async function checkLink(url) {
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return { check: 'gone', checkStatus: res.status };
    if (!res.ok) return { check: 'unsure', checkStatus: res.status }; // logins, bot walls, a server having a bad day
    const moved = res.url && hostOf(res.url) !== hostOf(url);
    return moved ? { check: 'moved', checkTo: res.url } : { check: 'ok' };
  } catch (err) {
    // No answer at all: the domain is gone, or the server refuses connections.
    return { check: err?.name === 'TimeoutError' ? 'unsure' : 'dead', checkStatus: 0 };
  }
}

// When each address was last really visited, from the browser's history (if it lets us look).
async function lastVisits() {
  if (!chrome.history?.search) return null;
  try {
    const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 100_000 });
    const map = new Map();
    for (const it of items) {
      const k = normUrl(it.url);
      if ((map.get(k) || 0) < it.lastVisitTime) map.set(k, it.lastVisitTime);
    }
    return map;
  } catch {
    return null;
  }
}

// ---------- the dialog ----------

// onDelete(ids) removes with the app's undo toast; onOpen(node) opens it in a background tab;
// onEditUrls([{ id, url }]) corrects addresses, also with one undo.
export function review({ folderId = null, tab = 'broken', onDelete, onOpen, onEditUrls }) {
  let scopeId = null; // null = everything
  let stopCheck = null;
  let age = 180; // days, for "Not opened"
  let visits; // undefined = not asked yet; null = the browser wouldn't say
  const checks = new Map(); // url -> { check, checkTo, checkStatus, checkAt }

  const here = folderId && M.node(folderId);
  const scope = h(
    'select',
    { class: 'rv-scope', onchange: () => ((scopeId = scope.value || null), stopCheck?.(), show(tab)) },
    h('option', { value: '' }, 'All bookmarks'),
    here && here.parent && h('option', { value: here.id }, `Only “${here.title}”`),
  );
  const tabs = [
    ['broken', 'Broken links'],
    ['moved', 'Updated links'],
    ['dupes', 'Duplicates'],
    ['stale', 'Not opened'],
  ].map(([id, label]) => h('button', { type: 'button', class: 'seg-btn', 'data-tab': id, onclick: () => (stopCheck?.(), show(id)) }, label));
  const body = h('div', { class: 'tidy-body rv-body' });
  const foot = h('div', { class: 'form-actions' });
  const panel = h('div', { class: 'form tidy review' }, h('h2', {}, 'Review', scope), h('div', { class: 'seg' }, tabs), body, foot);
  const close = openDialog(panel, { wide: true, onClose: () => stopCheck?.() });

  const closeBtn = () => h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Close');
  const status = (text, extra) => body.replaceChildren(h('div', { class: 'tidy-status' }, h('div', { class: 'tidy-spinner' }), h('span', {}, text), extra));
  const empty = (text) => body.replaceChildren(h('p', { class: 'tidy-empty' }, text));

  function show(id) {
    tab = id;
    for (const b of tabs) b.classList.toggle('on', b.dataset.tab === id);
    foot.replaceChildren(closeBtn());
    ({ broken: showChecked, moved: showChecked, dupes: showDupes, stale: showStale })[id]();
  }

  // A checklist in groups. groups: [{ label, icon, hint, items: [{ node, reason, checked, tag, actions }] }]
  // What the button does with the ticked ones is `act`: deleting them, unless a tab says otherwise.
  const deleting = { cls: 'danger', label: (n) => (n ? `Delete ${plural(n, 'bookmark')}` : 'Delete'), run: (ids) => onDelete(ids) };
  function checklist(intro, groups, act = deleting) {
    const boxes = new Map(); // id -> checkbox
    const del = h('button', { type: 'button', class: 'btn primary ' + (act.cls || '') });
    const count = () => {
      const n = [...boxes.values()].filter((b) => b.checked).length;
      del.textContent = act.label(n);
      del.disabled = !n;
    };
    del.onclick = async () => {
      const ids = [...boxes].filter(([, b]) => b.checked).map(([id]) => id);
      del.disabled = true;
      await act.run(ids);
      await M.load();
      show(tab);
    };
    const rowBtn = (a, row) =>
      h('button', {
        type: 'button',
        class: 'rv-act',
        title: a.label,
        'aria-label': a.label,
        icon: a.icon,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          a.run(row);
        },
      });
    body.replaceChildren(
      ...(intro ? [h('p', { class: 'rv-intro' }, intro)] : []),
      ...groups
        .filter((g) => g.items.length)
        .map((g) => {
          const all = h('input', { type: 'checkbox' });
          const mine = [];
          const sync = () => {
            const on = mine.filter((b) => b.checked).length;
            all.checked = on > 0 && on === mine.length;
            all.indeterminate = on > 0 && on < mine.length;
            count();
          };
          all.onchange = () => (mine.forEach((b) => (b.checked = all.checked)), sync());
          const rows = g.items.map((it) => {
            const box = h('input', { type: 'checkbox', checked: !!it.checked, onchange: () => sync() });
            if (!it.locked) (boxes.set(it.node.id, box), mine.push(box));
            else box.disabled = true;
            const row = h(
              'label',
              { class: 'tidy-row rv-row', title: `${it.node.url}\nIn ${folderPath(it.node)}${noteOf(it.node.url) ? `\nNote: ${noteOf(it.node.url)}` : ''}` },
              box,
              h('img', { class: 'tidy-fav', alt: '', src: faviconUrl(it.node.url, 32) }),
              h('span', { class: 'tidy-title' }, it.node.title || hostOf(it.node.url)),
              it.tag && h('span', { class: 'tidy-new' }, it.tag),
              h('span', { class: 'tidy-reason' }, it.reason || ''),
            );
            // Handed to a row's actions: "this one is dealt with", so it leaves the list and the count.
            const dealtWith = {
              remove() {
                boxes.delete(it.node.id);
                if (mine.includes(box)) mine.splice(mine.indexOf(box), 1);
                row.remove();
                sync();
              },
            };
            row.append(h('span', { class: 'rv-acts' }, (it.actions || []).map((a) => rowBtn(a, dealtWith))));
            return row;
          });
          sync();
          return h(
            'div',
            { class: 'tidy-group' },
            h('label', { class: 'tidy-head' }, all, h('span', { class: 'menu-ico', icon: g.icon || 'folder' }), h('span', { class: 'tidy-dest' }, g.label), g.hint && h('span', { class: 'tidy-reason' }, g.hint), h('span', { class: 'tidy-n' }, g.items.length)),
            rows,
          );
        }),
    );
    count();
    foot.replaceChildren(closeBtn(), del);
  }

  const openAct = { label: 'Open in a new tab', icon: 'open', run: () => {} };
  const open = (n) => ({ ...openAct, run: () => onOpen(n) });

  // ----- broken links, and links that moved: two readings of the same check -----

  async function showChecked() {
    const mine = tab;
    const nodes = linksUnder(scopeId);
    if (!nodes.length) return empty('No web bookmarks in here.');
    status('Looking up the last check…');
    const urls = [...new Set(nodes.map((n) => n.url))];
    for (const url of urls) {
      if (checks.has(url)) continue;
      const rec = await getRec(url).catch(() => null);
      if (rec?.check && Date.now() - rec.checkAt < CHECK_FRESH) checks.set(url, rec);
    }
    if (tab !== mine) return;
    const todo = urls.filter((u) => !checks.has(u));
    if (todo.length > urls.length * 0.2) return brokenIntro(urls, todo);
    (tab === 'moved' ? movedResults : brokenResults)(nodes, todo.length);
  }

  function brokenIntro(urls, todo) {
    body.replaceChildren(
      h(
        'section',
        { class: 'tidy-option' },
        h('span', { class: 'tidy-option-ico', icon: 'link' }),
        h(
          'div',
          {},
          h('strong', {}, `Check ${plural(urls.length, 'address')}`),
          h('p', {}, 'Shelf asks each site for the page, without your cookies, and sorts what comes back: gone (404), no answer at all, or moved to another site (those are listed under Updated links). Pages behind a login or a bot wall are left alone as “couldn’t tell”. It takes about a minute per few hundred, and results are remembered for a week.'),
          h('div', { class: 'tidy-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => runCheck(todo) }, todo.length < urls.length ? `Check the ${todo.length} not checked yet` : 'Check links')),
        ),
      ),
    );
  }

  async function runCheck(todo) {
    const mine = tab;
    if (!navigator.onLine) return toast('You’re offline, so every link would look broken');
    await rulesReady;
    let stopped = false;
    let done = 0;
    stopCheck = () => ((stopped = true), (stopCheck = null));
    const bar = h('i');
    const paint = () => {
      bar.style.width = (done / todo.length) * 100 + '%';
      label.textContent = `Checked ${done} of ${todo.length}…`;
    };
    const label = h('span');
    body.replaceChildren(h('div', { class: 'tidy-status rv-progress' }, h('div', { class: 'tidy-spinner' }), label, h('div', { class: 'rv-bar' }, bar)));
    foot.replaceChildren(h('button', { type: 'button', class: 'btn ghost', onclick: () => (stopCheck?.(), show(mine)) }, 'Stop'));
    paint();
    const queue = [...todo];
    const worker = async () => {
      for (let url; !stopped && (url = queue.shift()); ) {
        const res = { ...(await checkLink(url)), checkAt: Date.now() };
        if (stopped) return;
        checks.set(url, res);
        patchRec(url, { checkTo: '', ...res }).catch(() => {});
        done++;
        paint();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (stopped) return;
    stopCheck = null;
    // If nearly nothing answered, the problem is on this side of the wire.
    const dead = todo.filter((u) => checks.get(u)?.check === 'dead').length;
    if (todo.length >= 10 && dead > todo.length * 0.6) {
      todo.forEach((u) => checks.delete(u));
      toast('Most sites didn’t answer. That looks like your connection, so nothing was marked');
    }
    if (tab === mine) show(mine);
  }

  function brokenResults(nodes, unchecked) {
    const by = (kind) => nodes.filter((n) => checks.get(n.url)?.check === kind);
    const wayback = (n) => ({ label: 'Look for a saved copy on the Wayback Machine', icon: 'refresh', run: () => chrome.tabs.create({ url: `https://web.archive.org/web/2/${n.url}`, active: false }) });
    const oldest = Math.min(...nodes.map((n) => checks.get(n.url)?.checkAt || Date.now()));
    const groups = [
      {
        label: 'Gone',
        icon: 'trash',
        hint: 'the site says this page no longer exists',
        items: by('gone').map((n) => ({ node: n, reason: `${checks.get(n.url).checkStatus} · ${folderPath(n)}`, checked: true, actions: [wayback(n), open(n)] })),
      },
      {
        label: 'No answer',
        icon: 'close',
        hint: 'the domain is gone or refuses connections',
        items: by('dead').map((n) => ({ node: n, reason: folderPath(n), checked: false, actions: [wayback(n), open(n)] })),
      },
    ];
    const unsure = by('unsure').length;
    const moved = by('moved').length;
    const bad = groups.reduce((s, g) => s + g.items.length, 0);
    const recheck = h('button', { type: 'button', class: 'btn soft', onclick: () => runCheck([...new Set(nodes.map((n) => n.url))]) }, 'Check again');
    const tail = `${moved ? ` ${moved} moved to another site: ${moved === 1 ? 'it is' : 'they are'} under Updated links.` : ''}${unsure ? ` ${unsure} ${unsure === 1 ? 'sits' : 'sit'} behind a login or bot wall and couldn’t be judged.` : ''}${unchecked ? ` ${unchecked} added since then ${unchecked === 1 ? 'isn’t' : 'aren’t'} checked yet.` : ''}`;
    if (!bad) {
      empty(`${moved ? 'No broken links' : `All ${nodes.length - unsure - unchecked} links that could be checked still work`}.${tail}`);
      body.append(h('div', { class: 'rv-center' }, recheck));
      return;
    }
    checklist(`${plural(bad, 'bookmark')} out of ${nodes.length} ${bad === 1 ? 'needs' : 'need'} a look (checked ${since(oldest)}).${tail}`, groups);
    body.append(h('div', { class: 'rv-center' }, recheck));
  }

  // Still alive, at a new address: nothing to delete here, the address is what gets corrected.
  function movedResults(nodes, unchecked) {
    const moved = nodes.filter((n) => checks.get(n.url)?.check === 'moved');
    const recheck = h('button', { type: 'button', class: 'btn soft', onclick: () => runCheck([...new Set(nodes.map((n) => n.url))]) }, 'Check again');
    const tail = unchecked ? ` ${unchecked} added since the last check ${unchecked === 1 ? 'isn’t' : 'aren’t'} checked yet.` : '';
    if (!moved.length) {
      empty(`No bookmark in here has moved to another site.${tail}`);
      body.append(h('div', { class: 'rv-center' }, recheck));
      return;
    }
    const update = async (list) => {
      const pairs = list.map((n) => ({ id: n.id, url: checks.get(n.url).checkTo }));
      await onEditUrls(pairs);
      for (const { url } of pairs) {
        checks.set(url, { check: 'ok', checkAt: Date.now() }); // it just answered
        patchRec(url, { check: 'ok', checkTo: '', checkAt: Date.now() }).catch(() => {});
      }
    };
    checklist(
      `${plural(moved.length, 'bookmark')} still ${moved.length === 1 ? 'works' : 'work'}, but the site now sends you to a different address. Updating saves the new address in the bookmark; nothing is deleted. Untick any that lead somewhere you don’t expect.${tail}`,
      [
        {
          label: 'Moved to another site',
          icon: 'move',
          hint: 'old address → where it leads now',
          items: moved.map((n) => ({
            node: n,
            reason: `${hostOf(n.url)} → ${hostOf(checks.get(n.url).checkTo)}`,
            checked: true,
            actions: [{ label: `Update only this one, to ${checks.get(n.url).checkTo}`, icon: 'check', run: async (row) => (await update([n]), row.remove()) }, open(n)],
          })),
        },
      ],
      { label: (n) => (n ? `Update ${plural(n, 'link')}` : 'Update'), run: (ids) => update(ids.map(M.node).filter(Boolean)) },
    );
    body.append(h('div', { class: 'rv-center' }, recheck));
  }

  // ----- duplicates -----

  function showDupes() {
    const groups = new Map();
    for (const n of linksUnder(scopeId)) {
      const k = normUrl(n.url);
      groups.set(k, [...(groups.get(k) || []), n]);
    }
    const dupes = [...groups.values()].filter((g) => g.length > 1);
    if (!dupes.length) return empty('No address is bookmarked twice in here.');
    const spare = dupes.reduce((s, g) => s + g.length - 1, 0);
    checklist(
      `${plural(spare, 'bookmark')} repeat one you already have. The copy with your note, or else the oldest, is kept; untick to choose differently.`,
      dupes.map((g) => {
        // Keep the one you wrote on, otherwise the first one you saved.
        const sorted = [...g].sort((a, b) => !!noteOf(b.url) - !!noteOf(a.url) || (a.dateAdded || 0) - (b.dateAdded || 0));
        return {
          label: sorted[0].title || hostOf(sorted[0].url),
          icon: 'link',
          hint: hostOf(sorted[0].url),
          items: sorted.map((n, i) => ({ node: n, reason: folderPath(n), checked: i > 0, tag: i === 0 ? 'keep' : '', actions: [open(n)] })),
        };
      }),
    );
  }

  // ----- saved long ago, not opened since -----

  async function showStale() {
    if (visits === undefined) {
      status('Reading when you last opened things…');
      visits = await lastVisits();
      if (tab !== 'stale') return;
    }
    const now = Date.now();
    const lastUsed = (n) => Math.max(n.dateLastUsed || 0, openedAt(n.url), visits?.get(normUrl(n.url)) || 0);
    const old = linksUnder(scopeId)
      .filter((n) => n.dateAdded && now - n.dateAdded > age * DAY && now - lastUsed(n) > HISTORY_REACH && now - keptAt(n.url) > 365 * DAY)
      .sort((a, b) => a.dateAdded - b.dateAdded);

    const pick = h(
      'select',
      { class: 'rv-scope', onchange: () => ((age = +pick.value), showStale()) },
      [[90, '3 months'], [180, '6 months'], [365, 'a year'], [730, '2 years']].map(([d, l]) => h('option', { value: d, selected: d === age }, l)),
    );
    const intro = h(
      'p',
      { class: 'rv-intro' },
      'Saved more than ',
      pick,
      ` ago and not opened in the last three months: ${old.length}. Open one to refresh your memory, press the heart to keep it (it won’t be asked about for a year), or tick what is out of date.`,
      visits ? '' : ' This browser doesn’t share its history with Shelf, so only opens from Shelf and the bookmarks bar are known.',
    );
    if (!old.length) {
      body.replaceChildren(intro, h('p', { class: 'tidy-empty' }, 'Nothing that old is gathering dust.'));
      return void foot.replaceChildren(closeBtn());
    }
    const years = new Map();
    for (const n of old) {
      const y = new Date(n.dateAdded).getFullYear();
      years.set(y, [...(years.get(y) || []), n]);
    }
    checklist(
      null,
      [...years].map(([y, list]) => ({
        label: `Saved in ${y}`,
        icon: 'folder',
        items: list.map((n) => ({
          node: n,
          reason: `${monthYear(n.dateAdded)} · ${lastUsed(n) ? 'opened ' + since(lastUsed(n)) : 'never opened'}`,
          checked: false,
          actions: [
            {
              label: 'Still good: keep it and stop asking',
              icon: 'heart',
              run: (row) => {
                markKept(n.url);
                row.remove();
              },
            },
            open(n),
          ],
        })),
      })),
    );
    body.prepend(intro);
  }

  show(tab);
}
