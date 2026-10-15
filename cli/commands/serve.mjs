import fs from 'node:fs';
import path from 'node:path';
import { flags, die } from '../lib/args.ts';
import { ensureExcluded } from '../lib/git.ts';
import { resolveDir, loadConfig, readState, takeLock, releaseLock, commitOps } from '../lib/state.mjs';
import { undelivered } from '../../src/shared/ops.ts';
import { DIST, PKG, startServer, listen, openBrowser, serverFile, stopServer, register, unregister } from '../lib/server.mjs';

const print = (text) => new Promise((r) => process.stdout.write(text, r));

// Feedback the reviewer sent while no agent was blocked in `review`: hand it over now, oldest first.
// Marked delivered only after printing (a repeat beats a loss). A running server keeps running.
async function deliverPending(dir) {
  const rounds = undelivered(readState(dir));
  for (const r of rounds) {
    const f = path.join(dir, 'rounds', String(r.n), 'feedback.md');
    await print((fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `(round ${r.n} was ${r.status} but ${f} is missing)`) + '\n');
    await commitOps(dir, [{ op: 'markDelivered', round: r.n }]);
    console.error(`reviewroom: round ${r.n} was ${r.status === 'approved' ? 'approved' : 'sent'} while you were not waiting → ${f}`);
  }
  return rounds.length > 0;
}

export async function cmdServe(repo, blocking, dir) {
  if (!repo) die('not inside a git repository (use --repo <path>)');
  dir ??= resolveDir(repo, { existing: true });
  const cfg = loadConfig(dir, repo);
  if (blocking && (await deliverPending(dir))) return process.exit(0);
  // take over a detached server for the same review (same port, so an open tab reconnects)
  const prev = await stopServer(dir);
  if (prev && !flags.port) flags.port = String(prev.port);
  fs.mkdirSync(dir, { recursive: true });
  if (dir.startsWith(path.join(repo, '.reviewroom'))) ensureExcluded(repo);
  if (!fs.existsSync(path.join(dir, 'config.json')) || flags.base || flags.head || flags.title) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(DIST, 'reviewroom.js'))) die(`missing build at ${DIST} — run \`bun run build\` in ${PKG}`);
  let finish;
  const done = new Promise((r) => (finish = r));
  const { server, commit, checkNarrative } = startServer({ repo, dir, cfg, onFinish: (f) => finish(f) });
  const port = await listen(server, +(flags.port || 4848));
  const url = `http://127.0.0.1:${port}/`;
  const holder = await takeLock(dir, port);
  if (holder) die(`another reviewroom server (pid ${holder.pid}, port ${holder.port}) is serving this review; stop it first`);
  const startedAt = new Date().toISOString();
  fs.writeFileSync(serverFile(dir), JSON.stringify({ pid: process.pid, port, url, startedAt }));
  register({ pid: process.pid, port, url, repo, dir, title: cfg.title ?? null, number: cfg.number ?? null, prUrl: cfg.url ?? null, base: cfg.base, head: cfg.head, mode: blocking ? 'review' : 'serve', startedAt });
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
  console.error(`reviewroom: ${path.relative(process.cwd(), dir) || '.'} · round ${s.round} · ${url}`);
  checkNarrative(); // after the lock: it may write state.json
  if (!flags['no-open']) {
    // a tab from the previous round reconnects on its own; only open one if nobody shows up
    let seen = false;
    server.once('rr-client', () => (seen = true));
    setTimeout(() => !seen && openBrowser(url), 2500);
  }
  if (!blocking) return;
  const res = await done;
  setTimeout(async () => {
    await print(res.md + '\n');
    try {
      commit([{ op: 'markDelivered', round: res.round }]);
    } catch (e) {
      console.error(`reviewroom: could not record delivery: ${e.message}`);
    }
    console.error(`\nreviewroom: round ${res.round} ${res.kind === 'approve' ? 'approved' : 'feedback saved'} → ${path.join(dir, 'rounds', String(res.round), 'feedback.md')}`);
    server.closeAllConnections?.();
    server.close();
    process.exit(0);
  }, 150);
}
