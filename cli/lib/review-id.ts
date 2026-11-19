// Stable GitHub PR identity and its on-disk directory.
import path from 'node:path';
import { fail } from './args.ts';
import { reviewsDir } from './paths.ts';

export type ReviewId = { owner: string; repo: string; number: number };
export const formatReviewId = ({ owner, repo, number }: ReviewId) => `${owner}/${repo}#${number}`;

export function parseReviewId(text: string, repository?: string, optional?: false): ReviewId;
export function parseReviewId(text: string, repository: string | undefined, optional: true): ReviewId | null;
export function parseReviewId(text: string, repository?: string, optional = false): ReviewId | null {
  const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i.exec(text);
  const [named, digits, extra] = (url ? `${url[1]}#${url[2]}` : /^\d+$/.test(text) ? `#${text}` : text).split('#');
  if (optional && !url && !/^#?\d+$/.test(text) && !named.includes('/')) return null;
  if (optional && digits === undefined && !url) return null; // a branch such as 32/topic
  const [owner, repo, rest] = (named || repository || '').toLowerCase().split('/');
  const number = Number(digits);
  if (extra !== undefined || rest !== undefined || !/^[a-z0-9-]+$/.test(owner) || !repo || !/^[a-z0-9._-]+$/.test(repo) || repo.endsWith('.') ||
      !/^\d+$/.test(digits ?? '') || !Number.isSafeInteger(number) || number < 1) fail(`invalid PR review ID "${text}" (use owner/repo#n, or select its repository)`);
  return { owner, repo, number };
}

export function reviewFolder(id: ReviewId): string {
  return path.resolve(reviewsDir(), `${id.owner}_${id.repo}`, 'pulls', String(id.number));
}

export function idFromFolder(dir: string): ReviewId | null {
  const [bucket, kind, number, extra] = path.relative(path.resolve(reviewsDir()), dir).split(path.sep);
  const split = bucket.indexOf('_');
  if (kind !== 'pulls' || !number || extra !== undefined || split < 1) return null;
  const id = parseReviewId(`${bucket.slice(0, split)}/${bucket.slice(split + 1)}#${number}`);
  if (reviewFolder(id) !== path.resolve(dir)) fail(`noncanonical PR review folder ${dir}; expected ${reviewFolder(id)}`);
  return id;
}

// Future branch folders can use encodeURIComponent to round-trip refs as portable path segments.
