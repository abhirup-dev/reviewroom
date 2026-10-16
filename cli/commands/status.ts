import path from 'node:path';
import type { Global } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig, readConfig, readState } from '../lib/state.ts';
import { liveServer, stopServer } from '../lib/server.ts';

export type StatusOpts = Global & { all?: boolean; json?: boolean };

export function cmdStatus(repo: string | null, o: StatusOpts) {
  const dir = dirForEdit(repo, o.dir);
  const s = readState(dir);
  const open = s.threads.filter((t) => t.status === 'open');
  const waiting = open.filter((t) => t.messages[t.messages.length - 1]?.author === 'you');
  if (o.json) {
    const cfg = readConfig(dir);
    let base, head;
    try {
      const p = makeProvider(repo!, loadConfig(dir, repo!)); // a null repo throws into the catch
      ({ base, head } = p);
    } catch {}
    console.log(JSON.stringify({ dir, review: path.join(dir, 'review.html'), url: liveServer(dir)?.url ?? null, base, head, config: cfg, round: s.round, threads: s.threads.length, open: open.length, awaitingAgent: waiting.map((t) => t.id) }, null, 2));
    return;
  }
  console.log(`${dir}\nround ${s.round} (${s.rounds.find((r) => r.n === s.round)?.status}) | ${s.threads.length} threads | ${open.length} open | ${waiting.length} awaiting agent reply`);
}

export async function cmdStop(repo: string | null, o: Global) {
  const dir = dirForEdit(repo, o.dir);
  const rec = await stopServer(dir);
  console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review');
}
