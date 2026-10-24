// git runner + the git-backed provider. Everything user-supplied that reaches git argv is validated here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, Commit, ReviewMeta, SearchHit, StackPr } from '../../src/kernel/state/model.shared.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import type { ReviewConfig } from './config.ts';

type GitOpts = { soft?: boolean; encoding?: BufferEncoding };
export function git(args: string[], cwd: string, opts: GitOpts & { soft: true }): string | null;
export function git(args: string[], cwd: string, opts?: GitOpts & { soft?: false }): string;
export function git(args: string[], cwd: string, opts?: GitOpts): string | null;
export function git(args: string[], cwd: string, opts: GitOpts = {}): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (opts.soft) return null;
    const { stderr, message } = e as Error & { stderr?: Buffer | string }; // execFileSync's error
    throw new ReviewroomError(`git ${args.join(' ')}: ${(stderr || message).toString().trim()}`, 500, { cause: e }); // the CLI prints one line, not a stack
  }
}
// Network fetches must never hang on an SSH passphrase / host-key prompt or a dead VPN.
// Several refspecs go in one fetch (one connection); it fails as a whole if any of them does.
export const fetchRef = (remote: string, refspecs: string | string[], cwd: string) => {
  try {
    execFileSync('git', ['fetch', '--quiet', '--end-of-options', remote, ...[refspecs].flat()], {
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
const maxCount = (n: number) => (GREP_MAX ? [`--max-count=${n}`] : []);
const capPerFile = (hits: SearchHit[], n: number) => {
  if (GREP_MAX) return hits;
  const seen = new Map<string, number>();
  return hits.filter((h) => { const c = (seen.get(h.path) || 0) + 1; seen.set(h.path, c); return c <= n; });
};
// Every rev that reaches git argv passes through here: a leading `-` would be read as an option
// (`--output=...` writes files), so revs are restricted to ref/sha syntax.
export const isRev = (r: unknown): r is string => typeof r === 'string' && /^[\w@][\w./~^@{}+-]*$/.test(r);
export const checkRev = (r: unknown) => {
  if (isRev(r)) return r;
  throw new ReviewroomError(`invalid revision ${JSON.stringify(r)}`);
};
export const hasRef = (ref: string, cwd: string) => isRev(ref) && !!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, { soft: true });
export const repoRoot = (from: string) => (git(['rev-parse', '--show-toplevel'], from, { soft: true }) || '').trim() || null;
export const WORKTREE = 'worktree';

export function defaultBase(repo: string) {
  for (const b of ['origin/main', 'origin/master', 'main', 'master', 'origin/moj_master', 'moj_master']) {
    if (git(['rev-parse', '--verify', '--quiet', b], repo, { soft: true })) return b;
  }
  return 'HEAD~1';
}

export function remoteName(repo: string) {
  const url = (git(['remote', 'get-url', 'origin'], repo, { soft: true }) || '').trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  if (m) return m[1];
  // no remote: the main checkout's name, so every worktree of the repo gets the same one
  const common = (git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, { soft: true }) || '').trim();
  return path.basename(common ? path.dirname(common) : repo);
}

export function remoteDefaultBranch(repo: string, remote: string) {
  const r = (git(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], repo, { soft: true }) || '').trim();
  if (r) return r.replace(`refs/remotes/${remote}/`, '');
  for (const b of ['main', 'master', 'moj_master']) if (git(['rev-parse', '--verify', '--quiet', `${remote}/${b}`], repo, { soft: true })) return b;
  return 'main';
}



const STATUS: Record<string, ChangedFile['status'] | undefined> = { A: 'added', D: 'deleted', R: 'renamed' };
/** `git diff -M -z --numstat` and `--name-status` of the same range -> changed files (status from the latter). */
export function parseDiff(numstat: string, nameStatus: string): ChangedFile[] {
  const status = new Map<string, ChangedFile['status']>();
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; i++) {
    const st = ns[i];
    if (!st) continue;
    const p1 = ns[++i];
    const p2 = /^[RC]/.test(st) ? ns[++i] : null; // renames and copies list old, then new
    status.set(p2 || p1, STATUS[st[0]] ?? 'modified');
  }
  const files: ChangedFile[] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [, a, d, name] = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(parts[i])!; // a path may itself contain tabs
    const prev = name === '' ? parts[++i] : undefined; // a rename: old and new path follow as their own fields
    const file = name === '' ? parts[++i] : name;
    files.push({ path: file, prevPath: prev, additions: a === '-' ? 0 : +a, deletions: d === '-' ? 0 : +d, binary: a === '-', status: status.get(file) ?? (prev ? 'renamed' : 'modified') });
  }
  return files;
}

export type Provider = ReturnType<typeof makeProvider>;

/** The commit that last changed each line start..end of `p` at `head`, within base..head (older: '^<sha>'). */
export const blame = (repo: string, base: string, head: string, p: string, start: number, end: number) =>
  git(['blame', '-s', '-l', '--root', '-L', `${start},${end}`, `${checkRev(base)}..${checkRev(head)}`, '--', p], repo).split('\n').filter(Boolean).map((l) => l.split(' ')[0]);

/** What a provider shows, for Round.heads: the whole range's base and head, and each stack PR's head as `#<n>`, in
 *  stack order (`#`: JSON keys that look like integers would be reordered). */
export const headsOf = (prov: Pick<Provider, 'base' | 'head' | 'layers'>): Record<string, string> => ({ base: prov.base, head: prov.head, ...Object.fromEntries((prov.layers ?? []).map((l) => [`#${l.number}`, l.head])) });

/** What changed between two rounds' heads, a line each: per stack PR (or the whole range) new commits, rewritten
 *  (a force-push or restack: with `git range-diff`'s pairing of old and new commits), new or gone. Unchanged: nothing. */
export function headChanges(repo: string, was: Record<string, string>, now: Record<string, string>): string[] {
  const keys = (h: Record<string, string>) => Object.keys(h).filter((k) => k.startsWith('#'));
  const [before, after] = [keys(was), keys(now)];
  const stacked = after.length > 0;
  // a layer's base is the head of the PR below it, the bottom's the range's base
  const baseOf = (h: Record<string, string>, ks: string[], k: string) => (ks.indexOf(k) > 0 ? h[ks[ks.indexOf(k) - 1]] : h.base);
  const lines: string[] = [];
  for (const k of stacked ? after : ['head']) {
    const name = stacked ? k : 'the branch';
    const [old, cur] = [was[k], now[k]];
    if (!old) lines.push(`${name}: new in the stack`);
    else if (old === cur) continue;
    else if (git(['merge-base', '--is-ancestor', old, cur], repo, { soft: true }) !== null) {
      const n = +(git(['rev-list', '--count', `${old}..${cur}`], repo, { soft: true }) || 0);
      lines.push(`${name}: ${n} new commit${n === 1 ? '' : 's'} (${old.slice(0, 7)}..${cur.slice(0, 7)})`);
    } else {
      const from = [stacked ? baseOf(was, before, k) : was.base, old], to = [stacked ? baseOf(now, after, k) : now.base, cur];
      const pairs = (git(['range-diff', '-s', '--no-color', `${from[0]}..${from[1]}`, `${to[0]}..${to[1]}`], repo, { soft: true }) || '').trim().split('\n').filter(Boolean);
      lines.push(`${name}: rewritten (force-pushed or restacked); git range-diff ${from[0].slice(0, 12)}..${from[1].slice(0, 12)} ${to[0].slice(0, 12)}..${to[1].slice(0, 12)}:`, ...pairs.slice(0, 20).map((l) => '    ' + l), ...(pairs.length > 20 ? [`    ... ${pairs.length - 20} more`] : []));
    }
  }
  for (const k of before) if (stacked && !now[k]) lines.push(`${k}: no longer in the stack (its threads stay)`);
  return lines;
}

/** A stack PR's layer: what it adds on the PR below. `restack`: the PR below was rewritten after this one was pushed,
 *  so the layer starts where the two still agree. */
export type Layer = { number: number; base: string; head: string; restack?: true };
/** A stack's layers, bottom first. A layer's base is the head of the PR below, never a merge-base with the stack's
 *  base branch (a squash-merged PR below is not in that branch's history); the bottom's is its merge-base with `base`. */
export function stackLayers(repo: string, base: string, prs: { number: number; head: string }[]): Layer[] {
  const sha = (ref: string) => git(['rev-parse', checkRev(ref) + '^{commit}'], repo).trim();
  const mergeBase = (a: string, b: string) => (git(['merge-base', a, b], repo, { soft: true }) || '').trim();
  let below = '';
  return prs.map((p) => {
    const head = sha(p.head);
    const from = below || mergeBase(sha(base), head) || sha(base);
    const restack = !!below && git(['merge-base', '--is-ancestor', below, head], repo, { soft: true }) === null;
    below = head;
    return { number: p.number, base: restack ? mergeBase(from, head) || from : from, head, ...(restack && { restack: true as const }) };
  });
}

export function makeProvider(repo: string, cfg: ReviewConfig) {
  const resolve = (ref: string) => (ref === WORKTREE ? WORKTREE : git(['rev-parse', checkRev(ref)], repo).trim());
  const head = resolve(cfg.head);
  const headCommit = head === WORKTREE ? git(['rev-parse', 'HEAD'], repo).trim() : head;
  const layers = cfg.stack ? stackLayers(repo, cfg.base, cfg.stack.prs) : null;
  // a stack: from the bottom layer's base, so a squash-merged PR below doesn't drag its commits back in
  const base = layers?.[0].base ?? (git(['merge-base', resolve(cfg.base), headCommit], repo, { soft: true }) || resolve(cfg.base)).trim();
  const isWT = (r: string) => r === WORKTREE;
  const realRepo = fs.realpathSync(repo);
  // heads are pinned for the provider's life: a stack's layers are computed once, on first use
  let stack: StackPr[] | undefined, byCommit: Map<string, number> | undefined;
  const stackPrs = () =>
    (stack ??= layers!.map((l, i) => {
      const p = cfg.stack!.prs[i];
      const changed = files(l.base, l.head);
      const state = p.state === 'open' ? (p.review ?? 'open') : p.state;
      return { number: p.number, title: p.title, author: p.author, url: p.url, state, headLabel: p.headLabel, base: l.base, head: l.head, ...(l.restack && { restack: true }), additions: changed.reduce((a, f) => a + f.additions, 0), deletions: changed.reduce((a, f) => a + f.deletions, 0), files: changed.length };
    }));
  // which layer a commit is in: the first (from the bottom) that has it
  const prOf = (sha: string) => (byCommit ??= new Map(layers!.toReversed().flatMap((l) => git(['rev-list', `${l.base}..${l.head}`], repo).split('\n').filter(Boolean).map((c) => [c, l.number] as const)))).get(sha);
  function files(b: string, h: string): ChangedFile[] {
    const range = isWT(h) ? [checkRev(b)] : [checkRev(b), checkRev(h)];
    const files = parseDiff(git(['diff', '--numstat', '-M', '-z', '--end-of-options', ...range], repo), git(['diff', '--name-status', '-M', '-z', '--end-of-options', ...range], repo));
    if (isWT(h)) {
      const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
      for (const p of untracked) {
        // nested repos are listed as `dir/`
        if (p.endsWith('/') || !fs.statSync(path.join(repo, p)).isFile()) continue;
        const buf = fs.readFileSync(path.join(repo, p));
        // same heuristic as git: a NUL in the first 8000 bytes means binary
        const binary = buf.subarray(0, 8000).includes(0);
        files.push({ path: p, additions: binary ? 0 : buf.toString('utf8').split('\n').length, deletions: 0, binary, status: 'added' });
      }
    }
    return files;
  }
  return {
    base,
    head,
    layers,
    meta(): Omit<ReviewMeta, 'id'> {
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
        ...(layers && { stack: stackPrs() }),
      };
    },
    commits(): Commit[] {
      if (isWT(head)) return [];
      const out = git(['log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P', `${base}..${head}`], repo).trim();
      return out ? out.split('\n').map((l) => { const [sha, short, subject, author, date, parents] = l.split('\x1f'); return { sha, short, subject, author, date, parent: parents.split(' ')[0] || undefined, ...(layers && { pr: prOf(sha) }) }; }) : [];
    },
    files,
    /** The range's diff for the client to render from; prefixes and colour pinned against the user's git config. */
    patch(b: string, h: string, ws: boolean): string {
      const range = isWT(h) ? [checkRev(b)] : [checkRev(b), checkRev(h)];
      return git(['-c', 'core.quotePath=false', 'diff', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', ...(ws ? ['-w'] : []), '--end-of-options', ...range], repo);
    },
    read(rev: string, p: string): string | null {
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
    search(q: unknown, rev: string, symbol?: boolean, limit = 60): SearchHit[] {
      if (typeof q !== 'string') return [];
      const r = isWT(rev) ? [] : [checkRev(rev)];
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // -z: `[<rev>:]<path>\0<line>\0<text>`, so paths containing `:<n>:` parse correctly
      const grep = (opts: string[], pattern: string, kind: SearchHit['kind']) =>
        (git(['grep', '-n', '-z', '-I', ...opts, '-e', pattern, ...r], repo, { soft: true }) || '')
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [name, line, ...text] = l.split('\0');
            if (!text.length) return null;
            const file = !isWT(rev) && name.startsWith(rev + ':') ? name.slice(rev.length + 1) : name;
            return { path: file, line: +line, text: text.join('\0').trim().slice(0, 240), rev, kind };
          })
          .filter((h) => h !== null);
      let hits: SearchHit[] = [];
      if (symbol) {
        const def = `(func|type|class|def|interface|struct|enum|message|service|const|let|var|fn|trait|object)[[:space:]]+(\\([^)]*\\)[[:space:]]*)?${esc}([^[:alnum:]_]|$)`;
        hits = capPerFile(grep(['-E', ...maxCount(20)], def, 'definition'), 20);
        const refs = capPerFile(grep(['-w', '-F', ...maxCount(10)], q, 'reference'), 10);
        for (const x of refs) if (!hits.some((y) => y.path === x.path && y.line === x.line)) hits.push(x);
      } else hits = capPerFile(grep(['-i', '-F', ...maxCount(20)], q, 'text'), 20);
      return hits.slice(0, limit);
    },
    tree(rev: string): string[] {
      if (isWT(rev)) return git(['ls-files'], repo).split('\n').filter(Boolean);
      return git(['ls-tree', '-r', '--name-only', '--end-of-options', checkRev(rev)], repo).split('\n').filter(Boolean);
    },
  };
}
