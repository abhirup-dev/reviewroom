// Explicit review selection and its saved configuration.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defaultBase, remoteHost, remoteName, repoRoot } from './git.ts';
import {
  formatReviewId, formatReviewRepository, idFromFolder, localReviewFolder,
  allReviewFolders, parseReviewId, reviewFolder, reviewFoldersForRepository, type ReviewId,
} from './review-id.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// repoPath: the checkout the review was made from, so a path target finds its repo; repo: GitHub's owner/name;
// profile: the report profile its report.html was made from (skills/reviewroom/references/profiles/<profile>/);
// assistant: this review runs the built-in assistant (its Ask panel and api/generate): set by the hub's Play and
// `pr --assistant`, never by an external agent's `pr`. Per review, so each can be written by whoever the reviewer picks.
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, remote: text, author: text, baseLabel: text, headLabel: text, profile: text, reportScaffoldHash: text, target: text, id: z.string().optional(), assistant: z.boolean().optional().catch(undefined) });
/** config.json, with --base/--head/--title applied (loadConfig). */
export type ReviewConfig = z.infer<typeof ConfigFile> & { base: string; head: string };
export const configPath = (dir: string) => path.join(dir, 'config.json');
export const shellArg = (value: string) => /^[\w./][\w./-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function reviewArgs(_repo: string, dir: string, cfg = readConfig(dir)): string {
  return shellArg(cfg.id ?? dir);
}

export function readConfig(dir: string): z.infer<typeof ConfigFile> {
  const file = configPath(dir);
  let cfg: z.infer<typeof ConfigFile> = {};
  if (fs.existsSync(file)) {
    try {
      cfg = ConfigFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new ReviewroomError(`${file} is not valid JSON (${(e as Error).message}); fix or delete it`);
    }
  }
  const folderId = idFromFolder(dir);
  if ((cfg.id || fs.existsSync(dir)) && cfg.id !== (folderId ? formatReviewId(folderId) : undefined)) {
    throw new ReviewroomError(`review ID mismatch in ${dir}: saved ${cfg.id ?? 'no PR ID'}, folder expects ${folderId ? formatReviewId(folderId) : 'a local review'}`, 409);
  }
  return cfg;
}

function checkPullRepo(pr: ReviewId, repo: string | null, remote: string, selected: boolean) {
  const actual = repo ? remoteName(repo, remote).toLowerCase() : 'none';
  const expected = formatReviewRepository(pr);
  if (actual === expected) return;
  const id = formatReviewId(pr);
  throw new ReviewroomError(selected
    ? `review ${id} belongs to ${expected}, selected repository is ${actual}`
    : `remote ${remote} in ${repo} does not match the repository for ${id}`);
}

function requiredTarget(repo: string | null, target: string | undefined, command: string, remote = 'origin'): string {
  if (!target) {
    const reviews = repo ? reviewFoldersForRepository(remoteName(repo)) : allReviewFolders();
    const calls = reviews.filter((dir) => fs.existsSync(configPath(dir))).map((dir) => `  reviewroom ${command} ${shellArg(readConfig(dir).id ?? dir)}`);
    throw new ReviewroomError(`missing review: reviewroom ${command} <review>, where <review> is 'owner/repo#n', a PR URL, a branch or a review folder${calls.length ? `\nhelp: reviews here:\n${calls.join('\n')}` : ''}`, 2);
  }
  if (/^#\d+$/.test(target) || (command !== 'pr' && /^\d+$/.test(target))) {
    throw new ReviewroomError('use a full PR review ID (owner/repo#n), URL, branch, or review-folder path; bare numbers are only accepted by pr', 2);
  }
  if (/^\d+$/.test(target) && (!repo || !remoteHost(repo, remote))) {
    throw new ReviewroomError("A bare PR number needs a GitHub remote. Use the 'owner/repo#n' form.");
  }
  return target;
}

/** A path target, or a bare name that is a review folder here (not a branch). */
const isFolder = (target: string) => target.startsWith('/') || target.startsWith('./') || fs.existsSync(path.resolve(target, 'config.json'));

export function resolveReview(repo: string | null, o: { dir?: string; repo?: string; remote?: string }, input: string | undefined, command: string) {
  if (o.dir !== undefined) throw new ReviewroomError('--dir was removed; use reviewroom <command> <review-folder> instead');
  const target = requiredTarget(repo, input, command, o.remote);
  const isPath = isFolder(target);
  const selected = repo ? remoteName(repo, o.remote) : undefined;
  const targetId = isPath ? null : parseReviewId(target, selected, true);
  if (!isPath && !targetId && !repo) throw new ReviewroomError('branch targets require a git repository (use --repo <path>)');
  const dir = isPath ? path.resolve(target) : targetId ? reviewFolder(targetId) : localReviewFolder(remoteName(repo!), target);
  if ((isPath || command !== 'pr') && !fs.existsSync(configPath(dir))) {
    throw new ReviewroomError(`no review in ${dir} - run \`reviewroom pr ${shellArg(target)}\` first`);
  }
  const cfg = readConfig(dir);
  if (cfg.id && !isPath && !targetId) {
    throw new ReviewroomError(`cannot use a branch target for ${cfg.id} in ${dir}; pass its PR review ID`);
  }
  const pr = targetId ?? (cfg.id ? parseReviewId(cfg.id) : null);
  const checkout = cfg.repoPath ? repoRoot(cfg.repoPath) : repo;
  if (pr) {
    const remote = o.remote ?? cfg.remote ?? 'origin';
    if (o.repo) checkPullRepo(pr, repo, remote, true);
    if (command === 'pr') {
      checkPullRepo(pr, checkout, remote, false);
    } else if (!cfg.id) {
      const id = formatReviewId(pr);
      throw new ReviewroomError(`no review for ${id} - run \`reviewroom pr ${id}\` first`);
    }
  }
  return { repo: checkout, dir, cfg, pr, isPath };
}

export function loadConfig(dir: string, repo: string, o: { base?: string; head?: string; title?: string } = {}): ReviewConfig {
  const cfg = readConfig(dir) as ReviewConfig; // base and head are filled in below
  for (const k of ['base', 'head', 'title'] as const) if (o[k] !== undefined) cfg[k] = o[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  cfg.repoPath ||= repo;
  return cfg;
}
