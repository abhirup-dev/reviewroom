// walkthrough.json on the CLI side: where a link sits in it (for `check`), the PR block (`pr`, `walkthrough publish`).
import type { GitHubSnapshot } from '../../src/core/types.ts';
import { findBlocks, stepRefs, type Walkthrough } from '../../src/shared/walkthrough.ts';
import { applyFixes, extractLinks, type LinkResult, type Links, type Piece } from './links.ts';

const chapterText = (c: Walkthrough['chapters'][number]) => [c.lead ?? '', ...c.steps.flatMap((s) => [s.text, ...stepRefs(s)])].join('\n');
/** Every string of the walkthrough a link can sit in, decoded. */
export const tourText = (w: Walkthrough) => w.chapters.map(chapterText).join('\n');
/** The same, a piece per chapter with the PR it is about (what `checkLinks` scans as `extra`). */
export const tourPieces = (w: Walkthrough): Piece[] => w.chapters.map((c) => ({ text: chapterText(c), pr: c.pr }));

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

/** A stack's walkthrough as one part per PR, bottom first, for its PR comment: each PR's chapters, the stack-wide ones
 *  (no pr) with the bottom PR. Every part says where it sits and the order of all chapters. PRs with none get no part. */
export function splitWalkthrough(w: Walkthrough, stack: { id: number; prs: number[] }) {
  const order = w.chapters.map((c) => c.id);
  const mine = (n: number, i: number) => (c: Walkthrough['chapters'][number]) => c.pr === n || (i === 0 && !stack.prs.includes(c.pr ?? 0));
  return stack.prs
    .map((n, i) => ({ pr: n, doc: { ...w, chapters: w.chapters.filter(mine(n, i)), stack: { id: stack.id, position: i + 1, order } } }))
    .filter((p) => p.doc.chapters.length);
}

/** The walkthroughs of a stack's PRs, bottom first, as one: a part published from a stack keeps each chapter's pr (none:
 *  the whole stack's) and its order; a PR's own walkthrough is that PR's chapters. Null: none. */
export function chainWalkthroughs(parts: { pr: number; doc: Walkthrough }[]): Walkthrough | null {
  if (!parts.length) return null;
  const seen = new Set<string>();
  const chapters = parts.flatMap(({ pr, doc }) =>
    doc.chapters.map((c) => {
      // two PRs' own walkthroughs may both have an "intro"
      const id = seen.has(c.id) ? `${c.id}-${pr}` : c.id;
      seen.add(id);
      return { ...c, id, pr: doc.stack ? c.pr : pr };
    }),
  );
  const order = parts.find((p) => p.doc.stack)?.doc.stack!.order ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  chapters.sort((a, b) => rank(a.id) - rank(b.id)); // stable: parts' own order where there is none
  return { version: 1, title: (parts.find((p) => p.doc.stack) ?? parts.at(-1)!).doc.title, chapters };
}
