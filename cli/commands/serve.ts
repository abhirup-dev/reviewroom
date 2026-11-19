import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type Global, fail } from '../lib/args.ts';
import { loadConfig, readConfig, configPath } from '../lib/config.ts';
import { readState, commitOps } from '../lib/state.ts';
import { answers, takeLock, releaseLock } from '../lib/lock.ts';
import { undelivered } from '../../src/kernel/state/ops.shared.ts';
import { startServer, listen, openBrowser } from '../lib/server.ts';
import { DIST, PKG } from '../lib/paths.ts';
import { type ServerRecord, liveServer, serverFile, register, unregister } from '../lib/registry.ts';
import { agentAncestor } from '../hub/proc.ts';
import { branchPr } from '../lib/github.ts';

export type StartOpts = Global & { port?: string; open: boolean; browser?: boolean; foreground?: boolean };

export async function runningServer(dir: string) {
  const rec = liveServer(dir);
  // A recorded process that is busy can time out. A different process on that port is stale.
  return rec && (await answers(rec.pid, rec.port)) !== false ? rec : null;
}

export async function ensureServer(repo: string | null, dir: string, o: StartOpts): Promise<ServerRecord> {
  const live = await runningServer(dir);
  if (live) return live;
  if (!repo) fail('not inside a git repository (use --repo <path>)');
  fs.mkdirSync(dir, { recursive: true });
  const args = [process.argv[1], 'start', '--foreground', '--repo', repo, '--dir', dir];
  if (o.port) args.push('--port', o.port);
  if (!o.open) args.push('--no-open');
  if (o.browser) args.push('--browser');
  const log = path.join(dir, 'server.log');
  const deadline = performance.now() + 60_000; // includes PR discovery and the initial report check
  const out = fs.openSync(log, 'a');
  let error: Error | undefined;
  let child;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
    child.once('error', (e) => { error = e; });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  while (performance.now() < deadline) {
    const rec = await runningServer(dir);
    if (rec) return rec;
    if (error || child.exitCode !== null || child.signalCode !== null) {
      fail(`server exited during startup${error ? `: ${error.message}` : ''} - see ${log}`);
    }
    await Bun.sleep(100);
  }
  fail(`server did not start - see ${log}`);
}

export async function cmdStart(repo: string | null, dir: string, o: StartOpts) {
  const rec = o.foreground ? await serve(repo, dir, o) : await ensureServer(repo, dir, o);
  if (rec) console.log(rec.url);
}

export async function cmdWait(repo: string | null, dir: string, o: StartOpts) {
  const { id } = readConfig(dir);
  const { url } = await ensureServer(repo, dir, o);
  console.error(`reviewroom: waiting for feedback | ${dir} | ${url}`);
  for (;; await Bun.sleep(500)) {
    const [round] = undelivered(readState(dir, { repair: false }));
    if (!round) continue;
    if (readConfig(dir).id !== id) fail(`review ID changed in ${dir} while waiting`);
    const file = path.join(dir, 'rounds', String(round.n), 'feedback.md');
    const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `(round ${round.n} was ${round.status} but ${file} is missing)`;
    // Record delivery only after stdout flushes. On interruption, a retry can print the round again.
    await new Promise<void>((resolve, reject) => process.stdout.write(md + '\n', (e) => e ? reject(e) : resolve()));
    await commitOps(dir, [{ op: 'markDelivered', round: round.n }]);
    console.error(`reviewroom: round ${round.n} ${round.status === 'approved' ? 'approved' : 'feedback saved'} -> ${file}`);
    return;
  }
}

async function serve(repo: string | null, dir: string, o: StartOpts) {
  const live = await runningServer(dir);
  if (live) return live;
  if (!repo) fail('not inside a git repository (use --repo <path>)');
  const cfg = loadConfig(dir, repo);
  fs.mkdirSync(dir, { recursive: true });
  // a branch review whose branch has an open PR is that PR's review: its description, conversation and CI come along
  const pr = branchPr(repo, cfg);
  if (pr) {
    Object.assign(cfg, pr);
    console.error(`reviewroom: ${pr.url} is open for this branch: showing its description, comments and CI`);
  }
  if (!fs.existsSync(path.join(DIST, 'reviewroom.js'))) fail(`missing build at ${DIST} - run \`bun run build\` in ${PKG}`);
  const agent = await agentAncestor(process.pid); // before the detached child's parent sees server.json and exits
  let seen = false; // a page (browser or app tab) connected
  const { app, watch, close } = startServer({ repo, dir, cfg, onClient: () => (seen = true) });
  const server = listen(app, +(o.port || 4848));
  const port = server.port!;
  const url = `http://127.0.0.1:${port}/`;
  const holder = await takeLock(dir, port);
  if (holder) {
    await server.stop(true);
    await close();
    return liveServer(dir);
  }
  const cleanup = () => {
    unregister(process.pid);
    try {
      if (JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')).pid === process.pid) fs.unlinkSync(serverFile(dir));
    } catch {}
    releaseLock(dir);
  };
  process.on('exit', cleanup);
  if (!fs.existsSync(configPath(dir)) || pr) fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
  // the assistant stops its turn, saves its session and ends its processes; a stop that hangs, or a second signal, exits
  // anyway, first ending its assistant's bridge (which ends the native agent under it; not a hub this server started):
  // only a crash leaves them running
  const shutdown = () => Promise.race([Promise.resolve(close()).catch((e: unknown) => console.error(`reviewroom: assistant cleanup failed: ${(e as Error).message}`)), Bun.sleep(8000)]);
  const exit = () => {
    Bun.spawnSync(['pkill', '-TERM', '-P', String(process.pid), '-f', 'bridge\\.mjs']);
    process.exit(0);
  };
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
    if (stopping) exit();
    stopping = true;
    void shutdown().finally(exit);
  });
  const s = readState(dir);
  watch();
  const rec = { pid: process.pid, port, url, startedAt: new Date().toISOString() };
  register({ ...rec, repo, dir, title: cfg.title ?? null, number: cfg.number ?? null, prUrl: cfg.url ?? null, base: cfg.base, head: cfg.head, mode: 'serve', agent, author: cfg.number ? (cfg.author ?? null) : null });
  fs.writeFileSync(serverFile(dir), JSON.stringify(rec));
  console.error(`reviewroom: ${path.relative(process.cwd(), dir) || '.'} | round ${s.round} | ${url}`);
  if (o.open) {
    // a tab from a previous server reconnects on its own; open one if nobody shows up
    setTimeout(() => !seen && openBrowser(url, !o.browser), 2500);
  }
  return rec;
}
