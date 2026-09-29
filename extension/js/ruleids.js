// Session-rule ids for one Shelf tab. Two distinct ids whatever the tab id is (rule ids must be
// unique positive 32-bit integers). Shared by the page, which installs them, and the worker,
// which removes them when the tab goes away.
export const ruleIds = (tabId) => {
  const base = (tabId % 1_000_000_000) + 1;
  return [base, base + 1_000_000_000];
};
