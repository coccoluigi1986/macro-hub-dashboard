// Service worker della dashboard (necessario per l'installazione come app e per un minimo di uso offline).
//
// Strategia — pensata per una dashboard di DATI LIVE, dove un dato vecchio è peggio di nessun dato:
//   - /api/*          → sempre dalla rete, MAI dalla cache. Se la rete manca risponde 503 e la pagina mostra
//                       "non disponibile" (come già fa quando una fonte non risponde).
//   - pagine (/, /info) → prima la rete (ogni deploy è visibile subito); solo se la rete manca o è troppo lenta
//                       si usa l'ultima copia salvata, così l'app si apre anche offline (senza dati).
//   - icone, manifest, font di Google → dalla cache mentre si aggiornano in background.
// Per forzare l'aggiornamento della cache dopo modifiche a questo file basta cambiare VERSION.

const VERSION = 'v1';
const SHELL_CACHE = `mhub-shell-${VERSION}`;
const FONT_CACHE = `mhub-fonts-${VERSION}`;
const PRECACHE = ['/', '/info', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const PAGE_TIMEOUT_MS = 6000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // un file che non risponde non deve impedire l'installazione dell'app
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('mhub-') && k !== SHELL_CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// chiave di cache di una pagina: percorso senza query né hash (così "/?source=app" e "/" sono la stessa pagina)
const pageKey = (url) => new Request(url.origin + url.pathname);

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function networkFirstPage(request) {
  const url = new URL(request.url);
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(request), PAGE_TIMEOUT_MS);
    // le risposte con redirect non possono essere servite a una navigazione dal service worker: non si salvano
    if (res && res.ok && res.type === 'basic' && !res.redirected) cache.put(pageKey(url), res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(pageKey(url))) || (await cache.match('/'));
    return hit || new Response('Sei offline e questa pagina non è ancora stata salvata. Riprova quando torni online.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })));
    return;
  }
  if (request.mode === 'navigate' && sameOrigin) { event.respondWith(networkFirstPage(request)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { event.respondWith(staleWhileRevalidate(request, FONT_CACHE)); return; }
  if (sameOrigin && (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest')) { event.respondWith(staleWhileRevalidate(request, SHELL_CACHE)); return; }
  // tutto il resto passa dalla rete senza intervento
});
