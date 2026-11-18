import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';
import { awaitingApproval, generateOffered, generationMachine, indicatorShown, reportWaiting, screenShown, stageIn, stageOf, statusText } from './generation.machine';

const hash = 'a'.repeat(64);
const doc = (state: ArtifactProgress['state'], extra: Partial<ArtifactProgress> = {}): ArtifactProgress => ({ state, ...(state === 'idle' ? {} : { by: 'assistant' as const }), ...extra });
const p = (w: ArtifactProgress, r: ArtifactProgress, generation?: Progress['generation']): Progress => ({ walkthrough: w, report: r, ...(generation && { generation }) });
const IDLE = p(doc('idle'), doc('idle'));
const REQUESTED = p(doc('requested'), doc('requested'));
const WRITING = p(doc('writing', { slides: 3, chapters: 2, hash }), doc('requested'));
const PLAYABLE = p(doc('validated', { hash }), doc('writing', { hash }));
const DONE = p(doc('validated', { hash }), doc('validated', { hash }));
const STOPPED = p(doc('stopped', { reason: 'failed' }), doc('stopped', { reason: 'failed' }));

function start(canGenerate = true, first: Progress = IDLE) {
  const a = createActor(generationMachine, { input: { canGenerate } }).start();
  const played: unknown[] = [];
  a.on('play', (e) => played.push(e));
  a.send({ type: 'progress', progress: first });
  const at = () => stageIn(a.getSnapshot());
  return { a, at, played, send: (progress: Progress) => a.send({ type: 'progress', progress }) };
}

test('stageOf: the documents decide the stage; a stop wins over all but both validated', () => {
  const at = (progress: Progress, requesting = false) => stageOf({ progress, requesting });
  expect([IDLE, REQUESTED, WRITING, PLAYABLE, DONE, STOPPED].map((x) => at(x))).toEqual(['idle', 'starting', 'writing', 'playable', 'done', 'stopped']);
  expect(at(p(doc('validated', { hash }), doc('stopped', { reason: 'interrupted' })))).toBe('stopped'); // a playable walkthrough, a stopped report
  expect(at(p(doc('validated', { hash, source: 'pr' }), doc('requested')))).toBe('playable'); // a PR walkthrough kept, the report asked for
  expect(at(p(doc('validated', { hash }), doc('idle')))).toBe('done'); // nothing left to wait for
  expect(at(IDLE, true)).toBe('starting'); // Generate pressed, not answered yet
  expect(at(STOPPED, true)).toBe('starting'); // Retry pressed
});

test('a generation followed through: idle -> starting -> writing -> playable (play at slide 1) -> done', () => {
  const g = start();
  expect(g.at()).toBe('idle');
  expect([screenShown(g.a.getSnapshot()), indicatorShown(g.a.getSnapshot()), generateOffered(g.a.getSnapshot())]).toEqual([false, false, true]);
  g.send(REQUESTED);
  expect([g.at(), screenShown(g.a.getSnapshot()), statusText(g.a.getSnapshot())]).toEqual(['starting', true, 'Reading the diff']);
  g.send(WRITING);
  expect([g.at(), statusText(g.a.getSnapshot())]).toEqual(['writing', '3 slides in 2 chapters written, checking']);
  expect(g.played).toEqual([]);
  g.send(PLAYABLE);
  expect([g.at(), screenShown(g.a.getSnapshot()), indicatorShown(g.a.getSnapshot()), reportWaiting(g.a.getSnapshot())]).toEqual(['playable', false, true, true]);
  expect(g.played).toEqual([{ type: 'play' }]);
  g.send(DONE);
  expect([g.at(), indicatorShown(g.a.getSnapshot()), reportWaiting(g.a.getSnapshot()), generateOffered(g.a.getSnapshot())]).toEqual(['done', false, false, false]);
});

test('a page that opens on a playable walkthrough does not play it on its own; one that opens done shows nothing', () => {
  expect(start(true, PLAYABLE).played).toEqual([]);
  const done = start(true, DONE);
  expect([done.at(), screenShown(done.a.getSnapshot()), indicatorShown(done.a.getSnapshot())]).toEqual(['done', false, false]);
});

test('a stop before any file changed leaves the loading screen for stopped, never spins', () => {
  const g = start(true, REQUESTED);
  g.send(STOPPED);
  expect([g.at(), screenShown(g.a.getSnapshot()), statusText(g.a.getSnapshot())]).toEqual(['stopped', true, 'Stopped: the walkthrough was not finished']);
  const restarted = start(true, p(doc('requested'), doc('stopped', { reason: 'interrupted' })));
  expect([restarted.at(), statusText(restarted.a.getSnapshot())]).toEqual(['stopped', 'Stopped: the review restarted while the report was being written']);
  // the stopped screen is from a walkthrough being written, then interrupted
  const writing = start(true, WRITING);
  writing.send(p(doc('stopped', { reason: 'interrupted', slides: 3, chapters: 2 }), doc('requested')));
  expect(writing.at()).toBe('stopped');
});

test('stopped -> Retry -> starting at once; the answer moves on, a refusal goes back with its message', () => {
  const g = start(true, STOPPED);
  expect(generateOffered(g.a.getSnapshot())).toBe(true);
  g.a.send({ type: 'dismiss' });
  g.a.send({ type: 'generate' });
  expect([g.at(), screenShown(g.a.getSnapshot()), generateOffered(g.a.getSnapshot())]).toEqual(['starting', true, false]); // the screen comes back
  g.send(STOPPED); // the old state, still arriving: stays starting while the request is out
  expect(g.at()).toBe('starting');
  g.a.send({ type: 'generated', progress: REQUESTED });
  expect([g.at(), g.a.getSnapshot().context.requesting]).toEqual(['starting', false]);
  const refused = start(true, STOPPED);
  refused.a.send({ type: 'generate' });
  refused.a.send({ type: 'failed', error: 'The assistant is answering a question.' });
  expect([refused.at(), refused.a.getSnapshot().context.error]).toEqual(['stopped', 'The assistant is answering a question.']);
  const fromIdle = start(true, IDLE);
  fromIdle.a.send({ type: 'generate' });
  fromIdle.a.send({ type: 'failed', error: 'x' });
  expect(fromIdle.at()).toBe('idle');
});

test('Generate is offered only where the server can generate, in idle and stopped', () => {
  const off = start(false, STOPPED);
  expect(generateOffered(off.a.getSnapshot())).toBe(false);
  off.a.send({ type: 'generate' });
  expect(off.at()).toBe('stopped');
  for (const x of [REQUESTED, WRITING, PLAYABLE, DONE]) expect(generateOffered(start(true, x).a.getSnapshot())).toBe(false);
});

test('the loading screen closes to the bare review: the indicator shows it under way and reopens it; a new request reopens it', () => {
  const g = start(true, WRITING);
  g.a.send({ type: 'dismiss' });
  expect([screenShown(g.a.getSnapshot()), indicatorShown(g.a.getSnapshot())]).toEqual([false, true]);
  g.a.send({ type: 'reopen' });
  expect([screenShown(g.a.getSnapshot()), indicatorShown(g.a.getSnapshot())]).toEqual([true, false]);
  g.a.send({ type: 'dismiss' });
  g.send(STOPPED); // stays closed: the indicator shows the stop
  expect([g.at(), screenShown(g.a.getSnapshot()), indicatorShown(g.a.getSnapshot())]).toEqual(['stopped', false, true]);
  g.send(REQUESTED); // someone asked again (an agent's pr --force)
  expect([g.at(), screenShown(g.a.getSnapshot())]).toEqual(['starting', true]);
  g.a.send({ type: 'dismiss' });
  g.send(IDLE); // reset: nothing to show
  expect([g.at(), indicatorShown(g.a.getSnapshot())]).toEqual(['idle', false]);
});

test('a turn waiting on an approval says so, and stays where it is', () => {
  const g = start(true, p(doc('requested'), doc('requested'), { running: true, awaitingApproval: true }));
  expect([g.at(), awaitingApproval(g.a.getSnapshot())]).toEqual(['starting', true]);
  g.send(p(doc('writing', { hash }), doc('requested'), { running: true, awaitingApproval: false }));
  expect([g.at(), awaitingApproval(g.a.getSnapshot())]).toEqual(['writing', false]);
});
