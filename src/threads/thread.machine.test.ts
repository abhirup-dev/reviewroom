import { expect, test } from 'bun:test';
import { createActor, fromPromise, waitFor } from 'xstate';
import { threadMachine } from './thread.machine.ts';
import { tick } from '../testing/wait';
import { fixture, type Fixture } from '../testing/fixture';

const anchor = { kind: 'general' } as const;
/** Requests answer when the test says so: `answer.create(x)` settles the pending create. */
const start = (scope: Fixture) => {
  let cleared = 0;
  const answer: { create?: (v: string | boolean) => void; resolve?: (v: boolean) => void } = {};
  const a = createActor(
    threadMachine.provide({
      actions: { clearSelection: () => void cleared++ },
      actors: {
        create: fromPromise(() => new Promise<string | boolean>((r) => (answer.create = r))),
        resolve: fromPromise(() => new Promise<boolean>((r) => (answer.resolve = r))),
      },
      delays: { leave: 0 },
    }),
  ).start();
  scope.defer(() => a.stop());
  const settled = () => waitFor(a, (s) => !s.matches({ composing: 'sending' }) && !s.matches('resolving'));
  return { a, answer, settled, cleared: () => cleared, at: () => a.getSnapshot().value, view: () => a.getSnapshot().context.view };
};

test('sending the first comment opens the new thread in a fresh view and drops the selection', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'compose', anchor, to: 'agent' });
  const composing = t.view();
  t.a.send({ type: 'compose', anchor: { kind: 'general' } }); // another anchor: still composing, selection kept
  expect([t.at(), t.view() !== composing, t.cleared()]).toEqual([{ composing: 'editing' }, true, 0]);
  t.a.send({ type: 'submit', body: 'hi', toGitHub: false });
  expect(t.at()).toEqual({ composing: 'sending' });
  t.answer.create!('t1');
  await t.settled();
  expect([t.at(), t.view(), t.cleared()]).toEqual(['viewing', { id: 't1' }, 1]);
});

test('a comment posted on GitHub closes the popup; one not sent stays in the composer', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'compose', anchor });
  t.a.send({ type: 'submit', body: 'hi', toGitHub: true });
  t.answer.create!(false);
  await t.settled();
  expect([t.at(), t.cleared()]).toEqual([{ composing: 'editing' }, 0]);
  t.a.send({ type: 'submit', body: 'hi', toGitHub: true });
  t.answer.create!(true);
  await t.settled();
  expect([t.at(), t.view(), t.cleared()]).toEqual(['closed', null, 1]);
});

test('closing a draft drops the selection; closing a thread has nothing to drop', () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'compose', anchor });
  t.a.send({ type: 'close' });
  expect([t.at(), t.view(), t.cleared()]).toEqual(['closed', null, 1]);
  t.a.send({ type: 'open', id: 't1' });
  t.a.send({ type: 'close' });
  expect([t.at(), t.cleared()]).toEqual(['closed', 1]);
});

test('opening a thread again gives a fresh view (docked and undocked again, say)', () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'open', id: 't1' });
  const first = t.view();
  t.a.send({ type: 'open', id: 't1' });
  expect(t.view()).toEqual(first);
  expect(t.view()).not.toBe(first);
});

test('resolving fades out then closes; refused, the thread stays up', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'open', id: 't1' });
  t.a.send({ type: 'resolve' });
  t.answer.resolve!(false);
  await t.settled();
  expect(t.at()).toBe('viewing');
  t.a.send({ type: 'resolve' });
  t.answer.resolve!(true);
  await t.settled();
  expect(t.at()).toBe('leaving');
  t.a.send({ type: 'open', id: 't2' }); // opened while fading: stays up
  expect([t.at(), t.view()]).toEqual(['viewing', { id: 't2' }]);
  t.a.send({ type: 'resolve' });
  t.answer.resolve!(true);
  await waitFor(t.a, (s) => s.matches('closed'));
});

test("a slow answer for a thread the popup has left doesn't drive the next one", async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'open', id: 't1' });
  t.a.send({ type: 'resolve' });
  t.a.send({ type: 'open', id: 't2' });
  t.answer.resolve!(true);
  await tick(5);
  expect([t.at(), t.view()]).toEqual(['viewing', { id: 't2' }]);

  t.a.send({ type: 'compose', anchor });
  t.a.send({ type: 'submit', body: 'hi', toGitHub: true });
  t.a.send({ type: 'compose', anchor: { kind: 'general' } }); // a new draft while the first is sending
  expect(t.at()).toEqual({ composing: 'editing' });
  t.answer.create!(true);
  await tick(5);
  expect(t.at()).toEqual({ composing: 'editing' });
});
