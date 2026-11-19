// Stable PR identity and the on-disk layouts for PR and local reviews.
import path from 'node:path';
import fs from 'node:fs';
import { fail } from './args.ts';
import { reviewsDir } from './paths.ts';

type ReviewRepository = { owner: string; repo: string };
export type ReviewId = ReviewRepository & { number: number };
export const formatReviewRepository = ({ owner, repo }: ReviewRepository) => `${owner}/${repo}`;
export const formatReviewId = (id: ReviewId) => `${formatReviewRepository(id)}#${id.number}`;

// The optional suffix covers PR subpages, query strings, and comment anchors.
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i;
const PR_NUMBER = /^\d+$/;
const PULLS = 'pulls';
export const isReviewUrl = (text: string) => PR_URL.test(text);

function parseReviewRepository(repository: string): ReviewRepository | null {
  const [owner, repo, extra] = repository.toLowerCase().split('/');
  if (extra !== undefined || !/^[a-z0-9-]+$/.test(owner) || !repo || !/^[a-z0-9._-]+$/.test(repo) || repo.endsWith('.')) return null;
  return { owner, repo };
}

export function parseReviewId(text: string, repository?: string, optional?: false): ReviewId;
export function parseReviewId(text: string, repository: string | undefined, optional: true): ReviewId | null;
export function parseReviewId(text: string, repository?: string, optional = false): ReviewId | null {
  const url = PR_URL.exec(text);
  const [named, digits, extra] = (url ? `${url[1]}#${url[2]}` : PR_NUMBER.test(text) ? `#${text}` : text).split('#');
  // In target lookup, only a number, URL, or owner/repo#n is a PR candidate.
  const short = !named && extra === undefined && PR_NUMBER.test(digits ?? '');
  if (optional && (digits === undefined || (!short && !named.includes('/')))) return null;
  const parts = parseReviewRepository(named || repository || '');
  const number = Number(digits);
  if (!parts || extra !== undefined ||
      !PR_NUMBER.test(digits ?? '') || !Number.isSafeInteger(number) || number < 1) fail(`invalid PR review ID "${text}" (use owner/repo#n, or select its repository)`);
  return { ...parts, number };
}

const pullsFolder = ({ owner, repo }: ReviewRepository) => path.resolve(reviewsDir(), `${owner}_${repo}`, PULLS);

export function reviewFolder(id: ReviewId): string {
  return path.join(pullsFolder(id), String(id.number));
}

export function idFromFolder(dir: string): ReviewId | null {
  const [bucket, kind, number, extra] = path.relative(path.resolve(reviewsDir()), dir).split(path.sep);
  const split = bucket.indexOf('_');
  if (kind !== PULLS || !number || extra !== undefined || split < 1) return null;
  const id = parseReviewId(`${bucket.slice(0, split)}/${bucket.slice(split + 1)}#${number}`);
  if (reviewFolder(id) !== path.resolve(dir)) fail(`noncanonical PR review folder ${dir}; expected ${reviewFolder(id)}`);
  return id;
}

// Preserve the old spelling, including its lossy slash replacement, for local and legacy folders.
const legacySegment = (value: string) => value.replace(/[^\w.-]+/g, '-').replace(/^\.*$/, '_');
export const localReviewsFolder = (repository: string) => path.resolve(reviewsDir(), legacySegment(repository));
export const localReviewFolder = (repository: string, branch: string) => path.join(localReviewsFolder(repository), legacySegment(branch));

export function localReviewParent(dir: string): string | null {
  const parent = path.dirname(path.resolve(dir));
  return path.dirname(parent) === path.resolve(reviewsDir()) ? parent : null;
}

const directories = (root: string) => fs.existsSync(root)
  ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  : [];

export const legacyReviewFolders = () => directories(path.resolve(reviewsDir())).flatMap(directories);

export function reviewFoldersForRepository(repository: string): string[] {
  const prRepo = parseReviewRepository(repository);
  return [...directories(localReviewsFolder(repository)), ...(prRepo ? directories(pullsFolder(prRepo)) : [])];
}

// Future branch folders can use encodeURIComponent to round-trip refs as portable path segments.
