import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
import { fail } from './args.ts';
import { readConfig } from './config.ts';
import { git, isRev } from './git.ts';
import { report } from './links.ts';
import { DIST } from './paths.ts';
import { formatReviewId, formatReviewRepository, idFromFolder } from './review-id.ts';
import { buildWalkthroughBundle, bundleJson } from './walkthrough-bundle.ts';
import { runCheck, schemaReport } from '../commands/check.ts';

const slug = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function walkthroughFilename(reviewId: string, title: string) {
  const extension = '.html';
  const limit = 100 - extension.length;
  const id = slug(reviewId) || 'walkthrough';
  if (id.length > limit) {
    const hash = createHash('sha256').update(reviewId).digest('hex').slice(0, 8);
    const prefix = id.slice(0, limit - hash.length - 1).replace(/-$/, '');
    return `${prefix}-${hash}${extension}`;
  }

  const space = limit - id.length - 1;
  if (space <= 0) return id + extension;
  const full = slug(title);
  const boundary = full.slice(0, space + 1).lastIndexOf('-');
  const short = full.length > space ? full.slice(0, boundary > 0 ? boundary : space) : full;
  return id + (short ? '-' + short : '') + extension;
}

export async function exportWalkthrough(checkout: string, dir: string, allowStale = false) {
  const checked = await runCheck(checkout, dir, { store: false, notes: false });
  if ('issues' in checked) fail(schemaReport(checked.issues), 422);
  if (checked.bad.length && !allowStale) fail(`${checked.bad.length} link(s) need attention (fix them, or export anyway with --allow-stale):\n${report(checked.bad)}`);
  const walkthrough = checked.tour ?? fail(`no ${WALKTHROUGH_FILE} in ${dir}`, 404);
  const commit = (rev: string) => isRev(rev) ? git(['rev-parse', '--verify', '--end-of-options', rev + '^{commit}'], checkout, { soft: true })?.trim() ?? null : null;
  const pr = idFromFolder(dir);
  const meta = checked.provider.meta();
  const reviewId = pr ? formatReviewId(pr) : `${meta.repo ?? path.basename(checkout)}/${readConfig(dir).target || meta.headLabel}`;
  const provider = {
    ...checked.provider,
    meta: () => pr ? { ...meta, repo: formatReviewRepository(pr), number: pr.number } : meta,
    // A Git tree can also resolve at sha:path. Only its file blobs belong in the export.
    read: (sha: string, file: string) => git(['cat-file', 'blob', `${sha}:${file}`], checkout, { soft: true }),
  };
  const bundle = buildWalkthroughBundle(walkthrough, provider, commit, new Date().toISOString());
  const shellPath = path.join(DIST, 'standalone.html');
  if (!fs.existsSync(shellPath)) fail('standalone walkthrough shell is missing; run bun run build', 500);
  const shell = fs.readFileSync(shellPath, 'utf8');
  const json = bundleJson(bundle);
  const html = shell.replace(/<!--RR_(TITLE|BUNDLE)-->/g, (_, marker: string) => marker === 'TITLE' ? Bun.escapeHTML(walkthrough.title) : json);
  return { html, filename: walkthroughFilename(reviewId, walkthrough.title) };
}
