import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig } from '../lib/config.ts';
import { readState, commitOps, readWalkthrough, walkthroughPath } from '../lib/state.ts';
import { checkLinks, problems, report, applyFixes, type LinkResult } from '../lib/links.ts';
import { fixTour, locate, tourText } from '../lib/slides-file.ts';
import { findingReport, lintTour, type Finding } from '../lib/slide-lint.ts';
import { PKG } from '../lib/paths.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';

type Checked = { issues: string[] } | { tour: Walkthrough | null; results: LinkResult[]; bad: LinkResult[]; healed: boolean; notes: Finding[] };

/** The stale-link check of review.html (missing: '') and walkthrough.json, which must match its schema first
 *  (else only `issues`), plus the walkthrough's static checks (`notes`; `estimates: false` when rendering measures them).
 *  Stores the new fingerprints unless `store: false`; `fix` rewrites moved links in both files. */
export async function runCheck(repo: string | null, dir: string, o: { fix?: boolean; accept?: boolean; store?: boolean; estimates?: boolean; notes?: boolean } = {}): Promise<Checked> {
  const tour = readWalkthrough(dir);
  if (tour && !tour.ok) return { issues: tour.issues };
  const file = path.join(dir, 'review.html');
  const tourFile = walkthroughPath(dir);
  const value = tour?.ok ? tour.value : null; // past the schema check, a walkthrough that is there is valid
  const tourRaw = value ? fs.readFileSync(tourFile, 'utf8') : '';
  const r = repo ?? fail('not inside a git repository (use --repo)');
  const raw = makeProvider(r, loadConfig(dir, r));
  const found = new Map<string, ReturnType<typeof raw.search>>(); // the link check and the notes resolve the same symbols
  const prov = { ...raw, search: (...a: Parameters<typeof raw.search>) => found.get(JSON.stringify(a)) ?? found.set(JSON.stringify(a), raw.search(...a)).get(JSON.stringify(a))! };
  const known = readState(dir, { repair: o.store !== false }).links ?? {};
  const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let { results, links } = checkLinks(html, prov, o.accept ? {} : known, value ? tourText(value) : '', value);
  let fixed = html, fixedTour = tourRaw;
  if (o.fix && results.some((x) => x.status === 'moved')) {
    if (value) fixedTour = fixTour(tourRaw, results, links); // same rewrites; the fingerprints move once, below
    ({ html: fixed, links } = applyFixes(html, results, links));
  }
  if (fixed !== html) fs.writeFileSync(file, fixed);
  if (fixedTour !== tourRaw) fs.writeFileSync(tourFile, fixedTour);
  const healed = fixed !== html || fixedTour !== tourRaw;
  if (healed) ({ results, links } = checkLinks(fixed, prov, links, value ? tourText(JSON.parse(fixedTour)) : '', value));
  if (o.store !== false && JSON.stringify(links) !== JSON.stringify(known)) await commitOps(dir, [{ op: 'setLinks', links }]);
  const notes = value && o.notes !== false ? lintTour(value, prov.files(prov.base, prov.head), (n) => prov.search(n, prov.head, true, 1)[0]?.path, { estimates: o.estimates }) : [];
  return { tour: value, results, bad: locate(problems(results), value), healed, notes };
}

export const WALKTHROUGH_SCHEMA = path.join(PKG, 'schema', 'walkthrough.schema.json');
export const schemaReport = (issues: string[]) => `walkthrough.json does not match ${WALKTHROUGH_SCHEMA}:\n  ${issues.join('\n  ')}`;

// Stale-link check of review.html and walkthrough.json. --fix rewrites links whose code moved <=5 lines; --accept
// re-fingerprints every link as it is now (after you've re-read the changed ones). Exit 1 = problems left.
export async function cmdCheck(repo: string | null, o: Global & { fix?: boolean; accept?: boolean; json?: boolean }) {
  const dir = dirForEdit(repo, o.dir);
  if (!fs.existsSync(path.join(dir, 'review.html'))) fail(`no review.html in ${dir}`);
  const c = await runCheck(repo, dir, o);
  if ('issues' in c) {
    if (o.json) console.log(JSON.stringify({ links: [], walkthrough: [], schema: c.issues }, null, 2));
    else console.error(schemaReport(c.issues));
    process.exitCode = 1;
    return;
  }
  const { tour, results, bad, healed, notes } = c;
  if (o.json) console.log(JSON.stringify({ links: bad, walkthrough: notes }, null, 2));
  else {
    if (bad.length) console.log(`${bad.length} of ${results.length} links need attention:\n${report(bad)}`);
    else console.log(`${results.length} links ok${tour ? ' (review.html and walkthrough.json)' : ''}${healed ? ' (moved links fixed)' : ''}`);
    if (tour && notes.length) console.log(`\nthe guided walkthrough, walkthrough.json (\`reviewroom slide-lint\` also measures each slide on screen):\n${findingReport(notes, tour)}`);
  }
  if (bad.length) process.exitCode = 1;
}
