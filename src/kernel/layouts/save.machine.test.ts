import { expect, test } from 'bun:test';
import { createActor, fromPromise, SimulatedClock } from 'xstate';
import type { LastLayout } from './layout.shared.ts';
import { layoutSaveMachine } from './save.machine.ts';
import { tick } from '../../testing/wait';

const dock = (n: number) => ({ dock: { grid: { root: { type: 'branch', data: [] }, width: n, height: 0, orientation: 'HORIZONTAL' }, panels: {} }, offered: [] }) as LastLayout;

/** The dock is `now`; the server answers a save when the test calls `done()`. */
const start = () => {
  const clock = new SimulatedClock();
  let now: LastLayout | null = dock(1);
  let reads = 0;
  const saves: { width: number; done: () => void; fail: () => void }[] = [];
  const a = createActor(
    layoutSaveMachine.provide({ actors: { save: fromPromise(({ input }) => new Promise<void>((done, reject) => saves.push({ width: input.dock.grid.width, done, fail: () => reject(new Error('save failed')) }))) } }),
    { input: { read: () => (reads++, now) }, clock },
  ).start();
  return { a, clock, saves, reads: () => reads, set: (l: LastLayout | null) => (now = l), done: async () => (saves.shift()!.done(), await tick()) };
};

test('a stream of changes is saved once, after it settles', () => {
  const { a, clock, saves } = start();
  a.send({ type: 'change' });
  clock.increment(200);
  a.send({ type: 'change' });
  clock.increment(200);
  expect(saves).toHaveLength(0);
  clock.increment(50);
  expect(saves.map((s) => s.width)).toEqual([1]);
});

test('one save at a time; the dock is still read on time meanwhile, and the newest read is saved next', async () => {
  const { a, clock, saves, reads, set, done } = start();
  a.send({ type: 'change' });
  clock.increment(250);
  for (const n of [2, 3]) {
    set(dock(n));
    a.send({ type: 'change' });
    clock.increment(250);
  }
  expect(reads()).toBe(3); // each settled change is read (an undo step) even with a save out
  expect(saves.map((s) => s.width)).toEqual([1]);
  await done();
  expect(saves.map((s) => s.width)).toEqual([3]);
  await done();
  expect(a.getSnapshot().matches({ store: 'idle' })).toBe(true);
});

test('nothing to keep is not saved; leaving the page skips the wait', () => {
  const { a, clock, saves, set } = start();
  set(null);
  a.send({ type: 'change' });
  clock.increment(250);
  expect(saves).toHaveLength(0);
  set(dock(3));
  a.send({ type: 'change' });
  a.send({ type: 'flush' });
  expect(saves.map((s) => s.width)).toEqual([3]);
});

test('dispose captures before debounce and drains without reading the torn-down dock', async () => {
  const { a, clock, saves, reads, set, done } = start();
  a.send({ type: 'change' });
  clock.increment(100);
  a.send({ type: 'dispose' });
  expect(reads()).toBe(1);
  expect(saves.map((s) => s.width)).toEqual([1]);
  set(dock(99)); // the dock and layout state can now be torn down synchronously
  a.send({ type: 'change' });
  clock.increment(300);
  expect(reads()).toBe(1);
  await done();
  expect(saves).toHaveLength(0);
  expect(a.getSnapshot().status).toBe('done');
});

test('dispose during a save captures the newest pending change and saves it in order before stopping', async () => {
  const { a, clock, saves, reads, set, done } = start();
  let completed = 0;
  a.subscribe({ complete: () => completed++ });
  a.send({ type: 'change' });
  clock.increment(250);
  set(dock(2));
  a.send({ type: 'change' });
  clock.increment(250);
  set(dock(3));
  a.send({ type: 'change' });
  a.send({ type: 'dispose' });
  expect(reads()).toBe(3);
  expect(saves.map((s) => s.width)).toEqual([1]);
  set(dock(99));
  a.send({ type: 'dispose' }); // repeated disposal must not recapture
  clock.increment(300);
  expect(reads()).toBe(3);
  await done();
  expect(saves.map((s) => s.width)).toEqual([3]);
  expect(a.getSnapshot().status).toBe('active');
  expect(completed).toBe(0);
  await done();
  expect(saves).toHaveLength(0);
  expect(a.getSnapshot().status).toBe('done');
  expect(completed).toBe(1);
});

test('dispose completes immediately when there is no persistent layout to save', () => {
  const { a, clock, saves, reads, set } = start();
  set(null);
  a.send({ type: 'dispose' });
  clock.increment(300);
  expect(reads()).toBe(1);
  expect(saves).toHaveLength(0);
  expect(a.getSnapshot().status).toBe('done');
});

test('dispose keeps the last pending layout when the dock is transient, and drains even after a save fails', async () => {
  const { a, clock, saves, set, done } = start();
  a.send({ type: 'change' });
  clock.increment(250);
  set(dock(2));
  a.send({ type: 'change' });
  clock.increment(250);
  set(null);
  a.send({ type: 'change' });
  a.send({ type: 'dispose' });
  saves.shift()!.fail();
  await tick();
  expect(saves.map((s) => s.width)).toEqual([2]);
  await done();
  expect(a.getSnapshot().status).toBe('done');
});


test('dispose captures synchronous layout edits before the dock publishes its deferred change event', async () => {
  const { a, set, saves, reads, done } = start();
  set(dock(7));
  a.send({ type: 'dispose' });
  expect(reads()).toBe(1);
  expect(saves.map(s => s.width)).toEqual([7]);
  await done();
  expect(a.getSnapshot().status).toBe('done');
});
