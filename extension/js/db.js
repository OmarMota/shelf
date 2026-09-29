// Preview cache (IndexedDB). Shared by the page and the service worker.
// One record per URL: { url, shot, shotAt, og, title, description, icon, metaAt, metaOk }

// v2 adds the personal library: `items` (the My Shelf tree) and `blobs` (the files themselves,
// kept apart so listing the tree never drags a 300 MB video through memory).

const DB = 'shelf';
const STORE = 'previews';
let dbp;

export function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id' }); // v3
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another context (the page vs. the worker) wants to upgrade: step aside and reopen later.
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }));
}

export const txDone = (tx) => done(tx);

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function getRec(url) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Read-merge-write in one transaction so the page and the worker never clobber each other.
export async function patchRec(url, patch) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let merged;
  const req = store.get(url);
  req.onsuccess = () => {
    merged = { ...(req.result || { url }), ...patch };
    store.put(merged);
  };
  await done(tx);
  return merged;
}

export async function delRec(url) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(url);
  await done(tx);
}
