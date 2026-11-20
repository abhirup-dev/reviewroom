import { expect, test } from 'bun:test';
import { changeBlocks, oldToNewLine, touchedBlocks } from './hunks';

test('change blocks carry file lines and text; a range touches a block whole', () => {
  // @@ -3,5 +3,6 @@: line 3 replaced by two, then (after one unchanged line) line 5 removed, then line 6 added after it
  const d = {
    hunks: [{ deletionStart: 3, deletionCount: 3, additionStart: 3, additionCount: 4, hunkContent: [
      { type: 'change' as const, deletions: 1, additions: 2, deletionLineIndex: 0, additionLineIndex: 0 },
      { type: 'context' as const, lines: 1 },
      { type: 'change' as const, deletions: 1, additions: 0, deletionLineIndex: 2, additionLineIndex: 3 },
      { type: 'change' as const, deletions: 0, additions: 1, deletionLineIndex: 3, additionLineIndex: 3 },
    ] }],
    deletionLines: ['old 3', 'same', 'old 5'],
    additionLines: ['new 3', 'new 4', 'same', 'new 6'],
  };
  const blocks = changeBlocks(d);
  expect(blocks.map((b) => [b.del, b.add, b.at, b.oldAt])).toEqual([[[3, 3], [3, 4], 3, 3], [[5, 5], null, 6, 5], [null, [6, 6], 6, 6]]);
  // an addition inside an old-side range (the "before" code a slide is about) is part of it
  expect(touchedBlocks(blocks, 'deletions', 4, 6)).toEqual([blocks[1], blocks[2]]);
  expect(blocks[0].lines).toEqual(['old 3', 'new 3', 'new 4']);
  // new line 4 is inside the first block: the whole block counts, not just line 4
  expect(touchedBlocks(blocks, 'additions', 4, 4)).toEqual([blocks[0]]);
  // a removal-only block sits before new line 6
  expect(touchedBlocks(blocks, 'additions', 6, 6)).toEqual([blocks[1], blocks[2]]);
  expect(touchedBlocks(blocks, 'deletions', 5, 5)).toEqual([blocks[1]]);
});

test('unchanged old lines map across by their gap offset', () => {
  // @@ -10,3 +10,5 @@ (two lines added) and @@ -40,4 +42,2 @@ (two removed)
  const hunks = [
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 4, additionStart: 42, additionCount: 2 },
  ];
  expect(oldToNewLine(hunks, 5)).toBe(5); // before any change
  expect(oldToNewLine(hunks, 11)).toBeUndefined(); // inside a hunk
  expect(oldToNewLine(hunks, 20)).toBe(22); // between: shifted by the two added lines
  expect(oldToNewLine(hunks, 50)).toBe(50); // after both: +2 then -2
});
