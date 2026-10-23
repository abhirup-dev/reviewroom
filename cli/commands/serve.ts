import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { resolveDir, loadConfig, configPath } from '../lib/config.ts';
import { readState, commitOps } from '../lib/state.ts';
import { takeLock, releaseLock } from '../lib/lock.ts';
import { undelivered } from '../../src/kernel/state/ops.shared.ts';
import { type Finished, startServer, listen, openBrowser } from '../lib/server.ts';
import { DIST, PKG } from '../lib/paths.ts';
import { serverFile, stopServer, register, unregister } from '../lib/registry.ts';
import { agentAncestor } from '../hub/proc.ts';

const print = (text: string) => new Promise<void>((r) => process.stdout.write(text, () => r()));

// Feedback the reviewer sent while no agent was blocked in `review`: hand it over now, oldest first.
// Marked delivered only after printing (a repeat beats a loss). A running server keeps running.
async function deliverPending(dir: string) {
  const rounds = undelivered(readState(dir));
  for (const r of rounds) {
    const f = path.join(dir, 'rounds', String(r.n), 'feedback.md');
    await print((fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `(round ${r.n} was ${r.status} but ${f} is missing)`) + '\n');
    await commitOps(dir, [{ op: 'markDelivered', round: r.n }]);
    console.error(`reviewroom: round ${r.n} was ${r.status === 'approved' ? 'approved' : 'sent'} while you were not waiting -> ${f}`);
  }
  return rounds.length > 0;
}

export type ServeOpts = Global & { base?: string; head?: string; title?: string; port?: string; open: boolean; browser?: boolean; forever?: boolean };

export async function cmdServe(repo: string | null, o: ServeOpts, blocking: boolean) {
  if (!repo) fail('not inside a git repository (use --repo <path>)');
  const dir = resolveDir(repo, o.dir, { existing: true });
  const cfg = loadConfig(dir, repo, o);
  if (blocking && (await deliverPending(dir))) return;
  // take over a detached server for the same review (same port, so an open tab reconnects)
  const prev = await stopServer(dir);
  const portFlag = o.port || (prev ? String(prev.port) : undefined);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(configPath(dir)) || o.base || o.head || o.title) fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(DIST, 'reviewroom.js'))) fail(`missing build at ${DIST} - run \`bun run build\` in ${PKG}`);
  let finish!: (f: Finished) => void;
  const done = new Promise<Finished>((r) => (finish = r));
  let seen = false; // a page (browser or app tab) connected
  const { app, commit, checkNarrative } = startServer({ repo, dir, cfg, onFinish: (f) => finish(f), onClient: () => (seen = true) });
  const server = listen(app, +(portFlag || 4848));
  const port = server.port!;
  const url = `http://127.0.0.1:${port}/`;
  const holder = await takeLock(dir, port);
  if (holder) fail(`another reviewroom server (pid ${holder.pid}, port ${holder.port}) is serving this review; stop it first`);
  const startedAt = new Date().toISOString();
  const agent = await agentAncestor(process.pid); // before server.json: `pr --detach` (our parent) waits for it, then exits
  fs.writeFileSync(serverFile(dir), JSON.stringify({ pid: process.pid, port, url, startedAt }));
  register({ pid: process.pid, port, url, repo, dir, title: cfg.title ?? null, number: cfg.number ?? null, prUrl: cfg.url ?? null, base: cfg.base, head: cfg.head, mode: blocking ? 'review' : 'serve', startedAt, agent, author: cfg.number ? (cfg.author ?? null) : null });
  const cleanup = () => {
    releaseLock(dir);
    unregister(process.pid);
    try {
      if (JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')).pid === process.pid) fs.unlinkSync(serverFile(dir));
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const s = readState(dir);
  console.error(`reviewroom: ${path.relative(process.cwd(), dir) || '.'} | round ${s.round} | ${url}`);
  checkNarrative(); // after the lock: it may write state.json
  if (o.open) {
    // a tab from the previous round reconnects on its own; only open one if nobody shows up
    setTimeout(() => !seen && openBrowser(url, !o.browser), 2500);
  }
  if (!blocking) return;
  const res = await done;
  setTimeout(async () => {
    await print(res.md + '\n');
    try {
      commit([{ op: 'markDelivered', round: res.round }]);
    } catch (e) {
      console.error(`reviewroom: could not record delivery: ${(e as Error).message}`);
    }
    console.error(`\nreviewroom: round ${res.round} ${res.kind === 'approve' ? 'approved' : 'feedback saved'} -> ${path.join(dir, 'rounds', String(res.round), 'feedback.md')}`);
    void server.stop(true);
    process.exit(0); // the review is over: also ends the narrative watcher and SSE pings
  }, 150);
}
