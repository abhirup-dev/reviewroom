#!/usr/bin/env node
// readingroom CLI — local server + review rounds.  Zero dependencies.
//
//   readingroom pr <number|url|branch> [--repo path] [--detach] [--wait]
//                      one step: fetch the PR (gh if available), scaffold .readingroom/pr-<n>/,
//                      start the server. --detach backgrounds it; --wait blocks for the round.
//   readingroom stop   [dir]            stop a detached server
//   readingroom init   [dir] [--base main] [--head HEAD] [--title "…"]   scaffold a review
//   readingroom review [dir] [...]   serve, open the browser, block until the reviewer sends
//                                    feedback or approves; print the feedback for the agent
//   readingroom serve  [dir] [...]   same server, never exits (for a long-running session)
//   readingroom threads [dir] [--all] [--json]       list threads (what the agent must answer)
//   readingroom reply <thread> "<markdown>" [--resolve] [dir]   answer a thread as the agent ("-" = stdin)
//   readingroom comment <rr-ref> "<markdown>" [dir]  start a thread as the agent
//   readingroom resolve <thread> [dir]
//   readingroom status [dir]
//
// The review dir defaults to <repo>/.readingroom/<branch>/ and holds:
//   review.html            the narrative (written by the agent, any HTML)
//   state.json             threads, rounds, viewed files, sign-offs
//   config.json            repo/base/head/title
//   rounds/<n>/            snapshot of review.html + feedback.md for every finished round
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { feedbackMarkdown } from './lib/feedback.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PKG, 'dist');

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const die = (msg, code = 1) => {
  console.error('readingroom: ' + msg);
  process.exit(code);
};

// ------------------------------------------------------------------ git
const git = (args, cwd, opts = {}) => {
  try {
    return execFileSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (opts.soft) return null;
    throw new Error(`git ${args.join(' ')}: ${(e.stderr || e.message).toString().trim()}`);
  }
};
const repoRoot = (from) => (git(['rev-parse', '--show-toplevel'], from, { soft: true }) || '').trim() || null;
const WORKTREE = 'worktree';

function resolveDir(repo) {
  if (flags.dir) return path.resolve(flags.dir);
  const p = pos.find((x) => fs.existsSync(x) && fs.statSync(x).isDirectory());
  if (p) return path.resolve(p);
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim().replace(/[^\w.-]+/g, '-');
  return path.join(repo, '.readingroom', branch);
}

function loadConfig(dir, repo) {
  const file = path.join(dir, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const k of ['base', 'head', 'title', 'repo-name', 'number', 'author', 'url']) if (typeof flags[k] === 'string') cfg[k === 'repo-name' ? 'repo' : k] = flags[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  return cfg;
}

function defaultBase(repo) {
  for (const b of ['origin/main', 'origin/master', 'main', 'master', 'origin/moj_master', 'moj_master']) {
    if (git(['rev-parse', '--verify', '--quiet', b], repo, { soft: true })) return b;
  }
  return 'HEAD~1';
}

function remoteName(repo) {
  const url = (git(['remote', 'get-url', 'origin'], repo, { soft: true }) || '').trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : path.basename(repo);
}

// ------------------------------------------------------------------ state
const emptyState = () => ({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }], threads: [], viewed: {}, pins: [] });
const statePath = (dir) => path.join(dir, 'state.json');
function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return emptyState();
  }
}
function writeState(dir, s) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = statePath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statePath(dir));
}
const uid = (p) => p + crypto.randomBytes(4).toString('hex');

// ------------------------------------------------------------------ git-backed provider
function makeProvider(repo, cfg) {
  const resolve = (ref) => (ref === WORKTREE ? WORKTREE : git(['rev-parse', ref], repo).trim());
  const head = resolve(cfg.head);
  const headCommit = head === WORKTREE ? git(['rev-parse', 'HEAD'], repo).trim() : head;
  const base = (git(['merge-base', resolve(cfg.base), headCommit], repo, { soft: true }) || resolve(cfg.base)).trim();
  const isWT = (r) => r === WORKTREE;
  return {
    base,
    head,
    meta() {
      const subject = !isWT(head) ? git(['log', '-1', '--format=%s', head], repo).trim() : 'Working tree changes';
      return {
        title: cfg.title || subject,
        repo: cfg.repo || remoteName(repo),
        number: cfg.number,
        author: cfg.author || (!isWT(head) ? git(['log', '-1', '--format=%an', head], repo).trim() : undefined),
        url: cfg.url,
        base,
        head,
        baseLabel: cfg.baseLabel || cfg.base,
        headLabel: cfg.headLabel || (isWT(head) ? 'working tree' : (git(['rev-parse', '--abbrev-ref', cfg.head], repo, { soft: true }) || cfg.head).trim()),
      };
    },
    commits() {
      if (isWT(head)) return [];
      const out = git(['log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', `${base}..${head}`], repo).trim();
      return out ? out.split('\n').map((l) => { const [sha, short, subject, author, date] = l.split('\x1f'); return { sha, short, subject, author, date }; }) : [];
    },
    files(b, h) {
      const range = isWT(h) ? [b] : [b, h];
      const num = git(['diff', '--numstat', '-M', '-z', ...range], repo);
      const files = [];
      const parts = num.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p) continue;
        const [a, d, name] = p.split('\t');
        let file, prev;
        if (name === '') {
          prev = parts[++i];
          file = parts[++i];
        } else file = name;
        files.push({ path: file, prevPath: prev, additions: a === '-' ? 0 : +a, deletions: d === '-' ? 0 : +d, binary: a === '-', status: prev ? 'renamed' : 'modified' });
      }
      const ns = git(['diff', '--name-status', '-M', '-z', ...range], repo).split('\0');
      for (let i = 0; i < ns.length; i++) {
        const st = ns[i];
        if (!st) continue;
        const p1 = ns[++i];
        const p2 = st.startsWith('R') || st.startsWith('C') ? ns[++i] : null;
        const f = files.find((x) => x.path === (p2 || p1));
        if (f) f.status = st[0] === 'A' ? 'added' : st[0] === 'D' ? 'deleted' : st[0] === 'R' ? 'renamed' : 'modified';
      }
      if (isWT(h)) {
        const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], repo).split('\0').filter((p) => p && !p.startsWith('.readingroom/'));
        for (const p of untracked) {
          const n = fs.readFileSync(path.join(repo, p), 'utf8').split('\n').length;
          files.push({ path: p, additions: n, deletions: 0, status: 'added' });
        }
      }
      return files.filter((f) => !f.path.startsWith('.readingroom/'));
    },
    read(rev, p) {
      if (isWT(rev)) {
        const full = path.resolve(repo, p);
        if (!full.startsWith(repo) || !fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf8');
      }
      return git(['show', `${rev}:${p}`], repo, { soft: true });
    },
    search(q, rev, symbol, limit = 60) {
      const r = isWT(rev) ? [] : [rev];
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parse = (out, kind) =>
        (out || '')
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const m = l.match(/^(?:[^:]+:)?(.+?):(\d+):(.*)$/);
            if (!m) return null;
            const file = isWT(rev) ? m[1] : m[1];
            return { path: file, line: +m[2], text: m[3].trim().slice(0, 240), rev, kind };
          })
          .filter(Boolean);
      const fix = (hits) => hits.map((h) => ({ ...h, path: h.path.startsWith(rev + ':') ? h.path.slice(rev.length + 1) : h.path }));
      let hits = [];
      if (symbol) {
        const def = `(func|type|class|def|interface|struct|enum|message|service|const|let|var|fn|trait|object)[[:space:]]+(\\([^)]*\\)[[:space:]]*)?${esc}([^[:alnum:]_]|$)`;
        hits = fix(parse(git(['grep', '-n', '-I', '-E', '--max-count=20', def, ...r, '--', '.', ':!.readingroom'], repo, { soft: true }), 'definition'));
        const refs = fix(parse(git(['grep', '-n', '-I', '-w', '-F', '--max-count=10', q, ...r, '--', '.', ':!.readingroom'], repo, { soft: true }), 'reference'));
        for (const x of refs) if (!hits.some((y) => y.path === x.path && y.line === x.line)) hits.push(x);
      } else hits = fix(parse(git(['grep', '-n', '-I', '-i', '-F', '--max-count=20', q, ...r, '--', '.', ':!.readingroom'], repo, { soft: true }), 'text'));
      return hits.slice(0, limit);
    },
    tree(rev) {
      if (isWT(rev)) return git(['ls-files'], repo).split('\n').filter(Boolean);
      return git(['ls-tree', '-r', '--name-only', rev], repo).split('\n').filter(Boolean);
    },
  };
}

function excerpt(prov, anchor) {
  if (anchor.kind !== 'code') return null;
  const text = prov.read(anchor.rev === 'base' ? prov.base : prov.head, anchor.path);
  if (!text) return null;
  const lines = text.split('\n');
  return lines.slice(anchor.start - 1, anchor.end).map((l, i) => `${String(anchor.start + i).padStart(4)}  ${l}`).join('\n');
}

// ------------------------------------------------------------------ server
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2' };

function startServer({ repo, dir, cfg, onFinish }) {
  const prov = makeProvider(repo, cfg);
  const clients = new Set();
  let lastState = fs.existsSync(statePath(dir)) ? fs.readFileSync(statePath(dir), 'utf8') : '';
  const reviewFile = path.join(dir, 'review.html');
  const hash = () => (fs.existsSync(reviewFile) ? crypto.createHash('sha1').update(fs.readFileSync(reviewFile)).digest('hex').slice(0, 12) : '');
  const send = (ev, data) => {
    for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let t1, t2;
  fs.mkdirSync(dir, { recursive: true });
  fs.watch(dir, (_e, f) => {
    if (f === 'state.json') {
      clearTimeout(t1);
      t1 = setTimeout(() => {
        const raw = fs.existsSync(statePath(dir)) ? fs.readFileSync(statePath(dir), 'utf8') : '';
        if (raw && raw !== lastState) {
          lastState = raw;
          try {
            send('state', JSON.parse(raw));
          } catch {}
        }
      }, 80);
    } else if (f === 'review.html' || (f && /\.(css|js|svg|png)$/.test(f))) {
      clearTimeout(t2);
      t2 = setTimeout(() => send('review', { hash: hash() }), 150);
    }
  });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const serveFile = (res, file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.startsWith(DIST) && !file.endsWith('readingroom.js') ? 'max-age=3600' : 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
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
        if (!f.startsWith(DIST)) return json(res, 403, {});
        return serveFile(res, f);
      }
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
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        const raw = await body(req);
        const s = JSON.parse(raw);
        lastState = JSON.stringify(s, null, 2);
        writeState(dir, s);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ hash: hash(), round: readState(dir).round })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => (clients.delete(res), clearInterval(ping)));
        server.emit('rr-client');
        return;
      }
      if (url.pathname === '/api/finish' && req.method === 'POST') {
        const { kind, note } = JSON.parse((await body(req)) || '{}');
        const s = readState(dir);
        const n = s.round;
        const md = feedbackMarkdown(s, { kind, note, codeExcerpt: (a) => excerpt(prov, a) });
        const rdir = path.join(dir, 'rounds', String(n));
        fs.mkdirSync(rdir, { recursive: true });
        if (fs.existsSync(reviewFile)) fs.copyFileSync(reviewFile, path.join(rdir, 'review.html'));
        fs.writeFileSync(path.join(rdir, 'feedback.md'), md);
        const r = s.rounds.find((x) => x.n === n);
        if (r) Object.assign(r, { status: kind === 'approve' ? 'approved' : 'sent', sentAt: new Date().toISOString(), note });
        if (kind === 'feedback') {
          s.round = n + 1;
          s.rounds.push({ n: n + 1, status: 'open', startedAt: new Date().toISOString() });
        }
        lastState = JSON.stringify(s, null, 2);
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
      if (!f.startsWith(dir) || path.basename(f) === 'state.json') return json(res, 403, {});
      return serveFile(res, f);
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });
  return { server, prov };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && left > 0 ? tryPort(p + 1, left - 1) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryPort(port, 20);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {}
}

function ensureExcluded(repo) {
  const ex = path.join(repo, '.git', 'info', 'exclude');
  try {
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!cur.split('\n').includes('.readingroom/')) fs.appendFileSync(ex, (cur.endsWith('\n') || !cur ? '' : '\n') + '.readingroom/\n');
  } catch {}
}

// ------------------------------------------------------------------ commands
const repo = repoRoot(flags.repo ? path.resolve(flags.repo) : process.cwd());

function scaffold(dir, cfg) {
  const target = path.join(dir, 'review.html');
  if (fs.existsSync(target) && !flags.force) return false;
  const prov = makeProvider(repo, cfg);
  const meta = prov.meta();
  const files = prov.files(prov.base, prov.head);
  let html = fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
  html = html.replaceAll('{{TITLE}}', meta.title.replace(/[<&]/g, '')).replace('{{FILES}}', files.map((f) => `          <li><rr-ref ref="rr:code/${f.path}"></rr-ref> — ${f.status}, +${f.additions} −${f.deletions}</li>`).join('\n'));
  fs.writeFileSync(target, html);
  return true;
}

// A running server records itself so `review`/`stop` can find (and take over) it.
const serverFile = (dir) => path.join(dir, 'server.json');
function liveServer(dir) {
  try {
    const rec = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8'));
    process.kill(rec.pid, 0);
    return rec;
  } catch {
    return null;
  }
}
async function stopServer(dir) {
  const rec = liveServer(dir);
  if (!rec || rec.pid === process.pid) return null;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 30 && liveServer(dir); i++) await new Promise((r) => setTimeout(r, 100));
  return rec;
}

async function cmdServe(blocking) {
  if (!repo) die('not inside a git repository (use --repo <path>)');
  const dir = resolveDir(repo);
  const cfg = loadConfig(dir, repo);
  // take over a detached server for the same review (same port, so an open tab reconnects)
  const prev = await stopServer(dir);
  if (prev && !flags.port) flags.port = String(prev.port);
  fs.mkdirSync(dir, { recursive: true });
  if (dir.startsWith(path.join(repo, '.readingroom'))) ensureExcluded(repo);
  if (!fs.existsSync(path.join(dir, 'config.json')) || flags.base || flags.head || flags.title) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(DIST, 'readingroom.js'))) die(`missing build at ${DIST} — run \`npm run build\` in ${PKG}`);
  let finish;
  const done = new Promise((r) => (finish = r));
  const { server } = startServer({ repo, dir, cfg, onFinish: (f) => finish(f) });
  const port = await listen(server, +(flags.port || 4848));
  const url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(serverFile(dir), JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }));
  const cleanup = () => {
    try {
      if (JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')).pid === process.pid) fs.unlinkSync(serverFile(dir));
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const s = readState(dir);
  console.error(`readingroom: ${path.relative(process.cwd(), dir) || '.'} · round ${s.round} · ${url}`);
  if (!flags['no-open']) {
    // a tab from the previous round reconnects on its own; only open one if nobody shows up
    let seen = false;
    server.once('rr-client', () => (seen = true));
    setTimeout(() => !seen && openBrowser(url), +(flags['open-delay'] || 2500));
  }
  if (!blocking) return;
  const res = await done;
  setTimeout(() => {
    process.stdout.write(res.md + '\n');
    console.error(`\nreadingroom: round ${res.round} ${res.kind === 'approve' ? 'approved' : 'feedback saved'} → ${path.join(dir, 'rounds', String(res.round), 'feedback.md')}`);
    server.closeAllConnections?.();
    server.close();
    process.exit(0);
  }, 150);
}

function threadArg() {
  const id = pos.shift();
  if (!id) die('missing thread id');
  return id;
}
function findThread(s, id) {
  const t = s.threads.find((x) => x.id === id) || s.threads.filter((x) => x.id.startsWith(id) || x.id === 't_' + id)[0];
  if (!t) die(`no thread ${id}`);
  return t;
}
function readBody() {
  let b = pos.shift();
  if (b === '-' || (!b && !process.stdin.isTTY)) b = fs.readFileSync(0, 'utf8');
  if (typeof flags.file === 'string') b = fs.readFileSync(flags.file, 'utf8');
  if (!b?.trim()) die('missing message body');
  return b.trim();
}
const dirForEdit = () => {
  if (!repo && !flags.dir) die('not inside a git repository (use --dir)');
  return flags.dir ? path.resolve(flags.dir) : resolveDir(repo);
};

function parseAnchor(ref) {
  const m = ref.match(/^rr:(\w+)\/(.*)$/);
  if (!m) return { kind: 'general' };
  const [, type, rest] = m;
  if (type === 'doc') {
    const [id, ...p] = rest.split('/');
    return { kind: 'doc', target: decodeURIComponent(id), path: p.length ? decodeURIComponent(p.join('/')) : undefined };
  }
  if (type === 'code') {
    const lm = rest.match(/#L(\d+)(?:-L?(\d+))?$/);
    let p = lm ? rest.slice(0, lm.index) : rest;
    let rev = 'head';
    const at = p.lastIndexOf('@');
    if (at > 0) (rev = p.slice(at + 1)), (p = p.slice(0, at));
    return { kind: 'code', path: p, rev: rev === 'base' ? 'base' : 'head', start: lm ? +lm[1] : 1, end: lm ? +(lm[2] || lm[1]) : 1 };
  }
  if (type === 'sym') return { kind: 'symbol', name: decodeURIComponent(rest) };
  return { kind: 'general' };
}

// ------------------------------------------------------------------ pr: the one-step entry point
function gh(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}
function remoteDefaultBranch(remote) {
  const r = (git(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], repo, { soft: true }) || '').trim();
  if (r) return r.replace(`refs/remotes/${remote}/`, '');
  for (const b of ['main', 'master', 'moj_master']) if (git(['rev-parse', '--verify', '--quiet', `${remote}/${b}`], repo, { soft: true })) return b;
  return 'main';
}

async function cmdPr() {
  if (!repo) die('not inside a git repository (cd into the project, or pass --repo <path>)');
  const arg = pos.shift() || die('usage: readingroom pr <number | PR url | branch>');
  const remote = typeof flags.remote === 'string' ? flags.remote : 'origin';
  const m = String(arg).match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/);
  const cfg = {};
  let dir;
  if (m) {
    const n = m[1];
    const info = gh(['pr', 'view', n, '--json', 'number,title,author,baseRefName,headRefName,url']);
    console.error(`readingroom: fetching PR #${n}${info ? ` “${info.title}”` : ''} from ${remote}…`);
    const ref = `refs/readingroom/pr-${n}`;
    if (!git(['fetch', '--quiet', remote, `+refs/pull/${n}/head:${ref}`], repo, { soft: true }) && !git(['rev-parse', '--verify', '--quiet', ref], repo, { soft: true })) {
      if (info?.headRefName && git(['fetch', '--quiet', remote, `+refs/heads/${info.headRefName}:${ref}`], repo, { soft: true }) === null) die(`could not fetch PR #${n} from ${remote}`);
      if (!info) die(`could not fetch refs/pull/${n}/head from ${remote} (is it a GitHub remote? is \`gh\` logged in?)`);
    }
    const baseBranch = info?.baseRefName || (typeof flags.base === 'string' ? flags.base : remoteDefaultBranch(remote));
    git(['fetch', '--quiet', remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`], repo, { soft: true });
    Object.assign(cfg, { base: `${remote}/${baseBranch}`, head: ref, number: +n, title: info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` });
    dir = path.join(repo, '.readingroom', `pr-${n}`);
  } else {
    const branch = String(arg);
    let head = branch;
    if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
      git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], repo, { soft: true });
      head = `${remote}/${branch}`;
      if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) die(`no branch or PR called “${branch}”`);
    }
    Object.assign(cfg, { base: typeof flags.base === 'string' ? flags.base : defaultBase(repo), head });
    dir = path.join(repo, '.readingroom', branch.replace(/[^\w.-]+/g, '-'));
  }
  if (typeof flags.dir === 'string') dir = path.resolve(flags.dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(repo);
  const prevCfg = fs.existsSync(path.join(dir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : {};
  const full = { ...prevCfg, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== null)) };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(full, null, 2));
  const fresh = scaffold(dir, full);
  const prov = makeProvider(repo, full);
  const files = prov.files(prov.base, prov.head);
  console.error(`readingroom: ${files.length} files changed · review: ${path.relative(process.cwd(), path.join(dir, 'review.html'))}${fresh ? ' (scaffolded — fill it in)' : ''}`);
  flags.dir = dir;
  for (const k of ['base', 'head', 'title']) delete flags[k];

  if (flags.detach) {
    const args = [fileURLToPath(import.meta.url), 'serve', '--repo', repo, '--dir', dir];
    if (flags.port) args.push('--port', String(flags.port));
    if (flags['no-open']) args.push('--no-open');
    await stopServer(dir);
    const out = fs.openSync(path.join(dir, 'server.log'), 'a');
    spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] }).unref();
    for (let i = 0; i < 50; i++) {
      const rec = liveServer(dir);
      if (rec) {
        console.log(rec.url);
        console.error(`readingroom: server running in the background (pid ${rec.pid}) · stop with \`readingroom stop --dir ${path.relative(process.cwd(), dir) || '.'}\``);
        return process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    die(`server did not start — see ${path.join(dir, 'server.log')}`);
  }
  await cmdServe(!!flags.wait);
}

switch (cmd) {
  case 'pr':
    await cmdPr();
    break;
  case 'stop': {
    const dir = dirForEdit();
    const rec = await stopServer(dir);
    console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review');
    break;
  }
  case 'serve':
    await cmdServe(false);
    break;
  case 'review':
    await cmdServe(true);
    break;
  case 'init': {
    if (!repo) die('not inside a git repository');
    const dir = resolveDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = loadConfig(dir, repo);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    if (!scaffold(dir, cfg)) console.error(`readingroom: ${path.join(dir, 'review.html')} exists (use --force to overwrite)`);
    ensureExcluded(repo);
    console.log(dir);
    break;
  }
  case 'threads': {
    const dir = dirForEdit();
    const s = readState(dir);
    const list = s.threads.filter((t) => flags.all || t.status === 'open');
    if (flags.json) {
      console.log(JSON.stringify({ round: s.round, threads: list }, null, 2));
      break;
    }
    console.log(`round ${s.round} · ${list.length} ${flags.all ? '' : 'open '}thread(s)`);
    for (const t of list) {
      const last = t.messages[t.messages.length - 1];
      console.log(`\n${t.id}  [${t.status}]  ${JSON.stringify(t.anchor)}`);
      for (const m of t.messages) console.log(`  ${m.author}@r${m.round}: ${m.body.split('\n').join('\n    ')}`);
      if (last?.author === 'you') console.log('  → awaiting agent reply');
    }
    break;
  }
  case 'reply': {
    const dir = dirForEdit();
    const id = threadArg();
    const bodyText = readBody();
    const s = readState(dir);
    const t = findThread(s, id);
    t.messages.push({ id: uid('m_'), author: 'agent', round: s.round, body: bodyText, at: new Date().toISOString() });
    if (flags.resolve) t.status = 'resolved';
    writeState(dir, s);
    console.log(`replied to ${t.id}${flags.resolve ? ' (resolved)' : ''}`);
    break;
  }
  case 'comment': {
    const dir = dirForEdit();
    const ref = pos.shift() || die('missing rr: ref (or "general")');
    const bodyText = readBody();
    const s = readState(dir);
    const t = { id: uid('t_'), anchor: parseAnchor(ref), status: 'open', createdRound: s.round, messages: [{ id: uid('m_'), author: 'agent', round: s.round, body: bodyText, at: new Date().toISOString() }] };
    s.threads.push(t);
    writeState(dir, s);
    console.log(t.id);
    break;
  }
  case 'resolve': {
    const dir = dirForEdit();
    const s = readState(dir);
    findThread(s, threadArg()).status = 'resolved';
    writeState(dir, s);
    console.log('resolved');
    break;
  }
  case 'status': {
    const dir = dirForEdit();
    const s = readState(dir);
    const open = s.threads.filter((t) => t.status === 'open');
    const waiting = open.filter((t) => t.messages[t.messages.length - 1]?.author === 'you');
    if (flags.json) {
      const cfg = fs.existsSync(path.join(dir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : {};
      let base, head;
      try {
        const p = makeProvider(repo, loadConfig(dir, repo));
        ({ base, head } = p);
      } catch {}
      console.log(JSON.stringify({ dir, review: path.join(dir, 'review.html'), url: liveServer(dir)?.url ?? null, base, head, config: cfg, round: s.round, threads: s.threads.length, open: open.length, awaitingAgent: waiting.map((t) => t.id) }, null, 2));
      break;
    }
    console.log(`${dir}\nround ${s.round} (${s.rounds.find((r) => r.n === s.round)?.status}) · ${s.threads.length} threads · ${open.length} open · ${waiting.length} awaiting agent reply`);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
