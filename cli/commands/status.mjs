import fs from 'node:fs';
import path from 'node:path';
import { flags } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig, readState } from '../lib/state.ts';
import { liveServer, stopServer } from '../lib/server.ts';

export function cmdStatus(repo) {
  const dir = dirForEdit(repo);
  const s = readState(dir);
  const open = s.threads.filter((t) => t.status === 'open');
  const waiting = open.filter((t) => t.messages[t.messages.length - 1]?.author === 'you');
  if (flags.json) {
    const cfg = fs.existsSync(path.join(dir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : {};
    let base, head;
    try {
      const p = makeProvider(repo, loadConfig(dir, repo));
      ({ base, head } = p);
    } catch {}
    console.log(JSON.stringify({ dir, review: path.join(dir, 'review.html'), url: liveServer(dir)?.url ?? null, base, head, config: cfg, round: s.round, threads: s.threads.length, open: open.length, awaitingAgent: waiting.map((t) => t.id) }, null, 2));
    return;
  }
  console.log(`${dir}\nround ${s.round} (${s.rounds.find((r) => r.n === s.round)?.status}) · ${s.threads.length} threads · ${open.length} open · ${waiting.length} awaiting agent reply`);
}

export async function cmdStop(repo) {
  const dir = dirForEdit(repo);
  const rec = await stopServer(dir);
  console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review');
}
