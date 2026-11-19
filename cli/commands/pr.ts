import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
// pr: the one-step entry point
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendProgress, recordArtifact } from '../lib/progress.ts';
import { fail } from '../lib/args.ts';
import { git, fetchRef, hasRef, defaultBase, isFullSha, remoteDefaultBranch, makeProvider, remoteHost } from '../lib/git.ts';
import { DEFAULT_PROFILE, profileSections, scaffold } from '../lib/scaffold.ts';
import { type ReviewConfig, resolveReview, currentBranch, reviewArgs, loadConfig, configPath } from '../lib/config.ts';
import { formatReviewId, formatReviewRepository, parseReviewId, type ReviewId } from '../lib/review-id.ts';
import { fetchPr, prTarget } from '../lib/github.ts';
import { walkthroughPath, writeAtomic } from '../lib/state.ts';
import { pickBlock } from '../lib/slides-file.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';
import { cmdWait, ensureServer, runningServer, type StartOpts } from './serve.ts';

function prMetadata(repo: string, remote: string, pr: ReviewId) {
  const host = remoteHost(repo, remote);
  if (!host) return null;
  const args = ['pr', 'view', String(pr.number), '--repo', `${host}/${formatReviewRepository(pr)}`, '--json', 'number,title,author,baseRefName,headRefName,url'];
  let info;
  try {
    info = JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
  } catch {
    return null;
  }
  if (info?.url && formatReviewId(parseReviewId(info.url)) !== formatReviewId(pr)) fail(`GitHub returned ${info.url} for ${formatReviewId(pr)}`);
  return info;
}

export type PrOpts = StartOpts & { base?: string; head?: string; title?: string; remote?: string; force?: boolean; wait?: boolean; profile?: string };
/** `pr <n>`: fetch the PR head and base branch, keeping the fetched PR ref for offline use. */
function prNumberConfig(repo: string, o: PrOpts, remote: string, pr: ReviewId): ReviewConfig {
  const n = String(pr.number);
  const info = prMetadata(repo, remote, pr);
  console.error(`reviewroom: fetching PR #${n}${info ? ` "${info.title}"` : ''} from ${remote}...`);
  const head = `refs/reviewroom/pr/${Buffer.from(formatReviewId(pr)).toString('base64url')}`;
  const fetched = fetchRef(remote, `+refs/pull/${n}/head:${head}`, repo);
  if (!fetched) {
    if (!hasRef(head, repo)) fail(`could not fetch ${formatReviewId(pr)} from ${remote} and found no cached PR ref`);
    console.error(`reviewroom: fetch failed; using cached ${formatReviewId(pr)} (may be behind the PR)`);
  }
  const baseBranch = (o.base ?? info?.baseRefName) || remoteDefaultBranch(repo, remote);
  if (fetched) fetchRef(remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`, repo);
  const base = [`${remote}/${baseBranch}`, baseBranch].find((r) => hasRef(r, repo));
  if (!base) fail(`base branch ${baseBranch} not found locally or on ${remote} (pass --base <ref>)`);
  return { base, head, number: +n, title: o.title ?? info?.title, author: info?.author?.login, url: info?.url, baseLabel: baseBranch, headLabel: info?.headRefName || `PR #${n}` };
}

/** `pr <branch>`: a local branch, or one fetched from the remote, against --base or the default branch. */
function branchConfig(repo: string, o: PrOpts, branch: string, remote: string): ReviewConfig {
  let head = branch;
  if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
    fetchRef(remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, repo);
    head = `${remote}/${branch}`;
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
  recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', ...(isFullSha(head) ? { head } : {}) });
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
  const remote = o.remote ?? saved.remote ?? 'origin';
  const found = pr ? prNumberConfig(repo, o, remote, pr) : arg ? branchConfig(repo, o, arg, remote) : loadConfig(dir, repo, o);
  const id = pr ? formatReviewId(pr) : undefined;
  // what this run found wins over config.json; what it did not find (undefined) keeps the file's value
  const cfg = { ...saved, ...Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)), repoPath: repo, remote: pr ? remote : undefined, target: pr ? undefined : (arg ?? currentBranch(repo)), id: saved.id ?? id } as ReviewConfig;
  if (o.profile) profileSections(o.profile); // an unknown profile fails before anything is written
  cfg.profile = o.profile ?? cfg.profile ?? DEFAULT_PROFILE;
  writeAtomic(configPath(dir), JSON.stringify(cfg, null, 2));
  const fresh = scaffold(repo, dir, cfg, !!o.force);
  const prov = makeProvider(repo, cfg);
  if (fresh || o.force) {
    for (const artifact of ['walkthrough', 'report'] as const) appendProgress(dir, { artifact, event: 'requested', ...(isFullSha(prov.head) ? { head: prov.head } : {}) });
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
