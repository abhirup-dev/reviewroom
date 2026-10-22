// Service worker, compiled to dist/sw.js by scripts/build.ts with the build id and precache list baked in.
// Served at /sw.js with scope / on the hub (ADR 0001). Plain Cache API, one cache per build: `rr-<build>`.
//   /_rr/*                    the worker's own build: precached shell, the rest cached at runtime; cache first
//   /r/<id>/_rr/*             a review's build: chunks, fonts, emoji cache first; entries network first
//   page navigations          network first; an offline page when the server can't be reached
//   /api/*, /r/<id>/api/*     not intercepted, nor build-info.json (the update check reads it)
declare const self: ServiceWorkerGlobalScope; // narrows the global: this file is a module (see `export {}`)
declare const __RR_BUILD__: string;
declare const __RR_PRECACHE__: string[];

// oxlint-disable-next-line unicorn/require-module-specifiers -- a module for the `self` above, yet nothing exported: a classic worker can't parse `export`
export {};
const CACHE = `rr-${__RR_BUILD__}`;
const base = new URL('./', self.location.href).pathname; // '/' on the hub, or the prefix a front serves it under
const at = (p: string) => base + p.slice(1); // '/_rr/x' -> '<base>_rr/x'

const cacheable = (res: Response) => res.status === 200 && !res.redirected && res.type === 'basic';

async function post(msg: unknown) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage has no target origin
  for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage(msg);
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const total = __RR_PRECACHE__.length;
      let done = 0;
      await Promise.all(
        __RR_PRECACHE__.map(async (p) => {
          const res = await fetch(at(p), { cache: 'reload' });
          if (!cacheable(res)) throw new Error(`precache ${p}: ${res.status}`); // fails the install: never a half-filled cache
          await cache.put(at(p), res);
          void post({ type: 'progress', done: ++done, total });
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('rr-') && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(base)) return;
  const path = url.pathname.slice(base.length - 1);
  if (/^\/(r\/[^/]+\/)?api\//.test(path)) return; // live data, writes and the event stream: always the network
  if (req.mode === 'navigate') return e.respondWith(fetch(req).catch(offline));
  const m = /^\/(r\/[^/]+\/)?_rr\/(.+)$/.exec(path);
  if (!m || m[2] === 'build-info.json') return;
  // a review's entry and CSS aren't hashed and its server may restart on a newer build than this worker's
  const fresh = m[1] && !/^(chunks|fonts)\/|^emoji\.json$/.test(m[2]);
  e.respondWith(fresh ? networkFirst(e) : cacheFirst(e));
});

async function cacheFirst(e: FetchEvent) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(e.request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(e.request);
  if (cacheable(res)) e.waitUntil(cache.put(e.request, res.clone()));
  return res;
}

async function networkFirst(e: FetchEvent) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(e.request);
    if (cacheable(res)) e.waitUntil(cache.put(e.request, res.clone()));
    return res;
  } catch (err) {
    const hit = await cache.match(e.request, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

function offline() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>reviewroom</title>
<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5">
<h1 style="font-size:1.25rem">reviewroom isn't reachable</h1>
<p>The hub, or the way this device reaches it, is offline. Check that <code>reviewroom hub</code> is running, then
<a href="" onclick="location.reload();return false">try again</a>.</p></body>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
