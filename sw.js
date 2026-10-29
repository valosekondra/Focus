// Offline: kostra appky z mezipaměti (data z Googlu se ukládají zvlášť v localStorage).
// Vždy nejdřív síť s ověřením u serveru (cache: "no-cache"), aby se po nahrání nové verze
// nesmíchaly staré a nové soubory; bez sítě poslední uložená verze.
const CACHE = "focus-v7";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;   // Google API a přihlášení se nekešují
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./")))
  );
});
