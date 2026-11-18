import { expect, test } from 'bun:test';
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';
import { generationSteps } from './generation-steps';

const at = '2026-11-19T10:00:00.000Z';
const w = (state: ArtifactProgress['state'], extra: Partial<ArtifactProgress> = {}): ArtifactProgress => ({ state, by: 'assistant', request: 'w1', since: at, ...extra });
const p = (walkthrough: ArtifactProgress, report: ArtifactProgress = { state: 'requested', by: 'assistant', request: 'r1' }): Progress => ({ walkthrough, report });
const pass = (slides: number, chapters = 3) => ({ at, slides, chapters });
const states = (steps: ReturnType<typeof generationSteps>) => steps.map((s) => `${s.id}:${s.state}`);
const live = { stream: true, wrote: false };

test('reading until the stream shows the first write; writing until the first save', () => {
  expect(states(generationSteps(p(w('requested')), live))).toEqual(['read:current', 'write:upcoming', 'check:upcoming', 'ready:upcoming', 'report:upcoming']);
  expect(states(generationSteps(p(w('requested')), { stream: true, wrote: true }))).toEqual(['read:done', 'write:current', 'check:upcoming', 'ready:upcoming', 'report:upcoming']);
});

test('each save is a pass row under checking; earlier ones revised, the last one checking; never backwards', () => {
  const steps = generationSteps(p(w('writing', { passes: [pass(7), pass(7, 4)], slides: 7, chapters: 4 })), live); // wrote not seen: still past it
  expect(states(steps)).toEqual(['read:done', 'write:done', 'check:current', 'ready:upcoming', 'report:upcoming']);
  expect(steps[1].detail).toBe('First draft · 7 slides in 3 chapters');
  expect(steps[2].passes).toEqual([
    { text: 'Pass 1 · 7 slides in 3 chapters · revised', state: 'done' },
    { text: 'Pass 2 · 7 slides in 4 chapters · checking', state: 'current' },
  ]);
});

test('validated: the walkthrough is ready, its last pass passed, and the report is being written', () => {
  const steps = generationSteps(p(w('validated', { passes: [pass(8)], slides: 8, chapters: 3 })), live);
  expect(states(steps)).toEqual(['read:done', 'write:done', 'check:done', 'ready:done', 'report:current']);
  expect(steps[2].passes).toEqual([{ text: 'Pass 1 · 8 slides in 3 chapters · passed', state: 'done' }]);
  expect(steps[3].detail).toBe('8 slides in 3 chapters');
  expect(generationSteps(p(w('validated'), { state: 'validated' }), live).at(-1)!.state).toBe('done');
});

test('stopped: the step it stopped at turns stopped with its reason; its last pass did not pass', () => {
  const steps = generationSteps(p(w('stopped', { reason: 'failed', passes: [pass(7), pass(8)] })), live);
  expect(states(steps)).toEqual(['read:done', 'write:done', 'check:stopped', 'ready:upcoming', 'report:upcoming']);
  expect(steps[2].detail).toBe('Stopped before it passed the check');
  expect(steps[2].passes!.at(-1)).toEqual({ text: 'Pass 2 · 8 slides in 3 chapters · did not pass', state: 'stopped' });
  const early = generationSteps(p(w('stopped', { reason: 'interrupted' })), live);
  expect(states(early).slice(0, 2)).toEqual(['read:stopped', 'write:upcoming']);
  expect(early[0].detail).toBe('Stopped: the review restarted');
  const report = generationSteps(p(w('validated'), { state: 'stopped', reason: 'failed' }), live);
  expect(report.at(-1)).toMatchObject({ state: 'stopped', detail: 'Stopped before it passed the check' });
});

test('no stream (your own agent, or through the hub): reading and writing are one step', () => {
  const none = { stream: false, wrote: true }; // a write flag without a stream is ignored
  expect(states(generationSteps(p(w('requested', { by: 'agent' })), none))).toEqual(['read-write:current', 'check:upcoming', 'ready:upcoming', 'report:upcoming']);
  expect(generationSteps(p(w('requested')), none)[0].title).toBe('Reading the change and writing the walkthrough');
  expect(states(generationSteps(p(w('writing', { passes: [pass(5)] })), none))).toEqual(['read-write:done', 'check:current', 'ready:upcoming', 'report:upcoming']);
  expect(generationSteps(p(w('stopped', { reason: 'failed' })), none)[0]).toMatchObject({ state: 'stopped', detail: 'Stopped before it passed the check' });
});
