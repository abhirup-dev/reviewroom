import fs from 'node:fs';
import path from 'node:path';
import { flags, die } from '../lib/args.mjs';
import { ensureExcluded } from '../lib/git.mjs';
import { resolveDir, loadConfig, readState } from '../lib/state.mjs';
import { DIST, PKG, startServer, listen, openBrowser, serverFile, stopServer } from '../lib/server.mjs';

export async function cmdServe(repo, blocking) {
  if (!repo) die('not inside a git repository (use --repo <path>)');
  const dir = resolveDir(repo);
  const cfg = loadConfig(dir, repo);
  // take over a detached server for the same review (same port, so an open tab reconnects)
  const prev = await stopServer(dir);
  if (prev && !flags.port) flags.port = String(prev.port);
  fs.mkdirSync(dir, { recursive: true });
  if (dir.startsWith(path.join(repo, '.readingroom'))) ensureExcluded(repo);
  if (!fs.existsSync(path.join(dir, 'config.json')) || flags.base || flags.head || flags.title) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(DIST, 'readingroom.js'))) die(`missing build at ${DIST} — run \`bun run build\` in ${PKG}`);
  let finish;
  const done = new Promise((r) => (finish = r));
  const { server } = startServer({ repo, dir, cfg, onFinish: (f) => finish(f) });
  const port = await listen(server, +(flags.port || 4848));
  const url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(serverFile(dir), JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }));
  const cleanup = () => {
    try {
      if (JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')).pid === process.pid) fs.unlinkSync(serverFile(dir));
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const s = readState(dir);
  console.error(`readingroom: ${path.relative(process.cwd(), dir) || '.'} · round ${s.round} · ${url}`);
  if (!flags['no-open']) {
    // a tab from the previous round reconnects on its own; only open one if nobody shows up
    let seen = false;
    server.once('rr-client', () => (seen = true));
    setTimeout(() => !seen && openBrowser(url), +(flags['open-delay'] || 2500));
  }
  if (!blocking) return;
  const res = await done;
  setTimeout(() => {
    process.stdout.write(res.md + '\n');
    console.error(`\nreadingroom: round ${res.round} ${res.kind === 'approve' ? 'approved' : 'feedback saved'} → ${path.join(dir, 'rounds', String(res.round), 'feedback.md')}`);
    server.closeAllConnections?.();
    server.close();
    process.exit(0);
  }, 150);
}
