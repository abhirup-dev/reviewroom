import fs from 'node:fs';
import path from 'node:path';
import { makeProvider } from './git.ts';
import type { ReviewConfig } from './config.ts';
import { PKG } from './paths.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import { progressHash } from './progress.ts';
import { reviewStore } from './review-store.ts';

export const DEFAULT_PROFILE = 'explainer';
const profilesDir = () => path.join(PKG, 'skills', 'reviewroom', 'references', 'profiles');

/** A report profile's sections (profiles/<name>/report.html); an unknown name fails with the ones there are. */
export function profileSections(name: string) {
  const file = path.join(profilesDir(), name, REPORT_FILE);
  if (/^[a-z0-9-]+$/.test(name) && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trimEnd();
  const known = fs.readdirSync(profilesDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  throw new ReviewroomError(`no report profile "${name}" (profiles: ${known.join(', ')})`);
}

/** Writes the report from the review's title and profile, once (or again with --force). Only the writing: the server
 *  serves it inside reviewroom's page (cli/lib/report-page.ts). */
export function scaffold(repo: string, dir: string, cfg: ReviewConfig, force = false) {
  const target = reviewStore(dir).report;
  if (target.exists() && !force) return undefined;
  const body = profileSections(cfg.profile ?? DEFAULT_PROFILE);
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const report = `<!-- The report: freeform HTML, served inside reviewroom's page. Building blocks and rr: links:
     skills/reviewroom/references/authoring.md. The sections come from the review's report profile. -->
<h1>${esc(makeProvider(repo, cfg).meta().title)}</h1>
${body}
`;
  target.write(report);
  return progressHash(report);
}
