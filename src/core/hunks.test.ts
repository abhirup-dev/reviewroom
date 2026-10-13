import { expect, test } from 'bun:test';
import { oldToNewLine } from './hunks';

test('unchanged old lines map across by their gap offset', () => {
  // @@ -10,3 +10,5 @@ (two lines added) and @@ -40,4 +42,2 @@ (two removed)
  const hunks = [
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 4, additionStart: 42, additionCount: 2 },
  ];
  expect(oldToNewLine(hunks, 5)).toBe(5); // before any change
  expect(oldToNewLine(hunks, 11)).toBeUndefined(); // inside a hunk
  expect(oldToNewLine(hunks, 20)).toBe(22); // between: shifted by the two added lines
  expect(oldToNewLine(hunks, 50)).toBe(50); // after both: +2 then −2
});
