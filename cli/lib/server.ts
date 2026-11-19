import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// HTTP server: review page, client bundle, JSON API, SSE live updates.
import { readProgress, recordArtifact } from './progress.ts';
import { pendingArtifact } from '../../src/kernel/state/progress.shared.ts';
import { execFile } from 'node:child_process';
import open from 'open';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { feedbackMarkdown } from '../../src/threads/feedback.shared.ts';
import { isFullSha, makeProvider, type Provider } from './git.ts';
import { readConfig, reviewArgs, reviewDirArgs, type ReviewConfig } from './config.ts';
import { readState, readWalkthrough, statePath, validWalkthrough, walkthroughPath, writeState } from './state.ts';
import { PKG, defaultLayoutFile, hubLog, layoutsDir } from './paths.ts';
import { ensureHub, reviewId } from './registry.ts';
import { builtinLayouts, Layout, LayoutId } from '../../src/kernel/layouts/layout.shared.ts';
import { applyOp, awaitingAgent, currentRound, OpError, ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { makeGitHub } from './github.ts';
import { checkLinks, problems, report } from './links.ts';
import { tourText } from './slides-file.ts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { compress } from 'hono/compress';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { FinishRound, GitHubAction, issueText, type Anchor, type Op } from '../../src/kernel/state/schema.shared.ts';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { getBunServer, serveStatic } from '@hono/bun';
import { buildId, serveClient, withHead } from './pwa.ts';
import { assistantEnabled, assistantRoutes, VIA_HUB } from './assistant.ts';

function excerpt(prov: Provider, anchor: Anchor) {
  if (anchor.kind !== 'code') return null;
  const text = prov.read(anchor.rev === 'base' ? prov.base : prov.head, anchor.path);
  if (!text) return null;
  const lines = text.split('\n');
  return lines.slice(anchor.start - 1, anchor.end).map((l, i) => `${String(anchor.start + i).padStart(4)}  ${l}`).join('\n');
}


/** Watch the review dir for report.html, walkthrough.json assets and progress.jsonl (debounced).
 *  The server is the only writer of state.json (it holds state.lock), so that is not watched. */
function watchNarrative(dir: string, onChange: (files: Set<string>) => void) {
  let t: NodeJS.Timeout | undefined, changed = new Set<string>();
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, (_e, f: string | null) => {
    if (f === 'progress.jsonl' || f === REPORT_FILE || f === WALKTHROUGH_FILE || (f && /\.(css|js|svg|png)$/.test(f))) {
      changed.add(f);
      clearTimeout(t);
      t = setTimeout(() => {
        onChange(changed);
        changed = new Set<string>();
      }, 150);
    }
  });
  // live reload is a nicety; a dead watcher (dir removed, fd limits) must not kill the server
  watcher.on('error', (e) => console.error(`reviewroom: file watch stopped: ${e.message}`));
  return watcher;
}

/** Stale-link check of report.html and walkthrough.json: fingerprint new links, tell the agent (stderr) when the report changes. */
function narrativeCheck(repo: string, dir: string, cfg: ReviewConfig, commit: (ops: Op[]) => unknown) {
  const reviewFile = path.join(dir, REPORT_FILE);
  let lastReport = '';
  return () => {
    try {
      if (!fs.existsSync(reviewFile)) return;
      const known = readState(dir).links ?? {};
      // the current head, not the one this server started on: `check` must fingerprint the same code
      const w = readWalkthrough(dir);
      const tour = w?.ok ? tourText(w.value) : '';
      const checked = checkLinks(fs.readFileSync(reviewFile, 'utf8'), makeProvider(repo, cfg), known, tour, w?.ok ? w.value : null);
      const { results } = checked;
      // a walkthrough.json that is broken for now hides its links: keep their fingerprints, or fixing it re-baselines moved code
      const links = w && !w.ok ? { ...known, ...checked.links } : checked.links;
      if (JSON.stringify(links) !== JSON.stringify(known)) commit([{ op: 'setLinks', links }]);
      const bad = problems(results);
      const text = bad.length ? `reviewroom: ${bad.length} stale link${bad.length > 1 ? 's' : ''} in ${REPORT_FILE} or ${WALKTHROUGH_FILE}; \`reviewroom check --fix\` heals the moved ones:\n${report(bad)}` : '';
      if (text && text !== lastReport) console.error(text);
      lastReport = text;
    } catch (e) {
      console.error(`reviewroom: link check failed: ${(e as Error).message}`);
    }
  };
}

/** What the access checks look at in a request. */
export type AccessRequest = { host?: string; origin?: string; site?: string; method: string; path: string };
export const accessRequest = (c: Context): AccessRequest => ({ host: c.req.header('host'), origin: c.req.header('origin'), site: c.req.header('sec-fetch-site'), method: c.req.method, path: c.req.path });
export const serverPort = (c: Context) => getBunServer<Bun.Server<undefined>>(c)?.port;

/** Host is one of `hosts`; API requests (`isApi`) are not cross-site, and writes carry no Origin or one of `origins`. */
export function sameSite(r: AccessRequest, hosts: string[], origins: string[], isApi = (p: string) => p.startsWith('/api/')) {
  if (!hosts.includes(r.host ?? '')) return false;
  if (!isApi(r.path.replace(/\/{2,}/g, '/'))) return true; // the router reads //api/ops as /api/ops
  if (r.site && r.site !== 'same-origin' && r.site !== 'none') return false;
  return r.method === 'GET' || r.method === 'HEAD' || r.origin === undefined || origins.includes(r.origin);
}

// Only this machine's browser tab may talk to us: other sites can reach 127.0.0.1 too (no-cors GETs, form POSTs,
// DNS rebinding), so check Host, Sec-Fetch-Site and Origin.
export const loopbackHosts = (port: number | undefined) => [`127.0.0.1:${port}`, `localhost:${port}`];
function allowed(c: Context) {
  const hosts = loopbackHosts(serverPort(c));
  return sameSite(accessRequest(c), hosts, hosts.map((h) => `http://${h}`));
}

/** Every response says which process and which client build sent it (lock.ts `answers`); requests `ok` refuses get a 403.
 *  The hub's server uses this too, with its own check (hubAccess). */
export const guarded = (ok: (c: Context) => boolean): MiddlewareHandler => async (c, next) => {
  c.header('x-reviewroom-pid', String(process.pid));
  const id = buildId();
  if (id) c.header('x-reviewroom-build', id);
  c.header('cache-control', 'no-store'); // unless a route says otherwise
  if (!ok(c)) return c.json({ error: 'forbidden' }, 403);
  await next();
};
export const localOnly = guarded(allowed);

/** `readOnly`: a server that only shows the review (`slide-lint`): no writes, no GitHub calls; it holds no lock. */
type ServerOpts = { repo: string; dir: string; cfg: ReviewConfig; onClient?: () => void; readOnly?: boolean };
export function startServer({ repo, dir, cfg, onClient, readOnly }: ServerOpts) {
  const prov = makeProvider(repo, cfg);
  const started = new Date().toISOString(); // a page tells this run from the next one by it
  const clients = new Set<SSEStreamingApi>();
  const github = makeGitHub({ repo, dir, cfg, prov, onChange: (snap) => send('github', snap) });
  const reviewFile = path.join(dir, REPORT_FILE);
  // A reconnecting client reloads when the Git range or either artifact changes.
  // each file's part of the hash; a pending artifact's part is 'pending', so saves while the agent writes don't change it
  const parts = () => {
    const progress = readProgress(dir);
    return ([['report', reviewFile], ['walkthrough', walkthroughPath(dir)]] as const).map(([artifact, f]) =>
      pendingArtifact(progress[artifact]) ? 'pending' : fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : '');
  };
  const hash = (p = parts()) => crypto.createHash('sha1').update([prov.base, prov.head, ...p].join('|')).digest('hex').slice(0, 12);
  const read = () => readState(dir, { repair: !readOnly }); // a read-only server never moves a corrupt state.json aside
  const send = (event: string, data: unknown) => {
    for (const c of clients) c.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
  };
  const json = (c: Context, body: unknown, code = 200) => c.json(body, code as ContentfulStatusCode);
  const checkIdentity = () => {
    const actual = readConfig(dir).id;
    if (actual !== cfg.id) throw new ReviewroomError(`review ID changed in ${dir}: expected ${cfg.id ?? 'no PR ID'}, found ${actual ?? 'no PR ID'}`, 409);
  };
  // request bodies are untrusted: a bad one is a 400 shaped like an OpError's
  const body = <T extends z.ZodType>(schema: T) =>
    zValidator('json', schema, (r, c) => {
      if (!r.success) return json(c, { error: issueText(r.error), code: 'bad_op' }, 400);
    });
  // Synchronous read-apply-write: requests can't interleave inside it. All-or-nothing per batch.
  const commit = (ops: Op[]) => {
    let s = readState(dir);
    ops.forEach((op, i) => {
      try {
        s = applyOp(s, op);
      } catch (e) {
        if (e instanceof OpError) e.index = i;
        throw e;
      }
    });
    writeState(dir, s);
    send('state', s);
    return s;
  };
  const checkNarrative = narrativeCheck(repo, dir, cfg, commit);
  // Watch only after the server owns state.lock. Read-only renderers never start it.
  let last = parts();
  let watcher: fs.FSWatcher | undefined;
  const watch = () => {
    checkIdentity();
    checkNarrative();
    watcher = watchNarrative(dir, (files) => {
      try {
        checkIdentity();
      } catch (e) {
        console.error(`reviewroom: ${(e as Error).message}`);
        return;
      }
      const head = isFullSha(prov.head) ? { head: prov.head } : {};
      if (files.has(WALKTHROUGH_FILE)) recordArtifact(dir, 'walkthrough', 'written', head);
      if (files.has(REPORT_FILE)) recordArtifact(dir, 'report', 'written', head);
      send('progress', readProgress(dir));
      // reload when a file's content shows something new, never when it goes back to pending (the page shows that live)
      const next = parts();
      if (next.some((p, i) => p !== last[i] && p !== 'pending') || [...files].some((f) => /\.(css|js|svg|png)$/.test(f))) send('review', { hash: hash(next) });
      last = next;
      if (files.has(REPORT_FILE) || files.has(WALKTHROUGH_FILE)) checkNarrative();
    });
  };

  const assistant = assistantEnabled() && !readOnly ? assistantRoutes({ repo, dir, cfg: { ...cfg, base: prov.base, head: prov.head } }) : undefined;
  const app = new Hono();
  app.use(localOnly);
  app.use(async (c, next) => {
    if (c.req.path !== '/favicon.ico') checkIdentity();
    await next();
  });
  app.use(compress()); // skips the event stream (text/event-stream) and small bodies
  if (readOnly) app.use(async (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : json(c, { error: 'read-only server' }, 403)));
  app.notFound((c) => json(c, { error: 'not found' }, 404));
  app.onError((e, c) => {
    if (e instanceof HTTPException) return json(c, { error: e.message, code: 'bad_op' }, e.status); // malformed JSON
    if (!(e instanceof OpError)) console.error(`reviewroom: ${c.req.method} ${c.req.path}: ${e.message}`);
    const op = e instanceof OpError ? e : undefined;
    return json(c, { error: e.message, code: op?.code, index: op?.index }, e instanceof ReviewroomError ? e.status : 500);
  });

  const page = (c: Context) => {
    const html = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : fs.readFileSync(path.join(PKG, 'templates', REPORT_FILE), 'utf8');
    return c.html(withHead(html), 200, { 'cache-control': 'no-cache' });
  };
  app.get('/', page);
  app.get('/index.html', page);
  serveClient(app);
  app.get('/favicon.ico', (c) => c.body(null, 204, { 'cache-control': 'max-age=86400' }));
  // The directory hash is the same for direct and proxied access.
  app.get('/api/meta', (c) => json(c, { ...prov.meta(), id: reviewId(dir), prReviewId: cfg.id, ...(assistant && !c.req.header(VIA_HUB) && { assistant: true }) }));
  if (assistant) app.route('/api/assistant', assistant.app);
  app.get('/api/commits', (c) => json(c, prov.commits()));
  app.get('/api/files', (c) => json(c, prov.files(c.req.query('base') || prov.base, c.req.query('head') || prov.head)));
  app.get('/api/patch', (c) => c.text(prov.patch(c.req.query('base') || prov.base, c.req.query('head') || prov.head, !!c.req.query('ws'))));
  app.get('/api/read', (c) => {
    const { rev, path: p } = c.req.query();
    const text = prov.read(rev, p);
    if (text === null) return json(c, { error: 'not found' }, 404);
    return c.text(text, 200, { 'cache-control': isFullSha(rev) ? 'max-age=86400' : 'no-store' });
  });
  app.get('/api/search', (c) => {
    const q = c.req.query();
    return json(c, prov.search(q.q, q.rev || prov.head, !!q.symbol, +q.limit || 60));
  });
  app.get('/api/tree', (c) => json(c, prov.tree(c.req.query('rev') || prov.head)));
  // A headless audit reads incomplete artifacts on purpose; generation must not cover its player.
  app.get('/api/progress', (c) => json(c, readOnly ? { walkthrough: { state: 'none' }, report: { state: 'none' } } : readProgress(dir)));
  app.get('/api/state', (c) => json(c, read()));
  // The diff's size for the hub's rows. shortcut: recomputed at most every 30 s (the hub asks every 2 s and git runs
  // synchronously), so a working-tree review's numbers lag edits by up to 30 s; key it on a file watcher if that matters.
  let sized: { at: number; key: string; value: { additions: number; deletions: number; files: number } | null } | null = null;
  const diffSize = () => {
    const key = `${prov.base}..${prov.head}`;
    if (!sized || sized.key !== key || Date.now() - sized.at > 30_000) {
      let value = null;
      try {
        const files = prov.files(prov.base, prov.head);
        value = { additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), files: files.length };
      } catch {} // git failed (a rewritten base, a removed worktree): the hub shows no size
      sized = { at: Date.now(), key, value };
    }
    return sized.value ?? {};
  };
  // Counts only, no thread text: for local tools that list running reviews (agent-annotation-hub).
  app.get('/api/summary', (c) => {
    const s = read();
    const open = s.threads.filter((t) => t.status === 'open');
    const round = currentRound(s);
    let updated: string | null = null;
    try {
      updated = fs.statSync(statePath(dir)).mtime.toISOString();
    } catch {} // no state.json yet: nothing has happened
    return json(c, { ...diffSize(), updated, prReviewId: cfg.id, round: s.round, roundStatus: round?.status ?? 'open', rounds: s.rounds.length, threads: s.threads.length, open: open.length, awaitingAgent: awaitingAgent(s).length, comments: s.threads.reduce((n, t) => n + t.messages.length, 0), browserClients: clients.size, walkthrough: fs.existsSync(walkthroughPath(dir)) });
  });
  // each op is checked by applyOp, which also tells the client which one failed (index)
  app.post('/api/ops', body(z.object({ ops: z.array(z.unknown()) })), (c) => {
    const ops = c.req.valid('json').ops as Op[];
    if (ops.some((o) => o?.op === 'finishRound')) throw new OpError('bad_op', 'finish a round with POST /api/finish');
    return json(c, { rev: commit(ops).rev });
  });
  app.get('/api/walkthrough', (c) => {
    const r = readWalkthrough(dir);
    return !r ? json(c, { error: `no ${WALKTHROUGH_FILE}` }, 404) : r.ok ? json(c, r.value) : json(c, { issues: r.issues }, 422);
  });
  // the hub: every review running on this machine; started on first use
  app.get('/api/hub', async (c) => {
    const url = await ensureHub();
    return url ? c.redirect(url) : json(c, { error: `the hub did not start; see ${hubLog()}` }, 500);
  });
  // this review's dock as the reviewer left it (dockview JSON, kept whole) and the PR panels already offered
  const lastLayout = path.join(dir, 'layout.json');
  app.get('/api/layout', (c) => json(c, fs.existsSync(lastLayout) ? JSON.parse(fs.readFileSync(lastLayout, 'utf8')) : null));
  app.put('/api/layout', body(z.object({ dock: z.looseObject({ grid: z.looseObject({}), panels: z.looseObject({}) }), offered: z.array(z.string()), layout: z.string().optional() })), (c) => {
    fs.writeFileSync(lastLayout, JSON.stringify(c.req.valid('json')));
    return json(c, { ok: true });
  });
  // the reviewer's layout files by name, and which one is their default; a file that no longer parses is skipped, not fatal
  const defaultLayout = (): string | null => {
    try {
      return z.object({ layout: LayoutId }).parse(JSON.parse(fs.readFileSync(defaultLayoutFile(), 'utf8'))).layout;
    } catch {
      return null;
    }
  };
  const setDefault = (id: string | null) => (id ? fs.writeFileSync(defaultLayoutFile(), JSON.stringify({ layout: id }) + '\n') : fs.rmSync(defaultLayoutFile(), { force: true }));
  app.get('/api/layouts', (c) => {
    const files = fs.existsSync(layoutsDir()) ? fs.readdirSync(layoutsDir()).filter((f) => f.endsWith('.json')) : [];
    const read = (f: string) => {
      try {
        return Layout.parse(JSON.parse(fs.readFileSync(path.join(layoutsDir(), f), 'utf8')));
      } catch (e) {
        console.error(`reviewroom: skipping layout ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const layouts = Object.fromEntries(files.flatMap((f) => {
      const id = f.slice(0, -5);
      const l = LayoutId.safeParse(id).success && !(id in builtinLayouts) && read(f);
      return l ? [[id, l]] : [];
    }));
    return json(c, { layouts, default: defaultLayout() });
  });
  app.put('/api/default-layout', body(z.object({ layout: LayoutId.nullable() })), (c) => {
    fs.mkdirSync(path.dirname(defaultLayoutFile()), { recursive: true });
    setDefault(c.req.valid('json').layout);
    return json(c, { ok: true });
  });
  const layoutId = zValidator('param', z.object({ id: LayoutId }), (r, c) => {
    if (!r.success) return json(c, { error: 'layout names are lowercase letters, digits and dashes', code: 'bad_op' }, 400);
  });
  // saving never replaces a layout: a shipped one's name or one already saved is taken
  app.put('/api/layouts/:id', layoutId, body(Layout), (c) => {
    const { id } = c.req.valid('param');
    const file = path.join(layoutsDir(), id + '.json');
    if (id in builtinLayouts || fs.existsSync(file)) return json(c, { error: `a layout named ${id} already exists`, code: 'taken' }, 409);
    fs.mkdirSync(layoutsDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(c.req.valid('json'), null, 2) + '\n', { flag: 'wx' });
    return json(c, { ok: true });
  });
  app.delete('/api/layouts/:id', layoutId, (c) => {
    const { id } = c.req.valid('param');
    fs.rmSync(path.join(layoutsDir(), id + '.json'), { force: true });
    if (defaultLayout() === id) setDefault(null);
    return json(c, { ok: true });
  });
  app.get('/api/github', async (c) => json(c, readOnly ? (github.cached() ?? { ok: false, threads: [], error: 'not fetched (read-only server)' }) : await (c.req.query('refresh') ? github.refresh() : github.snapshot())));
  app.post('/api/github', body(GitHubAction), async (c) => json(c, await github.act(c.req.valid('json'))));
  app.get('/api/events', (c) =>
    // Hono answers HEAD with the GET handler and drops the body without aborting it: no stream for HEAD
    c.req.method === 'HEAD' ? c.body(null, 200, { 'content-type': 'text/event-stream' }) : streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ hash: hash(), started }) });
      if (!readOnly) await stream.writeSSE({ event: 'progress', data: JSON.stringify(readProgress(dir)) });
      clients.add(stream);
      const ping = setInterval(() => stream.write(': ping\n\n').catch(() => {}), 20000);
      onClient?.();
      await new Promise<void>((r) => stream.onAbort(r));
      clearInterval(ping);
      clients.delete(stream);
    }),
  );
  app.post('/api/finish', body(FinishRound.omit({ op: true, at: true })), (c) => {
    const { kind, note, round } = c.req.valid('json');
    const prev = readState(dir);
    const n = prev.round;
    const s = applyOp(prev, { op: 'finishRound', kind, note, round }); // 409 unless this round is still open
    const md = feedbackMarkdown(prev, { kind, note, dirArgs: reviewDirArgs(dir), lifecycleArgs: reviewArgs(repo, dir, cfg), codeExcerpt: (a) => excerpt(prov, a), github: github.cached()?.threads, walkthrough: validWalkthrough(dir) });
    const rdir = path.join(dir, 'rounds', String(n));
    fs.mkdirSync(rdir, { recursive: true });
    if (fs.existsSync(reviewFile)) fs.copyFileSync(reviewFile, path.join(rdir, REPORT_FILE));
    fs.writeFileSync(path.join(rdir, 'feedback.md'), md);
    writeState(dir, s);
    send('state', s);
    return json(c, { ok: true, round: s.round, state: s });
  });
  app.get(`/api/rounds/:n{[0-9]+}/${REPORT_FILE}`, serveStatic({ root: dir, rewriteRequestPath: (p) => p.replace(/^\/api/, '') }));
  // anything else: static files next to report.html (images, extra css/js the agent wrote). serveStatic refuses
  // `..`, `//` and `\`; it decodes with decodeURI, which keeps reserved chars encoded: decode those too (not %2F),
  // so `a%231.png` finds `a#1.png`. The review's own state files are never served: checked on the fully decoded path.
  const stateFile = (p: string) => {
    try {
      return /(^|\/)\.?state\.(json|lock)[^/]*$/i.test(decodeURIComponent(p));
    } catch {
      return true; // malformed escapes: serveStatic would refuse them anyway
    }
  };
  app.get(
    '*',
    async (c, next) => (stateFile(c.req.path) ? c.notFound() : next()),
    serveStatic({
      root: dir,
      allowPercentInPath: true,
      rewriteRequestPath: (p) => p.replace(/%(23|24|26|2B|2C|3A|3B|3D|3F|40)/gi, decodeURIComponent),
    }),
  );

  // for a server that ends before its process does (`slide-lint`): the watch would keep the process alive
  const close = () => { watcher?.close(); return assistant?.close(); };
  return { app, prov, commit, github, watch, close };
}

/** Serve on 127.0.0.1 at `port`, or the next free one of the `spread` after it. */
export function listen(app: Hono, port: number, spread = 20) {
  for (let p = port; ; p++) {
    try {
      // idleTimeout 0: an SSE stream is quiet for 20 s between pings, past Bun's 10 s default
      return Bun.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: p, idleTimeout: 0 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || p >= port + spread) throw e;
    }
  }
}

const openUrl = (url: string) => void open(url).catch(() => {}); // best effort: the URL is printed anyway
// `app`: hand the page to the macOS app (app/), which opens it in a tab; the browser when it isn't installed.
export const openBrowser = (url: string, app = false) =>
  app && process.platform === 'darwin' ? execFile('open', ['-b', 'dev.reviewroom.mac', url], (e) => e && openUrl(url)) : openUrl(url);
