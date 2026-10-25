import { expect, test } from 'bun:test';
import { createActor, fromPromise, SimulatedClock } from 'xstate';
import { ASK_MS, cardMachine, chromeMachine, coachMachine, IDLE_MS, POINT_MS, SETTLE_MS, type Orient } from './phone.machine';

const chrome = (held = () => false) => {
  const clock = new SimulatedClock();
  const a = createActor(chromeMachine.provide({ guards: { held } }), { clock }).start();
  return { a, later: (ms: number) => clock.increment(ms), is: () => a.getSnapshot().value };
};

test('chrome: shown fades to immersive after IDLE_MS untouched (4 s), not before', () => {
  const c = chrome();
  expect(IDLE_MS).toBe(4000);
  c.a.send({ type: 'wake' });
  c.later(IDLE_MS - 1);
  expect(c.is()).toBe('shown');
  c.later(1);
  expect(c.is()).toBe('immersive');
});

test('chrome: a touch while shown restarts the wait; a touch while immersive does nothing; wake brings it back', () => {
  const c = chrome();
  c.a.send({ type: 'wake' });
  c.later(3000);
  c.a.send({ type: 'touch' });
  c.later(3000);
  expect(c.is()).toBe('shown');
  c.later(1000);
  expect(c.is()).toBe('immersive');
  c.a.send({ type: 'touch' });
  expect(c.is()).toBe('immersive');
  c.a.send({ type: 'wake' }); // Show controls
  expect(c.is()).toBe('shown');
});

test('chrome: hide (Full screen) goes immersive at once; only while shown', () => {
  const c = chrome();
  c.a.send({ type: 'hide' });
  expect(c.is()).toBe('off');
  c.a.send({ type: 'wake' });
  c.a.send({ type: 'hide' });
  expect(c.is()).toBe('immersive');
});

test('chrome: held blocks the fade until it lets go', () => {
  let held = true;
  const c = chrome(() => held);
  c.a.send({ type: 'wake' });
  c.later(IDLE_MS * 3);
  expect(c.is()).toBe('shown');
  held = false;
  c.later(IDLE_MS);
  expect(c.is()).toBe('immersive');
});

test('chrome: stop (paused, closed) keeps it shown with no timer', () => {
  const c = chrome();
  c.a.send({ type: 'wake' });
  c.a.send({ type: 'stop' });
  c.later(IDLE_MS * 2);
  expect(c.is()).toBe('off');
});

const H: [number, number, number] = [60, 300, 600];
const card = () => {
  const clock = new SimulatedClock();
  const a = createActor(cardMachine, { clock }).start();
  const grab = (o: { up?: boolean; grip?: boolean; scrollTop?: number; height?: number; heights?: [number, number, number] } = {}) =>
    a.send({ type: 'grab', up: o.up ?? true, grip: o.grip ?? false, scrollTop: o.scrollTop ?? 0, height: o.height ?? 300, heights: o.heights ?? H });
  const at = () => [a.getSnapshot().value, a.getSnapshot().context.detent];
  return { a, grab, at, later: (ms: number) => clock.increment(ms) };
};

test('card: a drag follows the finger within one line and tall, and settles on the nearest detent', () => {
  const c = card();
  c.grab();
  c.a.send({ type: 'drag', dy: -1000 });
  expect(c.a.getSnapshot().context.height).toBe(600);
  c.a.send({ type: 'drag', dy: 1000 });
  expect(c.a.getSnapshot().context.height).toBe(60);
  c.a.send({ type: 'drag', dy: -270 }); // 570: nearest tall
  c.a.send({ type: 'release', dy: -270 });
  expect(c.at()).toEqual(['settling', 2]);
  expect(c.a.getSnapshot().context.from).toBe(570);
  c.later(SETTLE_MS);
  expect(c.at()).toEqual(['rest', 2]);
});

test('card: a flick moves one detent its way, a short drag springs back', () => {
  const c = card();
  c.grab();
  c.a.send({ type: 'drag', dy: -50 });
  c.a.send({ type: 'release', dy: -50 });
  expect(c.at()).toEqual(['settling', 2]);
  c.grab({ height: 600 });
  c.a.send({ type: 'drag', dy: 20 });
  c.a.send({ type: 'release', dy: 20 });
  expect(c.at()).toEqual(['settling', 2]);
});

test('card: tall is skipped when the text fits the default detent', () => {
  const c = card();
  c.grab({ heights: [60, 300, 304] });
  c.a.send({ type: 'drag', dy: -100 });
  c.a.send({ type: 'release', dy: -100 });
  expect(c.at()).toEqual(['settling', 1]);
});

test('card: dragging down from text scrolled past its top scrolls instead; from the top or the grip it sizes', () => {
  const c = card();
  c.grab({ up: false, scrollTop: 40 });
  expect(c.at()).toEqual(['rest', 1]);
  expect(c.a.getSnapshot().can({ type: 'grab', up: false, grip: true, scrollTop: 40, height: 300, heights: H })).toBe(true);
  c.grab({ up: false, scrollTop: 0 });
  expect(c.at()).toEqual(['dragging', 1]);
});

test('card: up past tall scrolls the text; the grip still drags; cancel settles back', () => {
  const c = card();
  c.a.send({ type: 'size', detent: 2, height: 300, heights: H });
  c.later(SETTLE_MS);
  c.grab({ up: true, height: 600 });
  expect(c.at()).toEqual(['rest', 2]);
  c.grab({ up: true, grip: true, height: 600 });
  c.a.send({ type: 'drag', dy: 100 });
  c.a.send({ type: 'cancel' });
  expect(c.at()).toEqual(['settling', 2]);
  expect(c.a.getSnapshot().context.from).toBe(500);
});

// ------------------------------------------------------------------ the coach

const coach = (skipped: Orient[] = []) => {
  const clock = new SimulatedClock();
  const log: string[] = [];
  let done = () => {};
  const a = createActor(
    coachMachine.provide({
      actors: { swipes: fromPromise(() => new Promise<void>((r) => (done = r))) },
      actions: { showSwipes: () => log.push('swipes'), point: () => log.push('point'), ask: () => log.push('ask'), remember: ({ context }) => log.push('skip ' + context.orient) },
    }),
    { clock },
  ).start();
  const start = (orient: Orient, forced = false) => a.send({ type: 'start', orient, forced, skipped: skipped.includes(orient) });
  return { a, log, start, later: (ms: number) => clock.increment(ms), swiped: () => (done(), new Promise((r) => setTimeout(r))), is: () => a.getSnapshot().value };
};

test('coach: swipes, then points at Show controls, then asks; unanswered it ends', async () => {
  const c = coach();
  c.start('portrait');
  expect(c.is()).toBe('swipes');
  await c.swiped();
  c.later(300);
  expect(c.is()).toBe('pointing');
  c.later(POINT_MS);
  c.later(300);
  expect(c.is()).toBe('asking');
  c.later(ASK_MS);
  expect([c.is(), c.log]).toEqual(['off', ['swipes', 'point', 'ask']]);
});

test('coach: once a page load per orientation unless forced; a skipped orientation never', () => {
  const c = coach(['landscape']);
  c.start('portrait');
  c.a.send({ type: 'end' });
  c.start('portrait');
  expect(c.is()).toBe('off');
  c.start('portrait', true);
  expect(c.is()).toBe('swipes');
  c.a.send({ type: 'end' });
  c.start('landscape', true);
  expect(c.is()).toBe('off');
});

test('coach: Skip is remembered for the orientation it started in; Repeat plays it again; end stops it anywhere', async () => {
  const c = coach();
  c.start('landscape');
  await c.swiped();
  [300, POINT_MS, 300].forEach(c.later);
  c.a.send({ type: 'repeat' });
  expect(c.is()).toBe('swipes');
  await c.swiped();
  [300, POINT_MS, 300].forEach(c.later);
  c.a.send({ type: 'skip' });
  expect([c.is(), c.log.at(-1)]).toEqual(['off', 'skip landscape']);
  c.start('portrait');
  c.a.send({ type: 'end' });
  expect(c.is()).toBe('off');
});
