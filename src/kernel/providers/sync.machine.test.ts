import { expect, test } from 'bun:test';
import { createActor, fromCallback, fromPromise, SimulatedClock } from 'xstate';
import { emptyState, type ReviewState } from '../state/model.shared.ts';
import { roundStatus, syncMachine, unsent, view } from './sync.machine.ts';
import { tick } from '../../testing/wait';
import { fixture, type Fixture } from '../../testing/fixture';
import type { Op } from '../state/schema.shared.ts';

const pin = (ref: string): Op => ({ op: 'setPin', ref, pinned: true });
const at = (rev: number, pins: string[] = []): ReviewState => ({ ...emptyState(), rev, pins });
const T0 = '2026-10-17T10:00:00.000Z';
const S = T0; // when the server started

/** The server answers when the test says so: `reply()` settles the oldest pending POST. */
const start = (scope: Fixture) => {
  const clock = new SimulatedClock();
  const posts: { ops: Op[]; ok: (v: { rev: number } | { rejected: number; error: string }) => void; fail: (e: Error) => void }[] = [];
  let streams = 0;
  let refetched = at(0);
  const a = createActor(
    syncMachine.provide({
      actors: {
        post: fromPromise(({ input }) => new Promise((ok, fail) => posts.push({ ops: input.ops, ok, fail }))),
        fetchState: fromPromise(async () => refetched),
        stream: fromCallback(() => void streams++),
      },
    }),
    { input: { base: at(1) }, clock },
  );
  scope.defer(() => a.stop());
  const out: { type: string; text?: string; state?: ReviewState }[] = [];
  for (const t of ['state', 'error', 'reload'] as const) a.on(t, (e) => void out.push(e));
  a.start();
  a.send({ type: 'connect' });
  const reply = async (r: { rev: number } | { rejected: number; error: string } | Error) => {
    const p = posts.shift()!;
    if (r instanceof Error) p.fail(r);
    else p.ok(r);
    await tick();
  };
  return { a, clock, posts, reply, out, streams: () => streams, refetch: (s: ReviewState) => (refetched = s), ctx: () => a.getSnapshot().context, sending: () => a.getSnapshot().hasTag('sending') };
};

test('one send in flight; ops queued meanwhile go next and only what went out is acked', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  t.a.send({ type: 'op', op: pin('b') });
  expect(t.posts.map((p) => p.ops.length)).toEqual([1]);
  await t.reply({ rev: 2 });
  expect(t.posts.map((p) => p.ops)).toEqual([[pin('b')]]);
  expect(t.ctx().queue.map((q) => q.ackRev)).toEqual([2, undefined]);
  await t.reply({ rev: 3 });
  expect(unsent(t.ctx())).toBe(false);
  // the server's broadcast at rev 3 settles both; what's shown is the server's state
  t.a.send({ type: 'state', state: at(3, ['a', 'b']) });
  expect(t.ctx().queue).toEqual([]);
  expect(t.out.at(-1)!.state!.pins).toEqual(['a', 'b']);
});

test('until the server has them, what is shown is its state plus the unsent ops; older broadcasts are ignored', () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  t.a.send({ type: 'state', state: at(0, ['old']) });
  expect(t.ctx().base.rev).toBe(1);
  expect(view(t.ctx()).pins).toEqual(['a']);
});

test('a stall is said once, retried on the timer, and said again after the next success', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('fetch failed'));
  expect(t.out.map((e) => e.text)).toEqual(['Not saved yet: the reviewroom server is not answering. Retrying.']);
  expect(t.posts.length).toBe(0);
  t.clock.increment(3000);
  expect(t.posts.length).toBe(1);
  await t.reply(new Error('state.lock is held'));
  t.clock.increment(3000);
  await t.reply({ rev: 2 });
  expect(t.out.length).toBe(1);
  t.a.send({ type: 'op', op: pin('b') });
  await t.reply(new Error('disk full'));
  expect(t.out.at(-1)!.text).toBe('Not saved yet (disk full). Retrying.');
});

test('stalled: the server saying hello again, or a flush, sends at once', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('x'));
  t.a.send({ type: 'flush' });
  expect(t.sending()).toBe(true);
  await t.reply(new TypeError('x'));
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  expect(t.sending()).toBe(true);
});

test('an op that can never apply is dropped and said; the rest of its batch still saves', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('x'));
  t.a.send({ type: 'op', op: pin('b') });
  t.clock.increment(3000);
  expect(t.posts[0].ops).toEqual([pin('a'), pin('b')]);
  await t.reply({ rejected: 0, error: 'thread t1 not found' });
  expect(t.out.at(-1)!.state!.pins).toEqual(['b']);
  expect(t.out.at(-2)!.text).toBe('Not saved: thread t1 not found');
  expect(t.posts.map((p) => p.ops)).toEqual([[pin('b')]]);
});

test('the stream reconnects after a drop and catches up; a new run reloads once the send in flight is done', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  t.a.send({ type: 'down' });
  t.clock.increment(2000);
  expect(t.streams()).toBe(2);
  t.refetch(at(5, ['agent']));
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  await tick();
  expect(t.out.at(-1)!.state!.pins).toEqual(['agent']);

  t.a.send({ type: 'op', op: pin('a') });
  t.a.send({ type: 'down' });
  t.clock.increment(2000);
  t.a.send({ type: 'hello', hash: 'h2', started: S }); // a new `reviewroom review` run
  expect(t.out.some((e) => e.type === 'reload')).toBe(false);
  await t.reply({ rev: 6 });
  expect(t.out.filter((e) => e.type === 'reload').length).toBe(1);
});

test('a reload waits for ops queued behind the send in flight', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  t.a.send({ type: 'op', op: pin('a') });
  t.a.send({ type: 'op', op: pin('b') });
  t.a.send({ type: 'review' });
  await t.reply({ rev: 2 });
  expect(t.out.some((e) => e.type === 'reload')).toBe(false);
  await t.reply({ rev: 3 });
  expect(t.out.filter((e) => e.type === 'reload').length).toBe(1);
});

test('stalled when a reload is due: one more try at once, then reload whatever it says', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('x'));
  t.a.send({ type: 'review' });
  expect([t.sending(), t.out.some((e) => e.type === 'reload')]).toEqual([true, false]);
  await t.reply(new TypeError('x'));
  expect(t.out.filter((e) => e.type === 'reload').length).toBe(1);
});

test('a rejection is an answer: a stall that ends in one is over', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('x'));
  t.clock.increment(3000);
  await t.reply({ rejected: 0, error: 'gone' });
  expect([t.ctx().failures, unsent(t.ctx())]).toEqual([0, false]);
});

test('round status comes from the state and which run of the server this is', () => {
  const sent = (sentAt: string): ReviewState => ({ ...at(3), round: 3, rounds: [{ n: 2, status: 'sent', startedAt: T0, sentAt }, { n: 3, status: 'open', startedAt: sentAt }] });
  expect(roundStatus({ base: sent('2026-10-17T10:00:05.000Z'), started: T0 })).toBe('waiting'); // sent during this run
  expect(roundStatus({ base: sent('2026-10-17T10:00:05.000Z'), started: '2026-10-17T11:00:00.000Z' })).toBe(null); // a later run: the agent is back
  expect(roundStatus({ base: sent('2026-10-17T10:00:05.000Z'), started: null })).toBe(null); // not connected yet
  expect(roundStatus({ base: { ...at(2), round: 2, rounds: [{ n: 2, status: 'approved', startedAt: T0, sentAt: T0 }] }, started: T0 })).toBe('approved');
});

test('a due reload still goes once a send fails, even after a success in between', async () => {
  using scope = fixture();
  const t = start(scope);
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  t.a.send({ type: 'op', op: pin('a') });
  await t.reply(new TypeError('x'));
  t.a.send({ type: 'review' }); // due now; the flush retries at once
  t.a.send({ type: 'op', op: pin('b') });
  await t.reply({ rev: 2 }); // a stored, b queued behind it
  expect(t.out.some((e) => e.type === 'reload')).toBe(false);
  await t.reply(new TypeError('x'));
  expect(t.out.filter((e) => e.type === 'reload').length).toBe(1);
});

test('first contact catches up on what changed since the page loaded; the round status waits for it', async () => {
  using scope = fixture();
  const t = start(scope);
  t.refetch(at(4, ['other tab']));
  t.a.send({ type: 'hello', hash: 'h1', started: S });
  expect(t.a.getSnapshot().hasTag('catchingUp')).toBe(true);
  await tick();
  expect([t.a.getSnapshot().hasTag('catchingUp'), t.out.at(-1)!.state!.pins]).toEqual([false, ['other tab']]);
});
