// git runner + the git-backed provider. Everything user-supplied that reaches git argv is validated here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const git = (args, cwd, opts = {}) => {
  try {
    return execFileSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (opts.soft) return null;
    throw new Error(`git ${args.join(' ')}: ${(e.stderr || e.message).toString().trim()}`);
  }
};
// Network fetches must never hang on an SSH passphrase / host-key prompt or a dead VPN.
export const fetchRef = (remote, refspec, cwd) => {
  try {
    execFileSync('git', ['fetch', '--quiet', '--end-of-options', remote, refspec], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
    });
    return true;
  } catch { return false; }
};
// `git grep --max-count` needs git >= 2.38 (Ubuntu 22.04 ships 2.34); cap in JS otherwise.
const GREP_MAX = (() => {
  const m = (git(['--version'], process.cwd(), { soft: true }) || '').match(/(\d+)\.(\d+)/);
  return !!m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 38));
})();
const maxCount = (n) => (GREP_MAX ? [`--max-count=${n}`] : []);
const capPerFile = (hits, n) => {
  if (GREP_MAX) return hits;
  const seen = new Map();
  return hits.filter((h) => { const c = (seen.get(h.path) || 0) + 1; seen.set(h.path, c); return c <= n; });
};
// Every rev that reaches git argv passes through here: a leading `-` would be read as an option
// (`--output=…` writes files), so revs are restricted to ref/sha syntax.
export const isRev = (r) => typeof r === 'string' && /^[\w@][\w./~^@{}+-]*$/.test(r);
export const checkRev = (r) => {
  if (isRev(r)) return r;
  throw Object.assign(new Error(`invalid revision ${JSON.stringify(r)}`), { status: 400 });
};
export const hasRef = (ref, cwd) => isRev(ref) && !!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, { soft: true });
export const repoRoot = (from) => (git(['rev-parse', '--show-toplevel'], from, { soft: true }) || '').trim() || null;
export const WORKTREE = 'worktree';

export function defaultBase(repo) {
  for (const b of ['origin/main', 'origin/master', 'main', 'master', 'origin/moj_master', 'moj_master']) {
    if (git(['rev-parse', '--verify', '--quiet', b], repo, { soft: true })) return b;
  }
  return 'HEAD~1';
}

export function remoteName(repo) {
  const url = (git(['remote', 'get-url', 'origin'], repo, { soft: true }) || '').trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : path.basename(repo);
}

export function remoteDefaultBranch(repo, remote) {
  const r = (git(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], repo, { soft: true }) || '').trim();
  if (r) return r.replace(`refs/remotes/${remote}/`, '');
  for (const b of ['main', 'master', 'moj_master']) if (git(['rev-parse', '--verify', '--quiet', `${remote}/${b}`], repo, { soft: true })) return b;
  return 'main';
}


export function ensureExcluded(repo) {
  const ex = path.join(repo, '.git', 'info', 'exclude');
  try {
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!cur.split('\n').includes('.readingroom/')) fs.appendFileSync(ex, (cur.endsWith('\n') || !cur ? '' : '\n') + '.readingroom/\n');
  } catch {}
}

export function makeProvider(repo, cfg) {
  const resolve = (ref) => (ref === WORKTREE ? WORKTREE : git(['rev-parse', checkRev(ref)], repo).trim());
  const head = resolve(cfg.head);
  const headCommit = head === WORKTREE ? git(['rev-parse', 'HEAD'], repo).trim() : head;
  const base = (git(['merge-base', resolve(cfg.base), headCommit], repo, { soft: true }) || resolve(cfg.base)).trim();
  const isWT = (r) => r === WORKTREE;
  const realRepo = fs.realpathSync(repo);
  return {
    base,
    head,
    meta() {
      // Without a PR title, the oldest commit of the range describes the change better than the latest fixup.
      const subject = isWT(head) ? 'Working tree changes'
        : (git(['log', '--reverse', '--format=%s', `${base}..${head}`], repo, { soft: true }) || '').split('\n')[0].trim() || git(['log', '-1', '--format=%s', head], repo).trim();
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
      const range = isWT(h) ? [checkRev(b)] : [checkRev(b), checkRev(h)];
      const num = git(['diff', '--numstat', '-M', '-z', '--end-of-options', ...range], repo);
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
      const ns = git(['diff', '--name-status', '-M', '-z', '--end-of-options', ...range], repo).split('\0');
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
          // nested repos are listed as `dir/`
          if (p.endsWith('/') || !fs.statSync(path.join(repo, p)).isFile()) continue;
          const buf = fs.readFileSync(path.join(repo, p));
          // same heuristic as git: a NUL in the first 8000 bytes means binary
          const binary = buf.subarray(0, 8000).includes(0);
          files.push({ path: p, additions: binary ? 0 : buf.toString('utf8').split('\n').length, deletions: 0, binary, status: 'added' });
        }
      }
      return files.filter((f) => !f.path.startsWith('.readingroom/'));
    },
    read(rev, p) {
      if (isWT(rev)) {
        let full;
        try {
          full = fs.realpathSync(path.resolve(repo, p));
        } catch {
          return null;
        }
        if (!full.startsWith(realRepo + path.sep) || !fs.statSync(full).isFile()) return null;
        return fs.readFileSync(full, 'utf8');
      }
      return git(['show', '--end-of-options', `${checkRev(rev)}:${p}`], repo, { soft: true });
    },
    search(q, rev, symbol, limit = 60) {
      if (typeof q !== 'string') return [];
      const r = isWT(rev) ? [] : [checkRev(rev)];
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // -z: `[<rev>:]<path>\0<line>\0<text>`, so paths containing `:<n>:` parse correctly
      const grep = (opts, pattern, kind) =>
        (git(['grep', '-n', '-z', '-I', ...opts, '-e', pattern, ...r, '--', '.', ':!.readingroom'], repo, { soft: true }) || '')
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [name, line, ...text] = l.split('\0');
            if (!text.length) return null;
            const file = !isWT(rev) && name.startsWith(rev + ':') ? name.slice(rev.length + 1) : name;
            return { path: file, line: +line, text: text.join('\0').trim().slice(0, 240), rev, kind };
          })
          .filter(Boolean);
      let hits = [];
      if (symbol) {
        const def = `(func|type|class|def|interface|struct|enum|message|service|const|let|var|fn|trait|object)[[:space:]]+(\\([^)]*\\)[[:space:]]*)?${esc}([^[:alnum:]_]|$)`;
        hits = capPerFile(grep(['-E', ...maxCount(20)], def, 'definition'), 20);
        const refs = capPerFile(grep(['-w', '-F', ...maxCount(10)], q, 'reference'), 10);
        for (const x of refs) if (!hits.some((y) => y.path === x.path && y.line === x.line)) hits.push(x);
      } else hits = capPerFile(grep(['-i', '-F', ...maxCount(20)], q, 'text'), 20);
      return hits.slice(0, limit);
    },
    tree(rev) {
      if (isWT(rev)) return git(['ls-files'], repo).split('\n').filter(Boolean);
      return git(['ls-tree', '-r', '--name-only', '--end-of-options', checkRev(rev)], repo).split('\n').filter(Boolean);
    },
  };
}
