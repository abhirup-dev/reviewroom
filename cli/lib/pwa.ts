import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { serveStatic } from '@hono/bun';
import { DIST } from './paths.ts';

// dist/build-info.json's id, read again when the file changes: a running server serves dist/ while `bun run dev` rebuilds it
let build: { mtime: number; id?: string } = { mtime: -1 };
export const buildId = () => {
  const f = path.join(DIST, 'build-info.json');
  try {
    const mtime = fs.statSync(f).mtimeMs;
    if (mtime !== build.mtime) build = { mtime, id: JSON.parse(fs.readFileSync(f, 'utf8')).id };
  } catch {
    build = { mtime: -1 }; // missing or half-written: no header, try again next time
  }
  return build.id;
};

/** The PWA head: the hub-root manifest (absolute: review pages live under /r/<id>/), iOS Home Screen tags, theme colours (--rr-bg). */
export const PWA_HEAD = `<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/_rr/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="reviewroom">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#e4e2db" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#07080a" media="(prefers-color-scheme: dark)">
`;

/** Adds what a page's <head> lacks (older review.html files): viewport-fit=cover, the PWA tags, the client entry. */
export function withHead(html: string) {
  const end = html.indexOf('</head>');
  if (end < 0) return html;
  let head = html.slice(0, end).replace(/(<meta name="viewport" content="(?![^"]*viewport-fit)[^"]*)"/, '$1, viewport-fit=cover"');
  if (!head.includes('rel="manifest"')) head += PWA_HEAD;
  // the client build loads relatively, so under the hub's /r/<id>/ the page gets this server's build, not the hub's
  head = head.replace(/(src=["'])\/_rr\/reviewroom\.js/, '$1_rr/reviewroom.js');
  if (!head.includes('_rr/reviewroom.js')) head += '<script type="module" src="_rr/reviewroom.js"></script>\n';
  return head + html.slice(end);
}

/**
 * The client build (/_rr/*), its service worker (/sw.js) and the web app manifest, on the review server and the hub. Chunks are
 * content-hashed, so immutable; fonts keep their file names across package upgrades, so a day; the rest (the entries,
 * css, build-info.json, sw.js, the manifest) revalidates so a new build never mixes with stale files.
 */
export function serveClient(app: Hono) {
  // no-cache files revalidate: an unchanged 2 MB entry costs a 304, not a download (a phone on a slow tailnet)
  for (const p of ['/_rr/*', '/manifest.webmanifest', '/sw.js']) app.use(p, etag({ retainedHeaders: [...RETAINED_304_HEADERS, 'x-reviewroom-pid', 'x-reviewroom-build'] })); // the hub proxy checks the pid on a 304 too
  const policy = (p: string) => (p.startsWith('/_rr/chunks/') ? 'public, max-age=31536000, immutable' : p.startsWith('/_rr/fonts/') ? 'max-age=86400' : 'no-cache');
  app.get('/_rr/*', async (c, next) => {
    c.header('cache-control', policy(c.req.path));
    return next();
  }, serveStatic({ root: DIST, precompressed: true, rewriteRequestPath: (p) => p.replace(/^\/_rr/, '') }));
  app.get('/manifest.webmanifest', async (c, next) => {
    c.header('cache-control', 'no-cache');
    return next();
  }, serveStatic({ root: DIST, precompressed: true, mimes: { webmanifest: 'application/manifest+json' } }));
  app.get('/sw.js', async (c, next) => {
    c.header('cache-control', 'no-cache');
    c.header('service-worker-allowed', '/');
    return next();
  }, serveStatic({ root: DIST, precompressed: true }));
}
