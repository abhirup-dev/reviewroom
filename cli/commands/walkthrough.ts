// publish-slides: ship walkthrough.json with the PR, as a comment `reviewroom pr` picks up.
import fs from 'node:fs';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit, readConfig } from '../lib/config.ts';
import { prTarget, upsertComment } from '../lib/github.ts';
import { report } from '../lib/links.ts';
import { walkthroughPath } from '../lib/state.ts';
import { BLOCK_MARK, encodeBlock, type Walkthrough } from '../../src/slides/model.shared.ts';
import { runCheck, schemaReport } from './check.ts';

const COMMENT_LIMIT = 65_536; // GitHub's maximum comment body

/** The comment body: the block plus a line for people reading the PR on GitHub. */
export function publishBody(w: Walkthrough, pr?: number) {
  const body = `${encodeBlock(w)}\n_A guided walkthrough of this PR: \`reviewroom pr ${pr ?? '<number>'}\` plays it in reviewroom._\n`;
  if (body.length > COMMENT_LIMIT) fail(`the walkthrough is ${body.length} characters as a comment; GitHub takes at most ${COMMENT_LIMIT}. Shorten the prose (leads and step text).`);
  return body;
}

type WalkthroughOpts = Global & { dryRun?: boolean; allowStale?: boolean };

export async function cmdPublishSlides(repo: string | null, o: WalkthroughOpts) {
  const dir = dirForEdit(repo, o.dir);
  if (!fs.existsSync(walkthroughPath(dir))) fail(`no walkthrough.json in ${dir}`);
  const c = await runCheck(repo, dir, { store: !o.dryRun, notes: false });
  if ('issues' in c) fail(schemaReport(c.issues));
  if (c.bad.length && !o.allowStale) fail(`${c.bad.length} link(s) need attention (fix them, or publish anyway with --allow-stale):\n${report(c.bad)}`);
  const t = prTarget(readConfig(dir));
  const body = publishBody(c.tour!, t?.number);
  if (o.dryRun) {
    console.log(body);
    return;
  }
  if (!t) fail('this review is not about a GitHub PR (start it with `reviewroom pr <number>`)');
  console.log(await upsertComment(dir, t, BLOCK_MARK, body));
}
