// The hub against real registries in temp dirs and real processes (sleepers stand in for Crit/Plannotator servers).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from './hub.ts';
import { hubApp } from './server.ts';
import { agentAncestor, lsofCwd, runCapture } from './proc.ts';
import { readCritRaw, readPlanRaw, readReviewroom, resolvePlannotatorDataDir } from './sources.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-hub-'));
const children: Bun.Subprocess[] = [];
const sleeper = (cwd?: string) => children[children.push(Bun.spawn(['sleep', '30'], { cwd, stdio: ['ignore', 'ignore', 'ignore'] })) - 1];
const write = (dir: string, name: string, body: unknown) => {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body));
};
const home = process.env.REVIEWROOM_HOME;
afterAll(() => {
  for (const c of children) c.kill();
  process.env.REVIEWROOM_HOME = home;
});
let rrHome = '';
beforeEach(() => (process.env.REVIEWROOM_HOME = rrHome = tmp())); // never the real ~/.reviewroom

describe('registries', () => {
  test('crit: the verified schema; junk files and bad types degrade', () => {
    const dir = tmp();
    write(dir, 'abc123def456.json', { pid: 123, port: 49171, host: '127.0.0.1', public_url: 'http://localhost:49171/p', cwd: '/tmp/repo', args: ['preview', '/tmp/x.html'], branch: 'main', review_path: '/r', started_at: '2026-08-19T06:59:38.771342Z' });
    write(dir, 'ffffffffffff.json', { pid: '123', port: null, cwd: 42, args: 'nope', host: 7 });
    write(dir, 'badbadbad000.json', '{not json');
    write(dir, 'abc123def456.log', 'log');
    write(dir, 'README.md', '{}');
    const byKey = Object.fromEntries(readCritRaw(dir).map((e) => [e.key, e]));
    expect(Object.keys(byKey).sort()).toEqual(['abc123def456', 'ffffffffffff']);
    expect(byKey.abc123def456).toMatchObject({ pid: 123, port: 49171, publicUrl: 'http://localhost:49171/p', args: ['preview', '/tmp/x.html'], startedAt: '2026-08-19T06:59:38.771Z' });
    expect(byKey.ffffffffffff).toMatchObject({ pid: null, port: null, cwd: null, args: [], host: '' });
    expect(readCritRaw(path.join(dir, 'nope'))).toEqual([]);
  });

  test('plannotator: the verified schema; the file name gives the pid when the body does not', () => {
    const dir = tmp();
    write(dir, '45678.json', { pid: 45678, port: 51723, url: 'http://localhost:51723', mode: 'plan', project: 'p', startedAt: '2026-08-20T10:15:30.000Z', label: 'plan-plan.md' });
    write(dir, '999.json', { pid: 'x', port: 1, url: null });
    write(dir, 'corrupt.json', ']]]');
    expect(readPlanRaw(dir).map((e) => [e.pid, e.mode]).sort((a, b) => Number(b[0]) - Number(a[0]))).toEqual([[45678, 'plan'], [999, null]]);
  });

  test('plannotator data dir: env, then ~/.plannotator, then an absolute XDG dir', () => {
    const none = () => false;
    expect(resolvePlannotatorDataDir({ PLANNOTATOR_DATA_DIR: '/x/y' }, '/h', none)).toBe('/x/y');
    expect(resolvePlannotatorDataDir({ XDG_DATA_HOME: '/xdg' }, '/h', (p) => p === '/h/.plannotator')).toBe('/h/.plannotator');
    expect(resolvePlannotatorDataDir({ XDG_DATA_HOME: '/xdg' }, '/h', none)).toBe('/xdg/plannotator');
    expect(resolvePlannotatorDataDir({ XDG_DATA_HOME: 'rel' }, '/h', none)).toBe('/h/.plannotator');
  });

  test('reviewroom: records under REVIEWROOM_HOME, URL rebuilt from the port, junk skipped', () => {
    write(rrHome, '321.json', { pid: 321, port: 4848, url: 'https://evil.example/', repo: '/r', dir: '/r/.reviewroom/feat', title: null, number: 7, head: 'worktree', mode: 'serve', agent: { name: 'codex', pid: 9 } });
    write(rrHome, '322.json', { pid: 999, port: 4849 }); // pid does not match the file
    write(rrHome, '323.json', '{not json');
    const [r, ...rest] = readReviewroom();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ pid: 321, url: 'http://127.0.0.1:4848/', repo: '/r', number: 7, mode: 'serve', agent: { name: 'codex', pid: 9 } });
  });
});

describe('poll', () => {
  test('Crit and Plannotator: live ones listed (down ones marked), dead ones hidden, remote URLs never linked', async () => {
    const critHome = tmp(), planDir = tmp(), cwd = tmp();
    write(critHome, 'aaaa11112222.json', { pid: process.pid, port: 1, host: '127.0.0.1', cwd, args: ['preview', '/tmp/x.html'], branch: 'from-registry', started_at: '2026-08-19T06:59:38.771342Z' });
    write(critHome, 'deaddeaddead.json', { pid: 4194304, port: 2, host: '', cwd: '/tmp', args: [] });
    write(critHome, 'bbbb33334444.json', { pid: process.pid, port: 8443, host: '0.0.0.0', args: [] });
    const good = sleeper(cwd), remote = sleeper(cwd);
    write(planDir, `${good.pid}.json`, { pid: good.pid, port: 1, url: 'http://localhost:1', mode: 'annotate', project: 'probe', label: 'annotate-d.md' });
    write(planDir, `${remote.pid}.json`, { pid: remote.pid, port: 443, url: 'https://tunnel.example.com/abc', mode: 'review' });
    const hub = new Hub({ critHome, plannotatorDataDir: planDir, healthTimeoutMs: 250 });
    const byId = async () => Object.fromEntries((await hub.poll()).map((s) => [s.id, s]));

    let s = await byId();
    expect(Object.keys(s).sort()).toEqual(['crit:aaaa11112222', 'crit:bbbb33334444', `plannotator:${good.pid}`, `plannotator:${remote.pid}`].sort());
    expect(s['crit:aaaa11112222']).toMatchObject({ url: 'http://localhost:1/preview', health: 'unreachable', mode: 'preview', branch: 'from-registry', startedAt: '2026-08-19T06:59:38.771Z' });
    expect(s['crit:bbbb33334444']).toMatchObject({ url: null, health: 'unknown' });
    expect(s['crit:bbbb33334444'].urlNote).toContain('non-loopback');
    expect(s[`plannotator:${good.pid}`]).toMatchObject({ url: 'http://localhost:1/', cwd: fs.realpathSync(cwd), project: 'probe', health: 'unreachable' });
    expect(s[`plannotator:${remote.pid}`].url).toBeNull();
    expect(fs.existsSync(path.join(critHome, 'sessions', 'deaddeaddead.json'))).toBe(true); // another tool's file: never deleted

    const firstSeen = s['crit:aaaa11112222'].firstSeenAt;
    good.kill();
    await good.exited;
    s = await byId();
    expect(s[`plannotator:${good.pid}`]).toBeUndefined();
    expect(s['crit:aaaa11112222'].firstSeenAt).toBe(firstSeen);
  });

  test('reviewroom: listed while its server answers with its pid, with counts; a dead record is deleted', async () => {
    const repo = tmp();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ round: 2, threads: 5, open: 2, browserClients: 1 }, { headers: { 'x-reviewroom-pid': String(process.pid) } }) });
    const dead = sleeper();
    write(rrHome, `${process.pid}.json`, { pid: process.pid, port: server.port, repo, dir: path.join(repo, '.reviewroom', 'pr-42'), title: 'Habit events', number: 42, head: 'refs/reviewroom/pr-42', mode: 'review', agent: { name: 'claude-code', pid: 77 } });
    const alsoLive = sleeper(); // answers as itself, with a body that is not JSON: kept
    const garbled = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('{not json', { headers: { 'x-reviewroom-pid': String(alsoLive.pid) } }) });
    write(rrHome, `${alsoLive.pid}.json`, { pid: alsoLive.pid, port: garbled.port, repo, dir: repo, head: 'main', mode: 'serve' });
    write(rrHome, `${dead.pid}.json`, { pid: dead.pid, port: 1, repo, dir: repo, head: 'main', mode: 'serve' }); // alive pid, no server: stale
    const sessions = Object.fromEntries((await new Hub({ critHome: tmp(), plannotatorDataDir: tmp(), healthTimeoutMs: 500 }).poll()).map((x) => [x.id, x]));
    void server.stop(true);
    void garbled.stop(true);
    expect(Object.keys(sessions).sort()).toEqual([`reviewroom:${process.pid}`, `reviewroom:${alsoLive.pid}`].sort());
    expect(sessions[`reviewroom:${process.pid}`]).toMatchObject({ kind: 'pull-request-review', target: '#42', label: 'Habit events', health: 'ok', reviewRound: 2, commentCount: 5, unresolvedCommentCount: 2, resolvedCommentCount: 3, browserClients: 1, origin: 'claude-code', parentAgentPid: 77 });
    expect(sessions[`reviewroom:${alsoLive.pid}`]).toMatchObject({ health: 'ok', commentCount: null });
    expect(fs.existsSync(path.join(rrHome, 'sessions', `${dead.pid}.json`))).toBe(false);
  });
});

describe('server', () => {
  test('page, JSON, guard, and close only with the header and only a discovered session', async () => {
    const planDir = tmp();
    const child = Bun.spawn(['bash', '-c', 'exec -a plannotator sleep 30'], { stdio: ['ignore', 'ignore', 'ignore'] }); // reads as plannotator in ps
    children.push(child);
    const impostor = sleeper(); // a reused pid: not plannotator any more
    write(planDir, `${impostor.pid}.json`, { pid: impostor.pid, port: 49124, url: 'http://localhost:49124', mode: 'review' });
    write(planDir, `${child.pid}.json`, { pid: child.pid, port: 49123, url: 'http://localhost:49123', mode: 'review' });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: hubApp(new Hub({ critHome: tmp(), plannotatorDataDir: planDir, healthTimeoutMs: 20 })).fetch });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await (await fetch(base)).text()).toContain('/_rr/hub.js');
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health).toMatchObject({ status: 'ok', sessionCounts: { crit: 0, plannotator: 2, reviewroom: 0 } });
      expect(health.compatibility.crit.verifiedAgainst).toBe('0.19.0');
      const sessions = await fetch(`${base}/api/sessions`);
      expect(sessions.headers.get('cache-control')).toContain('no-store');
      expect((await sessions.json()).count).toBe(2);
      expect((await fetch(`${base}/api/nope`)).status).toBe(404);
      expect((await fetch(`${base}/api/sessions`, { headers: { host: 'evil.example' } })).status).toBe(403); // DNS rebinding

      const close = (id: string, headers: Record<string, string> = { 'x-reviewroom-action': 'close-session' }) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/close`, { method: 'POST', headers });
      expect((await close(`plannotator:${child.pid}`, {})).status).toBe(403);
      expect(child.exitCode).toBeNull();
      expect((await close(`plannotator:${child.pid}`, { 'x-reviewroom-action': 'close-session', origin: 'http://evil.example' })).status).toBe(403);
      const closed = await close(`plannotator:${child.pid}`);
      expect(closed.status).toBe(202);
      await child.exited;
      expect((await close('plannotator:999999')).status).toBe(404);
      expect((await close(`plannotator:${impostor.pid}`)).status).toBe(409);
      expect(impostor.exitCode).toBeNull();
    } finally {
      void server.stop(true);
    }
  });
});

describe('processes', () => {
  test('runCapture never throws', async () => {
    expect(await runCapture(['echo', 'hi'])).toEqual({ ok: true, stdout: 'hi\n' });
    expect((await runCapture(['false'])).ok).toBe(false);
    expect(await runCapture(['definitely-not-a-binary-xyz'])).toEqual({ ok: false, stdout: '' });
  });
  test('lsofCwd finds a child cwd, null once it is gone', async () => {
    const dir = tmp();
    const child = sleeper(dir);
    expect(await lsofCwd(child.pid)).toBe(fs.realpathSync(dir));
    child.kill();
    await child.exited;
    expect(await lsofCwd(child.pid)).toBeNull();
  });
  test('agentAncestor: an agent or null, never a throw', async () => {
    const a = await agentAncestor(process.pid);
    expect(a === null || (typeof a.name === 'string' && a.pid > 1)).toBe(true);
    expect(await agentAncestor(1)).toBeNull();
  });
});
