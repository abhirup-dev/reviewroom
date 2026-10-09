// pr: the one-step entry point
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flags, pos, die } from '../lib/args.mjs';
import { git, fetchRef, hasRef, defaultBase, remoteDefaultBranch, ensureExcluded, makeProvider } from '../lib/git.mjs';
import { scaffold } from '../lib/scaffold.mjs';
import { liveServer, stopServer } from '../lib/server.mjs';
import { cmdServe } from './serve.mjs';

// --detach respawns the bin entry, not this module
const ENTRY = fileURLToPath(new URL('../readingroom.mjs', import.meta.url));

function gh(repo, args) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

export async function cmdPr(repo) {
  if (!repo) die('not inside a git repository (cd into the project, or pass --repo <path>)');
  const arg = pos.shift() || die('usage: readingroom pr <number | PR url | branch>');
  const remote = typeof flags.remote === 'string' ? flags.remote : 'origin';
  const m = String(arg).match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/);
  const cfg = {};
  let dir;
  if (m) {
    const n = m[1];
    const info = gh(repo, ['pr', 'view', n, '--json', 'number,title,author,baseRefName,headRefName,url']);
    console.error(`readingroom: fetching PR #${n}${info ? ` “${info.title}”` : ''} from ${remote}…`);
    let ref = `refs/readingroom/pr-${n}`;
    const fetched = fetchRef(remote, `+refs/pull/${n}/head:${ref}`, repo)
      || (info?.headRefName && fetchRef(remote, `+refs/heads/${info.headRefName}:${ref}`, repo));
    if (!fetched) {
      // Offline, SSH without an agent, or not GitHub: fall back to what is already local.
      const local = [ref, `pr-${n}`, `pr/${n}`, `${remote}/pr/${n}`, info?.headRefName, info?.headRefName && `${remote}/${info.headRefName}`].filter(Boolean).find((r) => hasRef(r, repo));
      if (!local) die(`could not fetch PR #${n} from ${remote} and found no local copy (tried refs/pull/${n}/head, branches pr-${n}, pr/${n}).\n  Fetch it yourself (git fetch ${remote} pull/${n}/head:pr-${n}) or pass the branch name: readingroom pr <branch>`);
      console.error(`readingroom: fetch failed; using local ${local} (may be behind the PR)`);
      ref = local;
    }
    const baseBranch = (typeof flags.base === 'string' ? flags.base : info?.baseRefName) || remoteDefaultBranch(repo, remote);
    if (fetched) fetchRef(remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`, repo);
    const base = [`${remote}/${baseBranch}`, baseBranch].find((r) => hasRef(r, repo)) || die(`base branch ${baseBranch} not found locally or on ${remote} (pass --base <ref>)`);
    Object.assign(cfg, { base, head: ref, number: +n, title: typeof flags.title === 'string' ? flags.title : info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` });
    dir = path.join(repo, '.readingroom', `pr-${n}`);
  } else {
    const branch = String(arg);
    let head = branch;
    if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
      fetchRef(remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, repo);
      head = `${remote}/${branch}`;
      if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) die(`no branch or PR called “${branch}”`);
    }
    Object.assign(cfg, { base: typeof flags.base === 'string' ? flags.base : defaultBase(repo), head, title: typeof flags.title === 'string' ? flags.title : undefined });
    dir = path.join(repo, '.readingroom', branch.replace(/[^\w.-]+/g, '-'));
  }
  if (typeof flags.dir === 'string') dir = path.resolve(flags.dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(repo);
  const prevCfg = fs.existsSync(path.join(dir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : {};
  const full = { ...prevCfg, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== null)) };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(full, null, 2));
  const fresh = scaffold(repo, dir, full);
  const prov = makeProvider(repo, full);
  const files = prov.files(prov.base, prov.head);
  console.error(`readingroom: ${files.length} files changed · review: ${path.relative(process.cwd(), path.join(dir, 'review.html'))}${fresh ? ' (scaffolded — fill it in)' : ''}`);
  flags.dir = dir;
  for (const k of ['base', 'head', 'title']) delete flags[k];

  if (flags.detach) {
    const args = [ENTRY, 'serve', '--repo', repo, '--dir', dir];
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
  await cmdServe(repo, !!flags.wait, dir);
}
