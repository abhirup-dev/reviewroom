// Which diff range a code thread is drawn on. A thread made on one commit's diff records the sha its side showed
// (CodeAnchor.sha); in a stack of PRs, one made on a PR's layer, the PR (CodeAnchor.pr), and its side's sha is the layer's
// as served now (so a restack moves it along); one on the whole stack, the whole stack's. Its line numbers mean those
// lines only where that side shows the same commit.
import type { Anchor } from './state/schema.shared';
import type { DiffRange, StackPr } from './state/model.shared';

type CodeAnchor = Extract<Anchor, { kind: 'code' }>;
type Sides = Pick<DiffRange, 'base' | 'head'>;
/** A stack's layers and its whole range: what threads without a sha of their own are at. */
export type StackSides = { layers: Pick<StackPr, 'number' | 'base' | 'head'>[]; all: Sides } | undefined;
const SHA = /^[0-9a-f]{40}$/;

/** The commit a side of a range shows, when it is a sha. */
export const sideSha = (r: Sides, side: 'base' | 'head') => {
  const v = side === 'base' ? r.base : r.head;
  return SHA.test(v) ? v : undefined;
};
/** The commit a thread's lines are at: its own sha, else (a stack) its layer's or the whole stack's side. None: a
 *  review of one diff, or a layer no longer in the stack. */
const pinnedSha = (a: CodeAnchor, stack: StackSides) => {
  if (a.sha || !stack) return a.sha;
  const r = a.pr === undefined ? stack.all : stack.layers.find((x) => x.number === a.pr);
  return r && sideSha(r, a.rev);
};

/** Drawn on `range` (one of `ranges`, every range the review offers): where its side shows its commit; not on the others.
 *  Without one, or once its commit is in no range (rewritten), everywhere, as before anchors had one. */
export function showsOn(a: CodeAnchor, range: Sides, ranges: Sides[], stack?: StackSides) {
  const sha = pinnedSha(a, stack);
  const at = (r: Sides) => sideSha(r, a.rev) === sha;
  return !sha || at(range) || !ranges.some(at);
}

/** The range a thread was made on (the first that shows its commit), while it still exists. */
export function homeRange<R extends Sides>(a: CodeAnchor, ranges: R[], stack?: StackSides) {
  const sha = pinnedSha(a, stack);
  return sha ? ranges.find((r) => sideSha(r, a.rev) === sha) : undefined;
}
