import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { gestureMachine, type GestureEvent } from './gesture.machine';

const run = (...events: GestureEvent[]) => {
  const a = createActor(gestureMachine).start();
  for (const e of events) a.send(e);
  const s = a.getSnapshot();
  a.stop();
  return [s.value, s.context.dx, s.context.dy];
};
const start = (up?: boolean, down?: boolean): GestureEvent => ({ type: 'start', x: 100, y: 100, up, down });
const move = (dx: number, dy: number): GestureEvent => ({ type: 'move', x: 100 + dx, y: 100 + dy });

test('the axis stays open within 10px, then locks to the one mostly travelled', () => {
  expect(run(start(), move(6, 6))).toEqual(['pending', 6, 6]);
  expect(run(start(), move(12, 3))).toEqual(['horizontal', 12, 3]);
  expect(run(start(), move(3, -12))).toEqual(['vertical', 3, -12]);
});

test('once locked the axis holds, whichever way the finger goes after', () => {
  expect(run(start(), move(12, 0), move(12, 80))[0]).toBe('horizontal');
  expect(run(start(), move(0, 12), move(80, 12))[0]).toBe('vertical');
});

test('a vertical move the owner does not claim is left to scroll', () => {
  expect(run(start(true, false), move(0, 20))[0]).toBe('scroll');
  expect(run(start(true, false), move(0, -20))[0]).toBe('vertical');
  expect(run(start(false, true), move(0, -20))[0]).toBe('scroll');
});

test('end keeps the state with the final deltas; cancel voids it; start begins anew', () => {
  expect(run(start(), move(20, 0), { type: 'end', x: 170, y: 104 })).toEqual(['horizontal', 70, 4]);
  expect(run(start(), move(0, 20), { type: 'cancel' })[0]).toBe('cancelled');
  expect(run(start(), move(0, 20), { type: 'cancel' }, start(), move(3, 3))).toEqual(['pending', 3, 3]);
});
