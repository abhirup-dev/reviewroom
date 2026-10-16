import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { dirForEdit, loadConfig, repoOf } from '../lib/config.ts';
import { readState, commitOps } from '../lib/state.ts';
import { checkLinks, problems, report, applyFixes } from '../lib/links.ts';

// Stale-link check of review.html. --fix rewrites links whose code moved <=5 lines; --accept
// re-fingerprints every link as it is now (after you've re-read the changed ones). Exit 1 = problems left.
export async function cmdCheck(repo: string | null, o: Global & { fix?: boolean; accept?: boolean; json?: boolean }) {
  const dir = dirForEdit(repo, o.dir);
  const file = path.join(dir, 'review.html');
  if (!fs.existsSync(file)) fail(`no review.html in ${dir}`);
  const r = repoOf(dir, repo);
  const prov = makeProvider(r, loadConfig(dir, r));
  const known = readState(dir).links ?? {};
  const html = fs.readFileSync(file, 'utf8');
  let { results, links } = checkLinks(html, prov, o.accept ? {} : known);
  let fixed = html;
  if (o.fix) ({ html: fixed, links } = applyFixes(html, results, links));
  if (fixed !== html) {
    fs.writeFileSync(file, fixed);
    ({ results, links } = checkLinks(fixed, prov, links));
  }
  if (JSON.stringify(links) !== JSON.stringify(known)) await commitOps(dir, [{ op: 'setLinks', links }]);
  const bad = problems(results);
  if (o.json) console.log(JSON.stringify(bad, null, 2));
  else if (bad.length) console.log(`${bad.length} of ${results.length} links need attention:\n${report(bad)}`);
  else console.log(`${results.length} links ok${fixed !== html ? ' (moved links fixed)' : ''}`);
  if (bad.length) process.exitCode = 1;
}
