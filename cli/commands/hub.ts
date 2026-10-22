import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../lib/args.ts';
import { DIST, PKG, hubFile, hubLog, settingsFile } from '../lib/paths.ts';
import { ensureHub, liveHub, type ServerRecord } from '../lib/registry.ts';
import { listen, openBrowser } from '../lib/server.ts';
import { Hub } from '../hub/hub.ts';
import { hubApp } from '../hub/server.ts';

export type HubOpts = { port?: string; open: boolean; detach?: boolean; stop?: boolean; publicOrigin?: string };

const readSettings = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
};
/** An http(s) origin and nothing else (no path, query or credentials), or null. */
export function parseOrigin(v: unknown): string | null {
  try {
    const u = new URL(String(v));
    return /^https?:$/.test(u.protocol) && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}
/** `--public-origin <url>|none`: saved in ~/.reviewroom/config.json (other keys kept), read when the hub starts. */
function savePublicOrigin(v: string) {
  const origin = v === 'none' ? null : parseOrigin(v);
  if (v !== 'none' && !origin) fail(`--public-origin wants an origin like https://mac.tailnet.ts.net (or none), not ${v}`);
  const { publicOrigin: _, ...rest } = readSettings();
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(origin ? { ...rest, publicOrigin: origin } : rest, null, 2) + '\n');
  console.error(origin ? `reviewroom: public origin ${origin} saved in ${settingsFile()}` : 'reviewroom: public origin cleared');
}

const readHub = (): ServerRecord | null => {
  try {
    return JSON.parse(fs.readFileSync(hubFile(), 'utf8'));
  } catch {
    return null;
  }
};

// One hub per machine: a second `hub` points at the running one.
export async function cmdHub(o: HubOpts) {
  const show = (url: string) => (console.log(url), o.open && openBrowser(url, true));
  if (o.publicOrigin !== undefined) savePublicOrigin(o.publicOrigin);
  const live = await liveHub();
  if (o.stop) {
    if (live) process.kill(live.pid, 'SIGTERM');
    return console.log(live ? `stopped the hub on port ${live.port}` : 'no hub running');
  }
  if (live) {
    console.error(`reviewroom: the hub is already running (pid ${live.pid})${o.publicOrigin !== undefined ? '; restart it (`reviewroom hub --stop`, then `reviewroom hub`) to use the new public origin' : ''}`);
    return show(live.url);
  }
  if (!fs.existsSync(path.join(DIST, 'hub.js'))) fail(`missing build at ${DIST} - run \`bun run build\` in ${PKG}`);
  if (o.detach) {
    const url = await ensureHub(o.port);
    if (!url) fail(`the hub did not start - see ${hubLog()}`);
    console.error('reviewroom: hub running in the background | stop it with `reviewroom hub --stop`');
    return show(url);
  }
  let stale = '';
  const raw = readSettings().publicOrigin;
  const pub = raw == null ? null : parseOrigin(raw);
  if (raw != null && !pub) console.error(`reviewroom: ignoring publicOrigin ${JSON.stringify(raw)} in ${settingsFile()}: not an http(s) origin`);
  const port = +(o.port || 4847);
  let server: ReturnType<typeof listen>;
  try {
    // the front points at a fixed port: with a public origin, never drift to the next free one
    server = listen(hubApp(new Hub(), pub), port, pub ? 0 : 20);
  } catch (e) {
    if (!pub || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    fail(`port ${port} is taken; with a public origin the hub stays on it (the front points there)`);
  }
  const rec: ServerRecord = { pid: process.pid, port: server.port!, url: `http://127.0.0.1:${server.port}/`, startedAt: new Date().toISOString() };
  // hub.json is the claim: created exclusively, so of two hubs started at once only one is ever published
  fs.mkdirSync(path.dirname(hubFile()), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(hubFile(), JSON.stringify(rec), { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const other = await liveHub();
    if (other || i >= 20) {
      void server.stop(true);
      if (!other) fail(`${hubFile()} is held by a hub that does not answer`);
      console.error(`reviewroom: the hub is already running (pid ${other.pid})`);
      return show(other.url);
    }
    // a hub that died without cleaning up, or one still starting: give it a moment, then take the file over
    await new Promise((r) => setTimeout(r, 100));
    if (i >= 5 && !(await liveHub()) && JSON.stringify(readHub()) === stale) fs.rmSync(hubFile(), { force: true });
    stale = JSON.stringify(readHub());
  }
  process.on('exit', () => readHub()?.pid === process.pid && fs.rmSync(hubFile(), { force: true }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  console.error(`reviewroom: hub | ${rec.url}${pub ? ` | public: ${pub}/` : ''}`);
  show(rec.url);
}
