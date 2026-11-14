// The Crit and Plannotator proxies: rewrites (pure) and a fake tool server behind a real hub.
import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from './hub.ts';
import { hubApp } from './server.ts';
import { referredPath, rewriteHtml, rewriteScript } from './proxy.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-proxy-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('pages: root attributes and pathname reads under the prefix, the shim first in <head>', () => {
  const html = rewriteHtml(`<html><head lang="en"><link href="/assets/a.css"><script src="/assets/i.js"></script><a href="//cdn.example/x">x</a><img src='/f.png'><a href="rel.js">r</a></head><body><script>if (window.location.pathname === '/preview') go();</script></body></html>`, '/crit/abc');
  expect(html.indexOf('<script>(()=>{const P="/crit/abc"')).toBe(html.indexOf('<head lang="en">') + '<head lang="en">'.length);
  expect(html).toContain('href="/crit/abc/assets/a.css"');
  expect(html).toContain('src="/crit/abc/assets/i.js"');
  expect(html).toContain("src='/crit/abc/f.png'");
  expect(html).toContain('href="//cdn.example/x"'); // another host
  expect(html).toContain('href="rel.js"'); // relative already stays under the prefix
  expect(html).not.toContain('window.location.pathname ===');
});

test('scripts: reads of location.pathname see the path below the prefix; assignments and other objects untouched', () => {
  const below = '(location.pathname.startsWith("/plannotator/42/")?location.pathname.slice(15):location.pathname)';
  const js = rewriteScript('a=location.pathname;b=window.location.pathname+location.search;c=doc.location.pathname;location.pathname = "/x";d=location.pathname==="/p"', '/plannotator/42');
  expect(js).toBe(`a=${below};b=${below}+location.search;c=doc.location.pathname;location.pathname = "/x";d=${below}==="/p"`);
  expect('/plannotator/42/preview'.slice(15)).toBe('/preview');
});

test('a root request from a tool page goes into its prefix; others are not redirected', () => {
  expect(referredPath('https://mac.ts.net:4847/crit/abc123/preview', '/api/config')).toBe('/crit/abc123/api/config');
  expect(referredPath('http://127.0.0.1:4847/plannotator/4567/', '/assets/x.woff2')).toBe('/plannotator/4567/assets/x.woff2');
  expect(referredPath('http://127.0.0.1:4847/r/0123456789ab/', '/x')).toBeNull();
  expect(referredPath('http://127.0.0.1:4847/', '/x')).toBeNull();
  expect(referredPath(undefined, '/x')).toBeNull();
  expect(referredPath('not a url', '/x')).toBeNull();
});

test('a Crit session through the hub, on loopback and the public origin', async () => {
  // Crit-like: refuses any Host but its own loopback one, serves a page that assumes it owns the root
  const hosts: string[] = [];
  using tool = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const host = req.headers.get('host') ?? '';
      hosts.push(host);
      if (host !== `127.0.0.1:${tool.port}`) return new Response('forbidden', { status: 403 });
      const p = new URL(req.url).pathname;
      if (p === '/preview') return new Response(`<html><head><script src="/app.js"></script></head></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (p === '/app.js') return new Response(`if (location.pathname === '/preview') fetch('/api/config');`, { headers: { 'content-type': 'text/javascript' } });
      if (p === '/api/config') return Response.json({ ok: true, origin: req.headers.get('origin') });
      if (p === '/go') return new Response(null, { status: 302, headers: { location: '/preview' } });
      return new Response('nope', { status: 404 });
    },
  });
  const critHome = fs.mkdtempSync(path.join(root, 'c-'));
  fs.mkdirSync(path.join(critHome, 'sessions'));
  fs.writeFileSync(path.join(critHome, 'sessions', 'abc123def456.json'), JSON.stringify({ pid: process.pid, port: tool.port, host: '127.0.0.1', args: ['preview', '/tmp/x.html'] }));
  const pub = 'https://mac.tailnet.ts.net:4847';
  using hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: hubApp(new Hub({ critHome, plannotatorDataDir: path.join(root, 'none'), healthTimeoutMs: 200 }), pub).fetch });
  const base = `http://127.0.0.1:${hub.port}`;
  const viaPublic = { host: 'mac.tailnet.ts.net:4847' };

  const page = await fetch(`${base}/crit/abc123def456/preview`, { headers: viaPublic });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('src="/crit/abc123def456/app.js"');
  expect(html).toContain('const P="/crit/abc123def456"');
  expect(hosts.every((h) => h === `127.0.0.1:${tool.port}`)).toBe(true); // the tool saw only its own Host

  const js = await (await fetch(`${base}/crit/abc123def456/app.js`)).text();
  expect(js).toContain('location.pathname.slice(18)');

  // a same-site write reaches the tool with its loopback Origin; a cross-site one stops at the hub
  const ok = await fetch(`${base}/crit/abc123def456/api/config`, { method: 'POST', headers: { ...viaPublic, origin: pub } });
  expect(await ok.json()).toEqual({ ok: true, origin: `http://127.0.0.1:${tool.port}` });
  expect((await fetch(`${base}/crit/abc123def456/api/config`, { method: 'POST', headers: { ...viaPublic, origin: 'https://evil.example' } })).status).toBe(403);

  const redirect = await fetch(`${base}/crit/abc123def456/go`, { redirect: 'manual' });
  expect(redirect.headers.get('location')).toBe('/crit/abc123def456/preview');

  // a root asset the shim could not reach: into the prefix of the page that asked
  const fallback = await fetch(`${base}/assets/f.woff2?v=1`, { redirect: 'manual', headers: { referer: `${pub}/crit/abc123def456/preview` } });
  expect([fallback.status, fallback.headers.get('location')]).toEqual([307, '/crit/abc123def456/assets/f.woff2?v=1']);
  expect((await fetch(`${base}/assets/f.woff2`, { redirect: 'manual' })).status).toBe(404);

  expect((await fetch(`${base}/crit/ffffffffffff/preview`)).status).toBe(404); // no such session
  expect((await fetch(`${base}/plannotator/1/`)).status).toBe(404);
  expect((await fetch(`${base}/crit/abc123def456/preview`, { headers: { host: 'evil.example' } })).status).toBe(403);
});
