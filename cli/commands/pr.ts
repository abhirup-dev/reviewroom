import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
// pr: the one-step entry point
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendProgress, recordArtifact } from '../lib/progress.ts';
import { fail } from '../lib/args.ts';
import { git, fetchRef, hasRef, defaultBase, remoteDefaultBranch, makeProvider } from '../lib/git.ts';
import { DEFAULT_PROFILE, profileSections, scaffold } from '../lib/scaffold.ts';
import { type ReviewConfig, resolveReview, currentBranch, reviewArgs, loadConfig, configPath } from '../lib/config.ts';
import { formatReviewId, parseReviewId } from '../lib/review-id.ts';
import { fetchPr, prTarget } from '../lib/github.ts';
import { walkthroughPath, writeAtomic } from '../lib/state.ts';
import { pickBlock } from '../lib/slides-file.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';
import { cmdWait, ensureServer, runningServer, type StartOpts } from './serve.ts';

function gh(repo: string, args: string[]) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

export type PrOpts = StartOpts & { base?: string; head?: string; title?: string; remote: string; force?: boolean; wait?: boolean; profile?: string };
/** `pr <n>`: fetch the PR's head (or fall back to a local copy) and its base branch. */
function prNumberConfig(repo: string, o: PrOpts, n: string): ReviewConfig {
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
  return { base, head, number: +n, title: o.title ?? info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` };
}

/** `pr <branch>`: a local branch, or one fetched from the remote, against --base or the default branch. */
function branchConfig(repo: string, o: PrOpts, branch: string): ReviewConfig {
  let head = branch;
  if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
    fetchRef(o.remote, `+refs/heads/${branch}:refs/remotes/${o.remote}/${branch}`, repo);
    head = `${o.remote}/${branch}`;
    if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) fail(`no branch or PR called "${branch}"`);
  }
  return { base: o.base ?? defaultBase(repo), head, title: o.title };
}

/** A PR's own walkthrough (a ```reviewroom-walkthrough block in a comment or the description) when there is no local one. */
async function pullWalkthrough(repo: string, dir: string, cfg: ReviewConfig, force: boolean, head: string) {
  const file = walkthroughPath(dir);
  const t = prTarget(cfg);
  if (!t || (fs.existsSync(file) && !force)) return;
  let pick;
  try {
    pick = pickBlock(await fetchPr(repo, t, null));
  } catch (e) {
    return console.error(`reviewroom: could not look for a walkthrough on the PR: ${(e as Error).message}`);
  }
  if (!pick) return;
  const r = parseWalkthrough(pick.text);
  if (!r.ok) return console.error(`reviewroom: the walkthrough in ${pick.from} is invalid, not used:\n  ${r.issues.join('\n  ')}`);
  fs.writeFileSync(file, JSON.stringify(r.value, null, 2) + '\n');
  recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', ...(/^[a-f0-9]{40}$/.test(head) ? { head } : {}) });
  console.error(`reviewroom: walkthrough from ${pick.from}`);
}

export async function cmdPr(selected: string | null, o: PrOpts, arg?: string) {
  const { repo, dir, cfg: saved, pr } = resolveReview(selected, o, arg, 'pr');
  if (!repo) fail('review checkout is unavailable (use --repo <path>)');
  const live = await runningServer(dir);
  if (live) {
    const args = reviewArgs(repo, dir, saved);
    console.error(`reviewroom: review is running in ${dir}. To pick up new commits, run \`reviewroom stop ${args}\`, then \`reviewroom pr ${args}\`.`);
    if (o.wait) return cmdWait(repo, dir, o);
    console.error(`reviewroom: next round: reviewroom wait ${args}`);
    console.log(live.url);
    return;
  }
  const found = pr ? prNumberConfig(repo, o, String(pr.number)) : arg ? branchConfig(repo, o, arg) : loadConfig(dir, repo, o);
  const id = pr ? formatReviewId(pr) : undefined;
  if (id && found.url) {
    const fetchedId = formatReviewId(parseReviewId(found.url));
    if (fetchedId !== id) fail(`requested review ${id}, but GitHub returned ${fetchedId}`);
  }
  // what this run found wins over config.json; what it did not find (undefined) keeps the file's value
  const cfg = { ...saved, ...Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)), repoPath: repo, target: pr ? undefined : (arg ?? currentBranch(repo)), id: saved.id ?? id } as ReviewConfig;
  if (o.profile) profileSections(o.profile); // an unknown profile fails before anything is written
  cfg.profile = o.profile ?? cfg.profile ?? DEFAULT_PROFILE;
  writeAtomic(configPath(dir), JSON.stringify(cfg, null, 2));
  const fresh = scaffold(repo, dir, cfg, !!o.force);
  const prov = makeProvider(repo, cfg);
  if (fresh || o.force) {
    for (const artifact of ['walkthrough', 'report'] as const) appendProgress(dir, { artifact, event: 'requested', ...(/^[a-f0-9]{40}$/.test(prov.head) ? { head: prov.head } : {}) });
  }
  const files = prov.files(prov.base, prov.head);
  console.error(`reviewroom: ${files.length} files changed | review: ${path.relative(process.cwd(), path.join(dir, REPORT_FILE))}${fresh ? ' (scaffolded - fill it in)' : ''}`);
  await pullWalkthrough(repo, dir, cfg, !!o.force, prov.head);

  if (o.wait) return cmdWait(repo, dir, o);
  const rec = await ensureServer(repo, dir, o);
  console.error(`reviewroom: review directory: ${dir}`);
  console.error(`reviewroom: next round: reviewroom wait ${reviewArgs(repo, dir, cfg)}`);
  console.log(rec.url);
}
