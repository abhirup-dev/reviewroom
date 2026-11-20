import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import path from 'node:path';
import type { Global } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { loadConfig, readConfig, shellArg } from '../lib/config.ts';
import { readState } from '../lib/state.ts';
import { awaitingAgent, currentRound } from '../../src/kernel/state/ops.shared.ts';
import { liveServer, stopServer } from '../lib/registry.ts';
import { readReviewroom } from '../hub/sources.ts';
import { runningServer } from './serve.ts';

export type StatusOpts = Global & { all?: boolean; json?: boolean };

export function cmdStatus(repo: string | null, dir: string, o: StatusOpts) {
  const s = readState(dir);
  const open = s.threads.filter((t) => t.status === 'open');
  const waiting = awaitingAgent(s);
  if (o.json) {
    const cfg = readConfig(dir);
    let base, head;
    try {
      if (repo) ({ base, head } = makeProvider(repo, loadConfig(dir, repo))); // no repo, or git fails: no base/head
    } catch {}
    const role = process.env.REVIEWROOM_ASSISTANT_DIR && path.resolve(process.env.REVIEWROOM_ASSISTANT_DIR) === dir ? 'assistant' : 'external';
    console.log(JSON.stringify({ id: cfg.id, dir, role, review: path.join(dir, REPORT_FILE), url: liveServer(dir)?.url ?? null, base, head, config: cfg, round: s.round, threads: s.threads.length, open: open.length, awaitingAgent: waiting.map((t) => t.id) }, null, 2));
    return;
  }
  console.log(`${dir}\nround ${s.round} (${currentRound(s)?.status}) | ${s.threads.length} threads | ${open.length} open | ${waiting.length} awaiting agent reply`);
}

export async function cmdStop(_repo: string | null, dir: string) {
  const rec = await stopServer(dir);
  console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review');
}

export async function cmdList({ json }: { json?: boolean }) {
  const sessions = await Promise.all(readReviewroom().map(async ({ dir, pid, port, title, url }) => {
    if (!dir) return null;
    const server = await runningServer(dir);
    if (server?.pid !== pid || server.port !== port) return null;
    try {
      return { id: readConfig(dir).id, dir, url, pid, title };
    } catch { return null; }
  }));
  const reviews = sessions.filter((review) => review !== null).sort((a, b) => (a.id ?? a.dir).localeCompare(b.id ?? b.dir));
  if (json) console.log(JSON.stringify(reviews, null, 2));
  else if (!reviews.length) console.log('No running reviews');
  else for (const { id, dir, url } of reviews) console.log(`${shellArg(id ?? dir)}\t${url}`);
}
