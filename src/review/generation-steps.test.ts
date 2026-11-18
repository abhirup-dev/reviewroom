import { expect, test } from 'bun:test';
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';
import { generationSteps } from './generation-steps';

const at = '2026-11-19T10:00:00.000Z';
const w = (state: ArtifactProgress['state'], extra: Partial<ArtifactProgress> = {}): ArtifactProgress => ({ state, by: 'assistant', request: 'w1', since: at, ...extra });
const p = (walkthrough: ArtifactProgress, report: ArtifactProgress = { state: 'requested', by: 'assistant', request: 'r1' }): Progress => ({ walkthrough, report });
const pass = (slides: number, chapters = 3) => ({ at, slides, chapters });
const states = (steps: ReturnType<typeof generationSteps>) => steps.map((s) => `${s.id}:${s.state}`);

const passRows = (...rows: [string, string][]) => ({ passes: rows.map(([text, state]) => ({ text, state })) });
test.each([
  ['requested: reading and writing are one step until the first save', p(w('requested')), ['read-write:current', 'check:upcoming', 'ready:upcoming', 'report:upcoming'], [{}]],
  ['writing: each save is a pass row under checking', p(w('writing', { passes: [pass(7), pass(7, 4)], slides: 7, chapters: 4 })), ['read-write:done', 'check:current', 'ready:upcoming', 'report:upcoming'],
    [{ detail: 'First draft · 7 slides in 3 chapters' }, passRows(['Pass 1 · 7 slides in 3 chapters · revised', 'done'], ['Pass 2 · 7 slides in 4 chapters · checking', 'current'])]],
  ['validated: ready, its last pass passed, the report being written', p(w('validated', { passes: [pass(8)], slides: 8, chapters: 3 })), ['read-write:done', 'check:done', 'ready:done', 'report:current'],
    [{}, passRows(['Pass 1 · 8 slides in 3 chapters · passed', 'done']), { detail: '8 slides in 3 chapters' }]],
  ['both validated', p(w('validated'), { state: 'validated' }), ['read-write:done', 'check:done', 'ready:done', 'report:done'], [{}]],
  ['stopped: the step it stopped at, with its reason; its last pass did not pass', p(w('stopped', { reason: 'failed', passes: [pass(7), pass(8)] })), ['read-write:done', 'check:stopped', 'ready:upcoming', 'report:upcoming'],
    [{}, { detail: 'Stopped before it passed the check', ...passRows(['Pass 1 · 7 slides in 3 chapters · revised', 'done'], ['Pass 2 · 8 slides in 3 chapters · did not pass', 'stopped']) }]],
  ['stopped by a restart', p(w('stopped', { reason: 'interrupted' })), ['read-write:stopped', 'check:upcoming', 'ready:upcoming', 'report:upcoming'], [{ detail: 'Stopped: the review restarted' }]],
  ['the report stopped', p(w('validated'), { state: 'stopped', reason: 'failed' }), ['read-write:done', 'check:done', 'ready:done', 'report:stopped'], [{}, {}, {}, { detail: 'Stopped before it passed the check' }]],
] as const)('%s', (_, progress, expected, details) => {
  const steps = generationSteps(progress);
  expect(states(steps)).toEqual([...expected]);
  (details as readonly object[]).forEach((d, i) => expect(steps[i]).toMatchObject(d));
});
