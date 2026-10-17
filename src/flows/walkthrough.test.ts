import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import type { Walkthrough } from '../shared/walkthrough';
import { current, deepLink, target, walkthroughMachine } from './walkthrough';

const steps = (...ids: string[]) => ids.map((id) => ({ id, text: id }));
const doc: Walkthrough = {
  version: 1,
  title: 'T',
  chapters: [
    { id: 'a', title: 'A', steps: steps('a1', 'a2') },
    { id: 'b', title: 'B', steps: steps('b1', 'b2', 'b3') },
  ],
};
const start = (d: Walkthrough | null = doc) => {
  const a = createActor(walkthroughMachine).start();
  a.send({ type: 'load', doc: d });
  return a;
};
const where = (a: ReturnType<typeof start>) => {
  const s = a.getSnapshot();
  return [s.value, s.context.chapter, s.context.step];
};

test('open without a document stays closed', () => {
  const a = start(null);
  a.send({ type: 'open' });
  expect(where(a)).toEqual(['closed', 0, 0]);
});

test('next and prev cross chapter edges and stop at the ends', () => {
  const a = start();
  a.send({ type: 'open' });
  a.send({ type: 'prev' });
  expect(where(a)).toEqual(['playing', 0, 0]);
  a.send({ type: 'next' });
  a.send({ type: 'next' });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'prev' });
  expect(where(a)).toEqual(['playing', 0, 1]);
  for (let i = 0; i < 9; i++) a.send({ type: 'next' });
  expect(where(a)).toEqual(['playing', 1, 2]);
  expect(current(a.getSnapshot().context)).toMatchObject({ isFirst: false, isLast: true, step: { id: 'b3' } });
});

test('open by ids, unknown ids fall back, goto clamps', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b2' });
  expect(where(a)).toEqual(['playing', 1, 1]);
  a.send({ type: 'open', chapter: 'b', step: 'nope' });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'open', chapter: 'nope' });
  expect(where(a)).toEqual(['playing', 0, 0]);
  a.send({ type: 'goto', chapter: 7, step: 7 });
  expect(where(a)).toEqual(['playing', 1, 2]);
});

test('pause then resume keeps the step; close then open starts over', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b3' });
  a.send({ type: 'pause' });
  expect(where(a)).toEqual(['paused', 1, 2]);
  a.send({ type: 'resume' });
  expect(where(a)).toEqual(['playing', 1, 2]);
  a.send({ type: 'close' });
  a.send({ type: 'open' });
  expect(where(a)).toEqual(['playing', 0, 0]);
});

test('reloading keeps the position where it exists; a removed document closes', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b3' });
  a.send({ type: 'load', doc: { ...doc, chapters: [doc.chapters[0], { ...doc.chapters[1], steps: steps('b1') }] } });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'load', doc: null });
  expect(where(a)).toEqual(['closed', 1, 0]);
});

test('the code pane target: own ref, last ref in the chapter, lead diagram, an earlier ref, nothing', () => {
  const d: Walkthrough = {
    version: 1,
    title: 'T',
    chapters: [
      { id: 'a', title: 'A', steps: [{ id: 'a1', text: 'x' }, { id: 'a2', text: 'x', ref: 'rr:code/a.go#L1' }, { id: 'a3', text: 'x' }] },
      { id: 'b', title: 'B', lead: '<rr-flow><rr-node>n</rr-node></rr-flow>', steps: [{ id: 'b1', text: 'x' }] },
      { id: 'c', title: 'C', steps: [{ id: 'c1', text: 'x' }] },
    ],
  };
  const at = (chapter: number, step: number) => target({ doc: d, chapter, step });
  expect([at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(2, 0)]).toEqual([null, { ref: 'rr:code/a.go#L1' }, { ref: 'rr:code/a.go#L1' }, 'diagram', { ref: 'rr:code/a.go#L1' }]);
});

test('deep link: ?walkthrough=<chapter>/<step>, either part optional', () => {
  expect(deepLink('?walkthrough=latency/s3')).toEqual({ chapter: 'latency', step: 's3' });
  expect(deepLink('?x=1&walkthrough=latency')).toEqual({ chapter: 'latency', step: undefined });
  expect(deepLink('?walkthrough')).toEqual({ chapter: undefined, step: undefined });
  expect(deepLink('?x=1')).toBeNull();
});
