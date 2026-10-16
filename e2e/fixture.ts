// End-to-end fixture: the demo repo with a scaffolded review, built once per test process. Each describe calls
// setup() for its own copy, REVIEWROOM_HOME and servers on OS-assigned ports. Run with `bun run smoke` (builds first).
import { afterAll } from 'bun:test';
import { $, type Subprocess } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const entry = path.join(root, 'dist', 'cli', 'reviewroom.mjs');
const node = Bun.which('node') ?? 'node'; // the CLI's runtime is Node, not the Bun running the tests
const run = async (env: Record<string, string | undefined>, args: string[], input = '') => {
  const r = await $`${node} ${entry} ${args} < ${new Response(input)}`.env(env).nothrow().quiet();
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

export function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-'));
  const repo = path.join(tmp, 'repo');
  const dir = path.join(repo, '.reviewroom', 'feat-habit-events');
  const d = ['--repo', repo, '--dir', dir];
  const env = { ...process.env, REVIEWROOM_HOME: path.join(tmp, 'home') };
  const procs: Subprocess[] = [];
  fs.cpSync(path.join(template, 'repo'), repo, { recursive: true });
  const cli = (args: string[], input?: string) => run(env, args, input);
  afterAll(async () => {
    for (const p of procs) p.kill();
    await cli(['stop', ...d]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return {
    tmp, repo, dir, d, cli,
    state: () => JSON.parse(read(dir, 'state.json')),
    /** The per-user session registry. */
    sessions: () => fs.readdirSync(path.join(tmp, 'home', 'sessions')).map((f) => JSON.parse(read(tmp, 'home', 'sessions', f))),
    git: (...args: string[]) => $`git -C ${repo} ${args}`.quiet(),
    /** `pr --detach` on a free port: the URL. */
    serve: async () => (await cli(['pr', 'feat/habit-events', '--detach', '--no-open', '--port', '0', '--repo', repo])).stdout.trim(),
    /** A foreground server process (killed in afterAll). */
    spawn: (args: string[]) => procs[procs.push(Bun.spawn([node, entry, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'] })) - 1],
    /** The URL of the server a foreground command started for a review dir. */
    url: (reviewDir = dir) => until<string>(() => JSON.parse(read(reviewDir, 'server.json')).url),
  };
}
