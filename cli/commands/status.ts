import path from 'node:path';
import type { Global } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig, readConfig } from '../lib/config.ts';
import { readState } from '../lib/state.ts';
import { awaitingAgent, currentRound } from '../../src/kernel/state/ops.shared.ts';
import { liveServer, stopServer } from '../lib/registry.ts';

export type StatusOpts = Global & { all?: boolean; json?: boolean };

export function cmdStatus(repo: string | null, o: StatusOpts) {
  const dir = dirForEdit(repo, o.dir);
  const s = readState(dir);
  const open = s.threads.filter((t) => t.status === 'open');
  const waiting = awaitingAgent(s);
  if (o.json) {
    const cfg = readConfig(dir);
    let base, head;
    try {
      if (repo) ({ base, head } = makeProvider(repo, loadConfig(dir, repo))); // no repo, or git fails: no base/head
    } catch {}
    console.log(JSON.stringify({ dir, review: path.join(dir, 'review.html'), url: liveServer(dir)?.url ?? null, base, head, config: cfg, round: s.round, threads: s.threads.length, open: open.length, awaitingAgent: waiting.map((t) => t.id) }, null, 2));
    return;
  }
  console.log(`${dir}\nround ${s.round} (${currentRound(s)?.status}) | ${s.threads.length} threads | ${open.length} open | ${waiting.length} awaiting agent reply`);
}

export async function cmdStop(repo: string | null, o: Global) {
  const dir = dirForEdit(repo, o.dir);
  const rec = await stopServer(dir);
  console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review');
}
