// Running servers: <dir>/server.json (so `start`/`wait`/`stop` find one), ~/.reviewroom/sessions/<pid>.json, and the
// hub's ~/.reviewroom/hub.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fail } from './args.ts';
import { answers, releaseLock, takeLock } from './lock.ts';
import { hubFile, hubLog, registryDir } from './paths.ts';
import type { Agent } from '../hub/proc.ts';

/** server.json, written by `start --foreground`. */
export type ServerRecord = { pid: number; port: number; url: string; startedAt: string };
/** Directory hash for hub routes and client storage keys (ADR 0001). */
export const routeId = (dir: string) => createHash('sha1').update(dir).digest('hex').slice(0, 12);
export const serverFile = (dir: string) => path.join(dir, 'server.json');
export function liveServer(dir: string): ServerRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8'));
    process.kill(rec.pid, 0);
    return rec;
  } catch {
    return null;
  }
}
export async function runningServer(dir: string) {
  const rec = liveServer(dir);
  // A busy server can time out. A different process on that port is stale.
  return rec && (await answers(rec.pid, rec.port, 1500)) !== false ? rec : null;
}
// Per-user registry of running servers, one <pid>.json each, so other local tools (an annotation hub)
// can list reviews without knowing which repos have them (AGENTS.md: a contract). Best effort: a failure never stops a review.
// `agent`: the agent CLI that started the server, found once at start while the process chain is intact.
// `author`: the PR author's GitHub login, for a review of a PR.
export type SessionRecord = ServerRecord & { repo: string; dir: string; title: string | null; reviewId?: string; head: string; agent?: Agent | null; author?: string | null };
export function register(rec: SessionRecord) {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(path.join(registryDir(), `${rec.pid}.json`), JSON.stringify(rec, null, 2));
  } catch {}
}
export function unregister(pid: number) {
  try {
    fs.unlinkSync(path.join(registryDir(), `${pid}.json`));
  } catch {}
}
// server.json can outlive its server and the pid be reused: only signal a pid that our server reports.
// `pid`: stop only that server (the hub closing the session it showed), not one that has replaced it since.
export async function stopServer(dir: string, pid?: number) {
  const rec = liveServer(dir);
  if (!rec) {
    const file = serverFile(dir);
    // A concurrent start writes its record under this lock.
    if (pid === undefined && fs.existsSync(file) && !(await takeLock(dir))) {
      try {
        if (!liveServer(dir)) fs.rmSync(file, { force: true });
      } finally {
        releaseLock(dir);
      }
    }
    return null;
  }
  if (rec.pid === process.pid || (pid !== undefined && rec.pid !== pid) || !(await answers(rec.pid, rec.port, 1500))) return null;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {}
  // past the server's shutdown grace (serve.ts: its assistant saves its session and ends its processes first)
  for (let i = 0; i < 100 && liveServer(dir); i++) await new Promise((r) => setTimeout(r, 100));
  return rec;
}

/** Starts a detached review server and owns the child until it registers or exits. */
export async function startDetached(repo: string, dir: string, extra: string[] = [], entry = process.argv[1], timeoutMs = 60_000) {
  const log = path.join(dir, 'server.log');
  let child;
  try {
    const out = fs.openSync(log, 'a');
    try {
      child = spawn(process.execPath, [entry, 'start', dir, '--foreground', '--repo', repo, ...extra], { detached: true, stdio: ['ignore', out, out] });
    } finally {
      fs.closeSync(out);
    }
  } catch (e) {
    fail(`could not launch the review server: ${(e as Error).message}`);
  }
  let error: Error | undefined;
  const { promise: done, resolve } = Promise.withResolvers<void>();
  child.once('exit', () => resolve());
  child.once('error', (e) => { error = e; resolve(); });
  const exited = () => error || child.exitCode !== null || child.signalCode !== null;
  // Only this child's record proves it finished startup.
  for (const end = performance.now() + timeoutMs; !exited() && performance.now() < end; await Bun.sleep(100)) {
    const server = liveServer(dir);
    if (server && server.pid === child.pid) {
      child.unref();
      return { server, started: true };
    }
  }
  if (child.exitCode === 0) {
    const server = await runningServer(dir); // another starter held the lock
    if (server) return { server, started: false };
  }
  if (exited()) fail(`server exited during startup${error ? `: ${error.message}` : ''} - see ${log}`);
  child.kill('SIGTERM');
  const grace = setTimeout(() => child.kill('SIGKILL'), 3000);
  await done;
  clearTimeout(grace);
  fail(`server did not start - see ${log}`);
}

/** The hub (`reviewroom hub`), if one answers as the process its hub.json names. */
export async function liveHub(): Promise<ServerRecord | null> {
  try {
    const rec: ServerRecord = JSON.parse(fs.readFileSync(hubFile(), 'utf8'));
    return (await answers(rec.pid, rec.port)) ? rec : null;
  } catch {
    return null;
  }
}
/** The hub's URL, starting it in the background first if none runs (null: it did not start, see hub.log).
 *  Respawns the running entry (the source or the bundle). */
export async function ensureHub(port?: string): Promise<string | null> {
  const live = await liveHub();
  if (live) return live.url;
  fs.mkdirSync(path.dirname(hubLog()), { recursive: true });
  const out = fs.openSync(hubLog(), 'a');
  spawn(process.execPath, [process.argv[1], 'hub', 'serve', '--no-open', ...(port ? ['--port', port] : [])], { detached: true, stdio: ['ignore', out, out] }).unref();
  fs.closeSync(out);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const rec = await liveHub();
    if (rec) return rec.url;
  }
  return null;
}
