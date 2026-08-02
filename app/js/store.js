const DB_NAME = 'rsvp';
const STORE = 'docs';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('opened', 'opened');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const t = conn.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const library = {
  put: (doc) => tx('readwrite', (s) => s.put(doc)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  async all() {
    const docs = await tx('readonly', (s) => s.getAll());
    return docs.sort((a, b) => b.opened - a.opened);
  },
};

export async function hashOf(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SETTINGS_KEY = 'rsvp:settings';
const DEFAULTS = {
  wpm: 350,
  chunkSize: 1,
  fontSize: 1,
  punctuationScale: 1,
  showContext: true,
  skipNoise: true,
  rewindOnResume: true,
  theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  font: 'sans',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
