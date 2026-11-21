import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { loadConfig, readConfig, shellArg } from '../lib/config.ts';
import { readState, commitOps } from '../lib/state.ts';
import { reapAssistantGroup } from '../lib/assistant-process.ts';
import { stopAssistantWork } from '../lib/progress.ts';
import { takeLock, releaseLock } from '../lib/lock.ts';
import { undelivered } from '../../src/kernel/state/ops.shared.ts';
import { startServer, listen, openBrowser } from '../lib/server.ts';
import { DIST, PKG } from '../lib/paths.ts';
import { type ServerRecord, closedFile, liveServer, serverFile, register, runningServer, startDetached, unregister } from '../lib/registry.ts';
import { agentAncestor } from '../hub/proc.ts';

export { runningServer };

export type StartOpts = Global & { port?: string; open: boolean; browser?: boolean; foreground?: boolean; timeout?: string };

export async function ensureServer(repo: string | null, dir: string, o: StartOpts): Promise<ServerRecord> {
  const live = await runningServer(dir);
  if (live) return live;
  if (!repo) fail('not inside a git repository (use --repo <path>)');
  const args = [];
  if (o.port) args.push('--port', o.port);
  if (!o.open) args.push('--no-open');
  if (o.browser) args.push('--browser');
  return (await startDetached(repo, dir, args)).server;
}

export async function cmdStart(repo: string | null, dir: string, o: StartOpts) {
  const rec = o.foreground ? await serve(repo, dir, o) : await ensureServer(repo, dir, o);
  if (rec) console.log(rec.url);
}

export async function cmdWait(repo: string | null, dir: string, o: StartOpts) {
  const { id } = readConfig(dir);
  const minutes = o.timeout === undefined ? Infinity : Number(o.timeout);
  if (!(minutes > 0)) fail(`--timeout takes a number of minutes above 0, not \`${o.timeout}\``, 2);
  const deadline = Date.now() + minutes * 60_000;
  const { url } = await ensureServer(repo, dir, o);
  console.error(`reviewroom: waiting for feedback | ${dir} | ${url}`);
  for (;; await Bun.sleep(500)) {
    const [round] = undelivered(readState(dir, { repair: false }));
    if (!round) {
      // closed on purpose (`stop`, the hub's Close): no round can come; a crashed server leaves no marker, so keep waiting
      if (fs.existsSync(closedFile(dir)) && !liveServer(dir)) {
        const msg = `REVIEW CLOSED: the review's server was stopped (\`reviewroom stop\` or the hub's Close), so no feedback will come.\nhelp:\n  Tell the reviewer; run \`reviewroom wait ${shellArg(id ?? dir)}\` again only if they ask (it reopens the review)\n`;
        await new Promise<void>((resolve) => process.stdout.write(msg, () => resolve()));
        process.exit(3);
      }
      // the agent's own limit, under its shell's: a definite answer instead of a killed call
      if (Date.now() > deadline) {
        console.log(`no round yet after ${o.timeout} min (no-op): the reviewer is still reviewing\nhelp:\n  Run \`reviewroom wait ${shellArg(id ?? dir)} --timeout ${o.timeout}\` again now, the same way`);
        return;
      }
      continue;
    }
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
  if (!fs.existsSync(path.join(DIST, 'reviewroom.js'))) fail(`missing build at ${DIST} - run \`bun run build\` in ${PKG}`);
  const agent = await agentAncestor(process.pid); // before the detached child's parent sees server.json and exits
  let seen = false; // a page (browser or app tab) connected
  const { app, watch, close, ready } = startServer({ repo, dir, cfg, onClient: () => (seen = true) });
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
  fs.rmSync(closedFile(dir), { force: true }); // open again
  reapAssistantGroup(dir); // under the lock, before allowing the new assistant to start
  stopAssistantWork(dir, 'interrupted');
  ready();
  // the assistant stops its turn, saves its session and ends its processes; a stop that hangs, or a second signal, exits
  // anyway, first reaping the assistant's private process group.
  const shutdown = () => Promise.race([Promise.resolve(close()).catch((e: unknown) => console.error(`reviewroom: assistant cleanup failed: ${(e as Error).message}`)), Bun.sleep(8000)]);
  const exit = () => {
    try {
      reapAssistantGroup(dir);
    } finally {
      process.exit(0);
    }
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
  register({ ...rec, repo, dir, title: cfg.title ?? null, reviewId: cfg.id, head: cfg.headLabel ?? cfg.head, agent, author: cfg.id ? (cfg.author ?? null) : null });
  fs.writeFileSync(serverFile(dir), JSON.stringify(rec));
  console.error(`reviewroom: ${path.relative(process.cwd(), dir) || '.'} | round ${s.round} | ${url}`);
  if (o.open) {
    // a tab from a previous server reconnects on its own; open one if nobody shows up
    setTimeout(() => !seen && openBrowser(url, !o.browser), 2500);
  }
  return rec;
}
