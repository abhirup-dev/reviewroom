import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig, repoOf } from '../lib/config.ts';
import { readState, commitOps, readWalkthrough, walkthroughPath } from '../lib/state.ts';
import { checkLinks, problems, report, applyFixes } from '../lib/links.ts';
import { fixTour, locate, tourText } from '../lib/walkthrough.ts';

// Stale-link check of review.html and walkthrough.json (which must match its schema first). --fix rewrites links
// whose code moved <=5 lines; --accept re-fingerprints every link as it is now (after you've re-read the changed
// ones). Exit 1 = problems left.
export async function cmdCheck(repo: string | null, o: Global & { fix?: boolean; accept?: boolean; json?: boolean }) {
  const dir = dirForEdit(repo, o.dir);
  const file = path.join(dir, 'review.html');
  if (!fs.existsSync(file)) fail(`no review.html in ${dir}`);
  const tour = readWalkthrough(dir);
  if (tour && !tour.ok) {
    console.error(`walkthrough.json does not match schema/walkthrough.schema.json:\n  ${tour.issues.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  const tourFile = walkthroughPath(dir);
  const tourRaw = tour ? fs.readFileSync(tourFile, 'utf8') : '';
  const tourLinks = tour?.ok ? tourText(tour.value) : '';
  const r = repoOf(dir, repo);
  const prov = makeProvider(r, loadConfig(dir, r));
  const known = readState(dir).links ?? {};
  const html = fs.readFileSync(file, 'utf8');
  let { results, links } = checkLinks(html, prov, o.accept ? {} : known, tourLinks);
  let fixed = html, fixedTour = tourRaw;
  const moved = results.some((x) => x.status === 'moved');
  if (o.fix && moved) {
    if (tour) fixedTour = fixTour(tourRaw, results, links); // same rewrites; the fingerprints move once, below
    ({ html: fixed, links } = applyFixes(html, results, links));
  }
  if (fixed !== html) fs.writeFileSync(file, fixed);
  if (fixedTour !== tourRaw) fs.writeFileSync(tourFile, fixedTour);
  const healed = fixed !== html || fixedTour !== tourRaw;
  if (healed) ({ results, links } = checkLinks(fixed, prov, links, tour?.ok ? tourText(JSON.parse(fixedTour)) : ''));
  if (JSON.stringify(links) !== JSON.stringify(known)) await commitOps(dir, [{ op: 'setLinks', links }]);
  const bad = locate(problems(results), tour?.ok ? tour.value : null);
  if (o.json) console.log(JSON.stringify(bad, null, 2));
  else if (bad.length) console.log(`${bad.length} of ${results.length} links need attention:\n${report(bad)}`);
  else console.log(`${results.length} links ok${tour ? ' (review.html and walkthrough.json)' : ''}${healed ? ' (moved links fixed)' : ''}`);
  if (bad.length) process.exitCode = 1;
}
