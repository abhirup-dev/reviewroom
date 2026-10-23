// Where the hub finds sessions: each tool's per-user registry, one JSON file per running server.
//   crit         ~/.crit/sessions/<key>.json         { pid, port, host, public_url, cwd, args, branch, review_path, started_at } (0.18.1)
//   plannotator  <data-dir>/sessions/<pid>.json      { pid, port, url, mode, project, startedAt, label } (0.27.7)
//   reviewroom   ~/.reviewroom/sessions/<pid>.json   SessionRecord (cli/lib/registry.ts)
// Crit's and Plannotator's files are never written or deleted here; review contents are never read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeTimestamp, parseStrictPid, parseStrictPort } from './loopback.ts';
import type { RawCritEntry, RawPlanEntry } from '../../src/hub/model.shared.ts';
import type { SessionRecord } from '../lib/registry.ts';
import { registryDir } from '../lib/paths.ts';

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Every `<name>.json` in `dir` whose name matches `re`, parsed; corrupt or partial files are skipped. */
function readJsonDir(dir: string, re: RegExp): { m: RegExpExecArray; o: Obj; mtime: string | null }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // the tool was never used, or the dir is unreadable: not an error
  }
  return names.flatMap((name) => {
    const m = re.exec(name);
    if (!m) return [];
    const file = path.join(dir, name);
    try {
      const o: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o === null || typeof o !== 'object' || Array.isArray(o)) return [];
      return [{ m, o: o as Obj, mtime: fs.statSync(file).mtime.toISOString() }];
    } catch {
      return [];
    }
  });
}

export const defaultCritHome = () => path.join(os.homedir(), '.crit');

export function readCritRaw(critHome: string): RawCritEntry[] {
  return readJsonDir(path.join(critHome, 'sessions'), /^([0-9a-f]{4,64})\.json$/i).map(({ m, o, mtime }) => ({
    key: m[1],
    pid: parseStrictPid(o.pid),
    port: parseStrictPort(o.port),
    host: str(o.host) ?? '',
    publicUrl: str(o.public_url),
    cwd: str(o.cwd),
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [],
    branch: str(o.branch),
    reviewPath: str(o.review_path),
    startedAt: normalizeTimestamp(o.started_at),
    registryUpdatedAt: mtime,
  }));
}

/** PLANNOTATOR_DATA_DIR, else an existing ~/.plannotator, else an absolute $XDG_DATA_HOME/plannotator, else ~/.plannotator. */
export function resolvePlannotatorDataDir(env: Record<string, string | undefined> = process.env, home = os.homedir(), exists = fs.existsSync): string {
  const fromEnv = env.PLANNOTATOR_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  const dot = path.join(home, '.plannotator');
  const xdg = env.XDG_DATA_HOME?.trim();
  return !exists(dot) && xdg && path.isAbsolute(xdg) ? path.join(xdg, 'plannotator') : dot;
}

export function readPlanRaw(dataDir: string): RawPlanEntry[] {
  return readJsonDir(path.join(dataDir, 'sessions'), /^(\d{1,8})\.json$/).map(({ m, o, mtime }) => ({
    pid: parseStrictPid(o.pid) ?? parseStrictPid(+m[1]), // the recorded pid, else the file name's
    port: parseStrictPort(o.port),
    url: str(o.url),
    mode: str(o.mode),
    project: str(o.project),
    startedAt: normalizeTimestamp(o.startedAt),
    registryUpdatedAt: mtime,
    label: str(o.label),
  }));
}

/** reviewroom's own session records: written by `serve`, removed on exit. The URL is rebuilt from the port, so it
 *  is loopback by construction. */
export function readReviewroom(): (SessionRecord & { registryUpdatedAt: string | null })[] {
  return readJsonDir(registryDir(), /^(\d{1,8})\.json$/).flatMap(({ m, o, mtime }) => {
    const pid = parseStrictPid(o.pid);
    const port = parseStrictPort(o.port);
    if (pid === null || pid !== +m[1] || port === null) return [];
    const agent = o.agent as Obj | null | undefined;
    return [{
      pid,
      port,
      url: `http://127.0.0.1:${port}/`,
      repo: str(o.repo) ?? '',
      dir: str(o.dir) ?? '',
      title: str(o.title),
      number: typeof o.number === 'number' || typeof o.number === 'string' ? o.number : null,
      prUrl: str(o.prUrl),
      base: str(o.base) ?? '',
      head: str(o.head) ?? '',
      mode: o.mode === 'review' ? 'review' : 'serve',
      startedAt: normalizeTimestamp(o.startedAt) ?? '',
      // a GitHub login: it ends up in an avatar URL
      author: typeof o.author === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.author) ? o.author : null,
      agent: typeof agent?.name === 'string' && parseStrictPid(agent.pid) ? { name: agent.name, pid: agent.pid as number } : null,
      registryUpdatedAt: mtime,
    }];
  });
}
