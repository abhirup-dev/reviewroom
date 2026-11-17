import { expect, test } from 'bun:test';
import { parseRef } from '../kernel/refs/refs.shared';
import { AskContext, askRef, contextPrompt, excerptLines, MAX_EXCERPT } from './context.shared';

const all = { key: 'all', base: 'main', head: 'feat/x' };
const commit = { key: 'abc123', base: 'abc123^', head: 'abc123' };
const code = (rev: 'base' | 'head') => ({ kind: 'code' as const, path: 'src/a b.ts', rev, start: 3, end: 5 });

test('a selection in the whole change links its side; in one commit, that commit', () => {
  expect(parseRef(askRef(code('head'), all))).toEqual({ type: 'code', path: 'src/a b.ts', rev: 'head', start: 3, end: 5 });
  expect(parseRef(askRef(code('base'), all))).toMatchObject({ rev: 'base' });
  expect(parseRef(askRef(code('head'), commit))).toMatchObject({ rev: 'abc123' });
  expect(parseRef(askRef(code('base'), commit))).toMatchObject({ rev: 'abc123^' });
});

test('a walkthrough block links its element, whatever text was selected in it', () => {
  const ref = askRef({ kind: 'doc', target: 'flow', path: 'p:nth-of-type(2)', quote: { exact: 'x' } }, all);
  expect(parseRef(ref)).toEqual({ type: 'doc', id: 'flow', path: 'p:nth-of-type(2)' });
});

test('the excerpt is the selected lines, capped', () => {
  expect(excerptLines('1\n2\n3\n4\n5\n6', 3, 5)).toBe('3\n4\n5');
  expect(excerptLines(Array.from({ length: 100 }, (_, i) => i + 1).join('\n'), 1, 100).split('\n')).toHaveLength(40);
});

test('only a code or walkthrough link with a brief excerpt is accepted', () => {
  const ok = { text: 'x', messageId: '', ref: 'rr:code/a.ts#L1', label: 'a.ts:1' };
  expect(AskContext.safeParse(ok).success).toBe(true);
  expect(AskContext.safeParse({ ...ok, ref: 'rr:thread/t1' }).success).toBe(false);
  expect(AskContext.safeParse({ ...ok, ref: 'src/a.ts' }).success).toBe(false);
  expect(AskContext.safeParse({ ...ok, text: 'x'.repeat(MAX_EXCERPT + 1) }).success).toBe(false);
});

test('the prompt names the link and the commit its side stood at', () => {
  const p = contextPrompt({ text: 'const a = 1;', messageId: '', ref: 'rr:code/a.ts@base#L1', label: 'a.ts:1' }, { base: 'b0', head: 'h0' });
  expect(p).toContain('rr:code/a.ts@base#L1 (base = b0)');
  expect(p).toContain('const a = 1;');
  expect(contextPrompt({ text: '', messageId: '', ref: 'rr:code/a.ts@abc#L1', label: 'a' }, { base: 'b0', head: 'h0' })).toContain('(commit abc)');
});
