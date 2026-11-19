import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// Which review: its dir (resolveDir, dirForEdit) and config.json (what it compares, and in which checkout).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, defaultBase, remoteName, repoRoot } from './git.ts';
import {
  formatReviewId, formatReviewRepository, idFromFolder, isReviewUrl, localReviewFolder,
  localReviewsFolder, parseReviewId, reviewFolder, reviewFoldersForRepository, type ReviewId,
} from './review-id.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';

export const currentBranch = (repo: string) => git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true })?.trim() || 'review';

/** Resolve a local review, including the current branch or sole-review fallback. */
export function resolveDir(repo: string | null, dirFlag: string | undefined, { existing = false, target, command, repoFlag }: { existing?: boolean; target?: string; command?: string; repoFlag?: string } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  if (!repo) throw new ReviewroomError('not inside a git repository (use --repo or --dir)');
  const remote = remoteName(repo);
  const root = localReviewsFolder(remote);
  const own = localReviewFolder(remote, target ?? currentBranch(repo));
  if (!existing || fs.existsSync(own)) return own;
  if (target) throw new ReviewroomError(`no review for ${shellArg(target)} - run \`reviewroom pr ${shellArg(target)}\` first`);
  const reviews = reviewFoldersForRepository(remote).filter((dir) => fs.existsSync(path.join(dir, REPORT_FILE)));
  if (reviews.length === 1) return reviews[0];
  if (!reviews.length) throw new ReviewroomError(`no review in ${root} - run \`reviewroom pr <n>\` first, or pass --dir`);
  if (!command) throw new ReviewroomError(`several reviews in ${root}: ${reviews.map((dir) => path.basename(dir)).join(', ')} - pass --dir`);
  const at = repoFlag ? ` --repo ${shellArg(repoFlag)}` : '';
  const calls = reviews.map((dir) => `  reviewroom ${command} ${reviewArgs(repo, dir)}${at}`);
  throw new ReviewroomError(`several reviews in ${root}:\n${calls.join('\n')}`);
}

/** The dir of an existing review for commands that only edit it: --dir works without a repo. With `needs`, a dir
 *  without that file is an error. */
export function dirForEdit(repo: string | null, dirFlag: string | undefined, needs?: typeof REPORT_FILE | typeof WALKTHROUGH_FILE) {
  if (!dirFlag && !repo) throw new ReviewroomError('not inside a git repository (use --dir)');
  const dir = resolveDir(repo, dirFlag, { existing: true });
  readConfig(dir); // guard implicit selections as well as --dir
  if (needs && !fs.existsSync(path.join(dir, needs))) throw new ReviewroomError(`no ${needs} in ${dir}`);
  return dir;
}

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// repoPath: the checkout the review was made from, so `--dir` alone finds its repo; repo: GitHub's owner/name;
// profile: the report profile its report.html was made from (skills/reviewroom/references/profiles/<profile>/);
// assistant: this review runs the built-in assistant (its Ask panel and api/generate): set by the hub's Play and
// `pr --assistant`, never by an external agent's `pr`. Per review, so each can be written by whoever the reviewer picks.
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, repo: text, remote: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text, profile: text, target: text, id: z.string().optional(), assistant: z.boolean().optional().catch(undefined) });
/** config.json, with --base/--head/--title applied (loadConfig). */
export type ReviewConfig = z.infer<typeof ConfigFile> & { base: string; head: string };
export const configPath = (dir: string) => path.join(dir, 'config.json');
const shellArg = (value: string) => /^[\w./][\w./#-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export const reviewDirArgs = (dir: string) => `--dir ${shellArg(dir)}`;

export function reviewArgs(repo: string, dir: string, cfg = readConfig(dir)): string {
  if (cfg.id) return cfg.id;
  const remote = remoteName(repo);
  if (cfg.target && localReviewFolder(remote, cfg.target) === dir) return shellArg(cfg.target);
  return reviewDirArgs(dir);
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

export function resolveReview(repo: string | null, o: { dir?: string; repo?: string; remote?: string }, target: string | undefined, command: string) {
  const selected = repo && target ? remoteName(repo, o.remote) : undefined;
  const targetId = target ? parseReviewId(target, selected, true) : null;
  const explicit = o.dir && path.resolve(o.dir);
  const dir = targetId
    ? reviewFolder(targetId)
    : resolveDir(repo, explicit, { existing: command !== 'pr', target, command, repoFlag: o.repo });
  if (targetId && explicit && explicit !== dir) {
    const saved = readConfig(explicit).id ?? 'no PR ID';
    throw new ReviewroomError(`review ID mismatch in ${explicit}: saved ${saved}, requested ${formatReviewId(targetId)}; its folder is ${dir}`);
  }
  const cfg = readConfig(dir);
  if (cfg.id && target && !targetId) {
    throw new ReviewroomError(`cannot use a branch target for ${cfg.id} in ${dir}; pass its PR review ID`);
  }
  const pr = targetId ?? (cfg.id ? parseReviewId(cfg.id) : null);
  const checkout = cfg.repoPath ? repoRoot(cfg.repoPath) : repo;
  if (pr) {
    const remote = o.remote ?? cfg.remote ?? 'origin';
    if (o.repo || target && isReviewUrl(target)) checkPullRepo(pr, repo, remote, true);
    if (command === 'pr') {
      if (checkout) checkPullRepo(pr, checkout, remote, false);
    } else if (!cfg.id) {
      const id = formatReviewId(pr);
      throw new ReviewroomError(`no review for ${id} - run \`reviewroom pr ${id}\` first`);
    }
  }
  return { repo: checkout, dir, cfg, pr };
}

export function loadConfig(dir: string, repo: string, o: { base?: string; head?: string; title?: string } = {}): ReviewConfig {
  const cfg = readConfig(dir) as ReviewConfig; // base and head are filled in below
  for (const k of ['base', 'head', 'title'] as const) if (o[k] !== undefined) cfg[k] = o[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  cfg.repoPath ||= repo;
  return cfg;
}
