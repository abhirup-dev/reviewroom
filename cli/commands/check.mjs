import fs from 'node:fs';
import path from 'node:path';
import { flags, die } from '../lib/args.mjs';
import { makeProvider } from '../lib/git.mjs';
import { dirForEdit, loadConfig, readState, commitOps } from '../lib/state.mjs';
import { checkLinks, problems, report, applyFixes } from '../lib/links.mjs';

// Stale-link check of review.html. --fix rewrites links whose code moved ≤5 lines; --accept
// re-fingerprints every link as it is now (after you've re-read the changed ones). Exit 1 = problems left.
export async function cmdCheck(repo) {
  const dir = dirForEdit(repo);
  const file = path.join(dir, 'review.html');
  if (!fs.existsSync(file)) die(`no review.html in ${dir}`);
  const prov = makeProvider(repo, loadConfig(dir, repo));
  const known = readState(dir).links ?? {};
  const html = fs.readFileSync(file, 'utf8');
  let { results, links } = checkLinks(html, prov, flags.accept ? {} : known);
  let fixed = html;
  if (flags.fix) ({ html: fixed, links } = applyFixes(html, results, links));
  if (fixed !== html) {
    fs.writeFileSync(file, fixed);
    ({ results, links } = checkLinks(fixed, prov, links));
  }
  if (JSON.stringify(links) !== JSON.stringify(known)) await commitOps(dir, [{ op: 'setLinks', links }]);
  const bad = problems(results);
  if (flags.json) console.log(JSON.stringify(bad, null, 2));
  else if (bad.length) console.log(`${bad.length} of ${results.length} links need attention:\n${report(bad)}`);
  else console.log(`${results.length} links ok${fixed !== html ? ' (moved links fixed)' : ''}`);
  if (bad.length) process.exitCode = 1;
}
