// Network rules that exist only while this Shelf tab is open, and only apply to this tab.
//  · frames: let bookmarked sites render inside the Quick Look frame (drop their frame-blocking headers)
//  · fetches: drop `Link: <…>; rel=preload` headers from Shelf's own metadata requests — otherwise
//    Chromium dutifully preloads every site's fonts and CSS into this page and then warns that
//    nothing used them.

import { ruleIds } from './ruleids.js';

export let tabId = null;

async function install() {
  const tab = await chrome.tabs.getCurrent();
  if (!tab) return;
  tabId = tab.id;
  const ids = ruleIds(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ids,
    addRules: [
      {
        id: ids[0],
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
            { header: 'content-security-policy-report-only', operation: 'remove' },
          ],
        },
        condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
      },
      {
        id: ids[1],
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: [{ header: 'link', operation: 'remove' }] },
        condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest'] },
      },
    ],
  });
  // The worker also removes these if the tab closes or navigates away.
  addEventListener('pagehide', () => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
  });
}

export const rulesReady = install().catch(() => {});
