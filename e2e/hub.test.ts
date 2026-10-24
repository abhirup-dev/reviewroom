// `reviewroom hub` with real review servers: listed with counts, opened from a review, closed, stale records pruned.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { reviewId } from '../cli/hub/hub.ts';
import { expectClientHeaders, op, setup } from './fixture.ts';
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

  test('serves the client with the same cache and build headers as a review', () => expectClientHeaders(hub, 'api/sessions'));

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

  describe('proxy /r/<id>/', () => {
    let r = '';
    beforeAll(async () => {
      const [s] = (await (await fetch(hub + 'api/sessions')).json()).sessions.filter((x: { tool: string }) => x.tool === 'reviewroom');
      r = `${hub}r/${s.reviewId}/`;
    });

    test('serves the review: page with a relative entry, its build, the same state as direct', async () => {
      expect(r).toMatch(/\/r\/[0-9a-f]{12}\/$/);
      const page = await (await fetch(r)).text();
      expect(page).toContain('src="_rr/reviewroom.js"');
      expect(page).not.toContain('"/_rr/reviewroom.js"');
      expect((await fetch(r + '_rr/reviewroom.js')).headers.get('cache-control')).toBe('no-cache');
      expect(await (await fetch(r + 'api/state')).json()).toEqual(await (await fetch(review + 'api/state')).json());
      // the client keys its storage by meta.id: the review id, whichever way it is reached
      expect((await (await fetch(review + 'api/meta')).json()).id).toBe(r.split('/').at(-2));
      expect((await (await fetch(r + 'api/meta')).json()).id).toBe(r.split('/').at(-2));
      const red = await fetch(r.slice(0, -1), { redirect: 'manual' });
      expect([red.status, new URL(red.headers.get('location')!, hub).href]).toEqual([302, r]);
    });

    test("passes the review's cache and build headers through unchanged", () => expectClientHeaders(r, 'api/state'));

    test('the event stream passes through and delivers an op', async () => {
      const ac = new AbortController();
      const res = await fetch(r + 'api/events', { signal: ac.signal });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let seen = '';
      const next = async (want: string) => {
        while (!seen.includes(want)) seen += (await reader.read()).value ?? '';
      };
      await next('event: hello');
      expect((await op(r, { op: 'createThread', id: 't_proxied', anchor: { kind: 'general' }, msgId: 'm_proxied', body: 'via the hub', author: 'you' })).status).toBe(200);
      await next('via the hub');
      expect(seen).toContain('event: state');
      ac.abort();
    });

    test('refuses foreign Host and cross-site writes, through the hub and the proxy', async () => {
      const host = { host: 'evil.com' };
      expect((await fetch(hub, { headers: host })).status).toBe(403);
      expect((await fetch(r + 'api/state', { headers: host })).status).toBe(403);
      const write = (headers: Record<string, string>) => fetch(r + 'api/ops', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ops: [] }) }).then((x) => x.status);
      expect(await write({ origin: 'https://evil.com' })).toBe(403);
      expect(await write({ 'sec-fetch-site': 'cross-site' })).toBe(403);
      expect(await write({ origin: hub.slice(0, -1) })).toBe(200);
      // spellings the review server might route as its API: never past the hub with a foreign Origin
      const odd = await Promise.all(['%61pi/ops', '/api/ops'].map((p) => fetch(r + p, { method: 'POST', headers: { origin: 'https://evil.com', 'content-type': 'application/json' }, body: '{"ops":[]}' }).then((x) => x.status)));
      expect(odd).toEqual([403, 403]);
    });

    test('an unknown id is 404, and only review sessions are reachable', async () => {
      expect((await fetch(`${hub}r/0123456789ab/api/state`)).status).toBe(404);
    });

    test('a session record for a port that is not a reviewroom server is not proxied to', async () => {
      const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not reviewroom') });
      const fake = path.join(tmp, 'not-a-review');
      const file = path.join(tmp, 'home', 'sessions', `${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...sessions()[0], pid: process.pid, port: other.port, url: `http://127.0.0.1:${other.port}/`, dir: fake }));
      try {
        expect((await fetch(`${hub}r/${reviewId(fake)}/`)).status).toBe(404);
        expect(fs.existsSync(file)).toBe(false); // the poll dropped it: nothing answered as that pid
      } finally {
        fs.rmSync(file, { force: true });
        void other.stop(true);
      }
    });
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

describe('hub with a public origin', () => {
  const { tmp, cli, serve } = setup();
  const pub = 'https://mac.tailnet.ts.net';
  let started = { stdout: '', stderr: '' };
  const settings = () => JSON.parse(fs.readFileSync(path.join(tmp, 'home', 'config.json'), 'utf8'));
  let hub = '';
  beforeAll(async () => {
    await serve();
    expect((await cli(['hub', '--public-origin', 'mac.tailnet.ts.net'])).code).toBe(1); // not an origin
    started = await cli(['hub', '--public-origin', pub + '/', '--detach', '--no-open', '--port', '0']);
    hub = started.stdout.trim();
  });
  afterAll(() => cli(['hub', '--stop']));

  test('is saved in ~/.reviewroom/config.json', () => expect(settings()).toEqual({ publicOrigin: pub }));

  test('`--detach` and a second `hub` print the public URL beside the loopback one', async () => {
    expect(started.stderr).toContain(`public: ${pub}/`);
    const again = await cli(['hub', '--no-open']);
    expect(again.stdout.trim()).toBe(hub);
    expect(again.stderr).toContain(`public: ${pub}/`);
  });

  test('a request on the public origin passes, and its writes reach the review', async () => {
    const as = { host: 'mac.tailnet.ts.net', 'sec-fetch-site': 'same-origin' };
    const [s] = (await (await fetch(hub + 'api/sessions', { headers: as })).json()).sessions.filter((x: { tool: string }) => x.tool === 'reviewroom');
    const r = `${hub}r/${s.reviewId}/`;
    expect((await fetch(r, { headers: as })).status).toBe(200);
    const post = (origin: string, ops: unknown[]) => fetch(r + 'api/ops', { method: 'POST', headers: { ...as, origin, 'content-type': 'application/json' }, body: JSON.stringify({ ops }) }).then((x) => x.status);
    expect(await post(pub, [{ op: 'createThread', id: 't_pub', anchor: { kind: 'general' }, msgId: 'm_pub', body: 'from the phone', author: 'you' }])).toBe(200);
    expect(await post('https://evil.com', [])).toBe(403);
    expect((await fetch(hub, { headers: { host: 'other.tailnet.ts.net' } })).status).toBe(403);
    expect((await fetch(hub)).status).toBe(200); // loopback as before
  });

  test('`--public-origin none` clears it', async () => {
    await cli(['hub', '--public-origin', 'none', '--no-open']);
    expect(settings()).toEqual({});
  });
});
