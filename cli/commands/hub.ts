import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../lib/args.ts';
import { DIST, PKG, hubFile, hubLog } from '../lib/paths.ts';
import { ensureHub, liveHub, type ServerRecord } from '../lib/registry.ts';
import { listen, openBrowser } from '../lib/server.ts';
import { Hub } from '../hub/hub.ts';
import { hubApp } from '../hub/server.ts';

export type HubOpts = { port?: string; open: boolean; detach?: boolean; stop?: boolean };

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
  const live = await liveHub();
  if (o.stop) {
    if (live) process.kill(live.pid, 'SIGTERM');
    return console.log(live ? `stopped the hub on port ${live.port}` : 'no hub running');
  }
  if (live) {
    console.error(`reviewroom: the hub is already running (pid ${live.pid})`);
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
  const server = listen(hubApp(new Hub()), +(o.port || 4847));
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
  console.error(`reviewroom: hub | ${rec.url}`);
  show(rec.url);
}
