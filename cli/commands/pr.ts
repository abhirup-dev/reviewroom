// pr: the one-step entry point
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { die } from '../lib/args.ts';
import { type ReviewConfig, git, fetchRef, hasRef, defaultBase, remoteDefaultBranch, ensureExcluded, makeProvider } from '../lib/git.ts';
import { scaffold } from '../lib/scaffold.ts';
import { resolveDir, loadConfig, readConfig, configPath } from '../lib/state.ts';
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

export async function cmdPr(repo: string | null, o: PrOpts, arg?: string) {
  if (!repo) die('not inside a git repository (cd into the project, or pass --repo <path>)');
  const { remote } = o;
  const m = arg?.match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/);
  const cfg: Partial<ReviewConfig> = {};
  let dir: string;
  if (m) {
    const n = m[1];
    const info = gh(repo, ['pr', 'view', n, '--json', 'number,title,author,baseRefName,headRefName,url']);
    console.error(`reviewroom: fetching PR #${n}${info ? ` “${info.title}”` : ''} from ${remote}…`);
    let ref = `refs/reviewroom/pr-${n}`;
    const fetched = fetchRef(remote, `+refs/pull/${n}/head:${ref}`, repo)
      || (info?.headRefName && fetchRef(remote, `+refs/heads/${info.headRefName}:${ref}`, repo));
    if (!fetched) {
      // Offline, SSH without an agent, or not GitHub: fall back to what is already local.
      const local = [ref, `pr-${n}`, `pr/${n}`, `${remote}/pr/${n}`, info?.headRefName, info?.headRefName && `${remote}/${info.headRefName}`].filter(Boolean).find((r) => hasRef(r, repo));
      if (!local) die(`could not fetch PR #${n} from ${remote} and found no local copy (tried refs/pull/${n}/head, branches pr-${n}, pr/${n}).\n  Fetch it yourself (git fetch ${remote} pull/${n}/head:pr-${n}) or pass the branch name: reviewroom pr <branch>`);
      console.error(`reviewroom: fetch failed; using local ${local} (may be behind the PR)`);
      ref = local;
    }
    const baseBranch = (o.base ?? info?.baseRefName) || remoteDefaultBranch(repo, remote);
    if (fetched) fetchRef(remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`, repo);
    const base = [`${remote}/${baseBranch}`, baseBranch].find((r) => hasRef(r, repo)) || die(`base branch ${baseBranch} not found locally or on ${remote} (pass --base <ref>)`);
    Object.assign(cfg, { base, head: ref, number: +n, title: o.title ?? info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` });
    dir = path.join(repo, '.reviewroom', `pr-${n}`);
  } else if (!arg) {
    // no target: the current branch (or --base/--head), nothing fetched
    dir = resolveDir(repo, o.dir);
    Object.assign(cfg, loadConfig(dir, repo, o));
  } else {
    const branch = arg;
    let head = branch;
    if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
      fetchRef(remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, repo);
      head = `${remote}/${branch}`;
      if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) die(`no branch or PR called “${branch}”`);
    }
    Object.assign(cfg, { base: o.base ?? defaultBase(repo), head, title: o.title });
    dir = path.join(repo, '.reviewroom', branch.replace(/[^\w.-]+/g, '-'));
  }
  if (o.dir) dir = path.resolve(o.dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(repo);
  const full = { ...readConfig(dir), ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== null)) } as ReviewConfig;
  fs.writeFileSync(configPath(dir), JSON.stringify(full, null, 2));
  const fresh = scaffold(repo, dir, full, !!o.force);
  const prov = makeProvider(repo, full);
  const files = prov.files(prov.base, prov.head);
  console.error(`reviewroom: ${files.length} files changed · review: ${path.relative(process.cwd(), path.join(dir, 'review.html'))}${fresh ? ' (scaffolded — fill it in)' : ''}`);
  // serve this dir; --base/--head/--title are in config.json now
  const serveOpts: ServeOpts = { ...o, dir, base: undefined, head: undefined, title: undefined };

  if (o.detach) {
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
        console.error(`reviewroom: server running in the background (pid ${rec.pid}) · stop with \`reviewroom stop --dir ${shortPath(dir)}\``);
        return process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    die(`server did not start — see ${path.join(dir, 'server.log')}`);
  }
  await cmdServe(repo, serveOpts, !!o.wait, dir);
}
