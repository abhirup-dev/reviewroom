import { expect, test } from 'bun:test';
import { pickBlock } from './slides-file.ts';
import { ownMarked } from './github.ts';
import { publishBody } from '../commands/walkthrough.ts';
import type { Walkthrough } from '../../src/walkthrough/model.shared.ts';

const block = (s: string) => '```reviewroom-walkthrough\n' + s + '\n```';
const msg = (body: string, login: string) => ({ body, gh: { login, url: `https://x/${login}` } });
const snap = (description: string, ...comments: ReturnType<typeof msg>[]) =>
  ({ description: { body: description, login: 'c' }, threads: comments.length ? [{ gh: { conversation: true }, messages: comments }] : [] }) as unknown as Parameters<typeof pickBlock>[0];

test('the newest block by the PR author (or the viewer) wins, then the description; none is null', () => {
  expect(pickBlock(snap(block('desc')))).toEqual({ text: 'desc', from: 'the PR description' });
  expect(pickBlock(snap(block('desc'), msg(block('old'), 'a'), msg('no block', 'b'), msg(block('new'), 'c'), msg(block('stranger'), 'd')))).toEqual({ text: 'new', from: 'PR comment by c (https://x/c)' });
  expect(pickBlock(snap('nothing', msg('chat', 'a')))).toBeNull();
});

test('publish: the viewer\'s own marked comment is the one updated; oversize is refused', () => {
  const c = (body: string, mine: boolean, kind = 'issue') => ({ body, gh: { kind, mine, node: body } });
  const s = { threads: [{ gh: { conversation: true }, messages: [c('<!-- m --> a', true), c('<!-- m --> theirs', false), c('<!-- m --> b', true), c('<!-- m --> review', true, 'review-body')] }] } as unknown as Parameters<typeof ownMarked>[0];
  expect(ownMarked(s, '<!-- m -->')?.body).toBe('<!-- m --> b');
  expect(ownMarked({ threads: [] }, '<!-- m -->')).toBeUndefined();
  const w: Walkthrough = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [{ id: 's', text: 'x' }] }] };
  expect(publishBody(w, 7)).toContain('reviewroom pr 7');
  expect(() => publishBody({ ...w, title: 'x'.repeat(70_000) })).toThrow(/at most 65536/);
});
