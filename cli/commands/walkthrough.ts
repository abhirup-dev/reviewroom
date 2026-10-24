// publish-slides: ship walkthrough.json with the PR, as a comment `reviewroom pr` picks up.
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit, readConfig } from '../lib/config.ts';
import { prTarget, upsertComment } from '../lib/github.ts';
import { report } from '../lib/links.ts';
import { splitWalkthrough } from '../lib/slides-file.ts';
import { BLOCK_MARK, encodeBlock, type Walkthrough } from '../../src/slides/model.shared.ts';
import { runCheck, schemaReport } from './check.ts';

const COMMENT_LIMIT = 65_536; // GitHub's maximum comment body

/** The comment body: the block plus a line for people reading the PR on GitHub. */
export function publishBody(w: Walkthrough, pr?: number) {
  const body = `${encodeBlock(w)}\n_A guided walkthrough of this PR: \`reviewroom pr ${pr ?? '<number>'}\` plays it in reviewroom._\n`;
  if (body.length > COMMENT_LIMIT) fail(`the walkthrough is ${body.length} characters as a comment; GitHub takes at most ${COMMENT_LIMIT}. Shorten the prose (leads and step text).`);
  return body;
}

type WalkthroughOpts = Global & { dryRun?: boolean; allowStale?: boolean; pr?: string };

export async function cmdPublishSlides(repo: string | null, o: WalkthroughOpts) {
  const dir = dirForEdit(repo, o.dir, 'walkthrough.json');
  const c = await runCheck(repo, dir, { store: !o.dryRun, notes: false });
  if ('issues' in c) fail(schemaReport(c.issues));
  if (c.bad.length && !o.allowStale) fail(`${c.bad.length} link(s) need attention (fix them, or publish anyway with --allow-stale):\n${report(c.bad)}`);
  const cfg = readConfig(dir);
  const t = prTarget(cfg);
  // a stack: each PR gets its own chapters (the bottom one the stack-wide ones too), as its own comment
  const parts = cfg.stack ? splitWalkthrough(c.tour!, { id: cfg.stack.id, prs: cfg.stack.prs.map((p) => p.number) }) : [{ pr: t?.number, doc: c.tour! }];
  const pick = o.pr ? parts.filter((p) => p.pr === +o.pr!) : parts;
  if (o.pr && !pick.length) fail(cfg.stack?.prs.some((p) => p.number === +o.pr!) ? `no chapter of the guided walkthrough is about PR #${o.pr}` : `PR #${o.pr} is not in this review's stack`);
  const bodies = pick.map((p) => ({ pr: p.pr, body: publishBody(p.doc, p.pr) })); // every one checked before any is posted
  if (o.dryRun) {
    console.log(bodies.map((b) => (cfg.stack ? `--- PR #${b.pr}\n${b.body}` : b.body)).join('\n'));
    return;
  }
  if (!t) fail('this review is not about a GitHub PR (start it with `reviewroom pr <number>`)');
  for (const b of bodies) console.log(await upsertComment(dir, { ...t, number: b.pr! }, BLOCK_MARK, b.body));
}
