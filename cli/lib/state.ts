// Review dir, config.json, state.json (read, atomic write, lock, ops).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { type Opts, die } from './args.ts';
import { git, defaultBase, type ReviewConfig } from './git.ts';
import type { Op, ReviewState } from '../../src/core/types.ts';
import { applyOp, OpError, type OpErrorCode } from '../../src/shared/ops.ts';
import { StoredState, issueText } from '../../src/shared/schema.ts';

/** The review dir: --dir, else <repo>/.reviewroom/<branch>. For an existing review
 *  (`existing`), a missing branch dir falls back to the repo's only review (e.g. pr-<n> made by `pr`). */
export function resolveDir(repo: string | null, dirFlag: string | undefined, { existing = false } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  repo = repo!; // only dirForEdit passes none, and only with --dir
  const root = path.join(repo, '.reviewroom');
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim().replace(/[^\w.-]+/g, '-');
  const own = path.join(root, branch);
  if (!existing || fs.existsSync(own)) return own;
  const reviews = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'review.html'))) : [];
  if (reviews.length === 1) return path.join(root, reviews[0]);
  die(reviews.length ? `several reviews in ${root}: ${reviews.join(', ')} — pass --dir` : `no review in ${root} — run \`reviewroom pr <n>\` first, or pass --dir`);
}

export function loadConfig(dir: string, repo: string, o: Opts): ReviewConfig {
  const file = path.join(dir, 'config.json');
  const cfg: ReviewConfig = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const k of ['base', 'head', 'title'] as const) if (typeof o[k] === 'string') cfg[k] = o[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  return cfg;
}

const emptyState = (): ReviewState => ({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }], threads: [], viewed: {}, pins: [] });
export const statePath = (dir: string) => path.join(dir, 'state.json');

export class StateError extends Error {}
/** Missing file = empty review. Unparseable file, or one that breaks the schema = moved aside and an error: never start over silently. */
export function readState(dir: string): ReviewState {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(dir), 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    // a moved-aside file means the review isn't empty: stay blocked until it is restored or deleted, never start over
    const aside = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')) : [];
    if (aside.length) throw new StateError(`${statePath(dir)} was moved aside as ${aside.join(', ')}. Fix one and move it back as state.json, or delete them all to start the review over.`);
    return emptyState();
  }
  let data: ReviewState;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    return moveAside(dir, `is not valid JSON (${e.message})`);
  }
  const checked = StoredState.safeParse(data);
  if (!checked.success) moveAside(dir, `does not match schema/state.schema.json (${issueText(checked.error)})`);
  return data; // as read, not Zod's copy: keys the schema doesn't know survive the next write
}
function moveAside(dir: string, why: string): never {
  const bad = `${statePath(dir)}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(statePath(dir), bad);
  } catch {}
  throw new StateError(`${statePath(dir)} ${why}; moved it to ${bad}. Fix and move it back, or delete it to start the review over.`);
}
/** Atomic: unique temp file in the same dir, fsync, rename. */
export function writeState(dir: string, s: ReviewState) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.state.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(s, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, statePath(dir));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// state.lock {pid, port}: a running server holds it for its lifetime (port set); a CLI holds it
// for one read-modify-write (port null). CLI writes go to the server while it holds the lock.
const lockPath = (dir: string) => path.join(dir, 'state.lock');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
};
/** Does a reviewroom server with this pid answer on this port? null = no answer in time (busy: git calls are synchronous). */
export async function answers(pid: number, port: number, timeout = 800): Promise<boolean | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(timeout) });
    return r.headers.get('x-reviewroom-pid') === String(pid);
  } catch (e: any) {
    return e.name === 'TimeoutError' ? null : false;
  }
}
/** Take state.lock. Returns null once it is ours, or the {pid, port} of the live server holding it. */
export type LockHolder = { pid: number; port: number | null };
export async function takeLock(dir: string, port: number | null = null): Promise<LockHolder | null> {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, port }), { flag: 'wx' });
      return null;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
    let h: LockHolder | null = null;
    try {
      h = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    } catch {}
    if (h?.pid === process.pid) return null;
    let busy = h ? alive(h.pid) && !h.port : true; // a CLI mid-write, or a holder still writing the file
    if (h?.port && alive(h.pid)) {
      const up = await answers(h.pid, h.port);
      if (up) return h;
      busy = up === null; // a busy server is not a dead one
    }
    if (busy && i < 60) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    fs.rmSync(lockPath(dir), { force: true }); // stale: holder died, or a server that no longer answers
  }
}
export function releaseLock(dir: string) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid === process.pid) fs.unlinkSync(lockPath(dir));
  } catch {}
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

export const dirForEdit = (repo: string | null, dirFlag: string | undefined) => {
  if (!repo && !dirFlag) die('not inside a git repository (use --dir)');
  return resolveDir(repo, dirFlag, { existing: true });
};


