// Which review: its dir (resolveDir, dirForEdit) and config.json (what it compares).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, defaultBase } from './git.ts';
import { ReviewroomError } from '../../src/shared/ops.ts';

/** The review dir: --dir, else <repo>/.reviewroom/<branch>. For an existing review
 *  (`existing`), a missing branch dir falls back to the repo's only review (e.g. pr-<n> made by `pr`). */
export function resolveDir(repo: string, dirFlag: string | undefined, { existing = false } = {}): string {
  if (dirFlag) return path.resolve(dirFlag);
  const root = path.join(repo, '.reviewroom');
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim().replace(/[^\w.-]+/g, '-');
  const own = path.join(root, branch);
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

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ base: text, head: text, title: text, repo: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text });
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
  return cfg;
}
