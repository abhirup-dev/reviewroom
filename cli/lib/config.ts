import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// Which review: its dir (resolveDir, dirForEdit) and config.json (what it compares, and in which checkout).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, defaultBase, remoteName, repoRoot } from './git.ts';
import {
  formatReviewId, formatReviewRepository, idFromFolder, isReviewUrl, legacyReviewFolders, localReviewFolder,
  localReviewParent, localReviewsFolder, parseReviewId, reviewFolder, reviewFoldersForRepository, type ReviewId,
} from './review-id.ts';
import { liveServer } from './registry.ts';
import { writeAtomic } from './state.ts';
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
// profile: the report profile its report.html was made from (skills/reviewroom/references/profiles/<profile>/).
const text = z.string().optional().catch(undefined);
const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, repo: text, remote: text, number: z.union([z.number(), z.string()]).optional().catch(undefined), author: text, url: text, baseLabel: text, headLabel: text, profile: text, target: text, id: z.string().optional() });
/** config.json, with --base/--head/--title applied (loadConfig). */
export type ReviewConfig = z.infer<typeof ConfigFile> & { base: string; head: string };
export const configPath = (dir: string) => path.join(dir, 'config.json');
const shellArg = (value: string) => /^[\w./][\w./#-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export const reviewDirArgs = (dir: string) => `--dir ${shellArg(dir)}`;

export function reviewArgs(repo: string, dir: string, cfg = readConfig(dir)): string {
  if (cfg.id) return cfg.id;
  const remote = remoteName(repo);
  for (const branch of [cfg.target, cfg.headLabel, cfg.head]) {
    if (branch && localReviewFolder(remote, branch) === dir) return shellArg(branch);
  }
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

type ReviewLocation = { dir: string; cfg: ReturnType<typeof readConfig> };

function legacyLocationId({ dir, cfg }: ReviewLocation, requested?: ReviewId): string | undefined {
  const bucket = localReviewParent(dir);
  if (cfg.id || !cfg.number || !bucket) return;
  try {
    if (cfg.url) {
      const id = parseReviewId(cfg.url);
      if (id.number === Number(cfg.number)) return formatReviewId(id);
      return;
    }
    const remote = cfg.repo ?? (cfg.repoPath && remoteName(cfg.repoPath, cfg.remote));
    const repository = remote?.includes('/') ? remote : requested && formatReviewRepository(requested);
    if (!repository) return;
    const id = parseReviewId(String(cfg.number), repository);
    if (bucket.toLowerCase() === localReviewsFolder(formatReviewRepository(id)).toLowerCase()) return formatReviewId(id);
  } catch {} // invalid legacy metadata cannot identify a PR
}

function findLegacy(pr: ReviewId, id: string): ReviewLocation | undefined {
  const matches = legacyReviewFolders().flatMap((dir) => {
    try {
      const cfg = readConfig(dir);
      return legacyLocationId({ dir, cfg }, pr) === id ? [{ dir, cfg }] : [];
    } catch { return []; }
  });
  if (matches.length > 1) throw new ReviewroomError(`several legacy folders match ${id}; pass --dir:\n${matches.map((match) => `  ${match.dir}`).join('\n')}`);
  return matches[0];
}

type PullLookup = { command: string; repo: string | null; remote?: string; verifyRepo: boolean };

function checkPullRemote(id: string, repository: string, saved: ReviewLocation['cfg'], { command, repo, remote, verifyRepo }: PullLookup) {
  const source = remote ?? saved.remote ?? 'origin';
  const selected = repo ? remoteName(repo, source).toLowerCase() : undefined;
  if (verifyRepo && selected !== repository) {
    throw new ReviewroomError(`review ${id} belongs to ${repository}, selected repository is ${selected ?? 'none'}`);
  }
  if (command === 'pr') {
    const checkout = saved.repoPath ?? repo;
    if (checkout && remoteName(checkout, source).toLowerCase() !== repository) {
      throw new ReviewroomError(`remote ${source} in ${checkout} does not match the repository for ${id}`);
    }
  }
  return selected;
}

function resolvePull(pr: ReviewId, explicit: ReviewLocation | undefined, lookup: PullLookup): ReviewLocation {
  const { command } = lookup;
  const id = formatReviewId(pr);
  const repository = formatReviewRepository(pr);
  const canonical = reviewFolder(pr);
  const cfg = readConfig(canonical);
  let legacy: ReviewLocation | undefined;
  if (explicit && explicit.dir !== canonical) {
    const saved = explicit.cfg.id ?? legacyLocationId(explicit, pr);
    if (saved !== id) throw new ReviewroomError(`review ID mismatch in ${explicit.dir}: saved ${saved ?? 'no PR ID'}, requested ${id}; its folder is ${canonical}`);
    legacy = explicit;
  } else if (!cfg.id) {
    legacy = findLegacy(pr, id);
  }
  const selected = checkPullRemote(id, repository, legacy?.cfg ?? cfg, lookup);
  if (!legacy) {
    if (!cfg.id && command !== 'pr') throw new ReviewroomError(`no review for ${id} - run \`reviewroom pr ${id}\` first`);
    if (!cfg.id && selected !== repository) throw new ReviewroomError(`select the checkout for ${id} with --repo`);
    return { dir: canonical, cfg };
  }
  if (!['pr', 'start', 'wait'].includes(command)) return legacy;
  if (liveServer(legacy.dir)) throw new ReviewroomError(`legacy review ${id} is running; stop it first: reviewroom stop ${id}`);
  if (fs.existsSync(canonical)) throw new ReviewroomError(`review ${id} already has a folder at ${canonical}`);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.renameSync(legacy.dir, canonical);
  const adopted = { ...legacy.cfg, id };
  writeAtomic(configPath(canonical), JSON.stringify(adopted, null, 2));
  return { dir: canonical, cfg: adopted };
}

export function resolveReview(repo: string | null, o: { dir?: string; repo?: string; remote?: string }, target: string | undefined, command: string) {
  const selected = repo ? remoteName(repo, o.remote).toLowerCase() : undefined;
  const explicitDir = o.dir ? path.resolve(o.dir) : undefined;
  const existing = command !== 'pr';
  const pr = target ? parseReviewId(target, selected, true) : null;
  const local = !pr || explicitDir ? resolveDir(repo, explicitDir, { existing: pr ? false : existing, target, command, repoFlag: o.repo }) : undefined;
  const location = local ? { dir: local, cfg: readConfig(local) } : undefined;
  const savedId = location && (location.cfg.id ?? legacyLocationId(location));
  if (savedId && !pr && (target || !existing && !explicitDir)) {
    throw new ReviewroomError(`cannot use a branch target for ${savedId} in ${local}; pass its PR review ID`);
  }
  const pull = pr ?? (savedId ? parseReviewId(savedId) : null);
  const resolved = pull ? resolvePull(pull, explicitDir ? location : undefined, {
    command, repo, remote: o.remote, verifyRepo: !!o.repo || !!target && isReviewUrl(target),
  }) : location!;
  return { ...resolved, repo: resolved.cfg.repoPath ? repoRoot(resolved.cfg.repoPath) : repo, pr: pull };
}

export function loadConfig(dir: string, repo: string, o: { base?: string; head?: string; title?: string } = {}): ReviewConfig {
  const cfg = readConfig(dir) as ReviewConfig; // base and head are filled in below
  for (const k of ['base', 'head', 'title'] as const) if (o[k] !== undefined) cfg[k] = o[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  cfg.repoPath ||= repo;
  return cfg;
}
