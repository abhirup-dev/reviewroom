// walkthrough.json on the CLI side: where a link sits in it (for `check`), the PR block (`pr`, `publish-slides`).
import type { GitHubSnapshot } from '../../src/core/types.ts';
import { findBlocks, stepRefs, type Walkthrough } from '../../src/shared/walkthrough.ts';
import { applyFixes, extractLinks, type LinkResult, type Links } from './links.ts';

/** Every string of the walkthrough a link can sit in, decoded (what `checkLinks` scans as `extra`). */
export const tourText = (w: Walkthrough) => w.chapters.flatMap((c) => [c.lead ?? '', ...c.steps.flatMap((s) => [s.text, ...stepRefs(s)])]).join('\n');

/** walkthrough.json with moved links rewritten in every string, re-serialized (2-space, trailing newline). */
export const fixTour = (json: string, results: LinkResult[], links: Links) =>
  JSON.stringify(JSON.parse(json, (_k, v: unknown) => (typeof v === 'string' ? applyFixes(v, results, links).html : v)), null, 2) + '\n';

/** Tag each result with where its link appears in the walkthrough: `<chapter>/<step>`, or `<chapter>` for a lead. */
export function locate(results: LinkResult[], w: Walkthrough | null) {
  if (!w) return results;
  const has = (s: string | undefined, ref: string) => !!s && extractLinks(s).includes(ref);
  return results.map((r) => {
    const where = w.chapters.flatMap((c) => [...(has(c.lead, r.ref) ? [c.id] : []), ...c.steps.filter((s) => stepRefs(s).includes(r.ref) || has(s.text, r.ref)).map((s) => `${c.id}/${s.id}`)]);
    return where.length ? { ...r, where } : r;
  });
}

/** The walkthrough to pull from a PR: the newest block in its conversation, else in its description. Only the PR
 *  author's or the viewer's own comments count: the prose is HTML the reviewer's browser renders. */
export function pickBlock(s: Pick<GitHubSnapshot, 'description' | 'threads'>) {
  const author = s.description?.login;
  const conv = (s.threads.find((t) => t.gh?.conversation)?.messages ?? []).filter((m) => m.gh?.mine || (author && m.gh?.login === author));
  const sources = [...[...conv].reverse().map((m) => ({ body: m.body, from: `PR comment by ${m.gh?.login} (${m.gh?.url})` })), { body: s.description?.body ?? '', from: 'the PR description' }];
  for (const src of sources) {
    const blocks = findBlocks(src.body);
    if (blocks.length) return { text: blocks.at(-1)!, from: src.from };
  }
  return null;
}
