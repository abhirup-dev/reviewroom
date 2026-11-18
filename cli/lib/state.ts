// state.json: read (checked against the schema), atomic write, and ops applied under state.lock.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { takeLock, releaseLock } from './lock.ts';
import { emptyState, type ReviewState } from '../../src/kernel/state/model.shared.ts';
import { applyOp, OpError, ReviewroomError, type OpErrorCode } from '../../src/kernel/state/ops.shared.ts';
import { StoredState, issueText, type Op } from '../../src/kernel/state/schema.shared.ts';
import { parseWalkthrough, type Parsed } from '../../src/slides/model.shared.ts';

export const statePath = (dir: string) => path.join(dir, 'state.json');
export const walkthroughPath = (dir: string) => path.join(dir, 'walkthrough.json');

/** The review's walkthrough.json, parsed; null when there is none. */
export function readWalkthrough(dir: string): Parsed | null {
  const f = walkthroughPath(dir);
  return fs.existsSync(f) ? parseWalkthrough(fs.readFileSync(f, 'utf8')) : null;
}
/** The walkthrough if there is a valid one (context for tour threads). */
export const validWalkthrough = (dir: string) => {
  const r = readWalkthrough(dir);
  return r?.ok ? r.value : null;
};

/** Missing file = empty review. Unparseable file, or one that breaks the schema = moved aside and an error: never start over silently.
 *  `repair: false` (a read-only reader) never moves anything: the error just says so. */
export function readState(dir: string, { repair = true } = {}): ReviewState {
  const raw = readUnlessAside(statePath(dir));
  if (raw === null) return emptyState();
  let data: ReviewState;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return moveAside(statePath(dir), repair, `is not valid JSON (${(e as Error).message})`);
  }
  const checked = StoredState.safeParse(data);
  if (!checked.success) moveAside(statePath(dir), repair, `does not match schema/state.schema.json (${issueText(checked.error)})`);
  return { ...checked.data, ...data }; // the file as read (keys this version doesn't know survive), plus the schema's defaults (an older file has no pins)
}

/** A file's text; null when it doesn't exist. A copy moved aside (`<file>.corrupt-*`) means its data isn't gone: stay
 *  blocked until it is restored or deleted, never start over. */
export function readUnlessAside(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const dir = path.dirname(file), name = path.basename(file);
    const aside = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`)) : [];
    if (aside.length) throw new ReviewroomError(`${file} was moved aside as ${aside.join(', ')}. Fix one and move it back as ${name}, or delete them all to start over.`);
    return null;
  }
}
export function moveAside(file: string, repair: boolean, why: string): never {
  if (!repair) throw new ReviewroomError(`${file} ${why}. Fix it or delete it to start over.`);
  const bad = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(file, bad);
  } catch {}
  throw new ReviewroomError(`${file} ${why}; moved it to ${bad}. Fix and move it back, or delete it to start over.`);
}
/** Atomic: unique temp file in the same dir, fsync, rename. */
export const writeState = (dir: string, s: ReviewState) => writeAtomic(statePath(dir), JSON.stringify(s, null, 2));
export function writeAtomic(file: string, text: string, mode = 0o666) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

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
