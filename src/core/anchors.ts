// Which diff range a code thread is drawn on. A thread made on one commit's diff records the sha its side showed
// (CodeAnchor.sha): its line numbers mean those lines only where that side shows the same commit.
import type { Anchor, DiffRange } from './types';

type CodeAnchor = Extract<Anchor, { kind: 'code' }>;
type Sides = Pick<DiffRange, 'base' | 'head'>;
const SHA = /^[0-9a-f]{40}$/;

/** The commit a side of a range shows, when it is a sha. */
export const sideSha = (r: Sides, side: 'base' | 'head') => {
  const v = side === 'base' ? r.base : r.head;
  return SHA.test(v) ? v : undefined;
};
const at = (a: CodeAnchor, r: Sides) => sideSha(r, a.rev) === a.sha;

/** Drawn on `range` (one of `ranges`, every range the review offers): where its side shows its sha; not on the others.
 *  Without a sha, or once its commit is in no range (rewritten), everywhere, as before anchors had one. */
export const showsOn = (a: CodeAnchor, range: Sides, ranges: Sides[]) => !a.sha || at(a, range) || !ranges.some((r) => at(a, r));

/** The range a thread was made on (the first that shows its sha), while it still exists. */
export const homeRange = <R extends Sides>(a: CodeAnchor, ranges: R[]) => (a.sha ? ranges.find((r) => at(a, r)) : undefined);
