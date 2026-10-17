// HTTP server: review page, client bundle, JSON API, SSE live updates.
import { execFile } from 'node:child_process';
import open from 'open';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { feedbackMarkdown } from '../../src/shared/feedback.ts';
import { makeProvider, type Provider } from './git.ts';
import type { ReviewConfig } from './config.ts';
import type { Anchor, Op } from '../../src/core/types.ts';
import { readState, writeState } from './state.ts';
import { DIST, PKG, layoutFile } from './paths.ts';
import { applyOp, OpError, ReviewroomError } from '../../src/shared/ops.ts';
import { makeGitHub } from './github.ts';
import { checkLinks, problems, report } from './links.ts';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { FinishRound, GitHubAction, issueText } from '../../src/shared/schema.ts';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { getBunServer, serveStatic } from '@hono/bun';

function excerpt(prov: Provider, anchor: Anchor) {
  if (anchor.kind !== 'code') return null;
  const text = prov.read(anchor.rev === 'base' ? prov.base : prov.head, anchor.path);
  if (!text) return null;
  const lines = text.split('\n');
  return lines.slice(anchor.start - 1, anchor.end).map((l, i) => `${String(anchor.start + i).padStart(4)}  ${l}`).join('\n');
}


export interface Finished {
  kind: 'feedback' | 'approve';
  md: string;
  round: number;
}

/** Watch the review dir for review.html and its assets (debounced); `edited` = review.html itself changed.
 *  The server is the only writer of state.json (it holds state.lock), so that is not watched. */
function watchNarrative(dir: string, onChange: (edited: boolean) => void) {
  let t: NodeJS.Timeout | undefined, edited = false;
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, (_e, f: string | null) => {
    if (f === 'review.html' || (f && /\.(css|js|svg|png)$/.test(f))) {
      edited ||= f === 'review.html';
      clearTimeout(t);
      t = setTimeout(() => {
        onChange(edited);
        edited = false;
      }, 150);
    }
  });
  // live reload is a nicety; a dead watcher (dir removed, fd limits) must not kill the server
  watcher.on('error', (e) => console.error(`reviewroom: file watch stopped: ${e.message}`));
}

/** Stale-link check of review.html: fingerprint new links, tell the agent (stderr) when the report changes. */
function narrativeCheck(repo: string, dir: string, cfg: ReviewConfig, commit: (ops: Op[]) => unknown) {
  const reviewFile = path.join(dir, 'review.html');
  let lastReport = '';
  return () => {
    try {
      if (!fs.existsSync(reviewFile)) return;
      const known = readState(dir).links ?? {};
      // the current head, not the one this server started on: `check` must fingerprint the same code
      const { results, links } = checkLinks(fs.readFileSync(reviewFile, 'utf8'), makeProvider(repo, cfg), known);
      if (JSON.stringify(links) !== JSON.stringify(known)) commit([{ op: 'setLinks', links }]);
      const bad = problems(results);
      const text = bad.length ? `reviewroom: ${bad.length} stale link${bad.length > 1 ? 's' : ''} in review.html; \`reviewroom check --fix\` heals the moved ones:\n${report(bad)}` : '';
      if (text && text !== lastReport) console.error(text);
      lastReport = text;
    } catch (e) {
      console.error(`reviewroom: link check failed: ${(e as Error).message}`);
    }
  };
}

type ServerOpts = { repo: string; dir: string; cfg: ReviewConfig; onFinish?: (f: Finished) => void };
export function startServer({ repo, dir, cfg, onFinish }: ServerOpts) {
  const prov = makeProvider(repo, cfg);
  const started = new Date().toISOString(); // a page tells this run from the next one by it
  const clients = new Set<SSEStreamingApi>();
  const github = makeGitHub({ repo, dir, cfg, prov, onChange: (snap) => send('github', snap) });
  const reviewFile = path.join(dir, 'review.html');
  const hash = () => (fs.existsSync(reviewFile) ? crypto.createHash('sha1').update(fs.readFileSync(reviewFile)).digest('hex').slice(0, 12) : '');
  const send = (event: string, data: unknown) => {
    for (const c of clients) c.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
  };
  const json = (c: Context, body: unknown, code = 200) => c.json(body, code as ContentfulStatusCode);
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
  watchNarrative(dir, (edited) => {
    send('review', { hash: hash() });
    if (edited) checkNarrative();
  });

  // Only this machine's browser tab may talk to us: other sites can reach 127.0.0.1 too
  // (no-cors GETs, form POSTs, DNS rebinding), so check Host, Sec-Fetch-Site and Origin.
  const allowed = (c: Context) => {
    const port = getBunServer<Bun.Server<undefined>>(c)?.port;
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!origins.includes(c.req.header('host') ?? '')) return false;
    if (!c.req.path.startsWith('/api/')) return true;
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = c.req.header('origin');
    return c.req.method === 'GET' || c.req.method === 'HEAD' || origin === undefined || origins.some((o) => origin === `http://${o}`);
  };

  const app = new Hono();
  app.use(async (c, next) => {
    c.header('x-reviewroom-pid', String(process.pid));
    c.header('cache-control', 'no-store'); // unless a route says otherwise
    if (!allowed(c)) return json(c, { error: 'forbidden' }, 403);
    await next();
  });
  app.notFound((c) => json(c, { error: 'not found' }, 404));
  app.onError((e, c) => {
    if (e instanceof HTTPException) return json(c, { error: e.message, code: 'bad_op' }, e.status); // malformed JSON
    if (!(e instanceof OpError)) console.error(`reviewroom: ${c.req.method} ${c.req.path}: ${e.message}`);
    const op = e instanceof OpError ? e : undefined;
    return json(c, { error: e.message, code: op?.code, index: op?.index }, e instanceof ReviewroomError ? e.status : 500);
  });

  const page = (c: Context) => {
    let html = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
    if (!html.includes('/_rr/reviewroom.js')) html = html.replace('</head>', '<script type="module" src="/_rr/reviewroom.js"></script>\n</head>');
    return c.html(html);
  };
  app.get('/', page);
  app.get('/index.html', page);
  // the client build; reviewroom.js is the entry and changes with every build, its chunks are content-hashed
  app.get(
    '/_rr/*',
    async (c, next) => (c.header('cache-control', c.req.path.endsWith('/reviewroom.js') ? 'no-store' : 'max-age=3600'), next()),
    serveStatic({ root: DIST, rewriteRequestPath: (p) => p.replace(/^\/_rr/, '') }),
  );
  app.get('/favicon.ico', (c) => c.body(null, 204, { 'cache-control': 'max-age=86400' }));
  app.get('/api/meta', (c) => json(c, prov.meta()));
  app.get('/api/commits', (c) => json(c, prov.commits()));
  app.get('/api/files', (c) => json(c, prov.files(c.req.query('base') || prov.base, c.req.query('head') || prov.head)));
  app.get('/api/patch', (c) => c.text(prov.patch(c.req.query('base') || prov.base, c.req.query('head') || prov.head, !!c.req.query('ws'))));
  app.get('/api/read', (c) => {
    const { rev, path: p } = c.req.query();
    const text = prov.read(rev, p);
    if (text === null) return json(c, { error: 'not found' }, 404);
    return c.text(text, 200, { 'cache-control': /^[0-9a-f]{40}$/.test(rev) ? 'max-age=86400' : 'no-store' });
  });
  app.get('/api/search', (c) => {
    const q = c.req.query();
    return json(c, prov.search(q.q, q.rev || prov.head, !!q.symbol, +q.limit || 60));
  });
  app.get('/api/tree', (c) => json(c, prov.tree(c.req.query('rev') || prov.head)));
  app.get('/api/state', (c) => json(c, readState(dir)));
  // Counts only, no thread text: for local tools that list running reviews (agent-annotation-hub).
  app.get('/api/summary', (c) => {
    const s = readState(dir);
    const open = s.threads.filter((t) => t.status === 'open');
    const round = s.rounds.find((r) => r.n === s.round);
    return json(c, { round: s.round, roundStatus: round?.status ?? 'open', rounds: s.rounds.length, threads: s.threads.length, open: open.length, awaitingAgent: open.filter((t) => t.messages.at(-1)?.author === 'you').length, comments: s.threads.reduce((n, t) => n + t.messages.length, 0), browserClients: clients.size });
  });
  // each op is checked by applyOp, which also tells the client which one failed (index)
  app.post('/api/ops', body(z.object({ ops: z.array(z.unknown()) })), (c) => {
    const ops = c.req.valid('json').ops as Op[];
    if (ops.some((o) => o?.op === 'finishRound')) throw new OpError('bad_op', 'finish a round with POST /api/finish');
    return json(c, { rev: commit(ops).rev });
  });
  app.get('/api/layout', (c) => json(c, fs.existsSync(layoutFile()) ? JSON.parse(fs.readFileSync(layoutFile(), 'utf8')) : null));
  app.delete('/api/layout', (c) => (fs.rmSync(layoutFile(), { force: true }), json(c, { ok: true })));
  // a dockview layout, kept whole (loose: unknown keys stay)
  app.put('/api/layout', body(z.looseObject({ grid: z.looseObject({}), panels: z.looseObject({}) })), (c) => {
    fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
    fs.writeFileSync(layoutFile(), JSON.stringify(c.req.valid('json')));
    return json(c, { ok: true });
  });
  app.get('/api/github', async (c) => json(c, await (c.req.query('refresh') ? github.refresh() : github.snapshot())));
  app.post('/api/github', body(GitHubAction), async (c) => json(c, await github.act(c.req.valid('json'))));
  app.get('/api/events', (c) =>
    // Hono answers HEAD with the GET handler and drops the body without aborting it: no stream for HEAD
    c.req.method === 'HEAD' ? c.body(null, 200, { 'content-type': 'text/event-stream' }) : streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ hash: hash(), started }) });
      clients.add(stream);
      const ping = setInterval(() => stream.write(': ping\n\n').catch(() => {}), 20000);
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
    const md = feedbackMarkdown(prev, { kind, note, dir, codeExcerpt: (a) => excerpt(prov, a), github: github.cached()?.threads });
    const rdir = path.join(dir, 'rounds', String(n));
    fs.mkdirSync(rdir, { recursive: true });
    if (fs.existsSync(reviewFile)) fs.copyFileSync(reviewFile, path.join(rdir, 'review.html'));
    fs.writeFileSync(path.join(rdir, 'feedback.md'), md);
    writeState(dir, s);
    send('state', s);
    const res = json(c, { ok: true, round: s.round, state: s });
    onFinish?.({ kind, md, round: n }); // serve.ts exits 150 ms later, after this response is out
    return res;
  });
  app.get('/api/rounds/:n{[0-9]+}/review.html', serveStatic({ root: dir, rewriteRequestPath: (p) => p.replace(/^\/api/, '') }));
  // anything else: static files next to review.html (images, extra css/js the agent wrote). serveStatic refuses
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

  return { app, prov, commit, github, checkNarrative, watchers: () => clients.size }; // watchers: pages connected now
}

/** Serve on 127.0.0.1 at `port`, or the next free one of the 20 after it. */
export function listen(app: Hono, port: number) {
  for (let p = port; ; p++) {
    try {
      // idleTimeout 0: an SSE stream is quiet for 20 s between pings, past Bun's 10 s default
      return Bun.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: p, idleTimeout: 0 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || p >= port + 20) throw e;
    }
  }
}

const openUrl = (url: string) => void open(url).catch(() => {}); // best effort: the URL is printed anyway
// The macOS app (app/) opens a tab for each review registered with open: 'app': launch it when installed, else the browser.
export const openBrowser = (url: string, app: boolean) =>
  app && process.platform === 'darwin' ? execFile('open', ['-b', 'dev.reviewroom.mac'], (e) => e && openUrl(url)) : openUrl(url);
