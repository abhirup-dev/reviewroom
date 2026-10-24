import { expect, test } from 'bun:test';
import { homeRange, showsOn } from './anchors';

const [B, C1, C2] = ['b', 'c', 'd'].map((x) => x.repeat(40));
const all = { base: B, head: C2, key: 'all' };
const first = { base: B, head: C1, key: C1 };
const second = { base: C1, head: C2, key: C2 };
const ranges = [all, first, second];
const code = (rev: 'base' | 'head', sha?: string) => ({ kind: 'code' as const, path: 'a.go', rev, start: 3, end: 4, sha });

test('a thread made on one commit shows where its side shows that commit, nowhere else', () => {
  const t = code('head', C1);
  expect(ranges.map((r) => showsOn(t, r, ranges))).toEqual([false, true, false]);
  expect(homeRange(t, ranges)).toBe(first);
  // the last commit's head is the review's head: the same lines in All changes
  expect(ranges.map((r) => showsOn(code('head', C2), r, ranges))).toEqual([true, false, true]);
  // the base side of the second commit is the first commit
  expect(ranges.map((r) => showsOn(code('base', C1), r, ranges))).toEqual([false, false, true]);
});

test("in a stack, a thread is at its layer's lines, or the whole stack's", () => {
  // #1: B..C1, #2: C1..C2 (the top); the whole stack B..C2; each layer is also a range
  const stack = { layers: [{ number: 1, base: B, head: C1 }, { number: 2, base: C1, head: C2 }], all };
  const layered = [all, first, second];
  const on = (a: ReturnType<typeof code> & { pr?: number }) => layered.map((r) => showsOn(a, r, layered, stack));
  expect(on({ ...code('head'), pr: 1 })).toEqual([false, true, false]);
  // the top layer's head is the whole stack's
  expect(on({ ...code('head'), pr: 2 })).toEqual([true, false, true]);
  expect(homeRange({ ...code('head'), pr: 1 }, layered, stack)).toBe(first);
  // no PR: the whole stack's lines, not the same numbers in a lower layer
  expect(on(code('head'))).toEqual([true, false, true]);
  expect(on(code('base'))).toEqual([true, true, false]);
  // a PR no longer in the stack: everywhere
  expect(on({ ...code('head'), pr: 9 })).toEqual([true, true, true]);
});

test('without a sha, or once its commit is gone, a thread shows everywhere', () => {
  expect(ranges.every((r) => showsOn(code('head'), r, ranges))).toBe(true);
  expect(ranges.every((r) => showsOn(code('head', 'e'.repeat(40)), r, ranges))).toBe(true);
  expect(homeRange(code('head'), ranges)).toBeUndefined();
});
