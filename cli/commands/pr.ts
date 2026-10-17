// pr: the one-step entry point
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../lib/args.ts';
import { git, fetchRef, hasRef, defaultBase, remoteDefaultBranch, makeProvider } from '../lib/git.ts';
import { scaffold } from '../lib/scaffold.ts';
import { type ReviewConfig, type StackConfig, resolveDir, branchDir, stackDir, stackReview, loadConfig, readConfig, configPath } from '../lib/config.ts';
import { liveServer, stopServer } from '../lib/registry.ts';
import { fetchPr, fetchStack, gql, prTarget as prOf } from '../lib/github.ts';
import { detectStack, type Query } from '../lib/stack.ts';
import { walkthroughPath } from '../lib/state.ts';
import { chainWalkthroughs, pickBlock } from '../lib/walkthrough.ts';
import { parseWalkthrough } from '../../src/shared/walkthrough.ts';
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

export type PrOpts = ServeOpts & { remote: string; force?: boolean; detach?: boolean; wait?: boolean; stack?: boolean };
/** Where the review lives and what it compares; base and head are always resolved. */
type Target = { dir: string; cfg: ReviewConfig };

const prRef = (n: number | string) => `refs/reviewroom/pr-${n}`;
/** A PR's head already here, when fetching failed. Offline, SSH without an agent, or not GitHub. */
const localCopy = (repo: string, remote: string, n: number | string, branch?: string) =>
  [prRef(n), `pr-${n}`, `pr/${n}`, `refs/pr/${n}`, `${remote}/pr/${n}`, branch, branch && `${remote}/${branch}`].filter((r): r is string => !!r).find((r) => hasRef(r, repo));

/** `pr <n>`: fetch the PR's head (or fall back to a local copy) and its base branch; and its stack's, when it is in one. */
async function prTarget(repo: string, o: PrOpts, n: string): Promise<Target> {
  const { remote } = o;
  const info = gh(repo, ['pr', 'view', n, '--json', 'number,title,author,baseRefName,headRefName,url']);
  console.error(`reviewroom: fetching PR #${n}${info ? ` "${info.title}"` : ''} from ${remote}...`);
  let head = prRef(n);
  const fetched = fetchRef(remote, `+refs/pull/${n}/head:${head}`, repo) || (info?.headRefName && fetchRef(remote, `+refs/heads/${info.headRefName}:${head}`, repo));
  if (!fetched) {
    const local = localCopy(repo, remote, n, info?.headRefName);
    if (!local) fail(`could not fetch PR #${n} from ${remote} and found no local copy (tried refs/pull/${n}/head, branches pr-${n}, pr/${n}).\n  Fetch it yourself (git fetch ${remote} pull/${n}/head:pr-${n}) or pass the branch name: reviewroom pr <branch>`);
    console.error(`reviewroom: fetch failed; using local ${local} (may be behind the PR)`);
    head = local;
  }
  const found = o.stack === false ? null : fetched && info?.url ? await stackOf(repo, remote, info.url) : undefined;
  // could not tell (offline, GitHub failed): keep the stack the review already has, not turn it into one PR's review
  const kept = found === undefined ? (o.dir ? path.resolve(o.dir) : stackReview(repo, (p) => p.number === +n)) : undefined;
  const stack = kept ? (readConfig(kept).stack ?? undefined) : found;
  const baseBranch = (o.base ?? stack?.base ?? info?.baseRefName) || remoteDefaultBranch(repo, remote);
  if (fetched) fetchRef(remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`, repo);
  const base = [`${remote}/${baseBranch}`, baseBranch].find((r) => hasRef(r, repo));
  if (!base) fail(`base branch ${baseBranch} not found locally or on ${remote} (pass --base <ref>)`);
  const top = stack?.prs.at(-1);
  const cfg = { base, head: top?.head ?? head, number: +n, title: o.title ?? info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: top?.headLabel ?? (info?.headRefName || `PR #${n}`), stack };
  // a stack has one review, whichever of its PRs it was opened from, and keeps it when its id changes (the bottom merged)
  if (stack) return { dir: kept ?? stackReview(repo, (p) => stack.prs.some((q) => q.number === p.number)) ?? stackDir(repo, stack.id), cfg };
  return { dir: branchDir(repo, info?.headRefName || `pr-${n}`), cfg }; // pr-<n> only when gh can't name the branch
}

/** The stack the PR at `url` is in, its PRs' heads fetched (null: none, the review is the PR alone; undefined: GitHub can't say). */
async function stackOf(repo: string, remote: string, url: string): Promise<StackConfig | null | undefined> {
  const t = prOf({ url })!;
  const q: Query = (query, vars = {}) => gql(repo, t.host, query, { owner: t.owner, name: t.name, ...vars });
  // a PR the description names is below this one only if its head is in this one's history
  const has = (sha: string) => git(['cat-file', '-e', `${sha}^{commit}`], repo, { soft: true }) !== null;
  const isAncestor = (a: string, b: string, n: number) => (has(a) || fetchRef(remote, `+refs/pull/${n}/head:${prRef(n)}`, repo)) && git(['merge-base', '--is-ancestor', a, b], repo, { soft: true }) !== null;
  let s;
  try {
    s = await detectStack(t, q, isAncestor);
  } catch (e) {
    console.error(`reviewroom: could not look for a stack of PRs: ${(e as Error).message}`);
    return undefined;
  }
  if (!s) return null;
  const how = { native: "GitHub's stack", chain: 'their branches', body: 'the PR descriptions' }[s.source];
  console.error(`reviewroom: PR #${t.number} is in a stack of ${s.prs.length} PRs (${s.prs.map((p) => '#' + p.number).join(', ')}, found from ${how}); fetching their heads...`);
  // every head in one fetch; when that fails, each on its own, then what is already here
  const all = fetchRef(remote, s.prs.map((p) => `+refs/pull/${p.number}/head:${prRef(p.number)}`), repo);
  const prs = s.prs.map((p) => {
    const ok = all || fetchRef(remote, `+refs/pull/${p.number}/head:${prRef(p.number)}`, repo);
    const head = ok ? prRef(p.number) : localCopy(repo, remote, p.number, p.headRefName);
    if (!head) fail(`could not fetch PR #${p.number} of the stack from ${remote} and found no local copy; fetch it (git fetch ${remote} pull/${p.number}/head:pr-${p.number}) or pass --no-stack`);
    if (!ok && git(['rev-parse', head], repo).trim() !== p.headRefOid) console.error(`reviewroom: PR #${p.number}: using local ${head}, behind the PR`);
    const review = p.reviewDecision === 'APPROVED' ? ('approved' as const) : p.reviewDecision === 'CHANGES_REQUESTED' ? ('changes' as const) : undefined;
    return { number: p.number, title: p.title, author: p.author?.login, url: p.url, state: p.state.toLowerCase() as Lowercase<typeof p.state>, ...(review && { review }), headLabel: p.headRefName, head };
  });
  return { id: s.id, source: s.source, base: s.base, prs };
}

/** `pr <branch>`: a local branch, or one fetched from the remote, against --base or the default branch. */
function branchTarget(repo: string, o: PrOpts, branch: string): Target {
  let head = branch;
  if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
    fetchRef(o.remote, `+refs/heads/${branch}:refs/remotes/${o.remote}/${branch}`, repo);
    head = `${o.remote}/${branch}`;
    if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) fail(`no branch or PR called "${branch}"`);
  }
  return { dir: branchDir(repo, branch), cfg: { base: o.base ?? defaultBase(repo), head, title: o.title } };
}

/** `pr`: the current branch (or --base/--head), nothing fetched. */
function localTarget(repo: string, o: PrOpts): Target {
  const dir = resolveDir(repo, o.dir);
  return { dir, cfg: loadConfig(dir, repo, o) };
}

/** A PR's own walkthrough (a ```reviewroom-walkthrough block in a comment or the description) when there is no local one. */
async function pullWalkthrough(repo: string, dir: string, cfg: ReviewConfig, force: boolean) {
  const file = walkthroughPath(dir);
  const t = prOf(cfg);
  if (!t || (fs.existsSync(file) && !force)) return;
  let found: { pr: number; pick: ReturnType<typeof pickBlock> }[];
  try {
    // a stack: every PR's own, chained in stack order
    const numbers = cfg.stack?.prs.map((p) => p.number);
    const parts = numbers ? (await fetchStack(repo, t, numbers, {})).parts : [await fetchPr(repo, t, null)];
    found = parts.map((s, i) => ({ pr: numbers?.[i] ?? t.number, pick: pickBlock(s) }));
  } catch (e) {
    return console.error(`reviewroom: could not look for a guided walkthrough on the PR: ${(e as Error).message}`);
  }
  const docs = found.flatMap(({ pr, pick }) => {
    if (!pick) return [];
    const r = parseWalkthrough(pick.text);
    if (r.ok) return [{ pr, doc: r.value, from: pick.from }];
    console.error(`reviewroom: the guided walkthrough in ${pick.from} is invalid, not used:\n  ${r.issues.join('\n  ')}`);
    return [];
  });
  if (!docs.length) return;
  const doc = cfg.stack ? chainWalkthroughs(docs)! : docs[0].doc;
  const r = parseWalkthrough(JSON.stringify({ ...doc, stack: undefined })); // chained: still one valid walkthrough; the part markers are the PRs'
  if (!r.ok) return console.error(`reviewroom: the PRs' guided walkthroughs do not chain into one, not used:\n  ${r.issues.join('\n  ')}`);
  fs.writeFileSync(file, JSON.stringify(r.value, null, 2) + '\n');
  console.error(`reviewroom: guided walkthrough from ${docs.map((d) => d.from).join(', ')}`);
}

export async function cmdPr(repo: string | null, o: PrOpts, arg?: string) {
  if (!repo) fail('not inside a git repository (cd into the project, or pass --repo <path>)');
  const n = arg?.match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/)?.[1];
  const t = n ? await prTarget(repo, o, n) : arg ? branchTarget(repo, o, arg) : localTarget(repo, o);
  const dir = o.dir ? path.resolve(o.dir) : t.dir;
  fs.mkdirSync(dir, { recursive: true });
  // what this run found wins over config.json; what it did not find (undefined) keeps the file's value
  const cfg = { ...readConfig(dir), ...Object.fromEntries(Object.entries(t.cfg).filter(([, v]) => v !== undefined)), repoPath: repo } as ReviewConfig;
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
  const fresh = scaffold(repo, dir, cfg, !!o.force);
  const prov = makeProvider(repo, cfg);
  const files = prov.files(prov.base, prov.head);
  for (const l of prov.layers ?? []) if (l.restack) console.error(`reviewroom: PR #${l.number} is not on the current head of the PR below it (a restack is pending); its layer starts where the two still agree`);
  console.error(`reviewroom: ${files.length} files changed | review: ${path.relative(process.cwd(), path.join(dir, 'review.html'))}${fresh ? ' (scaffolded - fill it in)' : ''}`);
  await pullWalkthrough(repo, dir, cfg, !!o.force);

  if (!o.detach) return cmdServe(repo, { dir, port: o.port, open: o.open, browser: o.browser }, !!o.wait); // --base/--head/--title are in config.json now
  const args = [ENTRY, 'review', '--forever', '--repo', repo, '--dir', dir];
  if (o.port) args.push('--port', o.port);
  if (!o.open) args.push('--no-open');
  if (o.browser) args.push('--browser');
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
