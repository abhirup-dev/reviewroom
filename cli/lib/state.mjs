// Review dir, config.json, state.json (read, atomic write, lock, ops) and rr: anchors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flags, pos, die } from './args.mjs';
import { git, defaultBase } from './git.mjs';
import { applyOp, OpError } from './ops.mjs';

/** The review dir: --dir, a dir argument, else <repo>/.reviewroom/<branch>. For an existing review
 *  (`existing`), a missing branch dir falls back to the repo's only review (e.g. pr-<n> made by `pr`). */
export function resolveDir(repo, { existing = false } = {}) {
  if (flags.dir) return path.resolve(flags.dir);
  const p = pos.find((x) => fs.existsSync(x) && fs.statSync(x).isDirectory());
  if (p) return path.resolve(p);
  const root = path.join(repo, '.reviewroom');
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim().replace(/[^\w.-]+/g, '-');
  const own = path.join(root, branch);
  if (!existing || fs.existsSync(own)) return own;
  const reviews = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'review.html'))) : [];
  if (reviews.length === 1) return path.join(root, reviews[0]);
  die(reviews.length ? `several reviews in ${root}: ${reviews.join(', ')} — pass --dir` : `no review in ${root} — run \`reviewroom pr <n>\` first, or pass --dir`);
}

export function loadConfig(dir, repo) {
  const file = path.join(dir, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const k of ['base', 'head', 'title', 'repo-name', 'number', 'author', 'url']) if (typeof flags[k] === 'string') cfg[k === 'repo-name' ? 'repo' : k] = flags[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  return cfg;
}

const emptyState = () => ({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }], threads: [], viewed: {}, pins: [] });
export const statePath = (dir) => path.join(dir, 'state.json');

export class StateError extends Error {}
/** Missing file = empty review. Unparseable file = moved aside and an error: never start over silently. */
export function readState(dir) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(dir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const bad = `${statePath(dir)}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(statePath(dir), bad);
    } catch {}
    throw new StateError(`${statePath(dir)} is not valid JSON (${e.message}); moved it to ${bad}. Fix and move it back, or delete it to start the review over.`);
  }
}
/** Atomic: unique temp file in the same dir, fsync, rename. */
export function writeState(dir, s) {
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
const lockPath = (dir) => path.join(dir, 'state.lock');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** Does a reviewroom server with this pid answer on this port? null = no answer in time (busy: git calls are synchronous). */
export async function answers(pid, port, timeout = 800) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(timeout) });
    return r.headers.get('x-reviewroom-pid') === String(pid);
  } catch (e) {
    return e.name === 'TimeoutError' ? null : false;
  }
}
/** Take state.lock. Returns null once it is ours, or the {pid, port} of the live server holding it. */
export async function takeLock(dir, port = null) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, port }), { flag: 'wx' });
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let h = null;
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
export function releaseLock(dir) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid === process.pid) fs.unlinkSync(lockPath(dir));
  } catch {}
}
/** Apply ops as one all-or-nothing batch: via the running server, else straight to the file under the lock. */
export async function commitOps(dir, ops) {
  const holder = await takeLock(dir);
  if (holder) {
    const r = await fetch(`http://127.0.0.1:${holder.port}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new OpError(b.code || 'bad_op', b.error || `server answered ${r.status}`);
    return b.rev;
  }
  try {
    const s = ops.reduce(applyOp, readState(dir));
    writeState(dir, s);
    return s.rev;
  } finally {
    releaseLock(dir);
  }
}
export const uid = (p) => p + crypto.randomBytes(4).toString('hex');

export const dirForEdit = (repo) => {
  if (!repo && !flags.dir) die('not inside a git repository (use --dir)');
  return resolveDir(repo, { existing: true });
};


export function parseAnchor(ref) {
  const m = ref.match(/^rr:(\w+)\/(.*)$/);
  if (!m) return { kind: 'general' };
  const [, type, rest] = m;
  if (type === 'doc') {
    const [id, ...p] = rest.split('/');
    return { kind: 'doc', target: decodeURIComponent(id), path: p.length ? decodeURIComponent(p.join('/')) : undefined };
  }
  if (type === 'code') {
    const lm = rest.match(/#L(\d+)(?:-L?(\d+))?$/);
    let p = lm ? rest.slice(0, lm.index) : rest;
    let rev = 'head';
    const at = p.lastIndexOf('@');
    if (at > 0) (rev = p.slice(at + 1)), (p = p.slice(0, at));
    return { kind: 'code', path: p, rev: rev === 'base' ? 'base' : 'head', start: lm ? +lm[1] : 1, end: lm ? +(lm[2] || lm[1]) : 1 };
  }
  if (type === 'sym') return { kind: 'symbol', name: decodeURIComponent(rest) };
  return { kind: 'general' };
}
