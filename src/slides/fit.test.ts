import { expect, test } from 'bun:test';
import { codeWidth, fitDiff, foldedHeight, shapeOf, stackSize } from './fit';
import type { ChangeBlock } from '../review/hunks';

test('a chapter takes its shape from its longest slide; an intro needs the room', () => {
  const chapter = (words: number[], lead?: string) => ({ id: 'c', title: 'C', lead, steps: words.map((n, i) => ({ id: `s${i}`, text: `<p>${'word '.repeat(n)}</p>` })) });
  expect(shapeOf(chapter([8, 30]))).toBe('short');
  expect(shapeOf(chapter([8], '<rr-mermaid>flowchart TD</rr-mermaid>'))).toBe('mid');
  expect(shapeOf(chapter([8, 120]))).toBe('mid');
  expect(shapeOf(chapter([200]))).toBe('long');
});

const block = (dels: number, adds: number, len = 20): ChangeBlock => ({
  del: dels ? [10, 9 + dels] : null,
  add: adds ? [10, 9 + adds] : null,
  at: 10,
  oldAt: 10,
  lines: Array.from({ length: dels + adds }, () => 'x'.repeat(len)),
});

test('split when the change removes 5 lines or more, or more than it adds', () => {
  expect(fitDiff([block(0, 7)], 900).diffStyle).toBe('unified'); // additions only
  expect(fitDiff([block(1, 1)], 900).diffStyle).toBe('unified'); // a small replacement
  expect(fitDiff([block(1, 2)], 900).diffStyle).toBe('unified'); // mostly additions
  expect(fitDiff([block(2, 1)], 900).diffStyle).toBe('split'); // mostly removals
  expect(fitDiff([block(6, 20)], 900).diffStyle).toBe('split'); // five or more removed
  expect(fitDiff([block(3, 0)], 900).diffStyle).toBe('split'); // removals only
  expect(fitDiff([], 900).diffStyle).toBe('unified'); // no change on the slide
});

test('a stacked file is sized by the code it shows folded, not by the lines its slide points at', () => {
  // @@ 3 context, a 1-for-2 change, 3 context @@: unified 9 rows, split 8; two folds (before, after)
  const hunks = [{ hunkContent: [{ type: 'context' as const, lines: 3 }, { type: 'change' as const, deletions: 1, additions: 2 }, { type: 'context' as const, lines: 3 }] }];
  expect(foldedHeight(hunks, 'unified')).toBe(9 * 20 + 2 * 32);
  expect(foldedHeight(hunks, 'split')).toBe(8 * 20 + 2 * 32);
  expect(stackSize(244, 7)).toEqual({ flex: '1 1 calc(244px + var(--rr-band-h))', minHeight: 'calc(180px + var(--rr-band-h))' });
  expect(stackSize(undefined, 7).flex).toBe('1 1 calc(340px + var(--rr-band-h))');
});

test('wrap only a compact change whose lines overflow a column', () => {
  // split halves the width: 76 characters (570px) overflow a 450px column, not a 950px one
  expect(fitDiff([block(2, 1, 76)], 1000).wrap).toBe(true);
  expect(fitDiff([block(0, 2, 76)], 1000).wrap).toBe(false);
  expect(fitDiff([block(0, 2, 140)], 1000).wrap).toBe(true);
  // more than five changed lines clip and scroll sideways, however long
  expect(fitDiff([block(0, 6, 200)], 1000).wrap).toBe(false);
});

test('code needs the room of its longest changed line, both columns when split, never less than the file band', () => {
  expect(codeWidth([block(0, 3, 20)], 'unified')).toBe(560);
  expect(codeWidth([block(0, 3, 100)], 'unified')).toBe(100 * 7.5 + 50);
  expect(codeWidth([block(6, 1, 60)], 'split')).toBe((60 * 7.5 + 50) * 2);
});
