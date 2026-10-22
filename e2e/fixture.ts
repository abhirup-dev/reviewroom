// End-to-end fixture: the demo repo with a scaffolded review, built once per test process. Each describe calls
// setup() for its own copy, REVIEWROOM_HOME and servers on OS-assigned ports. Run with `bun run smoke` (builds first).
import { afterAll, expect } from 'bun:test';
import { $, type Subprocess } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const entry = path.join(root, 'dist', 'cli', 'reviewroom.js');
const bun = process.execPath; // the CLI runs on the same Bun as the tests
const run = async (env: Record<string, string | undefined>, args: string[], input = '') => {
  const r = await $`${bun} ${entry} ${args} < ${new Response(input)}`.env(env).nothrow().quiet();
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

const template = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-template-'));
process.on('exit', () => fs.rmSync(template, { recursive: true, force: true }));
await $`bash ${path.join(root, 'examples', 'make-demo-repo.sh')} ${path.join(template, 'repo')}`.quiet();
for (const args of [['pr', 'feat/habit-events', '--detach', '--no-open', '--port', '0'], ['stop']]) {
  const r = await run({ ...process.env, REVIEWROOM_HOME: path.join(template, 'home') }, [...args, '--repo', path.join(template, 'repo')]);
  if (r.code) throw new Error(r.stderr);
}

/** Poll until fn returns something truthy (throwing counts as not yet). */
export async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; ; await Bun.sleep(50)) {
    const v = await Promise.resolve().then(fn).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
  }
}
export const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const op = (url: string, o: object) => post(url + 'api/ops', { ops: [o] });
export const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

/** The client build's cache headers and the build id, the same on the review server and the hub (`api`: one of its API paths). */
export async function expectClientHeaders(url: string, api: string) {
  const id = JSON.parse(read(root, 'dist', 'build-info.json')).id;
  const chunk = fs.readdirSync(path.join(root, 'dist', 'chunks'))[0];
  const want: Record<string, string> = {
    [`_rr/chunks/${chunk}`]: 'public, max-age=31536000, immutable',
    '_rr/fonts/inter-latin-opsz-normal.woff2': 'max-age=86400',
    '_rr/reviewroom.js': 'no-cache',
    '_rr/build-info.json': 'no-cache',
    'sw.js': 'no-cache',
    'manifest.webmanifest': 'no-cache',
    '': 'no-cache',
    [api]: 'no-store',
  };
  for (const [p, cache] of Object.entries(want)) {
    const r = await fetch(url + p);
    expect([p, r.status, r.headers.get('cache-control'), r.headers.get('x-reviewroom-build')]).toEqual([p, 200, cache, id]);
    if (p === 'sw.js') expect(r.headers.get('service-worker-allowed')).toBe('/');
    if (p === '') expect(await r.text()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    if (p === 'manifest.webmanifest') {
      expect(r.headers.get('content-type')).toStartWith('application/manifest+json');
      const m = await r.json();
      expect(m).toMatchObject({ name: 'reviewroom', start_url: './', scope: './', display: 'standalone' });
      expect('id' in m).toBe(false); // an id, or a new start_url, orphans installed icons
      for (const i of m.icons) expect((await fetch(new URL(i.src, url + p))).status).toBe(200);
    }
  }
}

export function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-'));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  // the demo repo has no remote: its reviews are keyed by the checkout's name
  const reviews = path.join(home, 'reviews', 'repo');
  const dir = path.join(reviews, 'feat-habit-events');
  const d = ['--repo', repo, '--dir', dir];
  const env = { ...process.env, REVIEWROOM_HOME: home };
  const procs: Subprocess[] = [];
  fs.cpSync(path.join(template, 'repo'), repo, { recursive: true });
  fs.cpSync(path.join(template, 'home', 'reviews'), path.join(home, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...JSON.parse(read(dir, 'config.json')), repoPath: repo }));
  const cli = (args: string[], input?: string) => run(env, args, input);
  afterAll(async () => {
    for (const p of procs) p.kill();
    await cli(['stop', ...d]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return {
    tmp, repo, reviews, dir, d, cli,
    state: () => JSON.parse(read(dir, 'state.json')),
    /** The per-user session registry. */
    sessions: () => fs.readdirSync(path.join(tmp, 'home', 'sessions')).map((f) => JSON.parse(read(tmp, 'home', 'sessions', f))),
    git: (...args: string[]) => $`git -C ${repo} ${args}`.quiet(),
    /** `pr --detach` on a free port: the URL. */
    serve: async () => (await cli(['pr', 'feat/habit-events', '--detach', '--no-open', '--port', '0', '--repo', repo])).stdout.trim(),
    /** A foreground server process (killed in afterAll). */
    spawn: (args: string[]) => procs[procs.push(Bun.spawn([bun, entry, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'] })) - 1],
    /** The URL of the server a foreground command started for a review dir. */
    url: (reviewDir = dir) => until<string>(() => JSON.parse(read(reviewDir, 'server.json')).url),
  };
}
