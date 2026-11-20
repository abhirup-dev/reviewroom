import fs from 'node:fs';
import path from 'node:path';
import { WALKTHROUGH_EXPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
import { type Global, fail } from '../lib/args.ts';
import { git, isRev } from '../lib/git.ts';
import { report } from '../lib/links.ts';
import { DIST } from '../lib/paths.ts';
import { buildWalkthroughBundle, bundleJson } from '../lib/walkthrough-bundle.ts';
import { runCheck, schemaReport } from './check.ts';

type ExportOptions = Global & { out?: string; allowStale?: boolean };

export async function cmdExport(repo: string | null, dir: string, options: ExportOptions) {
  const checkout = repo ?? fail('not inside a git repository (use --repo)');
  const checked = await runCheck(checkout, dir, { store: false, notes: false });
  if ('issues' in checked) fail(schemaReport(checked.issues));
  if (checked.bad.length && !options.allowStale) fail(`${checked.bad.length} link(s) need attention (fix them, or export anyway with --allow-stale):\n${report(checked.bad)}`);
  const walkthrough = checked.tour ?? fail(`no ${WALKTHROUGH_FILE} in ${dir}`);
  const commit = (rev: string) => isRev(rev) ? git(['rev-parse', '--verify', '--end-of-options', rev + '^{commit}'], checkout, { soft: true })?.trim() ?? null : null;
  const provider = {
    ...checked.provider,
    // A Git tree can also resolve at sha:path. Only its file blobs belong in the export.
    read: (sha: string, file: string) => git(['cat-file', 'blob', `${sha}:${file}`], checkout, { soft: true }),
  };
  const bundle = buildWalkthroughBundle(walkthrough, provider, commit, new Date().toISOString());
  const shellPath = path.join(DIST, 'standalone.html');
  if (!fs.existsSync(shellPath)) fail('standalone walkthrough shell is missing; run bun run build');
  const shell = fs.readFileSync(shellPath, 'utf8');
  const output = path.resolve(options.out ?? WALKTHROUGH_EXPORT_FILE);
  const html = shell.replace(/<!--RR_(TITLE|BUNDLE)-->/g, (_, marker: string) => marker === 'TITLE' ? Bun.escapeHTML(walkthrough.title) : bundleJson(bundle));
  fs.writeFileSync(output, html);
  console.log(output);
}
