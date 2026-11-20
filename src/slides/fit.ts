// How the walkthrough draws a slide's code, judged on the change blocks the slide touches (never the rest of the file):
// split when the change removes 5 lines or more, or more than it adds (a small replacement reads unified); wrap a compact
// change (5 changed lines or fewer) whose lines overflow a column, else clip and scroll sideways.
import type { ChangeBlock } from '../review/hunks';
import type { Fit } from '../review/code';
import type { Walkthrough } from './model.shared';

const SHORT_WORDS = 40; // a chapter whose slides all fit in this many words, with no intro, is short
const LONG_WORDS = 150; // one slide over this many makes it long

/** A chapter's shape, from its longest slide, set once per chapter so nothing moves between its slides (slides.css):
 *  short slides with no intro read at the lede size, lower down, beside a narrow narration; long ones get a wide one. */
export function shapeOf(c: Walkthrough['chapters'][number]): 'short' | 'mid' | 'long' {
  const most = Math.max(...c.steps.map((s) => s.text.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length));
  return most <= SHORT_WORDS && !c.lead ? 'short' : most <= LONG_WORDS ? 'mid' : 'long';
}

const SPLIT_REMOVED = 5; // a change removing this many lines reads side by side, whatever it adds
const WRAP_CHANGED = 5; // a change of at most this many lines wraps rather than scrolls sideways
// one character of the code's 12.5px monospace (--diffs-font-size, diffs.css), and the line numbers and padding
const CHAR = 7.5;
const GUTTER = 50;

const count = (r: [number, number] | null) => (r ? r[1] - r[0] + 1 : 0);
const longestOf = (blocks: ChangeBlock[]) => Math.max(0, ...blocks.flatMap((b) => b.lines.map((l) => l.trimEnd().replace(/\t/g, '    ').length)));

/** The view for these blocks. */
export function viewOf(blocks: ChangeBlock[]): Fit['diffStyle'] {
  const dels = blocks.reduce((n, b) => n + count(b.del), 0);
  const adds = blocks.reduce((n, b) => n + count(b.add), 0);
  return dels >= SPLIT_REMOVED || dels > adds ? 'split' : 'unified';
}

/** The view and wrapping for these blocks in a pane `width` px wide (a split view's column: half of it). */
export function fitDiff(blocks: ChangeBlock[], width: number): Fit {
  const diffStyle = viewOf(blocks);
  const changed = blocks.reduce((n, b) => n + count(b.del) + count(b.add), 0);
  return { diffStyle, wrap: changed <= WRAP_CHANGED && longestOf(blocks) * CHAR > (diffStyle === 'split' ? width / 2 : width) - GUTTER };
}

const BAND = 560; // the file band's path, views, size and Viewed

/** The width code needs to show these blocks unclipped, in px (a chapter's widest sets how far its narration may
 *  widen, player.ts): the longest changed line with its line numbers, in each column of a split view, and never less
 *  than the file band. */
export const codeWidth = (blocks: ChangeBlock[]) => Math.max(BAND, (longestOf(blocks) * CHAR + GUTTER) * (viewOf(blocks) === 'split' ? 2 : 1));

const ROW = 20; // a code row
const FOLD = 32; // a fold: its "N unmodified lines" row
type Hunk = { hunkContent: ({ type: 'context'; lines: number } | { type: 'change'; deletions: number; additions: number })[] };

/** How tall a file's diff stands folded to its hunks, in px (a stacked chunk's share of the pane, player.ts): its rows
 *  in this view, a fold before each hunk and one after the last. */
export function foldedHeight(hunks: Hunk[], diffStyle: Fit['diffStyle']) {
  let rows = 0;
  for (const hk of hunks) for (const c of hk.hunkContent) rows += c.type === 'context' ? c.lines : diffStyle === 'split' ? Math.max(c.deletions, c.additions) : c.deletions + c.additions;
  return rows * ROW + (hunks.length + 1) * FOLD;
}

/** A stacked chunk's size: its flex from its code's height (its band on top), so a short file is not left floating in a
 *  share it cannot fill and a long one is not squeezed, all giving way in proportion when they do not fit; and never
 *  less than its slide's lines and a row either side. Code with no plan (a file the PR left alone): its lines and ten
 *  more. */
export const stackSize = (tall: number | undefined, lines: number) => ({
  flex: `1 1 calc(${tall ?? (lines + 10) * ROW}px + var(--rr-band-h))`,
  minHeight: `calc(${(lines + 2) * ROW}px + var(--rr-band-h))`,
});
