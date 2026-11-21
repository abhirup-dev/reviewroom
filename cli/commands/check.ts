import { WALKTHROUGH_FILE, REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail, hint } from '../lib/args.ts';
import { progressHash, readProgress, recordArtifact } from '../lib/progress.ts';
import { liveServer } from '../lib/registry.ts';
import { isFullSha, makeProvider, type Provider } from '../lib/git.ts';
import { loadConfig, reviewArgs } from '../lib/config.ts';
import { readState, commitOps, readWalkthrough, walkthroughPath } from '../lib/state.ts';
import { checkLinks, problems, report, applyFixes, extractLinks, uncomment, prepareSymbols, type SymbolResolver, type LinkResult } from '../lib/links.ts';
import { fixTour, locate, tourText } from '../lib/slides-file.ts';
import { findingReport, lintTour, type Finding } from '../lib/slide-lint.ts';
import { PKG } from '../lib/paths.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';
import { selectSlides, selectionLinks, type SlideSelector, type SlideSelection } from '../lib/slide-selection.ts';

type Checked = { issues: string[] } | { tour: Walkthrough | null; provider: Provider & SymbolResolver; results: LinkResult[]; bad: LinkResult[]; healed: boolean; reportHash: string; head?: string; notes: Finding[]; selection?: SlideSelection };
type CheckOptions = { fix?: boolean; accept?: boolean; store?: boolean; estimates?: boolean; notes?: boolean; select?: SlideSelector };

function checkScope(value: Walkthrough | null, o: CheckOptions, dir: string) {
  const selection = o.select ? selectSlides(value ?? fail(`no ${WALKTHROUGH_FILE} in ${dir}`), o.select) : undefined;
  const partial = selection && selection.scope.kind !== 'all';
  if (partial && (o.fix || o.accept || o.store !== false)) fail('scoped slide checks must be read-only');
  const selected = partial ? new Set(selection.slides.map((s) => `${s.chapter}/${s.step}`)) : undefined;
  const locations = partial ? selectionLinks(value!, selection) : undefined;
  return { selection, selected, locations };
}

function staticNotes(value: Walkthrough | null, prov: Provider & SymbolResolver, o: CheckOptions, selected?: ReadonlySet<string>) {
  if (!value || o.notes === false) return [];
  return lintTour(value, selected ? [] : prov.files(prov.base, prov.head), (n) => prov.resolveSymbol(n)[0]?.path, { estimates: o.estimates, selected });
}

function linkScope(html: string, tour: Walkthrough | null, locations?: Map<string, string[]>) {
  const extra = locations ? [...locations.keys()] : tour ? tourText(tour) : '';
  return { extra, refs: typeof extra === 'string' ? extractLinks(uncomment(html + '\n' + extra)) : extra };
}

/** The stale-link check of report.html (missing: '') and walkthrough.json, which must match its schema first
 *  (else only `issues`), plus the walkthrough's static checks (`notes`; `estimates: false` when rendering measures them).
 *  Stores the new fingerprints unless `store: false`; `fix` rewrites moved links in both files.
 *  `select` scopes slide checks without slicing the full tour; a partial selection requires store:false. */
export async function runCheck(repo: string | null, dir: string, o: CheckOptions = {}): Promise<Checked> {
  const tour = readWalkthrough(dir);
  if (tour && !tour.ok) return { issues: tour.issues };
  const file = path.join(dir, REPORT_FILE);
  const tourFile = walkthroughPath(dir);
  const value = tour?.ok ? tour.value : null; // past the schema check, a walkthrough that is there is valid
  const { selection, selected, locations } = checkScope(value, o, dir);
  const tourRaw = value ? fs.readFileSync(tourFile, 'utf8') : '';
  const r = repo ?? fail('not inside a git repository (use --repo)');
  const raw = makeProvider(r, loadConfig(dir, r));
  const known = readState(dir, { repair: o.store !== false }).links ?? {};
  const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const scope = linkScope(html, value, locations);
  const prov = await prepareSymbols(r, raw, scope.refs);
  let { results, links } = checkLinks(html, prov, o.accept ? {} : known, scope.extra, value);
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
  const notes = staticNotes(value, prov, o, selected);
  const bad = locations ? problems(results).map((r) => ({ ...r, where: locations.get(r.ref) })) : locate(problems(results), value);
  return { tour: value, provider: prov, results, bad, healed, reportHash: progressHash(fixed), head: isFullSha(raw.head) ? raw.head : undefined, notes, selection };
}

export const WALKTHROUGH_SCHEMA = path.join(PKG, 'schema', 'walkthrough.schema.json');
export const schemaReport = (issues: string[]) => `${WALKTHROUGH_FILE} does not match ${WALKTHROUGH_SCHEMA}:\n  ${issues.join('\n  ')}`;

// Stale-link check of report.html and walkthrough.json. --fix rewrites links whose code moved <=5 lines; --accept
// re-fingerprints every link as it is now (after you've re-read the changed ones). Exit 1 = problems left.
export async function cmdCheck(repo: string | null, dir: string, o: Global & { fix?: boolean; accept?: boolean; json?: boolean }) {
  const c = await runCheck(repo, dir, o);
  if ('issues' in c) {
    console.log(o.json ? JSON.stringify({ links: [], walkthrough: [], schema: c.issues }) : schemaReport(c.issues));
    process.exitCode = 1;
    return;
  }
  const { tour, results, bad, healed, notes } = c;
  if (o.json) console.log(JSON.stringify({ links: bad, walkthrough: notes }));
  else {
    if (bad.length) console.log(`${bad.length} of ${results.length} links need attention:\n${report(bad)}`);
    else console.log(`${results.length} links ok${tour ? ` (${REPORT_FILE} and ${WALKTHROUGH_FILE})` : ''}${healed ? ' (moved links fixed)' : ''}`);
    if (tour && notes.length) console.log(`\nthe walkthrough, ${WALKTHROUGH_FILE} (\`reviewroom slide-lint\` also measures each slide on screen):\n${findingReport(notes, tour)}`);
  }
  if (bad.length) process.exitCode = 1;
  else recordArtifact(dir, 'report', 'validated', { head: c.head }, c.reportHash);
  if (o.json) return;
  const args = reviewArgs(repo ?? '', dir);
  const has = (status: string) => bad.some((x) => x.status === status);
  const w = readProgress(dir).walkthrough.state;
  const url = liveServer(dir)?.url;
  hint(
    has('moved') && `moved: run \`reviewroom check ${args} --fix\``,
    has('changed') && `changed: re-read the code and the prose that links it, then \`reviewroom check ${args} --accept\``,
    has('broken') && 'broken: fix or remove the link',
    !bad.length && tour && w !== 'validated' && `Run \`reviewroom slide-lint ${args}\`: the walkthrough is not validated yet`,
    !bad.length && url && (!tour || w === 'validated') && readState(dir).round === 1 && `Hand over: tell the reviewer the review is ready at ${url}${tour ? '?walkthrough=' : ''}, then leave comments and click Send feedback or Approve`,
  );
}
