// HTTP server: review page, client bundle, JSON API, SSE live updates, and the server.json record.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { feedbackMarkdown } from './feedback.mjs';
import { makeProvider } from './git.mjs';
import { readState, writeState, answers } from './state.mjs';
import { applyOp, OpError } from './ops.mjs';

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
  const reviewFile = path.join(dir, 'review.html');
  const hash = () => (fs.existsSync(reviewFile) ? crypto.createHash('sha1').update(fs.readFileSync(reviewFile)).digest('hex').slice(0, 12) : '');
  const send = (ev, data) => {
    for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // The server holds state.lock while it runs and is the only writer of state.json (CLI writes
  // come in through /api/ops), so only review.html and its assets are watched.
  let t;
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, (_e, f) => {
    if (f === 'review.html' || (f && /\.(css|js|svg|png)$/.test(f))) {
      clearTimeout(t);
      t = setTimeout(() => send('review', { hash: hash() }), 150);
    }
  });
  // live reload is a nicety; a dead watcher (dir removed, fd limits) must not kill the server
  watcher.on('error', (e) => console.error(`readingroom: file watch stopped: ${e.message}`));

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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.startsWith(DIST) && !file.endsWith('readingroom.js') ? 'max-age=3600' : 'no-store' });
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
    res.setHeader('x-readingroom-pid', String(process.pid));
    const url = new URL(req.url, 'http://x');
    if (!allowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const q = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        let html = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
        if (!html.includes('/_rr/readingroom.js')) html = html.replace('</head>', '<script type="module" src="/_rr/readingroom.js"></script>\n</head>');
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
      if (url.pathname === '/api/ops' && req.method === 'POST') {
        const b = await readJson(req);
        const ops = Array.isArray(b.ops) ? b.ops : [b];
        if (ops.some((o) => o?.op === 'finishRound')) throw new OpError('bad_op', 'finish a round with POST /api/finish');
        return json(res, 200, { rev: commit(ops).rev });
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
        const md = feedbackMarkdown(prev, { kind, note, codeExcerpt: (a) => excerpt(prov, a) });
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
      if (!(e instanceof OpError)) console.error(`readingroom: ${req.method} ${url.pathname}: ${e.message || e}`);
      json(res, e.status || 500, { error: String(e.message || e), code: e.code, index: e.index });
    }
  });
  return { server, prov, commit };
}

export function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && left > 0 ? tryPort(p + 1, left - 1) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
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
