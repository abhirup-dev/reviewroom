import { expect, test } from 'bun:test';
import { build } from '../testing/build';
import { feedbackMarkdown } from './feedback.shared';
import type { Walkthrough } from '../slides/model.shared';

const walkthrough: Walkthrough = {
  version: 1,
  title: 'T',
  chapters: [
    { id: 'why', title: 'Why this change', steps: [{ id: 's1', text: '<p>One</p>' }, { id: 's2', text: '<p>The <a href="rr:code/a.go">fetcher</a> &amp; its <code>deadline</code>.</p>' }] },
  ],
};

test('tour threads come last, in tour order, with their slide; a removed step is flagged', () => {
  const state = build.state({
    threads: [build.thread('t_gone', { anchor: build.anchor.tour('why', 'old') }), build.thread('t_s2', { anchor: build.anchor.tour('why', 's2') }), build.thread('t_gen')],
  });
  const md = feedbackMarkdown(state, { kind: 'feedback', walkthrough });
  const anchors = md.split('\n').filter((l) => l.startsWith('Anchor: '));
  expect(anchors).toEqual([
    'Anchor: general',
    'Anchor: guided walkthrough slide why/old (no longer in the guided walkthrough)  (rr:tour/why/old)',
    'Anchor: guided walkthrough "Why this change" slide 2/2: "The fetcher & its deadline."  (rr:tour/why/s2)',
  ]);
});
