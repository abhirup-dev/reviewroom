import fs from 'node:fs';
import path from 'node:path';

// state.lock {pid, port}: a running server holds it for its lifetime (port set); a CLI holds it
// for one read-modify-write (port null). CLI writes go to the server while it holds the lock.
const lockPath = (dir: string) => path.join(dir, 'state.lock');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** Does a reviewroom server with this pid answer on this port? null = no answer in time (busy: git calls are synchronous). */
export async function answers(pid: number, port: number, timeout = 800): Promise<boolean | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(timeout) });
    return r.headers.get('x-reviewroom-pid') === String(pid);
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? null : false;
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let h: LockHolder | null = null, raw = '';
    try {
      h = JSON.parse((raw = fs.readFileSync(lockPath(dir), 'utf8')));
    } catch {}
    if (h?.pid === process.pid) return null;
    let busy = h ? alive(h.pid) && !h.port : true; // a CLI mid-write, or a holder still writing the file
    if (h?.port && alive(h.pid)) {
      const up = await answers(h.pid, h.port);
      if (up) return h;
      busy = up === null; // a busy server is not a dead one
    }
    if ((busy && i < 60) || !clearStale(dir, raw)) await new Promise((r) => setTimeout(r, 50));
  }
}
/** Delete a stale lock (holder died, or a server that no longer answers), if it still is the one we saw. One taker
 *  at a time: two CLIs that both saw it dead would otherwise both delete, the later one deleting the earlier one's new lock. */
function clearStale(dir: string, raw: string) {
  const claim = lockPath(dir) + '.takeover';
  try {
    fs.writeFileSync(claim, String(process.pid), { flag: 'wx' });
  } catch {
    // a taker that died mid-takeover
    if (Date.now() - (fs.statSync(claim, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 5000) fs.rmSync(claim, { force: true });
    return false;
  }
  try {
    if (fs.readFileSync(lockPath(dir), 'utf8') === raw) fs.rmSync(lockPath(dir));
  } catch {
  } finally {
    fs.rmSync(claim, { force: true });
  }
  return true;
}
export function releaseLock(dir: string) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid === process.pid) fs.unlinkSync(lockPath(dir));
  } catch {}
}
