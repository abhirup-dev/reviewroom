// state.json ops, applied under state.lock or through the running server.
import crypto from 'node:crypto';
import { takeLock, releaseLock } from './lock.ts';
import { emptyState, type ReviewState } from '../../src/kernel/state/model.shared.ts';
import { applyOp, OpError, type OpErrorCode } from '../../src/kernel/state/ops.shared.ts';
import type { StoredState, Op } from '../../src/kernel/state/schema.shared.ts';
import { reviewStore } from './review-store.ts';
import { parseWalkthrough, type Parsed } from '../../src/slides/model.shared.ts';


/** The review's walkthrough.json, parsed; null when there is none. */
export function readWalkthrough(dir: string): Parsed | null {
  const raw = reviewStore(dir).walkthrough.read();
  return raw === null ? null : parseWalkthrough(raw);
}
/** The walkthrough if there is a valid one (context for tour threads). */
export const validWalkthrough = (dir: string) => {
  const r = readWalkthrough(dir);
  return r?.ok ? r.value : null;
};

/** Missing file = empty review. `repair: false` (a read-only reader) never moves a broken file aside. */
export const readState = (dir: string, { repair = true } = {}): ReviewState => (reviewStore(dir).state.read({ repair }) as ReviewState | null) ?? emptyState();
export const writeState = (dir: string, s: ReviewState) => reviewStore(dir).state.write(s as StoredState);

/** Apply ops as one all-or-nothing batch: via the running server, else straight to the file under the lock. */
export async function commitOps(dir: string, ops: Op[]): Promise<number | undefined> {
  const holder = await takeLock(dir);
  if (holder) {
    const r = await fetch(`http://127.0.0.1:${holder.port}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) });
    const b = (await r.json().catch(() => ({}))) as { rev?: number; error?: string; code?: OpErrorCode };
    if (!r.ok) throw new OpError(b.code || 'bad_op', b.error || `server answered ${r.status}`);
    return b.rev;
  }
  try {
    const s = ops.reduce<ReviewState>(applyOp, readState(dir));
    writeState(dir, s);
    return s.rev;
  } finally {
    releaseLock(dir);
  }
}
export const uid = (p: string) => p + crypto.randomBytes(4).toString('hex');
