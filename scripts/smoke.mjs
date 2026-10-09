// End-to-end smoke test: demo repo → `readingroom pr` (detached) → API + bundle respond → stop.
// Run with `mise run smoke` (or `bun scripts/smoke.mjs`). Exits non-zero on any failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(root, 'cli', 'readingroom.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-smoke-'));
const repo = path.join(tmp, 'repo');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const node = process.execPath;
const port = String(4900 + Math.floor(Math.random() * 90));
// raw request so crafted Host / Sec-Fetch-Site / Origin headers reach the server untouched
const raw = (url, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
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

  // security regressions
  const marker = path.join(tmp, 'pwned');
  const inj = await fetch(url + `api/search?rev=worktree&q=${encodeURIComponent('-Otouch ' + marker)}`);
  check(inj.ok && Array.isArray(await inj.json()) && !fs.existsSync(marker), 'search query starting with - is a pattern, not a git option');
  const outBase = await fetch(url + `api/files?base=${encodeURIComponent('--output=' + marker)}`);
  check(!outBase.ok && !fs.existsSync(marker), `files rejects an option as base (${outBase.status})`);
  const outRev = await fetch(url + `api/read?path=x&rev=${encodeURIComponent('--output=' + marker)}`);
  check(!outRev.ok && !fs.existsSync(marker + ':x'), `read rejects an option as rev (${outRev.status})`);
  check((await raw(url + 'api/state', { 'sec-fetch-site': 'cross-site' })) === 403, 'cross-site API request is refused');
  check((await raw(url + 'api/state', { origin: 'https://evil.example', 'content-type': 'application/json' }, 'PUT')) === 403, 'write from a foreign origin is refused');
  check((await raw(url + 'api/meta', { host: `evil.example:${new URL(url).port}` })) === 403, 'foreign Host header is refused');
  check((await raw(url + 'api/meta')) === 200, 'same-machine API request is allowed');
  const leak = path.join(repo, '.readingroom', 'feat-habit-events-leak');
  fs.mkdirSync(leak, { recursive: true });
  fs.writeFileSync(path.join(leak, 'secret.txt'), 'secret');
  const trav = await fetch(url + '..%2ffeat-habit-events-leak%2fsecret.txt');
  check(trav.status === 403, `static route stays inside the review dir (${trav.status})`);
} catch (e) {
  console.error(e.stderr || e.message);
  process.exitCode = 1;
} finally {
  try {
    const out = run(node, [cli, 'stop', '--repo', repo, '--dir', path.join(repo, '.readingroom', 'feat-habit-events')]);
    check(out.startsWith('stopped'), 'stop finds and stops the server');
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
