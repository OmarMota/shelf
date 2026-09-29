// What Shelf remembers about an address that the browser's bookmark store has no field for:
// your note, when you last opened it from Shelf, and "still good, stop asking" from Review.
// Kept by URL (ids change when an item is rebuilt by undo, or carried to My Shelf) in
// chrome.storage.local, and small enough to hold in memory so search and cards can read it directly.

import { debounce } from './util.js';

let notes = {}; // url -> text
let marks = {}; // url -> { o: last opened from Shelf, k: kept in Review }
const listeners = new Set();

export async function loadNotes() {
  const got = await chrome.storage.local.get(['notes', 'marks']);
  notes = got.notes || {};
  marks = got.marks || {};
}

export const onNotesChanged = (fn) => listeners.add(fn);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.notes && !changes.marks)) return;
  if (changes.notes) notes = changes.notes.newValue || {};
  if (changes.marks) marks = changes.marks.newValue || {};
  if (changes.notes) for (const fn of listeners) fn();
});

export const noteOf = (url) => notes[url] || '';

// Returns the previous text, for undo.
export async function setNote(url, text) {
  const prev = notes[url] || '';
  text = (text || '').trim();
  if (text === prev) return prev;
  notes = { ...notes };
  if (text) notes[url] = text;
  else delete notes[url];
  await chrome.storage.local.set({ notes });
  return prev;
}

const saveMarks = debounce(() => chrome.storage.local.set({ marks }), 400);

function mark(url, key) {
  marks[url] = { ...marks[url], [key]: Date.now() };
  saveMarks();
}

export const markOpened = (url) => mark(url, 'o');
export const markKept = (url) => mark(url, 'k');
export const openedAt = (url) => marks[url]?.o || 0;
export const keptAt = (url) => marks[url]?.k || 0;
