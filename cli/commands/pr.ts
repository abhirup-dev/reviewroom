// pr: the one-step entry point
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../lib/args.ts';
import { git, fetchRef, hasRef, defaultBase, remoteDefaultBranch, ensureExcluded, makeProvider } from '../lib/git.ts';
import { scaffold } from '../lib/scaffold.ts';
import { type ReviewConfig, resolveDir, loadConfig, readConfig, configPath } from '../lib/config.ts';
import { liveServer, stopServer } from '../lib/registry.ts';
import { cmdServe, type ServeOpts } from './serve.ts';

// a path as the user would type it: relative when inside the cwd, else absolute
const shortPath = (p: string) => (path.relative(process.cwd(), p).startsWith('..') ? p : path.relative(process.cwd(), p) || '.');
// --detach respawns the running entry (the source or the bundle)
const ENTRY = process.argv[1];

function gh(repo: string, args: string[]) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

export type PrOpts = ServeOpts & { remote: string; force?: boolean; detach?: boolean; wait?: boolean };
/** Where the review lives and what it compares; base and head are always resolved. */
type Target = { dir: string; cfg: ReviewConfig };

/** `pr <n>`: fetch the PR's head (or fall back to a local copy) and its base branch. */
function prTarget(repo: string, o: PrOpts, n: string): Target {
  const { remote } = o;
  const info = gh(repo, ['pr', 'view', n, '--json', 'number,title,author,baseRefName,headRefName,url']);
  console.error(`reviewroom: fetching PR #${n}${info ? ` "${info.title}"` : ''} from ${remote}...`);
  let head = `refs/reviewroom/pr-${n}`;
  const fetched = fetchRef(remote, `+refs/pull/${n}/head:${head}`, repo) || (info?.headRefName && fetchRef(remote, `+refs/heads/${info.headRefName}:${head}`, repo));
  if (!fetched) {
    // Offline, SSH without an agent, or not GitHub: fall back to what is already local.
    const local = [head, `pr-${n}`, `pr/${n}`, `${remote}/pr/${n}`, info?.headRefName, info?.headRefName && `${remote}/${info.headRefName}`].filter(Boolean).find((r) => hasRef(r, repo));
    if (!local) fail(`could not fetch PR #${n} from ${remote} and found no local copy (tried refs/pull/${n}/head, branches pr-${n}, pr/${n}).\n  Fetch it yourself (git fetch ${remote} pull/${n}/head:pr-${n}) or pass the branch name: reviewroom pr <branch>`);
    console.error(`reviewroom: fetch failed; using local ${local} (may be behind the PR)`);
    head = local;
  }
  const baseBranch = (o.base ?? info?.baseRefName) || remoteDefaultBranch(repo, remote);
  if (fetched) fetchRef(remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`, repo);
  const base = [`${remote}/${baseBranch}`, baseBranch].find((r) => hasRef(r, repo));
  if (!base) fail(`base branch ${baseBranch} not found locally or on ${remote} (pass --base <ref>)`);
  const cfg = { base, head, number: +n, title: o.title ?? info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` };
  return { dir: path.join(repo, '.reviewroom', `pr-${n}`), cfg };
}

/** `pr <branch>`: a local branch, or one fetched from the remote, against --base or the default branch. */
function branchTarget(repo: string, o: PrOpts, branch: string): Target {
  let head = branch;
  if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
    fetchRef(o.remote, `+refs/heads/${branch}:refs/remotes/${o.remote}/${branch}`, repo);
    head = `${o.remote}/${branch}`;
    if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) fail(`no branch or PR called "${branch}"`);
  }
  return { dir: path.join(repo, '.reviewroom', branch.replace(/[^\w.-]+/g, '-')), cfg: { base: o.base ?? defaultBase(repo), head, title: o.title } };
}

/** `pr`: the current branch (or --base/--head), nothing fetched. */
function localTarget(repo: string, o: PrOpts): Target {
  const dir = resolveDir(repo, o.dir);
  return { dir, cfg: loadConfig(dir, repo, o) };
}

export async function cmdPr(repo: string | null, o: PrOpts, arg?: string) {
  if (!repo) fail('not inside a git repository (cd into the project, or pass --repo <path>)');
  const n = arg?.match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/)?.[1];
  const t = n ? prTarget(repo, o, n) : arg ? branchTarget(repo, o, arg) : localTarget(repo, o);
  const dir = o.dir ? path.resolve(o.dir) : t.dir;
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(repo);
  // what this run found wins over config.json; what it did not find (undefined) keeps the file's value
  const cfg = { ...readConfig(dir), ...Object.fromEntries(Object.entries(t.cfg).filter(([, v]) => v !== undefined)) } as ReviewConfig;
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
  const fresh = scaffold(repo, dir, cfg, !!o.force);
  const prov = makeProvider(repo, cfg);
  const files = prov.files(prov.base, prov.head);
  console.error(`reviewroom: ${files.length} files changed | review: ${path.relative(process.cwd(), path.join(dir, 'review.html'))}${fresh ? ' (scaffolded - fill it in)' : ''}`);

  if (!o.detach) return cmdServe(repo, { dir, port: o.port, open: o.open }, !!o.wait); // --base/--head/--title are in config.json now
  const args = [ENTRY, 'review', '--forever', '--repo', repo, '--dir', dir];
  if (o.port) args.push('--port', o.port);
  if (!o.open) args.push('--no-open');
  await stopServer(dir);
  const out = fs.openSync(path.join(dir, 'server.log'), 'a');
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 50; i++) {
    const rec = liveServer(dir);
    if (rec) {
      console.log(rec.url);
      console.error(`reviewroom: server running in the background (pid ${rec.pid}) | stop with \`reviewroom stop --dir ${shortPath(dir)}\``);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`server did not start - see ${path.join(dir, 'server.log')}`);
}
