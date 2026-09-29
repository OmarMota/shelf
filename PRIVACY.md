# Privacy Policy: Shelf

*Last updated: 29 September 2026. Applies to Shelf version 0.2.0.*

Shelf is a browser extension that gives your bookmarks a visual canvas. It has **no server, no
account, no analytics and no telemetry**. The developer receives none of your data. Everything
Shelf keeps is stored inside your browser, on your device.

This page describes exactly what the extension reads, stores and requests, based on its source code
(which is public in this repository).

## What Shelf reads

| Data | Why | Permission |
| --- | --- | --- |
| Your browser bookmarks | To show, search, move, rename, add and delete them. Shelf edits the browser's own bookmark store, so changes show up in the browser and vice versa. | `bookmarks` |
| Your browsing history (visit dates only) | Only when you open **Review → Not opened**, to find bookmarks you haven't visited in a while. It is compared locally and not stored. | `history` |
| Open tabs in the current window (URL, title) | For **Save this window's tabs as a folder**, for **Open all in a new window / as a tab group**, and to find an already open Shelf tab. | `tabs`, `tabGroups` |
| What's visible in the active tab (screenshot) | To make card previews: (a) of the live preview inside Quick Look, and (b) when you visit a page that is bookmarked. (b) is on by default and can be turned off in **Settings → Snapshot bookmarked pages as I browse**. Pages that are not bookmarked are never captured. | `tabs`, host access |
| The address of pages you load (top frame) | Compared locally with your bookmarks, so a preview can be refreshed when you visit a bookmarked page, even through a redirect. Addresses are kept in memory only while the tab is open and never stored or sent. | `tabs`, `webNavigation` |
| Posts shown on your X bookmarks, Instagram saved posts or Pinterest boards | Only when you start **Import → My X bookmarks / Instagram saved posts / Pinterest boards**. Shelf opens the site in a tab and injects a small panel that reads the post links, text and picture addresses already displayed on the page. It does not read passwords, cookies or tokens. | `scripting`, host access |
| Files you drop into My Shelf | To store them in your personal library. | none |
| Your clipboard (write, and read on request) | **Copy link / Copy image / Copy prompt** write to it; **Paste plan** in Tidy up reads it only when you click it. | `clipboardWrite` |

## What Shelf stores (only on your device)

- **IndexedDB** (inside the extension): card previews (screenshots and pictures), page titles,
  descriptions and authors fetched for your bookmarks; your **My Shelf** library (links, folders and
  the files you add); and up to 20 **snapshots of your bookmark tree** (a safety net taken once a day
  when Shelf is opened and before every Tidy up). `unlimitedStorage` lets this hold large files.
- **Extension storage** (`chrome.storage`): settings, the notes you write on bookmarks, when you last
  opened a bookmark from Shelf, bookmarks you marked "keep" in Review, and when you last imported from
  X / Instagram / Pinterest.
- **localStorage**: the aspect ratio of preview images, for layout.

Nothing of this is synced or uploaded by Shelf. Removing the extension deletes this data; your browser
bookmarks stay where they are.

## Network requests

Shelf has no backend. The requests below go **directly from your browser** to the site in question.
Requests Shelf makes itself (`fetch`) are sent **without cookies and without a referrer**, so they
don't act on your behalf. Like any web request, they reveal your IP address to the site contacted.

1. **Your bookmarked sites**, to read a page's title, description, icon and preview image when its card
   comes into view (results are cached for 30 days, or 3 days after a failure). The same kind of
   request is used when you add a link, run **Review → Broken links**, choose **Copy image / Save image**,
   or **Save a local copy to My Shelf**.
2. **Public embed/metadata endpoints**, for video and social-post bookmarks only:
   `www.youtube.com/oembed`, `i.ytimg.com` (thumbnails), `vimeo.com/api/oembed.json`,
   `cdn.syndication.twimg.com` and `publish.twitter.com/oembed` (X posts), and Instagram's public
   post embed page (`www.instagram.com/p/…/embed/captioned/`).
3. **Picture addresses** collected during an X / Instagram / Pinterest import, to keep a copy of each
   post's image as its preview.
4. **Quick Look** shows the real page in a frame, or the platform's official player:
   `www.youtube.com/embed`, `player.vimeo.com`, `platform.twitter.com/embed` (with "do not track"),
   Instagram's embed, `assets.pinterest.com/ext/embed.html`. YouTube is reached through
   `https://example.com/` first, because its player needs to be opened from a web page. Framed pages
   load like any web page: they may run their own scripts and use their own cookies, subject to your
   browser's settings. To let sites display inside Quick Look, Shelf removes their frame-blocking
   headers (`X-Frame-Options`, `Content-Security-Policy`) **only for frames inside the Shelf tab, and
   only while that tab is open** (`declarativeNetRequest` session rules).
5. **Favicons** come from the browser's built-in favicon cache (`favicon` permission). No external
   favicon service is used.

Shelf does **not** contact any analytics, advertising, tracking or AI service. **Sort with Claude**
only copies a prompt (containing the titles and addresses of the bookmarks being sorted) to your
clipboard; it is sent nowhere unless you paste it somewhere yourself. The **Wayback Machine** link in
Review simply opens `web.archive.org` in a new tab when you click it.

## Sharing and selling

The developer does not collect, receive, sell or share any user data. There is no remote code: all
code that runs is shipped inside the extension.

## Children

Shelf is a general-purpose tool and does not knowingly collect data from anyone, including children.

## Changes

If a future version changes what is described here, this file will be updated in the same release.

## Contact

Questions: open an issue on the project's GitHub repository ([github.com/OmarMota](https://github.com/OmarMota)).
