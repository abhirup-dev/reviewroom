import { expect, test } from 'bun:test';
import { afterTurn, askRefusal, generateRefusal, generationOf, keyOf, modelFor, originOf, type Phase, type Running } from './assistant-phase';
import { replayStream } from './replay-stream';

const run = (origin: Running['origin']): Running => ({ name: 'running', origin, id: 's1', model: 'opus', stream: replayStream({}), abort: new AbortController(), done: Promise.resolve() });
const PHASES: Phase[] = [{ name: 'starting' }, { name: 'idle' }, run('question'), run('generation'), { name: 'paused', origin: 'question', model: 'opus' }, { name: 'paused', origin: 'generation', model: 'opus' }, { name: 'closing', done: Promise.resolve() }];
const at = (key: string) => PHASES.find((p) => keyOf(p) === key)!;

test.each([
  // phase, a question, generate, generation as the pages read it
  ['starting', 'still starting', 'starting', [false, false]],
  ['idle', undefined, undefined, [false, false]],
  ['running:question', 'already answering', 'busy', [false, false]],
  ['running:generation', 'writing the review', 'running', [true, false]],
  ['paused:question', undefined, 'busy', [false, false]],
  ['paused:generation', undefined, 'running', [true, true]],
  ['closing', 'closing', 'closing', [false, false]],
] as const)('%s: a question is %p, generate %p, generation %p', (key, ask, generate, [running, awaitingApproval]) => {
  const p = at(key);
  expect(askRefusal(p) ?? undefined).toEqual(ask && expect.stringContaining(ask));
  const g = generateRefusal(p);
  expect(g === undefined || g === 'running' ? g : g.code).toBe(generate);
  expect(generationOf(p)).toEqual({ running, awaitingApproval });
});

test.each([
  // now, the turn's own origin, whether the native session holds it, where it leaves the conversation
  ['running:question', 'question', false, 'idle'],
  ['running:generation', 'generation', true, 'paused:generation'],
  ['closing', 'generation', true, 'closing'], // a closing review stays closing, whatever the turn says
  ['closing', 'question', false, 'closing'],
] as const)('a turn ending from %s (%s, held: %p) leaves %s', (now, origin, held, left) => {
  expect(keyOf(afterTurn(at(now), run(origin), held))).toBe(left);
});

test('a question continues what is paused: its origin, and for an approval its model; else a question on the configured model', () => {
  const paused = at('paused:generation');
  expect([originOf(paused), originOf(at('idle'))]).toEqual(['generation', 'question']);
  expect([modelFor(paused, false, () => 'sonnet'), modelFor(paused, true, () => 'sonnet'), modelFor(at('idle'), false, () => 'sonnet')]).toEqual(['opus', 'sonnet', 'sonnet']);
});
