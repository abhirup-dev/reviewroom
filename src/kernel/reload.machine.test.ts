import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { reloadMachine, type ReloadEvent, type Reasons } from './reload.machine';

const run = (...events: ReloadEvent[]) => {
  const calls: string[] = [];
  let reloaded: Reasons | null = null;
  const a = createActor(
    reloadMachine.provide({
      actions: {
        offer: () => void calls.push('offer'),
        withdraw: () => void calls.push('withdraw'),
        reload: ({ context }) => void (reloaded = context.reasons),
      },
    }),
  ).start();
  for (const e of events) a.send(e);
  const s = a.getSnapshot();
  a.stop();
  return { state: s.value, reasons: s.context.reasons, calls, reloaded: reloaded as Reasons | null };
};
const want = (key: string, nuke?: boolean): ReloadEvent => ({ type: 'want', key, nuke });
const held: ReloadEvent = { type: 'tick', held: true };
const free: ReloadEvent = { type: 'tick', held: false };

test('nothing unsent: a wanted reload goes on the next tick', () => {
  expect(run(want('layout'), free).reloaded).toEqual({ layout: { nuke: false } });
});

test('held over unsent work it offers, and goes once the work is sent', () => {
  const r = run(want('layout'), held, held, free);
  expect(r.calls).toEqual(['offer', 'offer']);
  expect(r.state).toBe('reloading');
});

test('the screen changing again while held keeps waiting: the reason is refreshed, not lost', () => {
  const r = run(want('layout'), held, want('layout'), held);
  expect(r.state).toBe('pending');
  expect(r.reasons).toEqual({ layout: { nuke: false } });
});

test('the screen suiting the page again drops the offer', () => {
  const r = run(want('layout'), held, { type: 'drop', key: 'layout' });
  expect(r.state).toBe('idle');
  expect(r.calls).toEqual(['offer', 'withdraw']);
  expect(run(want('layout'), held, { type: 'drop', key: 'layout' }, free).reloaded).toBeNull();
});

test('reasons add up: dropping one keeps the other, and nuke sticks', () => {
  const r = run(want('update', true), want('layout'), want('update'), { type: 'drop', key: 'layout' }, held);
  expect(r.state).toBe('pending');
  expect(r.reasons).toEqual({ update: { nuke: true } });
});

test('go takes the reload while held', () => {
  expect(run(want('update'), held, { type: 'go' }).state).toBe('reloading');
  expect(run({ type: 'go' }, free).state).toBe('idle'); // nothing wanted: nothing to take
});
