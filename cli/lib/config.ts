import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// Which review: its dir (resolveDir, dirForEdit) and config.json (what it compares, and in which checkout).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, defaultBase, remoteName } from './git.ts';
import { reviewsDir } from './paths.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';

/** Where a repo's reviews live: ~/.reviewroom/reviews/<owner>-<repo>/, shared by all its worktrees. */
const reviewsOf = (repo: string) => path.join(reviewsDir(), remoteName(repo).replace(/[^\w.-]+/g, '-').replace(/^\.*$/, '_')); // one segment, never `..`
export const prNumber = (target?: string) => target?.match(/^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/|#)?(\d+)(?:[/?#].*)?$/)?.[1].replace(/^0+(?=\d)/, '');
export const currentBranch = (repo: string) => git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true })?.trim() || 'review';
const targetName = (target: string) => {
  const n = prNumber(target);
  return n ? `pr-${n}` : branchName(target);
};
const branchName = (branch: string) => branch.replace(/[^\w.-]+/g, '-').replace(/^\.+$/, '_');

/** Resolve an explicit directory or target, then the current branch or the repo's only review. */
export function resolveDir(repo: string | null, dirFlag: string | undefined, { existing = false, target, command, repoFlag }: { existing?: boolean; target?: string; command?: string; repoFlag?: string } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  if (!repo) throw new ReviewroomError('not inside a git repository (use --repo or --dir)');
  const root = reviewsOf(repo);
  const own = path.join(root, target ? targetName(target) : branchName(currentBranch(repo)));
  if (!existing || fs.existsSync(own)) return own;
  if (target) throw new ReviewroomError(`no review for ${shellArg(target)} - run \`reviewroom pr ${shellArg(target)}\` first`);
  const reviews = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, REPORT_FILE))) : [];
  if (reviews.length === 1) return path.join(root, reviews[0]);
  if (!reviews.length) throw new ReviewroomError(`no review in ${root} - run \`reviewroom pr <n>\` first, or pass --dir`);
  if (!command) throw new ReviewroomError(`several reviews in ${root}: ${reviews.join(', ')} - pass --dir`);
  const at = repoFlag ? ` --repo ${shellArg(repoFlag)}` : '';
  const calls = reviews.map((name) => {
    const dir = path.join(root, name);
    return `  reviewroom ${command} ${reviewArgs(repo, dir)}${at}`;
  });
  throw new ReviewroomError(`several reviews in ${root}:\n${calls.join('\n')}`);
}

/** The dir of an existing review for commands that only edit it: --dir works without a repo. With `needs`, a dir
 *  without that file is an error. */
export function dirForEdit(repo: string | null, dirFlag: string | undefined, needs?: typeof REPORT_FILE | typeof WALKTHROUGH_FILE) {
  if (!dirFlag && !repo) throw new ReviewroomError('not inside a git repository (use --dir)');
  const dir = resolveDir(repo, dirFlag, { existing: true });
  if (needs && !fs.existsSync(path.join(dir, needs))) throw new ReviewroomError(`no ${needs} in ${dir}`);
  return dir;
}

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// repoPath: the checkout the review was made from, so `--dir` alone finds its repo; repo: GitHub's owner/name;
// profile: the report profile its report.html was made from (skills/reviewroom/references/profiles/<profile>/).
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, repo: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text, profile: text, target: text });
/** config.json, with --base/--head/--title applied (loadConfig). */
export type ReviewConfig = z.infer<typeof ConfigFile> & { base: string; head: string };
export const configPath = (dir: string) => path.join(dir, 'config.json');
const shellArg = (value: string) => /^[\w./][\w./-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** Shell arguments for lifecycle commands. Older reviews can still be named by their configured branch. */
export function reviewArgs(repo: string, dir: string, cfg = readConfig(dir)): string {
  if (path.dirname(dir) === reviewsOf(repo)) {
    for (const target of [cfg.target, cfg.number?.toString(), cfg.headLabel, cfg.head]) {
      if (target && targetName(target) === path.basename(dir)) return shellArg(prNumber(target) ?? target);
    }
  }
  return `--dir ${shellArg(dir)}`;
}

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
