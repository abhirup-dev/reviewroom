import { expect, test } from 'bun:test';
import { createActor, fromPromise, SimulatedClock } from 'xstate';
import type { LastLayout } from '../shared/layout.ts';
import { layoutSaveMachine } from './layout.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dock = (n: number) => ({ dock: { grid: { root: { type: 'branch', data: [] }, width: n, height: 0, orientation: 'HORIZONTAL' }, panels: {} }, offered: [] }) as LastLayout;

/** The dock is `now`; the server answers a save when the test calls `done()`. */
const start = () => {
  const clock = new SimulatedClock();
  let now: LastLayout | null = dock(1);
  let reads = 0;
  const saves: { width: number; done: () => void }[] = [];
  const a = createActor(
    layoutSaveMachine.provide({ actors: { save: fromPromise(({ input }) => new Promise<void>((done) => saves.push({ width: input.dock.grid.width, done }))) } }),
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
