// Which review: its dir (resolveDir, dirForEdit) and config.json (what it compares, and in which checkout).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, defaultBase, remoteName } from './git.ts';
import { reviewsDir } from './paths.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';

/** Where a repo's reviews live: ~/.reviewroom/reviews/<owner>-<repo>/, shared by all its worktrees. */
const reviewsOf = (repo: string) => path.join(reviewsDir(), remoteName(repo).replace(/[^\w.-]+/g, '-').replace(/^\.*$/, '_')); // one segment, never `..`
/** A branch's review dir. shortcut: two forks' PRs from the same branch name share it; add a suffix if that bites. */
export const branchDir = (repo: string, branch: string) => path.join(reviewsOf(repo), branch.replace(/[^\w.-]+/g, '-'));

/** The review dir: --dir, else the current branch's. For an existing review (`existing`),
 *  a missing branch dir falls back to the repo's only review. */
export function resolveDir(repo: string, dirFlag: string | undefined, { existing = false } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  const root = reviewsOf(repo);
  const own = branchDir(repo, (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim());
  if (!existing || fs.existsSync(own)) return own;
  const reviews = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'review.html'))) : [];
  if (reviews.length === 1) return path.join(root, reviews[0]);
  throw new ReviewroomError(reviews.length ? `several reviews in ${root}: ${reviews.join(', ')} - pass --dir` : `no review in ${root} - run \`reviewroom pr <n>\` first, or pass --dir`);
}

/** The dir of an existing review for commands that only edit it: --dir works without a repo. */
export const dirForEdit = (repo: string | null, dirFlag: string | undefined) => {
  if (dirFlag) return path.resolve(dirFlag);
  if (!repo) throw new ReviewroomError('not inside a git repository (use --dir)');
  return resolveDir(repo, undefined, { existing: true });
};

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// repoPath: the checkout the review was made from, so `--dir` alone finds its repo; repo: GitHub's owner/name.
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, repo: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text });
/** config.json, with --base/--head/--title applied (loadConfig). */
export type ReviewConfig = z.infer<typeof ConfigFile> & { base: string; head: string };
export const configPath = (dir: string) => path.join(dir, 'config.json');

export function readConfig(dir: string): z.infer<typeof ConfigFile> {
  if (!fs.existsSync(configPath(dir))) return {};
  try {
    return ConfigFile.parse(JSON.parse(fs.readFileSync(configPath(dir), 'utf8')));
  } catch (e) {
    throw new ReviewroomError(`${configPath(dir)} is not valid JSON (${(e as Error).message}); fix or delete it`);
  }
}

export function loadConfig(dir: string, repo: string, o: { base?: string; head?: string; title?: string } = {}): ReviewConfig {
  const cfg = readConfig(dir) as ReviewConfig; // base and head are filled in below
  for (const k of ['base', 'head', 'title'] as const) if (o[k] !== undefined) cfg[k] = o[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  cfg.repoPath ||= repo;
  return cfg;
}
