// A detached server answers its API and bundle, and refuses what it must.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { SearchHit } from '../src/core/types.ts';
import { setup } from './fixture.ts';

describe('api', () => {
  const { tmp, repo, dir, serve, sessions } = setup();
  const marker = path.join(tmp, 'pwned');
  const status = (p: string, init?: RequestInit) => fetch(url + p, init).then((r) => r.status);
  let url = '';
  beforeAll(async () => (url = await serve()));

  test('server up', () => expect(url).toStartWith('http://127.0.0.1:'));
  test('diff has 5 files', async () => expect(await (await fetch(url + 'api/files')).json()).toHaveLength(5));
  test('symbol search finds the definition', async () => {
    const hits: SearchHit[] = await (await fetch(url + 'api/search?symbol=1&q=RecentEvents&rev=feat/habit-events')).json();
    expect(hits.some((h) => h.kind === 'definition')).toBe(true);
  });
  test('client bundle is served', async () => expect(await status('_rr/reviewroom.js')).toBe(200));
  test('review page is scaffolded', async () => expect(await (await fetch(url)).text()).toContain('<rr-review>'));
  test('a running server is listed in the per-user session registry', () =>
    expect(sessions().some((s) => s.url === url && s.repo === fs.realpathSync(repo) && s.dir.endsWith('feat-habit-events'))).toBe(true));
  test('summary gives round and counts without thread text', async () =>
    expect(await (await fetch(url + 'api/summary')).json()).toMatchObject({ round: 1, threads: 0, browserClients: expect.any(Number) }));

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
  test('static route stays inside the review dir', async () => {
    const leak = path.join(repo, '.reviewroom', 'feat-habit-events-leak');
    fs.mkdirSync(leak, { recursive: true });
    fs.writeFileSync(path.join(leak, 'secret.txt'), 'secret');
    expect(await status('..%2ffeat-habit-events-leak%2fsecret.txt')).toBe(404);
  });
  test('state files are not served, a bad escape is a 404', async () =>
    expect(await Promise.all(['state.json', 'STATE.JSON', 'state%2Ejson', 'state.lock', '%E0'].map((f) => status(f)))).toEqual([404, 404, 404, 404, 404]));
  test('a body that is not JSON is a 400', async () => {
    const r = await fetch(url + 'api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect([r.status, (await r.json()).code]).toEqual([400, 'bad_op']);
  });
  test('static file with # and ? in its name is served', async () => {
    fs.writeFileSync(path.join(dir, 'fig #1?.txt'), 'fig');
    const r = await fetch(url + encodeURIComponent('fig #1?.txt'));
    expect([r.status, await r.text()]).toEqual([200, 'fig']);
  });
});
