# Contributing to Shelf

Thanks for wanting to help. Shelf is small and deliberately simple, so contributing is too.

## Setup

There is no build step and no dependencies. The `extension/` folder *is* the extension.

1. Fork and clone the repo.
2. Open `dia://extensions` (or `chrome://extensions`, `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** and click **Load unpacked**, then pick the `extension/` folder.
4. After editing a file, click the reload arrow on the Shelf card and reopen Shelf (`⌥⇧B`).
   Changes to `background.js` or `manifest.json` always need that reload; for page-only changes
   (`app.css`, `js/*`) reloading the Shelf tab is usually enough.

Debugging: right-click inside Shelf → **Inspect** for the page, and the **service worker** link on the
extension card for `background.js`.

## Guidelines

- **Plain modern JavaScript (ES modules), HTML and CSS.** No frameworks, bundlers or npm packages.
  If you think one is truly needed, open an issue first.
- **The browser's bookmark store is the source of truth.** Anything that changes bookmarks goes
  through `chrome.bookmarks` (see `js/model.js`), so Shelf and the browser never disagree.
- **Privacy is a feature.** No analytics, no accounts, no remote code, no new third-party services.
  Requests to websites go out without cookies (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`).
  If your change adds a network request or a permission, say so in the PR and update `PRIVACY.md`.
- **Destructive actions need Undo** (or an explicit review step, like Tidy up and Review).
- Keep the calm look: match the existing spacing, type and motion in `app.css`, and respect
  `prefers-reduced-motion`.

## Pull requests

- One focused change per PR, with a short description and, for UI changes, a screenshot or GIF.
- Say which browser(s) you tested in (Dia, Chrome, Arc, Brave, Edge).
- **Never commit personal data.** Your own bookmarks, backups or tidy plans do not belong in the repo;
  `backups/` and `plans/` are gitignored for that reason.

## Reporting bugs

Open an issue with the browser and version, what you did, what you expected and what happened.
Console errors from the Shelf page or the service worker help a lot. Please redact any bookmark
URLs you don't want to make public.

## Packaging a release

The zip attached to each GitHub release is the `extension/` folder, zipped with `manifest.json` at its
root and without macOS metadata:

```bash
mkdir -p dist && cd extension
zip -r -X ../dist/shelf-v$(node -p "require('./manifest.json').version").zip . -x '.*' -x '*/.*'
```

Bump `version` in `extension/manifest.json` first. The same zip is what the Chrome Web Store expects.
`dist/` is gitignored: upload the file to the release, don't commit it.
