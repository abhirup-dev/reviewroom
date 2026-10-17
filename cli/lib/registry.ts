// Running servers: <dir>/server.json (so `review`/`stop` find one), ~/.reviewroom/sessions/<pid>.json, and the
// hub's ~/.reviewroom/hub.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { answers } from './lock.ts';
import { hubFile, hubLog, registryDir } from './paths.ts';
import type { Agent } from '../hub/proc.ts';

/** server.json, written by `serve`. */
export type ServerRecord = { pid: number; port: number; url: string; startedAt: string };
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
// Per-user registry of running servers, one <pid>.json each, so other local tools (an annotation hub)
// can list reviews without knowing which repos have them (AGENTS.md: a contract). Best effort: a failure never stops a review.
// `agent`: the agent CLI that started the server, found once at start while the process chain is intact.
// `author`: the PR author's GitHub login, for a review of a PR.
export type SessionRecord = ServerRecord & { repo: string; dir: string; title: string | null; number: number | string | null; prUrl: string | null; base: string; head: string; mode: 'review' | 'serve'; open?: 'app' | 'browser' | 'none'; agent?: Agent | null; author?: string | null };
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
  if (!rec || rec.pid === process.pid || (pid !== undefined && rec.pid !== pid) || !(await answers(rec.pid, rec.port, 1500))) return null;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 30 && liveServer(dir); i++) await new Promise((r) => setTimeout(r, 100));
  return rec;
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
 *  Respawns the running entry (the source or the bundle), like `pr --detach`. */
export async function ensureHub(port?: string): Promise<string | null> {
  const live = await liveHub();
  if (live) return live.url;
  fs.mkdirSync(path.dirname(hubLog()), { recursive: true });
  const out = fs.openSync(hubLog(), 'a');
  spawn(process.execPath, [process.argv[1], 'hub', '--no-open', ...(port ? ['--port', port] : [])], { detached: true, stdio: ['ignore', out, out] }).unref();
  fs.closeSync(out);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const rec = await liveHub();
    if (rec) return rec.url;
  }
  return null;
}
