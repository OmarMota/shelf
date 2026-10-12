// Tidy up: work out where loose bookmarks belong, show the plan, and only then move anything.
// A plan can come from two places, and both end in the same review screen:
//   · on-device — compares each item with what already lives in every folder
//   · Claude    — Shelf writes the prompt (with the bookmarks in it); you run it in Claude, then
//                 bring the answer back as a plan. No API key, nothing sent by Shelf itself.

import { h, hostOf, plural, faviconUrl, isWeb } from './util.js';
import { openDialog, toast } from './ui.js';
import * as M from './model.js';
import * as previews from './previews.js';
import { takeBackup } from './backup.js';
import { classify, isSocialPost, PLATFORM_FOLDER, fileKind } from './media.js';

// ---------- describing items and folders ----------

function kindOf(n) {
  if (M.isFile(n)) return `${fileKind(n.file?.mime, n.file?.name)} file`;
  const m = classify(n.url);
  return { tweet: 'tweet', instagram: 'instagram post', pinterest: 'pinterest pin', youtube: 'youtube video', vimeo: 'vimeo video' }[m.type] || m.type;
}

function describe(n) {
  const e = previews.peek(n.url);
  let path = '';
  try {
    path = decodeURIComponent(new URL(n.url).pathname).slice(0, 80);
  } catch {
    /* files have no path */
  }
  return {
    id: n.id,
    title: (n.title || e?.pageTitle || '').slice(0, 160),
    site: M.isFile(n) ? '' : hostOf(n.url),
    path,
    kind: kindOf(n),
    description: (e?.description || '').slice(0, 300),
    author: e?.author || '',
  };
}

const folderPath = (f) => M.pathTo(f.id).map((p) => p.title).join(' / ');

// ---------- on-device engine ----------

const STOP = new Set(
  'the and for with from your you that this are was not but all any can has have how what when who why our out its into more most best free new get use using via home page site web www com org net app html http https official welcome about'.split(' '),
);
const GENERIC_HOSTS = new Set(['x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'youtu.be', 'vimeo.com', 'google.com', 'docs.google.com', 'medium.com', 'notion.so', 'figma.com', 'github.com', 'reddit.com']);

function tokens(str) {
  return (str || '')
    .toLowerCase()
    .split(/[^a-z0-9àèéìòùäöüñç]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

const hostTokens = (url) => tokens(hostOf(url).split('.').slice(0, -1).join(' '));

function bag(parts) {
  const v = new Map();
  for (const [text, weight] of parts) for (const t of Array.isArray(text) ? text : tokens(text)) v.set(t, (v.get(t) || 0) + weight);
  return v;
}

function proposeLocally(items, folders, currentId) {
  const docs = folders.map((f) => {
    const kids = (f.children || []).filter((k) => k.url);
    return {
      f,
      hosts: new Set(kids.filter((k) => isWeb(k.url)).map((k) => hostOf(k.url))),
      kids,
      vec: bag([
        [f.title, 5],
        [M.pathTo(f.id).slice(0, -1).map((p) => p.title).join(' '), 1.5],
        ...kids.flatMap((k) => [
          [k.title, 1],
          [isWeb(k.url) ? hostTokens(k.url) : [], 1.5],
          [previews.peek(k.url)?.description || '', 0.6],
        ]),
      ]),
    };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.vec.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + docs.length / (df.get(t) || 0.5));
  const norm = (v) => Math.sqrt([...v].reduce((s, [t, w]) => s + (w * idf(t)) ** 2, 0)) || 1;
  for (const d of docs) d.norm = norm(d.vec);

  return items.map((n) => {
    const e = previews.peek(n.url);
    const host = isWeb(n.url) ? hostOf(n.url) : '';
    const vec = bag([
      [n.title, 2],
      [e?.pageTitle || '', 1],
      [e?.description || '', 1],
      [M.isFile(n) ? n.file?.name || '' : hostTokens(n.url), 1.5],
    ]);
    const vn = norm(vec);
    let best = null;
    for (const d of docs) {
      if (d.f.id === n.parent.id || d.f.id === currentId || M.isLocked(d.f) || !M.canDrop([n.id], d.f.id)) continue;
      let dot = 0;
      const shared = [];
      for (const [t, w] of vec) {
        const fw = d.vec.get(t);
        if (!fw) continue;
        dot += w * fw * idf(t) ** 2;
        shared.push([t, w * fw * idf(t) ** 2]);
      }
      let score = dot / (vn * d.norm);
      const sameSite = host && !GENERIC_HOSTS.has(host) && d.hosts.has(host);
      if (sameSite) score += 0.3;
      if (!best || score > best.score) best = { d, score, sameSite, shared };
    }
    if (best && best.score >= 0.14) {
      const words = best.shared.sort((a, b) => b[1] - a[1]).slice(0, 2).map((s) => s[0]);
      const reason = best.sameSite ? `Other ${host} links live here` : words.length ? `Matches “${words.join('”, “')}”` : 'Similar to what’s here';
      return { id: n.id, folderId: best.d.f.id, reason, score: best.score };
    }
    const m = M.isFile(n) ? {} : classify(n.url);
    if (isSocialPost(m)) return { id: n.id, platform: m.platform, reason: 'Saved post' };
    return { id: n.id, stay: true };
  });
}

// ---------- plans: the hand-off format ----------
// { "shelfPlan": 1, "moves": [ { "id": "123", "url": "https://…", "to": ["Bookmarks bar", "Design", "Icons"], "reason": "…" } ] }
// `to` is a folder path by name from the top; folders that don't exist yet are created.

const PROMPT = `You are organising my saved bookmarks into folders, the way a thoughtful librarian would.

Below is JSON with "folders" (every folder I already have, as a path) and "items" (the bookmarks to file: id, title, url, where it sits now, and when known a description, a post's caption and its author).

Work out what each item is actually about and what I would use it for, from its content rather than from the site that hosts it. A tweet about typography belongs with typography, not in a folder called Twitter. Only when a post's content is unknown should it go in a folder named after the platform.

Rules:
- Prefer my existing folders, and the most specific one that fits. Keep my naming style.
- Propose a new folder only when several items share a theme that no folder covers. Give it a short name and put it where it belongs in the tree.
- Leave an item out entirely if it is already in the right place, or is too one-off to deserve a move. Never move something just to have moved it.
- Flag nothing, explain nothing outside the JSON.

Answer with only this JSON (no prose, no code fence):
{"shelfPlan":1,"moves":[{"id":"<item id>","url":"<item url>","to":["<top folder>","<folder>","<subfolder>"],"reason":"<max 8 words, written to me>"}]}
"to" is the full destination path by folder name, starting from one of my top-level folders.

`;

function collect(n, deep, out = []) {
  for (const k of n.children || []) {
    if (k.url) out.push(k);
    else if (deep) collect(k, deep, out);
  }
  return out;
}

function buildPrompt(items, currentId) {
  const folders = M.allFolders(currentId).map((f) => folderPath(f.node));
  const data = {
    folders,
    items: items.map((n) => {
      const d = describe(n);
      return {
        id: d.id,
        title: d.title,
        url: M.isFile(n) ? undefined : n.url,
        kind: d.kind,
        in: folderPath(n.parent),
        ...(d.description ? { description: d.description } : {}),
        ...(d.author ? { author: d.author } : {}),
      };
    }),
  };
  return PROMPT + JSON.stringify(data, null, 1);
}

export function parsePlan(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('That doesn’t contain a plan. Copy Claude’s whole answer and try again.');
  let plan;
  try {
    plan = JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error('The plan isn’t valid JSON. Ask Claude to answer with only the JSON.');
  }
  if (!Array.isArray(plan.moves)) throw new Error('That JSON isn’t a Shelf plan (it has no "moves").');
  return plan;
}

const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

// Follow a path of folder names as far as it exists. -> { folder, rest } (rest = names still to create)
function walkPath(path, fallbackRootId) {
  let names = path.map((x) => String(x).trim()).filter(Boolean);
  let at = M.model.root.children.find((r) => same(r.title, names[0]));
  if (at) names = names.slice(1);
  else at = M.node(fallbackRootId);
  while (names.length) {
    const next = (at.children || []).find((k) => !k.url && same(k.title, names[0]));
    if (!next) break;
    at = next;
    names = names.slice(1);
  }
  return { folder: at, rest: names };
}

function proposalsFromPlan(plan) {
  const byUrl = new Map();
  for (const n of M.model.byId.values()) if (n.url && !byUrl.has(n.url)) byUrl.set(n.url, n);
  const out = [];
  let unknown = 0;
  for (const mv of plan.moves) {
    let n = M.node(String(mv.id ?? ''));
    if (mv.url && (!n || n.url !== mv.url)) n = byUrl.get(mv.url) || null; // ids differ between browsers; the url doesn't
    if (!n || !n.url || M.isLocked(n) || !Array.isArray(mv.to) || !mv.to.length) {
      unknown++;
      continue;
    }
    const root = M.isLocal(n.id) ? M.SHELF_ROOT : M.model.root.children[0].id;
    const { folder, rest } = walkPath(mv.to, root);
    if (!rest.length && folder.id === n.parent.id) continue; // already there
    if (!M.canDrop([n.id], folder.id)) continue;
    out.push({ id: n.id, base: folder.id, rest, reason: String(mv.reason || '').slice(0, 80) });
  }
  return { proposals: out, unknown };
}

// ---------- proposals -> groups ----------

function toGroups(proposals, sourceRootId) {
  const groups = new Map();
  for (const p of proposals) {
    if (p.stay) continue;
    let base = p.base ?? p.folderId ?? sourceRootId;
    let rest = p.rest ?? (p.folderId ? [] : [PLATFORM_FOLDER[p.platform]]);
    // A folder of that name may already exist there: use it instead of making a twin.
    ({ folder: { id: base }, rest } = walkPath(rest, base));
    const key = base + '/' + rest.join('/').toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { base, rest, isNew: rest.length > 0, label: [...M.pathTo(base).map((x) => x.title), ...rest].join(' / '), items: [] });
    }
    groups.get(key).items.push(p);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

// ---------- the dialog ----------

export function tidy({ items, currentId, onApplied }) {
  const loose = items.filter((n) => n.url && !M.isLocked(n));
  const here = M.node(currentId);
  const local = M.isLocal(currentId);
  const sourceRootId = local ? M.SHELF_ROOT : M.model.root.children[0].id;

  let closed = false;
  const abort = () => (closed = true);
  const body = h('div', { class: 'tidy-body' });
  const foot = h('div', { class: 'form-actions' });
  const badge = h('span', { class: 'tidy-engine', hidden: true });
  const panel = h('div', { class: 'form tidy' }, h('h2', {}, 'Tidy up', badge), body, foot);
  const close = openDialog(panel, { wide: true, onClose: abort });
  const say = (text) => {
    body.replaceChildren(h('div', { class: 'tidy-status' }, h('div', { class: 'tidy-spinner' }), h('span', {}, text)));
    foot.replaceChildren();
  };
  const note = (text) => {
    body.replaceChildren(h('p', { class: 'tidy-empty' }, text));
    foot.replaceChildren(h('button', { class: 'btn ghost', onclick: start }, 'Back'), h('button', { class: 'btn primary', onclick: close }, 'Done'));
  };

  // Know what each page says before judging it (cached after the first time).
  async function read(list) {
    let done = 0;
    say(`Reading pages… 0 of ${list.length}`);
    await Promise.all(list.map((n) => previews.ensure(n.url).then(() => !closed && say(`Reading pages… ${++done} of ${list.length}`))));
  }

  function start() {
    badge.hidden = true;
    const deep = h('input', { type: 'checkbox' });
    const scope = () => (deep.checked ? collect(here, true) : loose);
    // Two separate ways to get a plan: one button on this Mac, or a round trip through Claude in three steps.
    const option = (icon, title, text, ...rest) =>
      h('section', { class: 'tidy-option' }, h('span', { class: 'tidy-option-ico', icon }), h('div', {}, h('strong', {}, title), h('p', {}, text), rest));
    const step = (title, text, ...actions) => h('li', {}, h('b', {}, title), h('p', {}, text), actions.length ? h('div', { class: 'tidy-actions' }, actions) : null);
    const btn = (label, run, cls = 'soft') => h('button', { type: 'button', class: 'btn ' + cls, onclick: run }, label);

    body.replaceChildren(
      option(
        'sparkle',
        'Sort on this Mac',
        `Compares the ${plural(loose.length, 'loose bookmark')} here with what your folders already hold. Instant and private, but it can only use folders you already have.`,
        h('div', { class: 'tidy-actions' }, btn('Suggest folders', runLocal, 'primary')),
      ),
      h('div', { class: 'tidy-or' }, 'or'),
      option(
        'edit',
        'Sort with Claude',
        'Claude reads what each page or post is about and can suggest new folders. Shelf sends nothing itself: you carry the prompt there and the answer back.',
        h(
          'ol',
          { class: 'tidy-steps' },
          step(
            'Copy the prompt',
            'Shelf writes it for you, with the bookmarks inside.',
            btn('Copy prompt', async () => {
              const list = scope();
              if (!list.length) return toast('Nothing to sort here');
              await read(list);
              if (closed) return;
              await navigator.clipboard.writeText(buildPrompt(list, currentId));
              start();
              toast(`Prompt with ${plural(list.length, 'bookmark')} copied. Paste it into Claude`);
            }),
            h('label', { class: 'check small' }, deep, h('span', {}, `Include everything inside “${here.title}”, subfolders too`)),
          ),
          step('Paste it into Claude', 'In claude.ai or Claude Code. When Claude has answered, copy its whole answer.'),
          step(
            'Bring the answer back',
            'Paste it here, or choose it as a file. You review every move before anything happens.',
            btn('Paste answer', async () => {
              try {
                review(parsePlan(await navigator.clipboard.readText()), 'Claude');
              } catch (err) {
                toast(err.message || 'Couldn’t read the clipboard');
              }
            }),
            btn('Choose file…', () => {
              const input = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
              input.addEventListener('change', async () => {
                try {
                  review(parsePlan(await input.files[0].text()), 'Claude');
                } catch (err) {
                  toast(err.message);
                }
              });
              input.click();
            }),
          ),
        ),
      ),
    );
    foot.replaceChildren(h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Close'));
  }

  async function runLocal() {
    if (!loose.length) return note('There are no loose bookmarks here. Select some, or open a folder that has them.');
    await read(loose);
    if (closed) return;
    const folders = M.allFolders(currentId).map((f) => f.node);
    show(proposeLocally(loose, folders, currentId), 'On-device', loose.length);
  }

  function review(plan, engine) {
    const { proposals, unknown } = proposalsFromPlan(plan);
    show(proposals, engine, plan.moves.length, unknown);
  }

  function show(proposals, engine, considered, unknown = 0) {
    badge.hidden = false;
    badge.textContent = engine;
    const groups = toGroups(proposals, sourceRootId);
    const moving = groups.reduce((s, g) => s + g.items.length, 0);
    if (!groups.length) {
      return note(
        engine === 'On-device'
          ? 'Nothing here clearly belongs in one of your folders. “Sort with Claude” understands content and can suggest new folders.'
          : 'Nothing in that plan needs moving: everything is already where it says.',
      );
    }

    const checked = new Set(groups.flatMap((g) => g.items.map((p) => p.id)));
    const apply = h('button', { class: 'btn primary' });
    const sync = () => {
      apply.textContent = checked.size ? `Move ${plural(checked.size, 'item')}` : 'Nothing selected';
      apply.disabled = !checked.size;
      for (const g of groups) {
        const on = g.items.filter((p) => checked.has(p.id)).length;
        g.box.checked = on > 0;
        g.box.indeterminate = on > 0 && on < g.items.length;
      }
    };
    const rest = considered - moving - unknown;
    body.replaceChildren(
      ...groups.map((g) => {
        g.box = h('input', { type: 'checkbox' });
        g.box.addEventListener('change', () => {
          for (const p of g.items) (g.box.checked ? checked.add(p.id) : checked.delete(p.id), (p.box.checked = g.box.checked));
          sync();
        });
        return h(
          'section',
          { class: 'tidy-group' },
          h('label', { class: 'tidy-head' }, g.box, h('span', { class: 'menu-ico', icon: g.isNew ? 'folderPlus' : 'folder' }), h('span', { class: 'tidy-dest' }, g.label), g.isNew && h('span', { class: 'tidy-new' }, 'new'), h('span', { class: 'tidy-n' }, g.items.length)),
          g.items.map((p) => {
            const n = M.node(p.id);
            p.box = h('input', { type: 'checkbox', checked: true });
            p.box.addEventListener('change', () => ((p.box.checked ? checked.add(p.id) : checked.delete(p.id)), sync()));
            return h(
              'label',
              { class: 'tidy-row', title: `Now in ${folderPath(n.parent)}` },
              p.box,
              h('img', { class: 'tidy-fav', alt: '', src: M.isFile(n) ? 'icons/icon48.png' : faviconUrl(n.url, 32) }),
              h('span', { class: 'tidy-title' }, n.title || hostOf(n.url)),
              h('span', { class: 'tidy-reason' }, p.reason || ''),
            );
          }),
        );
      }),
      h(
        'p',
        { class: 'tidy-stay' },
        [rest > 0 && `${plural(rest, 'item')} will stay where ${rest === 1 ? 'it is' : 'they are'}.`, unknown > 0 && `${plural(unknown, 'entry')} in the plan didn’t match a bookmark and ${unknown === 1 ? 'was' : 'were'} skipped.`, 'A backup of your browser bookmarks is saved before anything moves.'].filter(Boolean).join(' '),
      ),
    );
    foot.replaceChildren(h('button', { type: 'button', class: 'btn ghost', onclick: start }, 'Back'), apply);
    sync();

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.textContent = 'Backing up…';
      const undos = [];
      let moved = 0;
      try {
        await takeBackup('Before Tidy up');
        apply.textContent = 'Moving…';
        for (const g of groups) {
          const ids = g.items.filter((p) => checked.has(p.id) && M.node(p.id)).map((p) => p.id);
          if (!ids.length) continue;
          let folderId = g.base;
          for (const name of g.rest) {
            // Re-check: an earlier group may have just created this folder.
            const twin = M.kids(folderId).find((k) => !k.url && same(k.title, name));
            if (twin) folderId = twin.id;
            else {
              const { made, undo } = await M.create({ parentId: folderId, title: name });
              undos.push(undo);
              folderId = made.id;
              await M.load();
            }
          }
          undos.push(await M.moveMany(ids, folderId));
          moved += ids.length;
          await M.load();
        }
      } catch (err) {
        console.error(err);
        toast('Some items couldn’t be moved');
      }
      close();
      onApplied({
        moved,
        undo: async () => {
          for (const u of undos.reverse()) {
            await u();
            await M.load();
          }
        },
      });
    });
  }

  start();
}
