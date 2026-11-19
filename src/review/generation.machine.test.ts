import { expect, test } from 'bun:test';
import { createActor, fromPromise } from 'xstate';
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';
import { generateOffered, generationMachine, generationSteps, indicatorShown, screenShown, stageIn, type Remembered } from './generation.machine';

const hash = 'a'.repeat(64);
const doc = (state: ArtifactProgress['state'], id: string, extra: Partial<ArtifactProgress> = {}): ArtifactProgress => ({ state, ...(state === 'idle' ? {} : { by: 'assistant' as const, request: id }), ...extra });
const p = (w: ArtifactProgress, r: ArtifactProgress): Progress => ({ walkthrough: w, report: r });
const at = (n: number) => ({
  REQUESTED: p(doc('requested', `w${n}`), doc('requested', `r${n}`)),
  WRITING: p(doc('writing', `w${n}`, { hash }), doc('requested', `r${n}`)),
  PLAYABLE: p(doc('validated', `w${n}`, { hash }), doc('writing', `r${n}`, { hash })),
  DONE: p(doc('validated', `w${n}`, { hash }), doc('validated', `r${n}`, { hash })),
  STOPPED: p(doc('stopped', `w${n}`, { reason: 'failed' }), doc('stopped', `r${n}`, { reason: 'failed' })),
});
const IDLE = p(doc('idle', ''), doc('idle', ''));
const { REQUESTED, WRITING, PLAYABLE, DONE, STOPPED } = at(1);
const { REQUESTED: R2, WRITING: W2, STOPPED: S2 } = at(2);
const KEPT = (w: string, r: ArtifactProgress) => p(doc('validated', w, { hash }), r); // a validated walkthrough, the report retried
const stoppedReport = (id: string) => doc('stopped', id, { reason: 'failed' });

// A step: a progress over SSE, a press, or the POST's answer (true: taken, false: nothing to write, a string: refused)
type Step = Progress | 'generate' | 'dismiss' | 'reopen' | { answer: boolean | string };
type Seen = [stage: string, screen: boolean, indicator: boolean, offered: boolean, played: string[], error?: string];

async function run(steps: Step[], input: { canGenerate?: boolean } & Remembered = {}): Promise<Seen> {
  const posts: { resolve: (v: boolean) => void; reject: (e: Error) => void }[] = [];
  const post = fromPromise(() => new Promise<boolean>((resolve, reject) => posts.push({ resolve, reject })));
  const a = createActor(generationMachine.provide({ actors: { generate: post } }), { input: { canGenerate: true, ...input } }).start();
  const played: string[] = [];
  a.on('play', (e) => played.push(e.request));
  for (const step of steps) {
    if (typeof step === 'string') a.send({ type: step });
    else if (!('answer' in step)) a.send({ type: 'progress', progress: step });
    else {
      const last = posts.at(-1)!;
      if (typeof step.answer === 'string') last.reject(new Error(step.answer));
      else last.resolve(step.answer);
      await Bun.sleep(0);
    }
  }
  const s = a.getSnapshot();
  return [stageIn(s), screenShown(s), indicatorShown(s), generateOffered(s), played, ...(s.context.error ? [s.context.error] : [])] as Seen;
}

test.each<[string, Step[], Seen, ({ canGenerate?: boolean } & Remembered)?]>([
  // the golden path
  ['requested opens the loading screen', [IDLE, REQUESTED], ['starting', true, false, false, []]],
  ['the walkthrough validated plays once; the indicator stands for the screen', [REQUESTED, WRITING, PLAYABLE, PLAYABLE], ['playable', false, true, false, ['w1']]],
  ['writing to both validated in one snapshot plays too', [REQUESTED, WRITING, DONE, DONE], ['done', false, false, false, ['w1']]],
  ['Generate, then the walkthrough lands validated before any pending snapshot: it plays', [IDLE, 'generate', PLAYABLE], ['playable', false, true, false, ['w1']]],
  // stops and Generate's POST
  ['a stop before any save opens the stop screen, Retry offered', [REQUESTED, STOPPED], ['stopped', true, false, true, []]],
  ['a stop of the new request while the POST is out wins over its late answer', [STOPPED, 'generate', R2, S2, { answer: true }], ['stopped', true, false, true, []]],
  ['answered first: still starting over a repeat of the old progress', [STOPPED, 'generate', { answer: true }, STOPPED], ['starting', true, false, false, []]],
  ['POST refused: back, with its message', [STOPPED, 'generate', { answer: 'busy' }], ['stopped', true, false, true, [], 'busy']],
  ['nothing to write ends the bridge at once', [IDLE, 'generate', { answer: false }], ['idle', false, false, true, []]],
  ['a report stop after the walkthrough validated never opens the screen', [WRITING, PLAYABLE, KEPT('w1', stoppedReport('r1'))], ['report-stopped', false, true, true, ['w1']]],
  ['a report-only retry does not replay the kept walkthrough', [KEPT('w0', stoppedReport('r0')), 'generate', KEPT('w0', doc('requested', 'r1')), KEPT('w0', doc('validated', 'r1', { hash }))], ['done', false, false, false, []]],
  ['a PR walkthrough with no report shows done and offers Generate', [KEPT('w0', doc('idle', ''))], ['done', false, false, true, []]],
  ['Generate can take over a pending agent walkthrough and keep the validated report', [
    p(doc('requested', 'w1', { by: 'agent' }), doc('validated', 'r1', { by: 'agent', hash })), 'dismiss',
  ], ['starting', false, true, true, []]],
  ['Generate is not offered where the server cannot generate', [STOPPED, 'generate'], ['stopped', true, false, false, []], { canGenerate: false }],
  // the screen, closed per request
  ['dismissed, it holds for the same request through its stop', [REQUESTED, 'dismiss', REQUESTED, WRITING, STOPPED], ['stopped', false, true, true, []]],
  ['a new request opens it again', [WRITING, 'dismiss', W2], ['writing', true, false, false, []]],
  ['the indicator reopens it', [REQUESTED, 'dismiss', 'reopen'], ['starting', true, false, false, []]],
  ['dismissed while requesting: closed for the request that answers', [STOPPED, 'generate', 'dismiss', { answer: true }, R2, W2], ['writing', false, true, false, []]],
  ['dismissed while requesting, then refused: closed on what is shown', [STOPPED, 'generate', 'dismiss', { answer: 'x' }], ['stopped', false, true, true, [], 'x']],
  // over a reload
  ['a page opening on a walkthrough it never waited for plays nothing', [PLAYABLE], ['playable', false, true, false, []]],
  ['a page that waited before a reload plays once', [DONE], ['done', false, false, false, ['w1']], { waitedFor: 'w1' }],
  ['a page that already played does not again', [DONE], ['done', false, false, false, []], { waitedFor: 'w1', played: 'w1' }],
  ['a page closed before a reload stays closed', [STOPPED], ['stopped', false, true, true, []], { closedFor: 'w1|r1' }],
])('%s', async (...[, steps, seen, input]) => { // a rest parameter: bun reads a 4th one as `done` on 3-cell rows
  expect(await run(steps, input)).toEqual(seen);
});

// The loading screen's steps (read, write, ready, report) and the pass rows under writing: outline, drafts, the pass.
const save = (slides: number) => ({ at: '2026-01-01T00:00:00.000Z', slides, chapters: 3 });
test.each<[string, Progress, string, string[]]>([
  ['reading until the first save', REQUESTED, 'current upcoming upcoming upcoming', []],
  ['the outline ends the reading and is never checked', p(doc('writing', 'w1', { passes: [save(6)] }), doc('requested', 'r1')), 'done current upcoming upcoming', ['current Outline · 6 slides in 3 chapters']],
  ['each save after it is a draft, checked', p(doc('writing', 'w1', { passes: [save(6), save(8)] }), doc('requested', 'r1')), 'done current upcoming upcoming', ['done Outline · 6 slides in 3 chapters', 'current Draft 1 · 8 slides in 3 chapters · checking']],
  ['a draft passes: ready, the report next', p(doc('validated', 'w1', { hash, passes: [save(6), save(8), save(9)] }), doc('writing', 'r1')), 'done done done current', ['done Outline · 6 slides in 3 chapters', 'done Draft 1 · 8 slides in 3 chapters · revised', 'done Draft 2 · 9 slides in 3 chapters · passes']],
  ['one save that passes is a draft, not an outline', p(doc('validated', 'w1', { hash, passes: [save(8)] }), doc('validated', 'r1', { hash })), 'done done done done', ['done Draft 1 · 8 slides in 3 chapters · passes']],
  ['stopped on the outline: not a failed pass', p(doc('stopped', 'w1', { reason: 'failed', passes: [save(6)] }), doc('stopped', 'r1', { reason: 'failed' })), 'done stopped upcoming upcoming', ['stopped Outline · 6 slides in 3 chapters']],
  ['stopped on a draft: it did not pass', p(doc('stopped', 'w1', { reason: 'failed', passes: [save(6), save(8)] }), doc('stopped', 'r1', { reason: 'failed' })), 'done stopped upcoming upcoming', ['done Outline · 6 slides in 3 chapters', 'stopped Draft 1 · 8 slides in 3 chapters · did not pass']],
  ['stopped before any save', STOPPED, 'stopped upcoming upcoming upcoming', []],
])('steps: %s', (_, progress, states, rows) => {
  const steps = generationSteps(progress);
  expect([steps.map((s) => s.state).join(' '), steps.flatMap((s) => (s.passes ?? []).map((r) => `${r.state} ${r.text}`))]).toEqual([states, rows]);
});
