import { expect, test } from 'bun:test';
import { createActor, fromPromise, waitFor } from 'xstate';
import type { CodeTarget } from '../shell/app';
import { revealMachine, type Prepared } from './reveal';

/** A reveal machine whose preparing and unfolding finish when told to, recording what it did to the view. */
function revealer() {
  const log: string[] = [];
  const preps: ((v: Prepared) => void)[] = [];
  const unfolds: ((v: boolean) => void)[] = [];
  const at = (t: CodeTarget | null) => `${t?.path}:${t?.start}`;
  const a = createActor(
    revealMachine.provide({
      actors: { prepare: fromPromise(() => new Promise<Prepared>((r) => preps.push(r))), unfold: fromPromise(() => new Promise<boolean>((r) => unfolds.push(r))) },
      actions: { land: ({ context }) => log.push('land ' + at(context.target)), glow: () => log.push('glow'), unglow: () => log.push('unglow'), clear: () => log.push('clear'), landed: () => log.push('landed') },
      delays: { glow: 30 },
    }),
  ).start();
  const reveal = (path: string, start?: number) => a.send({ type: 'reveal', target: { path, side: 'head', start } });
  return { a, log, preps, unfolds, reveal };
}
const tick = () => new Promise((r) => setTimeout(r));

test('reveal: prepare, land, unfold and land again, glow and say landed, then let the highlight go', async () => {
  const r = revealer();
  r.reveal('a.go', 5);
  r.preps[0]('lines');
  await waitFor(r.a, (s) => s.matches('unfolding'));
  r.unfolds[0](true);
  await waitFor(r.a, (s) => s.matches('idle'));
  expect(r.log).toEqual(['land a.go:5', 'land a.go:5', 'glow', 'landed', 'unglow', 'clear']);
});

test("reveal: a newer reveal drops the older one's late work; nothing to highlight still says landed", async () => {
  const r = revealer();
  r.reveal('a.go', 5);
  r.reveal('b.go');
  r.preps[0]('lines'); // stale: its state is gone
  r.preps[1]('nothing');
  await tick();
  expect([r.a.getSnapshot().value, r.log]).toEqual(['idle', ['landed']]);
});

test('reveal: the user selecting while it glows keeps their selection; a reveal while it glows clears first', async () => {
  const r = revealer();
  r.reveal('a.go', 5);
  r.preps[0]('lines');
  await waitFor(r.a, (s) => s.matches('unfolding'));
  r.unfolds[0](false);
  await waitFor(r.a, (s) => s.matches('glowing'));
  r.a.send({ type: 'select' });
  expect(r.log.slice(-2)).toEqual(['landed', 'unglow']);
  r.reveal('a.go', 9);
  r.preps[1]('lines');
  await waitFor(r.a, (s) => s.matches('unfolding'));
  r.unfolds[1](false);
  await waitFor(r.a, (s) => s.matches('glowing'));
  r.reveal('c.go', 1);
  expect(r.log.slice(-3)).toEqual(['landed', 'unglow', 'clear']);
});
