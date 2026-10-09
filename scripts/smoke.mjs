// End-to-end smoke test: demo repo → `readingroom pr` (detached) → API + bundle respond → stop.
// Run with `mise run smoke` (or `bun scripts/smoke.mjs`). Exits non-zero on any failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(root, 'cli', 'readingroom.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-smoke-'));
const repo = path.join(tmp, 'repo');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const node = process.execPath;
const port = String(4900 + Math.floor(Math.random() * 90));
const check = (cond, msg) => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exitCode = 1;
  } else console.log('✓ ' + msg);
};

try {
  run('bash', [path.join(root, 'examples', 'make-demo-repo.sh'), repo]);
  const url = run(node, [cli, 'pr', 'feat/habit-events', '--repo', repo, '--detach', '--no-open', '--port', port]).trim();
  check(url.startsWith('http://127.0.0.1:'), `server up at ${url}`);
  const files = await (await fetch(url + 'api/files')).json();
  check(files.length === 5, `diff has ${files.length} files`);
  const sym = await (await fetch(url + 'api/search?symbol=1&q=RecentEvents&rev=feat/habit-events')).json();
  check(sym.some((h) => h.kind === 'definition'), 'symbol search finds the definition');
  const js = await fetch(url + '_rr/readingroom.js');
  check(js.ok, 'client bundle is served');
  const page = await (await fetch(url)).text();
  check(page.includes('<rr-review>'), 'review page is scaffolded');
} catch (e) {
  console.error(e.stderr || e.message);
  process.exitCode = 1;
} finally {
  try {
    run(node, [cli, 'stop', '--repo', repo, '--dir', path.join(repo, '.readingroom', 'feat-habit-events')]);
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
