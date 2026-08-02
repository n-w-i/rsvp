const CACHE = 'flash-v1';
const SHARE_CACHE = 'flash-share';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/rsvp.js',
  'js/extract.js',
  'js/tokenize.js',
  'js/store.js',
  'vendor/pdf.mjs',
  'vendor/pdf.worker.mjs',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Android share sheet posts the file here; stash it and hand off to the page.
  if (e.request.method === 'POST' && url.origin === location.origin) {
    e.respondWith(
      (async () => {
        try {
          const form = await e.request.formData();
          const file = form.get('file');
          if (file) {
            const cache = await caches.open(SHARE_CACHE);
            await cache.put(
              'shared',
              new Response(file, { headers: { 'x-filename': encodeURIComponent(file.name || 'shared.pdf') } }),
            );
          }
        } catch {}
        return Response.redirect('./?shared=1', 303);
      })(),
    );
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
