import { expect, test } from 'bun:test';
import { afterTurn, askRefusal, generateRefusal, generationOf, keyOf, modelFor, originOf, type Phase, type Running } from './assistant-phase';
import { replayStream } from './replay-stream';

const run = (origin: Running['origin']): Running => ({ name: 'running', origin, id: 's1', model: 'opus', stream: replayStream({}), abort: new AbortController(), done: Promise.resolve() });
const PHASES: Phase[] = [{ name: 'starting' }, { name: 'idle' }, run('question'), run('generation'), { name: 'paused', origin: 'question', model: 'opus' }, { name: 'paused', origin: 'generation', model: 'opus' }, { name: 'closing', done: Promise.resolve() }];
const at = (key: string) => PHASES.find((p) => keyOf(p) === key)!;

test.each([
  // phase, a question, generate, generation as the pages read it, [a question here continues, a held turn's end leaves]
  ['starting', 'still starting', 'starting', [false, false], ['question', 'paused:generation']],
  ['idle', undefined, undefined, [false, false], ['question', 'paused:generation']],
  ['running:question', 'already answering', 'busy', [false, false], ['question', 'paused:generation']],
  ['running:generation', 'writing the review', 'running', [true, false], ['question', 'paused:generation']],
  ['paused:question', undefined, 'busy', [false, false], ['question', 'paused:generation']],
  ['paused:generation', undefined, 'running', [true, true], ['generation', 'paused:generation']],
  ['closing', 'closing', 'closing', [false, false], ['question', 'closing']], // closing stays closing, whatever the turn says
] as const)('%s: a question is %p, generate %p, generation %p', (key, ask, generate, [running, awaitingApproval], [continues, held]) => {
  const p = at(key);
  expect(askRefusal(p) ?? undefined).toEqual(ask && expect.stringContaining(ask));
  const g = generateRefusal(p);
  expect(g === null || g === 'running' ? (g ?? undefined) : g.code).toBe(generate);
  expect(generationOf(p)).toEqual({ running, awaitingApproval });
  expect(originOf(p)).toBe(continues);
  // an approval continues on the paused turn's model; a new question, on the configured one
  expect([modelFor(p, false, () => 'sonnet'), modelFor(p, true, () => 'sonnet')]).toEqual([p.name === 'paused' ? 'opus' : 'sonnet', 'sonnet']);
  expect([keyOf(afterTurn(p, run('generation'), true)), keyOf(afterTurn(p, run('question'), false))]).toEqual([held, key === 'closing' ? 'closing' : 'idle']);
});
