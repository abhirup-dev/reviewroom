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

/** A stack's review dir: one review per stack (docs/adr/0001-one-review-per-stack.md), named by the stack's id. */
export const stackDir = (repo: string, id: number) => path.join(reviewsOf(repo), `stack-${id}`);
/** The repo's review of a stack with a PR that `is` (by its config.json), if there is one. */
export function stackReview(repo: string, is: (p: StackConfig['prs'][number]) => boolean): string | undefined {
  const root = reviewsOf(repo);
  if (!fs.existsSync(root)) return;
  return fs.readdirSync(root).map((d) => path.join(root, d)).find((d) => {
    try {
      return !!readConfig(d).stack?.prs.some(is);
    } catch {
      return false; // someone else's broken config.json is not this lookup's problem
    }
  });
}

/** The review dir: --dir, else the current branch's. For an existing review (`existing`), a missing branch dir falls
 *  back to the review of a stack that has a PR from this branch, then to the repo's only review. */
export function resolveDir(repo: string, dirFlag: string | undefined, { existing = false } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  const root = reviewsOf(repo);
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim();
  const own = branchDir(repo, branch);
  if (!existing || fs.existsSync(own)) return own;
  const stacked = stackReview(repo, (p) => p.headLabel === branch);
  if (stacked) return stacked;
  const reviews = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'review.html'))) : [];
  if (reviews.length === 1) return path.join(root, reviews[0]);
  throw new ReviewroomError(reviews.length ? `several reviews in ${root}: ${reviews.join(', ')} - pass --dir` : `no review in ${root} - run \`reviewroom pr <n>\` first, or pass --dir`);
}

/** The dir of an existing review for commands that only edit it: --dir works without a repo. With `needs`, a dir
 *  without that file is an error. */
export function dirForEdit(repo: string | null, dirFlag: string | undefined, needs?: 'review.html' | 'walkthrough.json') {
  if (!dirFlag && !repo) throw new ReviewroomError('not inside a git repository (use --dir)');
  const dir = dirFlag ? path.resolve(dirFlag) : resolveDir(repo!, undefined, { existing: true });
  if (needs && !fs.existsSync(path.join(dir, needs))) throw new ReviewroomError(`no ${needs} in ${dir}`);
  return dir;
}

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// repoPath: the checkout the review was made from, so `--dir` alone finds its repo; repo: GitHub's owner/name.
const text = z.string().optional().catch(undefined);
// stack: the PR stack the review covers (`reviewroom pr` on a PR in one), bottom first; head is each PR's fetched ref.
// A stack that no longer parses means no stack, not a broken review.
const StackPr = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().optional(),
  url: z.string().optional(),
  state: z.enum(['open', 'merged', 'closed']),
  review: z.enum(['approved', 'changes']).optional(),
  headLabel: z.string(),
  head: z.string(),
});
const Stack = z.looseObject({ id: z.number().int(), source: z.enum(['native', 'chain', 'body', 'local']), base: z.string(), prs: z.array(StackPr).min(2) });
export type StackConfig = z.infer<typeof Stack>;
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, repo: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text, stack: Stack.nullable().optional().catch(undefined) }); // null: `pr` found none (or --no-stack)
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
