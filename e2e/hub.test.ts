// `reviewroom hub` with real review servers: listed with counts, opened from a review, closed, stale records pruned.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture.ts';
import { until } from '../src/testing/wait.ts';

describe('hub', () => {
  const { tmp, dir, d, cli, serve, spawn, url, sessions } = setup();
  let review = '', hub = '';
  const list = async () => (await (await fetch(hub + 'api/sessions')).json()).sessions as { id: string; tool: string; label: string; reviewRound: number; commentCount: number; health: string }[];
  beforeAll(async () => {
    review = await serve();
    await cli(['comment', 'general', 'why?', ...d]);
    hub = (await cli(['hub', '--detach', '--no-open', '--port', '0'])).stdout.trim();
  });
  afterAll(() => cli(['hub', '--stop']));

  test('`hub --detach` prints the URL; a second `hub` points at the same one', async () => {
    expect(hub).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect((await cli(['hub', '--no-open'])).stdout.trim()).toBe(hub);
    expect(await (await fetch(hub)).text()).toContain('/_rr/hub.js');
    expect((await fetch(hub + '_rr/hub.css')).status).toBe(200);
  });

  test('lists the running review with its round and threads', async () => {
    const [s] = (await list()).filter((x) => x.tool === 'reviewroom');
    expect(s).toMatchObject({ reviewRound: 1, commentCount: 1, health: 'ok' });
  });

  test("a review's /api/hub redirects to the hub", async () => {
    const r = await fetch(review + 'api/hub', { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([302, hub]);
  });

  test('a server killed without cleanup is dropped and its record deleted', async () => {
    const other = path.join(path.dirname(dir), 'other');
    const p = spawn(['review', '--forever', '--no-open', '--port', '0', ...d.slice(0, 2), '--dir', other]);
    await url(other);
    expect(sessions().map((s) => s.pid)).toContain(p.pid);
    p.kill('SIGKILL');
    await p.exited;
    await until(async () => !(await list()).some((s) => s.id === `reviewroom:${p.pid}`) && !fs.existsSync(path.join(tmp, 'home', 'sessions', `${p.pid}.json`)));
  });

  test('closing a review from the hub stops its server', async () => {
    const [s] = (await list()).filter((x) => x.tool === 'reviewroom');
    const r = await fetch(`${hub}api/sessions/${encodeURIComponent(s.id)}/close`, { method: 'POST', headers: { 'x-reviewroom-action': 'close-session' } });
    expect(r.status).toBe(202);
    expect(fs.existsSync(path.join(dir, 'server.json'))).toBe(false);
    expect((await list()).filter((x) => x.tool === 'reviewroom')).toEqual([]);
  });

  test('two hubs started at once: both print the one that runs', async () => {
    await cli(['hub', '--stop']);
    await until(() => !fs.existsSync(path.join(tmp, 'home', 'hub.json')));
    const [a, b] = await Promise.all([cli(['hub', '--detach', '--no-open', '--port', '0']), cli(['hub', '--detach', '--no-open', '--port', '0'])]);
    expect(a.stdout.trim()).toMatch(/^http:/);
    expect(b.stdout.trim()).toBe(a.stdout.trim());
    hub = a.stdout.trim();
    expect((await fetch(hub + 'api/health')).ok).toBe(true);
  });

  test('`hub --stop` stops it', async () => {
    expect((await cli(['hub', '--stop'])).stdout).toStartWith('stopped');
    await until(() => !fs.existsSync(path.join(tmp, 'home', 'hub.json')));
  });
});
