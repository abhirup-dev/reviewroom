import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// pr: the one-step entry point
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { importToRetry, recordArtifact, requestGeneration, resetGeneration, staleArtifacts } from '../lib/progress.ts';
import { ARTIFACTS } from '../../src/kernel/state/progress.shared.ts';
import { fail } from '../lib/args.ts';
import { git, fetchRef, hasRef, defaultBase, isFullSha, remoteDefaultBranch, makeProvider, remoteHost } from '../lib/git.ts';
import { DEFAULT_PROFILE, profileSections, scaffold } from '../lib/scaffold.ts';
import { type ReviewConfig, resolveReview, reviewArgs, loadConfig, readConfig, configPath } from '../lib/config.ts';
import { formatReviewId, formatReviewRepository, parseReviewId, type ReviewId } from '../lib/review-id.ts';
import { fetchPr } from '../lib/github.ts';
import { walkthroughPath, writeAtomic } from '../lib/state.ts';
import { pickBlock } from '../lib/slides-file.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';
import { ensureServer, runningServer, type StartOpts } from './serve.ts';

function prMetadata(repo: string, remote: string, pr: ReviewId) {
  const host = remoteHost(repo, remote);
  if (!host) return null;
  const args = ['pr', 'view', String(pr.number), '--repo', `${host}/${formatReviewRepository(pr)}`, '--json', 'title,author,baseRefName,baseRefOid,headRefName,url'];
  let info;
  try {
    info = JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
  } catch {
    return null;
  }
  if (info?.url && formatReviewId(parseReviewId(info.url)) !== formatReviewId(pr)) fail(`GitHub returned ${info.url} for ${formatReviewId(pr)}`);
  return info;
}

export type PrOpts = StartOpts & { base?: string; head?: string; title?: string; remote?: string; force?: boolean; profile?: string; agent?: boolean; serve?: boolean; assistant?: boolean };
/** `pr <n>`: fetch the PR head and its recorded base, keeping the fetched PR ref for offline use. */
function prNumberConfig(repo: string, o: PrOpts, remote: string, pr: ReviewId, saved: ReturnType<typeof readConfig>): ReviewConfig {
  const n = String(pr.number);
  const info = prMetadata(repo, remote, pr);
  console.error(`reviewroom: fetching PR #${n}${info ? ` "${info.title}"` : ''} from ${remote}...`);
  const head = `refs/reviewroom/pr/${Buffer.from(formatReviewId(pr)).toString('base64url')}`;
  const fetched = fetchRef(remote, `+refs/pull/${n}/head:${head}`, repo);
  if (!fetched) {
    if (!hasRef(head, repo)) fail(`could not fetch ${formatReviewId(pr)} from ${remote} and found no cached PR ref`);
    console.error(`reviewroom: fetch failed; using cached ${formatReviewId(pr)} (may be behind the PR)`);
  }
  const baseLabel = (o.base ?? info?.baseRefName ?? saved.baseLabel) || remoteDefaultBranch(repo, remote);
  // GitHub compares against the PR's merge base. After a merge, force-push or branch deletion,
  // today's branch tip may no longer share the history that GitHub used.
  const recordedBase: unknown = info?.baseRefOid ?? saved.base;
  let base: string | undefined;
  if (!o.base && typeof recordedBase === 'string' && isFullSha(recordedBase)) {
    if (!hasRef(recordedBase, repo)) fetchRef(remote, recordedBase, repo);
    if (!hasRef(recordedBase, repo)) fail(`could not fetch PR base commit ${recordedBase} from ${remote} (pass --base <ref>)`);
    base = recordedBase;
  } else {
    if (fetched && !isFullSha(baseLabel)) fetchRef(remote, `+refs/heads/${baseLabel}:refs/remotes/${remote}/${baseLabel}`, repo);
    base = [`${remote}/${baseLabel}`, baseLabel].find((r) => hasRef(r, repo));
    if (!base) fail(`base ref ${baseLabel} not found locally or on ${remote} (pass --base <ref>)`);
  }
  return { base, head, title: o.title ?? info?.title, author: info?.author?.login, baseLabel, headLabel: info?.headRefName || saved.headLabel || `PR #${n}` };
}

/** `pr <branch>`: a local branch, or one fetched from the remote, against --base or the default branch. */
function branchConfig(repo: string, o: PrOpts, branch: string, remote: string): ReviewConfig {
  let head = branch;
  if (!git(['rev-parse', '--verify', '--quiet', branch], repo, { soft: true })) {
    fetchRef(remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, repo);
    head = `${remote}/${branch}`;
    if (!git(['rev-parse', '--verify', '--quiet', head], repo, { soft: true })) fail(`no branch or PR called "${branch}"`);
  }
  return { base: o.base ?? defaultBase(repo), head: o.head ?? head, title: o.title };
}

/** A PR's own walkthrough (a ```reviewroom-walkthrough block in a comment or the description) when there is no local one. */
async function pullWalkthrough(repo: string, dir: string, cfg: ReviewConfig, force: boolean, head: string) {
  const file = walkthroughPath(dir);
  const t = cfg.id ? parseReviewId(cfg.id) : null;
  // a local file is kept, unless it is still an earlier import not validated now (a refresh whose fetch failed): retried
  if (!t || (fs.existsSync(file) && !force && !importToRetry(dir, head))) return;
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const before = read();
  let pick;
  try {
    pick = pickBlock(await fetchPr(repo, t, null, remoteHost(repo, cfg.remote ?? 'origin') ?? 'github.com'));
  } catch (e) {
    return console.error(`reviewroom: could not look for a walkthrough on the PR: ${(e as Error).message}`);
  }
  if (!pick) return;
  const r = parseWalkthrough(pick.text);
  if (!r.ok) return console.error(`reviewroom: the walkthrough in ${pick.from} is invalid, not used:\n  ${r.issues.join('\n  ')}`);
  // an edit saved while GitHub answered wins: recheck right before writing
  if (!force && read() !== before) return console.error(`reviewroom: ${WALKTHROUGH_FILE} changed while fetching the PR's walkthrough; kept yours`);
  fs.writeFileSync(file, JSON.stringify(r.value, null, 2) + '\n');
  recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', ...(isFullSha(head) ? { head } : {}) });
  console.error(`reviewroom: walkthrough from ${pick.from}`);
}

/** A fresh or forced review asks its agent for both documents. --no-agent (the hub) sets up only: generation goes idle
 *  until someone asks (api/generate); on a re-add, each document validated or requested for another head goes idle too (on
 *  disk), the others are kept. Going stale never imports the PR's walkthrough over the file: pullWalkthrough decides. */
function settleGeneration(dir: string, o: PrOpts, fresh: boolean, head: string) {
  if (o.agent !== false) {
    if (fresh || o.force) requestGeneration(dir, 'agent', head);
  } else resetGeneration(dir, fresh || o.force ? ARTIFACTS : staleArtifacts(dir, head));
}

export async function cmdPr(selected: string | null, o: PrOpts, arg?: string) {
  const { repo, dir, cfg: saved, pr } = resolveReview(selected, o, arg, 'pr');
  if (!repo) fail('review checkout is unavailable (use --repo <path>)');
  const live = await runningServer(dir);
  if (live) {
    const args = reviewArgs(repo, dir, saved);
    console.error(`reviewroom: review is running in ${dir}. To pick up new commits, run \`reviewroom stop ${args}\`, then \`reviewroom pr ${args}\`.`);
    if (o.force) fail(`review is running; stop it first: reviewroom stop ${args}`);
    console.error(`reviewroom: next round: reviewroom wait ${args}`);
    console.log(live.url);
    return;
  }
  const remote = o.remote ?? saved.remote ?? 'origin';
  const isPath = arg?.startsWith('/') || arg?.startsWith('./');
  const found = pr ? prNumberConfig(repo, o, remote, pr, saved) : isPath ? loadConfig(dir, repo, o) : branchConfig(repo, o, arg!, remote);
  const id = pr ? formatReviewId(pr) : undefined;
  // what this run found wins over config.json; what it did not find (undefined) keeps the file's value
  const cfg = { ...saved, ...Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)), repoPath: repo, remote: pr ? remote : undefined, target: pr ? undefined : (isPath ? saved.target : arg), id: saved.id ?? id } as ReviewConfig;
  if (o.profile) profileSections(o.profile); // an unknown profile fails before anything is written
  cfg.profile = o.profile ?? cfg.profile ?? DEFAULT_PROFILE;
  if (o.assistant) cfg.assistant = true; // never cleared here: a later plain `pr` (an external agent) leaves it as it was
  // the revisions resolve before anything is written; config.json last: a failed run leaves the previous one (or none:
  // no playable hub row, and a retry finds no half-made review)
  const prov = makeProvider(repo, cfg);
  const files = prov.files(prov.base, prov.head);
  fs.mkdirSync(dir, { recursive: true });
  const fresh = scaffold(repo, dir, cfg, !!o.force);
  writeAtomic(configPath(dir), JSON.stringify(cfg, null, 2));
  settleGeneration(dir, o, fresh, prov.head);
  console.error(`reviewroom: ${files.length} files changed | review: ${path.relative(process.cwd(), path.join(dir, REPORT_FILE))}${fresh ? ' (scaffolded - fill it in)' : ''}`);
  await pullWalkthrough(repo, dir, cfg, !!o.force, prov.head);

  if (o.serve === false) return console.log(dir); // set up only (the hub's Add a PR): its Play starts the server
  const rec = await ensureServer(repo, dir, o);
  console.error(`reviewroom: review directory: ${dir}`);
  console.error(`reviewroom: next round: reviewroom wait ${reviewArgs(repo, dir, cfg)}`);
  console.log(rec.url);
}
