import fs from 'node:fs';
import path from 'node:path';
import { makeProvider } from './git.ts';
import type { ReviewConfig } from './config.ts';
import { PKG } from './paths.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';

export const DEFAULT_PROFILE = 'explainer';
const profilesDir = () => path.join(PKG, 'skills', 'reviewroom', 'references', 'profiles');

/** A report profile's sections (profiles/<name>/report.html); an unknown name fails with the ones there are. */
export function profileSections(name: string) {
  const file = path.join(profilesDir(), name, REPORT_FILE);
  if (/^[a-z0-9-]+$/.test(name) && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trimEnd();
  const known = fs.readdirSync(profilesDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  throw new ReviewroomError(`no report profile "${name}" (profiles: ${known.join(', ')})`);
}

/** Writes the report from the page shell and the review's profile, once (or again with --force). */
export function scaffold(repo: string, dir: string, cfg: ReviewConfig, force = false) {
  const target = path.join(dir, REPORT_FILE);
  if (fs.existsSync(target) && !force) return false;
  const body = profileSections(cfg.profile ?? DEFAULT_PROFILE);
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = fs.readFileSync(path.join(PKG, 'templates', REPORT_FILE), 'utf8');
  // function replacers: `$&`, `$'` in titles must stay literal
  fs.writeFileSync(target, html.replaceAll('{{TITLE}}', () => esc(makeProvider(repo, cfg).meta().title)).replace('{{BODY}}', () => body));
  return true;
}
