import { expect, test } from 'bun:test';
import { emptyState, type ReviewState } from '../core/types';
import { feedbackMarkdown } from './feedback';
import type { Walkthrough } from './walkthrough';

const walkthrough: Walkthrough = {
  version: 1,
  title: 'T',
  chapters: [
    { id: 'why', title: 'Why this change', steps: [{ id: 's1', text: '<p>One</p>' }, { id: 's2', text: '<p>The <a href="rr:code/a.go">fetcher</a> &amp; its <code>deadline</code>.</p>' }] },
  ],
};
const thread = (id: string, anchor: ReviewState['threads'][number]['anchor']) => ({ id, anchor, status: 'open' as const, createdRound: 1, messages: [{ id: 'm' + id, author: 'you' as const, round: 1, body: 'unclear', at: '' }] });

test('tour threads come last, in tour order, with their slide; a removed step is flagged', () => {
  const state = {
    ...emptyState(),
    round: 1,
    threads: [thread('t_gone', { kind: 'tour', chapter: 'why', step: 'old' }), thread('t_s2', { kind: 'tour', chapter: 'why', step: 's2' }), thread('t_gen', { kind: 'general' })],
  } as ReviewState;
  const md = feedbackMarkdown(state, { kind: 'feedback', walkthrough });
  const anchors = md.split('\n').filter((l) => l.startsWith('Anchor: '));
  expect(anchors).toEqual([
    'Anchor: general',
    'Anchor: guided walkthrough slide why/old (no longer in the guided walkthrough)  (rr:tour/why/old)',
    'Anchor: guided walkthrough "Why this change" slide 2/2: "The fetcher & its deadline."  (rr:tour/why/s2)',
  ]);
});

test('a stack: a section per PR, bottom first, with its verdict and branch; whole-stack threads last', () => {
  const code = (pr?: number) => ({ kind: 'code' as const, path: 'a.go', rev: 'head' as const, start: 1, end: 1, ...(pr && { pr }) });
  const state = { ...emptyState(), threads: [thread('t_top', code(368)), thread('t_all', code()), thread('t_low', code(366))] } as ReviewState;
  const stack = [366, 367, 368].map((number) => ({ number, title: `PR ${number}`, headLabel: `b${number}` }));
  const md = feedbackMarkdown(state, { kind: 'feedback', stack, verdicts: { 366: 'approve', 367: 'approve', 368: 'changes' } });
  expect(md.split('\n').filter((l) => /^#{2,3} /.test(l))).toEqual(['## #366 PR 366 - approved', '### Thread t_low - open', '## #367 PR 367 - approved', '## #368 PR 368 - changes wanted', '### Thread t_top - open', '## The whole stack', '### Thread t_all - open']);
  expect(md).toContain('Commit fixes for it on branch `b368`.');
  expect(md).toContain('Anchor: a.go:1 (#368, new/head side)  (rr:code/a.go@pr:368#L1)');
  // the same threads without a stack: as before stacks, one flat list
  const flat = feedbackMarkdown(state, { kind: 'feedback' });
  expect(flat.split('\n').filter((l) => /^#{2,3} /.test(l))).toEqual(['## Thread t_top - open', '## Thread t_all - open', '## Thread t_low - open']);
  expect(flat).not.toContain('whole stack');
});
