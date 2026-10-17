// Running servers: <dir>/server.json (so `review`/`stop` find one) and ~/.reviewroom/sessions/<pid>.json.
import fs from 'node:fs';
import path from 'node:path';
import { answers } from './lock.ts';
import { registryDir } from './paths.ts';

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
export type SessionRecord = ServerRecord & { repo: string; dir: string; title: string | null; number: number | string | null; prUrl: string | null; base: string; head: string; mode: 'review' | 'serve'; open: 'app' | 'browser' | 'none' };
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
export async function stopServer(dir: string) {
  const rec = liveServer(dir);
  if (!rec || rec.pid === process.pid || !(await answers(rec.pid, rec.port, 1500))) return null;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 30 && liveServer(dir); i++) await new Promise((r) => setTimeout(r, 100));
  return rec;
}
