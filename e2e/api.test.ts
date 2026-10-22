// A detached server answers its API and bundle, and refuses what it must.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { SearchHit } from '../src/core/types.ts';
import { expectClientHeaders, setup } from './fixture.ts';

describe('api', () => {
  const { tmp, repo, dir, serve, sessions } = setup();
  const marker = path.join(tmp, 'pwned');
  const status = (p: string, init?: RequestInit) => fetch(url + p, init).then((r) => r.status);
  let url = '';
  beforeAll(async () => (url = await serve()));

  test('the patch is a plain git diff whatever the git config', async () => expect(await (await fetch(url + 'api/patch')).text()).toStartWith('diff --git a/'));
  test('symbol search finds the definition', async () => {
    const hits: SearchHit[] = await (await fetch(url + 'api/search?symbol=1&q=RecentEvents&rev=feat/habit-events')).json();
    expect(hits.some((h) => h.kind === 'definition')).toBe(true);
  });
  test('a running server is listed in the per-user session registry', () =>
    expect(sessions().some((s) => s.url === url && s.repo === fs.realpathSync(repo) && s.dir.endsWith('feat-habit-events'))).toBe(true));
  test('summary gives round and counts without thread text', async () =>
    expect(await (await fetch(url + 'api/summary')).json()).toMatchObject({ round: 1, threads: 0, browserClients: expect.any(Number), walkthrough: expect.any(Boolean) }));

  test('walkthrough: 404 when absent, the file when valid, 422 with issues when not', async () => {
    const file = path.join(dir, 'walkthrough.json');
    fs.rmSync(file, { force: true });
    expect(await status('api/walkthrough')).toBe(404);
    const w = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [{ id: 's1', text: '<p>x</p>', ref: 'rr:code/x.go#L1' }] }] };
    fs.writeFileSync(file, JSON.stringify(w));
    const ok = await fetch(url + 'api/walkthrough');
    expect([ok.status, await ok.json()]).toEqual([200, w]);
    fs.writeFileSync(file, JSON.stringify({ ...w, version: 2 }));
    const bad = await fetch(url + 'api/walkthrough');
    expect([bad.status, (await bad.json()).issues]).toEqual([422, [expect.stringContaining('version')]]);
    expect(await status('api/walkthrough', { headers: { 'sec-fetch-site': 'cross-site' } })).toBe(403);
    fs.rmSync(file);
  });
  test('saved layouts: shipped and taken names are refused, deleting the default clears it', async () => {
    const put = (p: string, body: unknown) => fetch(url + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const mine = { title: 'Mine', root: { tabs: ['narrative'] } };
    expect((await put('api/layouts/reading', mine)).status).toBe(409);
    expect((await put('api/layouts/mine', mine)).status).toBe(200);
    expect((await put('api/layouts/mine', mine)).status).toBe(409);
    expect((await put('api/layouts/..%2Fx', mine)).status).toBe(400);
    expect((await put('api/default-layout', { layout: 'mine' })).status).toBe(200);
    expect(await (await fetch(url + 'api/layouts')).json()).toEqual({ layouts: { mine }, default: 'mine' });
    expect(await status('api/layouts/mine', { method: 'DELETE' })).toBe(200);
    expect(await (await fetch(url + 'api/layouts')).json()).toEqual({ layouts: {}, default: null });
  });

  // security regressions
  test('search query starting with - is a pattern, not a git option', async () => {
    const r = await fetch(url + `api/search?rev=worktree&q=${encodeURIComponent('-Otouch ' + marker)}`);
    expect(r.ok && Array.isArray(await r.json())).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
  test('files rejects an option as base', async () => {
    expect(await status(`api/files?base=${encodeURIComponent('--output=' + marker)}`)).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(marker)).toBe(false);
  });
  test('read rejects an option as rev', async () => {
    expect(await status(`api/read?path=x&rev=${encodeURIComponent('--output=' + marker)}`)).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(marker + ':x')).toBe(false);
  });
  // Bun's fetch sends these headers as given
  test('cross-site API request is refused', async () => expect(await status('api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).toBe(403));
  test('write from a foreign origin is refused', async () =>
    expect(await status('api/ops', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example', 'content-type': 'application/json' } })).toBe(403));
  test('foreign Host header is refused', async () => expect(await status('api/meta', { headers: { host: `evil.example:${new URL(url).port}` } })).toBe(403));
  test('the page loads its build relatively (under the hub\'s /r/<id>/, its own)', async () => expect(await (await fetch(url)).text()).toContain('src="_rr/reviewroom.js"'));
  test('state files are not served', async () =>
    expect(await Promise.all(['state.json', 'STATE.JSON', 'state%2Ejson', 'state.lock'].map((f) => status(f)))).toEqual([404, 404, 404, 404]));
  test('static file with # and ? in its name is served', async () => {
    fs.writeFileSync(path.join(dir, 'fig #1?.txt'), 'fig');
    const r = await fetch(url + encodeURIComponent('fig #1?.txt'));
    expect([r.status, await r.text()]).toEqual([200, 'fig']);
  });
  test('an older review.html gets the PWA head; <rr-review> is untouched', async () => {
    const file = path.join(dir, 'review.html');
    const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const body = '<rr-review>\n<h1>Old</h1><meta name="viewport" content="x"><p>rel="manifest" </head></p>\n</rr-review>';
    try {
      fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body>${body}</body></html>`);
      const html = await (await fetch(url)).text();
      for (const tag of ['<link rel="manifest" href="/manifest.webmanifest">', 'name="apple-mobile-web-app-capable"', 'media="(prefers-color-scheme: dark)"', 'initial-scale=1, viewport-fit=cover"', 'src="_rr/reviewroom.js"'])
        expect(html).toContain(tag);
      expect(html.slice(html.indexOf('<rr-review>'), html.indexOf('</rr-review>') + 12)).toBe(body);
    } finally {
      if (saved === undefined) fs.rmSync(file);
      else fs.writeFileSync(file, saved);
    }
  });
  test('hashed chunks are immutable, the rest revalidates; every response names the build', () => expectClientHeaders(url, 'api/state'));
  test('the build header follows a rebuild without a restart', async () => {
    const f = path.join(import.meta.dir, '..', 'dist', 'build-info.json');
    const saved = fs.readFileSync(f, 'utf8');
    try {
      fs.writeFileSync(f, JSON.stringify({ id: 'rebuilt' }));
      expect((await fetch(url + 'api/state')).headers.get('x-reviewroom-build')).toBe('rebuilt');
      fs.rmSync(f);
      expect((await fetch(url + 'api/state')).headers.get('x-reviewroom-build')).toBeNull();
    } finally {
      fs.writeFileSync(f, saved);
    }
  });
});
