import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';
import { awaitingApproval, generateOffered, generationMachine, indicatorShown, remembered, reportWaiting, screenShown, stageIn, stageOf, statusText, type Remembered } from './generation.machine';

const hash = 'a'.repeat(64);
// each document under request `id` (w1/r1 by default)
const doc = (state: ArtifactProgress['state'], id: string, extra: Partial<ArtifactProgress> = {}): ArtifactProgress => ({ state, ...(state === 'idle' ? {} : { by: 'assistant' as const, request: id }), ...extra });
const p = (w: ArtifactProgress, r: ArtifactProgress, generation?: Progress['generation']): Progress => ({ walkthrough: w, report: r, ...(generation && { generation }) });
const at = (n = 1) => ({
  REQUESTED: p(doc('requested', `w${n}`), doc('requested', `r${n}`)),
  WRITING: p(doc('writing', `w${n}`, { slides: 3, chapters: 2, hash }), doc('requested', `r${n}`)),
  PLAYABLE: p(doc('validated', `w${n}`, { hash }), doc('writing', `r${n}`, { hash })),
  DONE: p(doc('validated', `w${n}`, { hash }), doc('validated', `r${n}`, { hash })),
  STOPPED: p(doc('stopped', `w${n}`, { reason: 'failed' }), doc('stopped', `r${n}`, { reason: 'failed' })),
});
const IDLE = p(doc('idle', ''), doc('idle', ''));
const { REQUESTED, WRITING, PLAYABLE, DONE, STOPPED } = at(1);

function start(canGenerate = true, first: Progress = IDLE, kept: Remembered = {}) {
  const a = createActor(generationMachine, { input: { canGenerate, ...kept } }).start();
  const played: string[] = [];
  a.on('play', (e) => played.push(e.request));
  a.send({ type: 'progress', progress: first });
  const s = () => a.getSnapshot();
  return { a, s, played, at: () => stageIn(s()), shown: () => screenShown(s()), send: (progress: Progress) => a.send({ type: 'progress', progress }) };
}

test('stageOf: the documents decide the stage; a stop wins over all but both validated', () => {
  const of = (progress: Progress, requesting: string | null = null) => stageOf({ progress, requesting });
  expect([IDLE, REQUESTED, WRITING, PLAYABLE, DONE, STOPPED].map((x) => of(x))).toEqual(['idle', 'starting', 'writing', 'playable', 'done', 'stopped']);
  expect(of(p(doc('validated', 'w1', { hash }), doc('stopped', 'r1', { reason: 'interrupted' })))).toBe('stopped');
  expect(of(p(doc('validated', 'w1', { hash, source: 'pr' }), doc('requested', 'r1')))).toBe('playable');
  expect(of(p(doc('validated', 'w1', { hash }), doc('idle', '')))).toBe('done');
  expect(of(IDLE, '|')).toBe('starting'); // Generate pressed, its request not shown yet
});

test('a generation followed through: idle -> starting -> writing -> playable (play at slide 1) -> done', () => {
  const g = start();
  expect([g.at(), g.shown(), indicatorShown(g.s()), generateOffered(g.s())]).toEqual(['idle', false, false, true]);
  g.send(REQUESTED);
  expect([g.at(), g.shown(), statusText(g.s())]).toEqual(['starting', true, 'Reading the diff']);
  g.send(WRITING);
  expect([g.at(), statusText(g.s()), g.played]).toEqual(['writing', '3 slides in 2 chapters written, checking', []]);
  g.send(PLAYABLE);
  expect([g.at(), g.shown(), indicatorShown(g.s()), reportWaiting(g.s()), g.played]).toEqual(['playable', false, true, true, ['w1']]);
  g.send(DONE);
  expect([g.at(), indicatorShown(g.s()), reportWaiting(g.s()), generateOffered(g.s()), g.played]).toEqual(['done', false, false, false, ['w1']]);
});

test('P1: a stop of the new request, delivered while the POST is out, wins over the late answer', () => {
  const g = start(true, STOPPED);
  g.a.send({ type: 'generate' });
  expect(g.at()).toBe('starting');
  const { REQUESTED: R2, STOPPED: S2 } = at(2);
  g.send(R2); // SSE: the new request
  g.send(S2); // SSE: its turn ended at once (Claude failed to start)
  g.a.send({ type: 'generated', started: true }); // the POST's answer, last
  expect([g.at(), g.shown(), generateOffered(g.s())]).toEqual(['stopped', true, true]);
  // the answer first, then the SSE lines: the same end
  const h = start(true, STOPPED);
  h.a.send({ type: 'generate' });
  h.a.send({ type: 'generated', started: true });
  h.send(STOPPED); // a repeat of the old state: still the bridge
  expect(h.at()).toBe('starting');
  h.send(R2);
  h.send(S2);
  expect(h.at()).toBe('stopped');
});

test('Generate: refused goes back with its message; nothing to write ends the bridge at once', () => {
  const refused = start(true, STOPPED);
  refused.a.send({ type: 'generate' });
  refused.a.send({ type: 'failed', error: 'The assistant is answering a question.' });
  expect([refused.at(), refused.s().context.error]).toEqual(['stopped', 'The assistant is answering a question.']);
  const nothing = start(true, IDLE);
  nothing.a.send({ type: 'generate' });
  nothing.a.send({ type: 'generated', started: false });
  expect(nothing.at()).toBe('idle');
});

test('a stop before any file changed leaves the loading screen for stopped, never spins', () => {
  const g = start(true, REQUESTED);
  g.send(STOPPED);
  expect([g.at(), g.shown(), statusText(g.s())]).toEqual(['stopped', true, 'Stopped: the walkthrough was not finished']);
  const restarted = start(true, p(doc('requested', 'w1'), doc('stopped', 'r1', { reason: 'interrupted' })));
  expect(statusText(restarted.s())).toBe('Stopped: the review restarted while the report was being written');
});

test('Generate is offered only where the server can generate, in idle and stopped', () => {
  const off = start(false, STOPPED);
  expect(generateOffered(off.s())).toBe(false);
  off.a.send({ type: 'generate' });
  expect(off.at()).toBe('stopped');
  for (const x of [REQUESTED, WRITING, PLAYABLE, DONE]) expect(generateOffered(start(true, x).s())).toBe(false);
});

test('P2: the screen is closed per request: a repeated snapshot keeps it closed, any new request opens it', () => {
  // closed at requested; the same snapshot again
  const g = start(true, REQUESTED);
  g.a.send({ type: 'dismiss' });
  g.send(REQUESTED);
  expect([g.shown(), indicatorShown(g.s())]).toEqual([false, true]);
  g.send(WRITING); // the same request, on its way: still closed
  g.send(STOPPED); // its stop: still closed, the indicator shows it
  expect([g.at(), g.shown(), indicatorShown(g.s())]).toEqual(['stopped', false, true]);
  // closed at writing; a new request first seen at writing opens it
  const h = start(true, WRITING);
  h.a.send({ type: 'dismiss' });
  h.send(at(2).WRITING);
  expect(h.shown()).toBe(true);
  // a report-only retry (the walkthrough kept its request) opens it too
  const k = start(true, p(doc('validated', 'w1', { hash }), doc('stopped', 'r1', { reason: 'failed' })));
  k.a.send({ type: 'dismiss' });
  k.send(p(doc('validated', 'w1', { hash }), doc('requested', 'r2')));
  expect([k.at(), k.shown()]).toEqual(['playable', false]); // playable shows no screen: but closing doesn't carry over
  k.send(p(doc('validated', 'w1', { hash }), doc('stopped', 'r2', { reason: 'failed' })));
  expect(k.shown()).toBe(true);
  // reopen, from the indicator
  g.a.send({ type: 'reopen' });
  expect(g.shown()).toBe(true);
});

test('P2: closed before Generate\'s request showed: stays closed for the request that answers', () => {
  const g = start(true, STOPPED);
  g.a.send({ type: 'generate' });
  g.a.send({ type: 'dismiss' });
  expect([g.shown(), indicatorShown(g.s())]).toEqual([false, true]);
  g.a.send({ type: 'generated', started: true });
  g.send(at(2).REQUESTED);
  g.send(at(2).WRITING);
  expect([g.at(), g.shown()]).toEqual(['writing', false]);
  expect(remembered(g.s()).closedFor).toBe('w2|r2');
  // refused: closed on what is shown
  const r = start(true, STOPPED);
  r.a.send({ type: 'generate' });
  r.a.send({ type: 'dismiss' });
  r.a.send({ type: 'failed', error: 'x' });
  expect([r.at(), r.shown()]).toEqual(['stopped', false]);
});

test('P2: a tab keeps its closing and its play over a reload', () => {
  const g = start(true, WRITING);
  g.a.send({ type: 'dismiss' });
  const kept = remembered(g.s());
  const reloaded = start(true, STOPPED, kept); // the server reloaded the page at the stop
  expect([reloaded.at(), reloaded.shown()]).toEqual(['stopped', false]);
});

test('P2: play once per walkthrough request, whatever the snapshots in between', () => {
  // writing -> done in one snapshot (both validated together)
  const g = start(true, WRITING);
  g.send(DONE);
  expect(g.played).toEqual(['w1']);
  g.send(DONE);
  expect(g.played).toEqual(['w1']); // once
  // Generate, then the walkthrough lands validated before any pending snapshot
  const fast = start(true, IDLE);
  fast.a.send({ type: 'generate' });
  fast.send(PLAYABLE);
  expect(fast.played).toEqual(['w1']);
  // a page that opens on a validated walkthrough it never waited for plays nothing; one that waited before a reload does
  expect(start(true, PLAYABLE).played).toEqual([]);
  expect(start(true, DONE, { waitedFor: 'w1' }).played).toEqual(['w1']);
  expect(start(true, DONE, { waitedFor: 'w1', played: 'w1' }).played).toEqual([]);
  // a report-only retry doesn't play the kept walkthrough again
  const k = start(true, p(doc('validated', 'w0', { hash }), doc('stopped', 'r0', { reason: 'failed' })));
  k.a.send({ type: 'generate' });
  k.send(p(doc('validated', 'w0', { hash }), doc('requested', 'r1')));
  k.send(p(doc('validated', 'w0', { hash }), doc('validated', 'r1', { hash })));
  expect(k.played).toEqual([]);
});

test('a turn waiting on an approval says so, and stays where it is', () => {
  const g = start(true, p(doc('requested', 'w1'), doc('requested', 'r1'), { running: true, awaitingApproval: true }));
  expect([g.at(), awaitingApproval(g.s())]).toEqual(['starting', true]);
  g.send(p(doc('writing', 'w1', { hash }), doc('requested', 'r1'), { running: true, awaitingApproval: false }));
  expect([g.at(), awaitingApproval(g.s())]).toEqual(['writing', false]);
});
