import { expect, test } from 'bun:test';
import { anchorOf, anchorRef, formatRef, parseRef } from './refs';

test('every rr: form parses, and formats back to itself', () => {
  for (const s of ['rr:doc/intro', 'rr:doc/intro/p%3Anth-of-type(2)', 'rr:code/a/b.go', 'rr:code/a.go#L4', 'rr:code/a.go#L4-9', 'rr:code/a.go@base#L4', 'rr:code/a.go@abc123', 'rr:file/a.go@head#L2-3', 'rr:sym/Build', 'rr:thread/t_1', 'rr:round/2', 'rr:code/my%20file.go#L1', 'rr:tour/why/s2'])
    expect(formatRef(parseRef(s)!)).toBe(s);
  expect(parseRef('<rr:code/a.go#L4-L9>')).toEqual({ type: 'code', path: 'a.go', rev: 'head', start: 4, end: 9 });
  expect(parseRef('rr:doc/%E0%A4')).toBeNull(); // bad escape
  expect(parseRef('https://x')).toBeNull();
  expect(parseRef('rr:tour/why')).toBeNull();
});

test('anchors: the CLI stores what the browser would', () => {
  expect(anchorOf('rr:code/my%20file.go@base#L3-5')).toEqual({ kind: 'code', path: 'my file.go', rev: 'base', start: 3, end: 5 });
  expect(anchorOf('rr:code/a.go')).toEqual({ kind: 'code', path: 'a.go', rev: 'head', start: 1, end: 1 });
  expect(anchorOf('rr:doc/intro/p')).toEqual({ kind: 'doc', target: 'intro', path: 'p' });
  expect(anchorOf('rr:sym/Build')).toEqual({ kind: 'symbol', name: 'Build' });
  expect(anchorOf('rr:tour/why/s2')).toEqual({ kind: 'tour', chapter: 'why', step: 's2' });
  for (const s of ['rr:thread/t_1', 'rr:file/a.go@x', 'general', '']) expect(anchorOf(s)).toEqual({ kind: 'general' });
  for (const s of ['rr:doc/intro/p', 'rr:code/my%20file.go@base#L3-5', 'rr:sym/Build', 'rr:tour/why/s2']) expect(anchorRef(anchorOf(s))).toBe(s);
  expect(anchorRef({ kind: 'general' })).toBeNull();
});

test('anchorOf: a one-line code link ends where it starts; a tour link has exactly a chapter and a step', () => {
  expect(anchorOf('rr:code/a.go#L12')).toMatchObject({ kind: 'code', start: 12, end: 12 });
  expect(anchorOf('rr:code/a.go#L3-9')).toMatchObject({ start: 3, end: 9 });
  expect(anchorOf('rr:tour/a/b/c')).toEqual({ kind: 'general' });
});
