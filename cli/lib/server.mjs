// HTTP server: review page, client bundle, JSON API, SSE live updates, and the server.json record.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { feedbackMarkdown } from './feedback.mjs';
import { makeProvider } from './git.mjs';
import { readState, writeState, answers } from './state.mjs';
import { applyOp, OpError } from './ops.mjs';
import { makeGitHub } from './github.mjs';
import { checkLinks, problems, report } from './links.mjs';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = path.join(PKG, 'dist');

function excerpt(prov, anchor) {
  if (anchor.kind !== 'code') return null;
  const text = prov.read(anchor.rev === 'base' ? prov.base : prov.head, anchor.path);
  if (!text) return null;
  const lines = text.split('\n');
  return lines.slice(anchor.start - 1, anchor.end).map((l, i) => `${String(anchor.start + i).padStart(4)}  ${l}`).join('\n');
}


const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2' };

export function startServer({ repo, dir, cfg, onFinish }) {
  const prov = makeProvider(repo, cfg);
  const clients = new Set();
  const github = makeGitHub({ repo, dir, cfg, prov, onChange: (snap) => send('github', snap) });
  const reviewFile = path.join(dir, 'review.html');
  const hash = () => (fs.existsSync(reviewFile) ? crypto.createHash('sha1').update(fs.readFileSync(reviewFile)).digest('hex').slice(0, 12) : '');
  const send = (ev, data) => {
    for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // The server holds state.lock while it runs and is the only writer of state.json (CLI writes
  // come in through /api/ops), so only review.html and its assets are watched.
  let t, edited;
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, (_e, f) => {
    if (f === 'review.html' || (f && /\.(css|js|svg|png)$/.test(f))) {
      edited ||= f === 'review.html';
      clearTimeout(t);
      t = setTimeout(() => {
        send('review', { hash: hash() });
        if (edited) (edited = false), checkNarrative();
      }, 150);
    }
  });
  // live reload is a nicety; a dead watcher (dir removed, fd limits) must not kill the server
  watcher.on('error', (e) => console.error(`reviewroom: file watch stopped: ${e.message}`));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const readJson = async (req) => {
    try {
      return JSON.parse((await body(req)) || '{}');
    } catch {
      throw new OpError('bad_op', 'request body is not JSON');
    }
  };
  // Stale-link check: fingerprint new links, tell the agent (stderr) when the report changes.
  let lastReport = '';
  const checkNarrative = () => {
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
      console.error(`reviewroom: link check failed: ${e.message}`);
    }
  };
  // Synchronous read-apply-write: requests can't interleave inside it. All-or-nothing per batch.
  const commit = (ops) => {
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
  const serveFile = (res, file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.startsWith(DIST) && !file.endsWith('reviewroom.js') ? 'max-age=3600' : 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  // Only this machine's browser tab may talk to us: other sites can reach 127.0.0.1 too
  // (no-cors GETs, form POSTs, DNS rebinding), so check Host, Sec-Fetch-Site and Origin.
  const allowed = (req, url) => {
    const port = server.address()?.port;
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!origins.includes(req.headers.host)) return false;
    if (!url.pathname.startsWith('/api/')) return true;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    return req.method === 'GET' || req.method === 'HEAD' || origin === undefined || origins.some((o) => origin === `http://${o}`);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-reviewroom-pid', String(process.pid));
    const url = new URL(req.url, 'http://x');
    if (!allowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const q = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        let html = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
        if (!html.includes('/_rr/reviewroom.js')) html = html.replace('</head>', '<script type="module" src="/_rr/reviewroom.js"></script>\n</head>');
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (url.pathname.startsWith('/_rr/')) {
        const f = path.resolve(DIST, url.pathname.slice(5));
        if (!f.startsWith(DIST + path.sep)) return json(res, 403, {});
        return serveFile(res, f);
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'max-age=86400' }); return res.end(); }
      if (url.pathname === '/api/meta') return json(res, 200, prov.meta());
      if (url.pathname === '/api/commits') return json(res, 200, prov.commits());
      if (url.pathname === '/api/files') return json(res, 200, prov.files(q.base || prov.base, q.head || prov.head));
      if (url.pathname === '/api/read') {
        const text = prov.read(q.rev, q.path);
        if (text === null) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': /^[0-9a-f]{40}$/.test(q.rev) ? 'max-age=86400' : 'no-store' });
        return res.end(text);
      }
      if (url.pathname === '/api/search') return json(res, 200, prov.search(q.q, q.rev || prov.head, !!q.symbol, +q.limit || 60));
      if (url.pathname === '/api/tree') return json(res, 200, prov.tree(q.rev || prov.head));
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, readState(dir));
      // Counts only, no thread text: for local tools that list running reviews (agent-annotation-hub).
      if (url.pathname === '/api/summary') {
        const s = readState(dir);
        const open = s.threads.filter((t) => t.status === 'open');
        const round = s.rounds.find((r) => r.n === s.round);
        return json(res, 200, { round: s.round, roundStatus: round?.status ?? 'open', rounds: s.rounds.length, threads: s.threads.length, open: open.length, awaitingAgent: open.filter((t) => t.messages.at(-1)?.author === 'you').length, comments: s.threads.reduce((n, t) => n + t.messages.length, 0), browserClients: clients.size });
      }
      if (url.pathname === '/api/ops' && req.method === 'POST') {
        const b = await readJson(req);
        const ops = Array.isArray(b.ops) ? b.ops : [b];
        if (ops.some((o) => o?.op === 'finishRound')) throw new OpError('bad_op', 'finish a round with POST /api/finish');
        return json(res, 200, { rev: commit(ops).rev });
      }
      if (url.pathname === '/api/github') {
        if (req.method === 'GET') return json(res, 200, await (q.refresh ? github.refresh() : github.snapshot()));
        if (req.method === 'POST') return json(res, 200, await github.act(await readJson(req)));
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ hash: hash() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => (clients.delete(res), clearInterval(ping)));
        server.emit('rr-client');
        return;
      }
      if (url.pathname === '/api/finish' && req.method === 'POST') {
        const { kind, note, round } = await readJson(req);
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
        json(res, 200, { ok: true, round: s.round });
        onFinish?.({ kind, md, round: n });
        return;
      }
      const m = url.pathname.match(/^\/api\/rounds\/(\d+)\/review\.html$/);
      if (m) return serveFile(res, path.join(dir, 'rounds', m[1], 'review.html'));
      // anything else: static files next to review.html (images, extra css/js the agent wrote)
      const f = path.resolve(dir, '.' + decodeURIComponent(url.pathname));
      if (!f.startsWith(dir + path.sep) || /^\.?state\.(json|lock)/.test(path.basename(f))) return json(res, 403, {});
      return serveFile(res, f);
    } catch (e) {
      if (!(e instanceof OpError)) console.error(`reviewroom: ${req.method} ${url.pathname}: ${e.message || e}`);
      json(res, e.status || 500, { error: String(e.message || e), code: e.code, index: e.index });
    }
  });
  return { server, prov, commit, github, checkNarrative };
}

export function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && left > 0 ? tryPort(p + 1, left - 1) : reject(e)));
      // the callback of a failed attempt stays registered and fires on the next success: report the real port
      server.listen(p, '127.0.0.1', () => resolve(server.address().port));
    };
    tryPort(port, 20);
  });
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {}
}


// A running server records itself so `review`/`stop` can find (and take over) it.
export const serverFile = (dir) => path.join(dir, 'server.json');
export function liveServer(dir) {
  try {
    const rec = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8'));
    process.kill(rec.pid, 0);
    return rec;
  } catch {
    return null;
  }
}
// Per-user registry of running servers, one <pid>.json each, so other local tools (an annotation hub)
// can list reviews without knowing which repos have them. Best effort: a failure never stops a review.
export const registryDir = () => path.join(process.env.REVIEWROOM_HOME || path.join(os.homedir(), '.reviewroom'), 'sessions');
export function register(rec) {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(path.join(registryDir(), `${rec.pid}.json`), JSON.stringify(rec, null, 2));
  } catch {}
}
export function unregister(pid) {
  try {
    fs.unlinkSync(path.join(registryDir(), `${pid}.json`));
  } catch {}
}
// server.json can outlive its server and the pid be reused: only signal a pid that our server reports.
export async function stopServer(dir) {
  const rec = liveServer(dir);
  if (!rec || rec.pid === process.pid || !(await answers(rec.pid, rec.port, 1500))) return null;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 30 && liveServer(dir); i++) await new Promise((r) => setTimeout(r, 100));
  return rec;
}
