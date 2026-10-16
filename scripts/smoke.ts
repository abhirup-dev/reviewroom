// End-to-end smoke test: demo repo → `reviewroom pr` (detached) → API + bundle respond → state ops,
// rounds and the agent hand-off → stop → file-only writes (lock, corrupt state).
// Run with `mise run smoke` (or `bun scripts/smoke.ts`). Exits non-zero on any failure.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(root, 'dist', 'cli', 'reviewroom.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-smoke-'));
const repo = path.join(tmp, 'repo');
process.env.REVIEWROOM_HOME = path.join(tmp, 'home'); // children inherit it: keep the session registry out of ~
const sessions = () => { try { return fs.readdirSync(path.join(tmp, 'home', 'sessions')).map((f) => JSON.parse(fs.readFileSync(path.join(tmp, 'home', 'sessions', f), 'utf8'))); } catch { return []; } };
const run = (cmd: string, args: string[], opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const node = process.execPath;
const port = String(4900 + Math.floor(Math.random() * 90));
// raw request so crafted Host / Sec-Fetch-Site / Origin headers reach the server untouched
const raw = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
// async CLI run, for concurrency and blocking `review`
const cliAsync = (args: string[], input?: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(node, [cli, ...args]);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('exit', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(input);
  });
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (cond: unknown, msg: string) => {
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
  check(sym.some((h: any) => h.kind === 'definition'), 'symbol search finds the definition');
  const js = await fetch(url + '_rr/reviewroom.js');
  check(js.ok, 'client bundle is served');
  const page = await (await fetch(url)).text();
  check(page.includes('<rr-review>'), 'review page is scaffolded');
  check(sessions().some((s) => s.url === url && s.repo === fs.realpathSync(repo) && s.dir.endsWith('feat-habit-events')), 'a running server is listed in the per-user session registry');
  const sum = await (await fetch(url + 'api/summary')).json();
  check(sum.round === 1 && sum.threads === 0 && typeof sum.browserClients === 'number', 'summary gives round and counts without thread text');

  // security regressions
  const marker = path.join(tmp, 'pwned');
  const inj = await fetch(url + `api/search?rev=worktree&q=${encodeURIComponent('-Otouch ' + marker)}`);
  check(inj.ok && Array.isArray(await inj.json()) && !fs.existsSync(marker), 'search query starting with - is a pattern, not a git option');
  const outBase = await fetch(url + `api/files?base=${encodeURIComponent('--output=' + marker)}`);
  check(!outBase.ok && !fs.existsSync(marker), `files rejects an option as base (${outBase.status})`);
  const outRev = await fetch(url + `api/read?path=x&rev=${encodeURIComponent('--output=' + marker)}`);
  check(!outRev.ok && !fs.existsSync(marker + ':x'), `read rejects an option as rev (${outRev.status})`);
  check((await raw(url + 'api/state', { 'sec-fetch-site': 'cross-site' })) === 403, 'cross-site API request is refused');
  check((await raw(url + 'api/ops', { origin: 'https://evil.example', 'content-type': 'application/json' }, 'POST')) === 403, 'write from a foreign origin is refused');
  check((await raw(url + 'api/meta', { host: `evil.example:${new URL(url).port}` })) === 403, 'foreign Host header is refused');
  check((await raw(url + 'api/meta')) === 200, 'same-machine API request is allowed');
  const leak = path.join(repo, '.reviewroom', 'feat-habit-events-leak');
  fs.mkdirSync(leak, { recursive: true });
  fs.writeFileSync(path.join(leak, 'secret.txt'), 'secret');
  const trav = await fetch(url + '..%2ffeat-habit-events-leak%2fsecret.txt');
  check(trav.status === 403, `static route stays inside the review dir (${trav.status})`);

  // ---- state ops through the running server
  const dir = path.join(repo, '.reviewroom', 'feat-habit-events');
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const d = ['--repo', repo, '--dir', dir];
  check(JSON.parse(fs.readFileSync(path.join(dir, 'state.lock'), 'utf8')).port === +port, 'server holds state.lock');
  const created = await post(url + 'api/ops', { op: 'createThread', id: 't_one', anchor: { kind: 'general' }, msgId: 'm_one', body: 'why?', author: 'you' });
  check(created.ok && (await created.json()).rev >= 1, 'browser op creates a thread');
  // a CLI reply racing a stream of browser ops (spanning the CLI's whole run): everything must land
  const browserOps = async () => {
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push((await post(url + 'api/ops', { op: 'addMessage', threadId: 't_one', id: 'm_b' + i, body: i ? 'b' + i : 'and?', author: 'you' })).status);
    codes.push((await post(url + 'api/ops', { op: 'setViewed', path: 'x.go', viewed: true })).status);
    return codes;
  };
  const [cliReply, codes] = await Promise.all([cliAsync(['reply', 't_one', 'because', ...d]), browserOps()]);
  const s1 = state();
  check(cliReply.code === 0 && codes.every((c) => c === 200) && s1.threads[0].messages.length === 22 && s1.threads[0].messages.some((m: any) => m.body === 'because') && s1.viewed['x.go'] === 1, 'concurrent CLI reply and browser ops all survive');
  check((await post(url + 'api/ops', { op: 'addMessage', threadId: 't_nope', id: 'm', body: 'x', author: 'you' })).status === 404, 'op on an unknown thread is a 404');
  check((await post(url + 'api/ops', { op: 'finishRound', kind: 'feedback' })).status === 400, 'rounds cannot be finished through /api/ops');
  const second = run(node, [cli, 'comment', 'general', 'fyi', ...d]).trim();
  const bulk = await cliAsync(['reply', '--json', '-', ...d], JSON.stringify([{ thread: 't_one', body: 'bulk one' }, { thread: second, body: 'bulk two', resolve: true }]));
  const s2 = state();
  check(bulk.code === 0 && s2.threads[0].messages.at(-1).body === 'bulk one' && s2.threads[1].status === 'resolved', 'reply --json answers several threads');
  const badBulk = await cliAsync(['reply', '--json', '-', ...d], JSON.stringify([{ thread: 't_one', body: 'x' }, { thread: 't_missing', body: 'y' }]));
  check(badBulk.code !== 0 && state().threads[0].messages.length === s2.threads[0].messages.length, 'reply --json is all-or-nothing');

  // ---- finishing a round, nobody waiting: one finish wins, the next `review` hands it over
  const [f1, f2] = await Promise.all([post(url + 'api/finish', { kind: 'feedback', round: 1 }), post(url + 'api/finish', { kind: 'feedback', round: 1 })]);
  check([f1.status, f2.status].sort((a, b) => a - b).join() === '200,409', `double finish: one wins, the other gets 409 (${f1.status}, ${f2.status})`);
  check(state().round === 2 && state().rounds[0].deliveredAt === null, 'round advanced once; feedback not yet delivered');
  const late = await cliAsync(['review', '--no-open', ...d]);
  check(late.code === 0 && late.stdout.includes('t_one') && late.stdout.includes('and?'), 'review prints feedback sent while no agent was waiting');
  check(typeof state().rounds[0].deliveredAt === 'string' && (await fetch(url + 'api/meta')).ok, 'delivery recorded; the running server kept running');
  check(/--dir '[^']*\/\.reviewroom\/feat-habit-events'/.test(late.stdout), 'feedback names the review dir in the commands it asks for'); // git may report the repo via /private/var on macOS

  // ---- bare commands from another branch find the repo's only review; several reviews → ask for --dir
  run('git', ['-C', repo, 'checkout', '-q', 'main']);
  check(run(node, [cli, 'status', '--threads', '--all', '--repo', repo]).includes('t_one'), 'bare `threads` on another branch finds the only review');
  fs.mkdirSync(path.join(repo, '.reviewroom', 'other'));
  fs.writeFileSync(path.join(repo, '.reviewroom', 'other', 'review.html'), '<rr-review></rr-review>');
  const ambiguous = await cliAsync(['status', '--threads', '--repo', repo]);
  check(ambiguous.code !== 0 && ambiguous.stderr.includes('--dir'), 'bare `threads` with several reviews asks for --dir');
  run('git', ['-C', repo, 'checkout', '-q', 'feat/habit-events']);

  const out = run(node, [cli, 'stop', ...d]);
  check(out.startsWith('stopped') && !fs.existsSync(path.join(dir, 'state.lock')), 'stop finds and stops the server and releases the lock');
  check(sessions().length === 0, 'a stopped server leaves the session registry');

  // ---- the blocking round loop: review waits, reviewer comments, agent replies, reviewer sends
  const port2 = String(+port + 1);
  const url2 = `http://127.0.0.1:${port2}/`;
  const waiting = cliAsync(['review', '--no-open', '--port', port2, ...d]);
  for (let i = 0; i < 50 && !(await fetch(url2 + 'api/meta').then((r) => r.ok, () => false)); i++) await sleep(100);
  await post(url2 + 'api/ops', { op: 'createThread', id: 't_loop', anchor: { kind: 'code', path: 'x.go', rev: 'head', start: 1, end: 2 }, msgId: 'm_l1', body: 'rename this', author: 'you' });
  run(node, [cli, 'reply', 't_loop', 'renamed', ...d]);
  await post(url2 + 'api/ops', { op: 'addMessage', threadId: 't_loop', id: 'm_l3', body: 'thanks, one more', author: 'you' });
  check((await post(url2 + 'api/finish', { kind: 'feedback', round: 2 })).ok, 'reviewer sends round 2');
  const loop = await waiting;
  check(loop.code === 0 && loop.stdout.includes('t_loop') && loop.stdout.includes('renamed') && loop.stdout.includes('thanks, one more'), 'blocked review prints the round with the agent reply in it');
  check(fs.readFileSync(path.join(dir, 'rounds', '2', 'feedback.md'), 'utf8').includes('thanks, one more') && typeof state().rounds[1].deliveredAt === 'string', 'feedback.md saved and delivery recorded');

  // ---- no server: CLI writes take the lock, a dead holder's lock is stale
  fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: 999999, port: null }));
  const [c1, c2] = await Promise.all([cliAsync(['comment', 'general', 'one', ...d]), cliAsync(['comment', 'general', 'two', ...d])]);
  const bodies = state().threads.map((t: any) => t.messages[0].body);
  check(c1.code === 0 && c2.code === 0 && bodies.includes('one') && bodies.includes('two') && !fs.existsSync(path.join(dir, 'state.lock')), 'concurrent CLI writes both land (stale lock taken over, then released)');

  // ---- stale links: fingerprint, head moves 2 lines, check reports, --fix heals
  const file = files.find((f: any) => f.status !== 'deleted').path;
  const ref = `rr:code/${file}#L3-4`;
  const reviewFile = path.join(dir, 'review.html');
  fs.writeFileSync(reviewFile, `<rr-review><section id="s"><a href="${ref}">x</a> <a href="rr:sym/RecentEvents">y</a> <a href="rr:doc/nope">z</a></section></rr-review>`);
  const k0 = await cliAsync(['check', ...d]);
  check(k0.code === 1 && k0.stdout.includes('rr:doc/nope') && typeof state().links[ref] === 'string', 'check fingerprints a new link and reports a broken section link');
  fs.writeFileSync(reviewFile, fs.readFileSync(reviewFile, 'utf8').replace(' <a href="rr:doc/nope">z</a>', ''));
  const src = path.join(repo, file);
  fs.writeFileSync(src, 'added 1\nadded 2\n' + fs.readFileSync(src, 'utf8'));
  run('git', ['-C', repo, 'commit', '-qam', 'shift']);
  const k1 = await cliAsync(['check', ...d]);
  check(k1.code === 1 && k1.stdout.includes('moved') && k1.stdout.includes('#L5-6'), 'check reports a link whose code moved');
  const k2 = await cliAsync(['check', '--fix', ...d]);
  check(k2.code === 0 && fs.readFileSync(reviewFile, 'utf8').includes(`rr:code/${file}#L5-6"`) && Object.keys(state().links).join() === `rr:code/${file}#L5-6,rr:sym/RecentEvents`, 'check --fix rewrites the moved link and re-fingerprints it');

  // the server fingerprints a link added after a commit against the new head, not the one it started on
  const port3 = String(+port + 2);
  const srv = spawn(node, [cli, 'review', '--forever', '--no-open', '--port', port3, ...d], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port3}/api/meta`).then((r) => r.ok, () => false)); i++) await sleep(100);
  fs.writeFileSync(src, 'added 3\n' + fs.readFileSync(src, 'utf8'));
  run('git', ['-C', repo, 'commit', '-qam', 'shift again']);
  fs.writeFileSync(reviewFile, `<rr-review><a href="rr:code/${file}#L6-7">x</a></rr-review>`);
  await sleep(500);
  const k3 = await cliAsync(['check', ...d]);
  srv.kill();
  await sleep(200);
  check(k3.code === 0 && !k3.stdout.includes('moved'), 'a running server fingerprints new links at the current head');

  // ---- CLI surface: strict flags, resolve without a body, pr without a target
  const typo = await cliAsync(['status', '--jsn', ...d]);
  check(typo.code === 2 && typo.stderr.includes('--jsn'), 'an unknown flag is an error (exit 2)');
  const rs = await cliAsync(['reply', 't_one', '--resolve', ...d]);
  check(rs.code === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).threads.find((t: any) => t.id === 't_one').status === 'resolved', 'reply --resolve without a body resolves the thread');
  const local = path.join(tmp, 'local-review');
  const lp = spawn(node, [cli, 'pr', '--base', 'main', '--head', 'feat/habit-events', '--no-open', '--port', String(+port + 3), '--repo', repo, '--dir', local], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(local, 'server.json')); i++) await sleep(100);
  check(fs.existsSync(path.join(local, 'review.html')) && JSON.parse(fs.readFileSync(path.join(local, 'config.json'), 'utf8')).head === 'feat/habit-events', 'pr without a target scaffolds from --base/--head and serves');
  lp.kill();
  await sleep(200);

  // ---- a corrupt state.json is kept aside, never replaced by an empty review
  fs.writeFileSync(path.join(dir, 'state.json'), '{"threads": [ broken');
  const bad = await cliAsync(['reply', 't_one', 'x', ...d]);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  check(bad.code !== 0 && /not valid JSON/.test(bad.stderr) && kept.length === 1 && fs.readFileSync(path.join(dir, kept[0]), 'utf8').includes('broken') && !fs.existsSync(path.join(dir, 'state.json')), 'corrupt state.json is preserved as .corrupt-* and not overwritten');
  // ---- so is one that parses but breaks the schema
  for (const f of kept) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, round: 'two', rounds: [], threads: [] }));
  const wrong = await cliAsync(['reply', 't_one', 'x', ...d]);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  check(wrong.code !== 0 && /does not match schema.*round/.test(wrong.stderr) && aside.length === 1 && !fs.existsSync(path.join(dir, 'state.json')), 'a state.json that breaks the schema is preserved as .corrupt-* with the reason');
  const again = await cliAsync(['comment', 'general', 'after', ...d]);
  check(again.code !== 0 && /moved aside/.test(again.stderr) && !fs.existsSync(path.join(dir, 'state.json')), 'after a state.json is moved aside, writes stay blocked instead of starting an empty review');
} catch (e) {
  console.error((e as any).stderr || (e as Error).message);
  process.exitCode = 1;
} finally {
  try {
    run(node, [cli, 'stop', '--repo', repo, '--dir', path.join(repo, '.reviewroom', 'feat-habit-events')]);
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
