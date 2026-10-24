import { expect, test } from 'bun:test';
import { chainWalkthroughs, pickBlock, splitWalkthrough } from './slides-file.ts';
import { ownMarked } from './github.ts';
import { publishBody } from '../commands/walkthrough.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';

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

test('a stack: one part per PR with its chapters (stack-wide ones with the bottom), chained back in order', () => {
  const ch = (id: string, pr?: number) => ({ id, title: id, steps: [{ id: 's', text: 'x' }], ...(pr && { pr }) });
  const w: Walkthrough = { version: 1, title: 'T', chapters: [ch('intro'), ch('a', 366), ch('b', 367), ch('c', 368), ch('end')] };
  const parts = splitWalkthrough(w, { id: 9, prs: [366, 367, 368, 369] });
  expect(parts.map((p) => [p.pr, p.doc.chapters.map((c) => c.id), p.doc.stack.position])).toEqual([[366, ['intro', 'a', 'end'], 1], [367, ['b'], 2], [368, ['c'], 3]]);
  // three comments; pulled back from any member, in the order written
  expect(chainWalkthroughs([...parts].reverse())).toEqual({ version: 1, title: 'T', chapters: w.chapters });
  // PRs' own walkthroughs (published from single-PR reviews): each one's chapters are that PR's, ids kept apart
  const own = (pr: number): { pr: number; doc: Walkthrough } => ({ pr, doc: { version: 1, title: `PR ${pr}`, chapters: [ch('intro')] } });
  expect(chainWalkthroughs([own(366), own(367)])!.chapters.map((c) => [c.id, c.pr])).toEqual([['intro', 366], ['intro-367', 367]]);
  expect(chainWalkthroughs([])).toBeNull();
});

test('publish on a stack: the bodies of a dry run, one per PR', () => {
  const w: Walkthrough = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', pr: 2, steps: [{ id: 's', text: 'x' }] }] };
  const [p] = splitWalkthrough(w, { id: 1, prs: [1, 2] });
  expect(publishBody(p.doc, p.pr)).toContain('"position": 2');
});
