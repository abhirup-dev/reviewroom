// Stable PR identity and the on-disk layouts for PR and local reviews.
import path from 'node:path';
import fs from 'node:fs';
import { fail } from './args.ts';
import { reviewsDir } from './paths.ts';

type ReviewRepository = { owner: string; repo: string };
export type ReviewId = ReviewRepository & { number: number };
export const formatReviewRepository = ({ owner, repo }: ReviewRepository) => `${owner}/${repo}`;
export const formatReviewId = (id: ReviewId) => `${formatReviewRepository(id)}#${id.number}`;
export const pullUrl = (id: ReviewId, host = 'github.com') => `https://${host}/${formatReviewRepository(id)}/pull/${id.number}`;

// The optional suffix covers PR subpages, query strings, and comment anchors.
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i;
const PR_NUMBER = /^\d+$/;
const PULLS = 'pulls';

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

// Use lowercase escapes for branch targets so case-insensitive filesystems keep distinct refs apart.
const localSegment = (value: string) => value.replace(/[^\w.-]+/g, '-').replace(/^\.*$/, '_');
const branchSegment = (branch: string) => branch === PULLS ? '%70ulls' : branch
  .replace(/[^a-z0-9_.-]/gu, (c) => Buffer.from(c).toString('hex').replace(/../g, '%$&'))
  .replace(/\.+$/, (dots) => '%2e'.repeat(dots.length));
export const localReviewsFolder = (repository: string) => path.resolve(reviewsDir(), localSegment(repository));
export const localReviewFolder = (repository: string, branch: string) => path.join(localReviewsFolder(repository), branchSegment(branch));

const directories = (root: string) => fs.existsSync(root)
  ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  : [];

/** Every review folder on this machine: local `<repository>/<branch>` and PR `<owner>_<repo>/pulls/<n>`. */
export const allReviewFolders = () => directories(reviewsDir()).flatMap(directories).flatMap((dir) => path.basename(dir) === PULLS ? directories(dir) : [dir]);

export function reviewFoldersForRepository(repository: string): string[] {
  const prRepo = parseReviewRepository(repository);
  return [...directories(localReviewsFolder(repository)), ...(prRepo ? directories(pullsFolder(prRepo)) : [])];
}
