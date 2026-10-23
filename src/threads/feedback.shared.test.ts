import { expect, test } from 'bun:test';
import { emptyState, type ReviewState } from '../kernel/state/model.shared';
import { feedbackMarkdown } from './feedback.shared';
import type { Walkthrough } from '../slides/model.shared';

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
