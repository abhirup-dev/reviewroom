import { expect, test } from 'bun:test';
import { createActor, fromPromise, waitFor } from 'xstate';
import type { Walkthrough } from '../shared/walkthrough';
import { current, deepLink, paneMachine, target, walkthroughMachine, type PaneShown, type PaneWant } from './walkthrough';

const steps = (...ids: string[]) => ids.map((id) => ({ id, text: id }));
const doc: Walkthrough = {
  version: 1,
  title: 'T',
  chapters: [
    { id: 'a', title: 'A', steps: steps('a1', 'a2') },
    { id: 'b', title: 'B', steps: steps('b1', 'b2', 'b3') },
  ],
};
const start = (d: Walkthrough | null = doc) => {
  const a = createActor(walkthroughMachine).start();
  a.send({ type: 'load', doc: d });
  return a;
};
const where = (a: ReturnType<typeof start>) => {
  const s = a.getSnapshot();
  const mode = s.matches({ open: 'playing' }) ? 'playing' : s.matches({ open: 'paused' }) ? 'paused' : 'closed';
  return [mode, s.context.chapter, s.context.step];
};

test('open without a document stays closed', () => {
  const a = start(null);
  a.send({ type: 'open' });
  expect(where(a)).toEqual(['closed', 0, 0]);
});

test('next and prev cross chapter edges and stop at the ends', () => {
  const a = start();
  a.send({ type: 'open' });
  a.send({ type: 'prev' });
  expect(where(a)).toEqual(['playing', 0, 0]);
  a.send({ type: 'next' });
  a.send({ type: 'next' });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'prev' });
  expect(where(a)).toEqual(['playing', 0, 1]);
  for (let i = 0; i < 9; i++) a.send({ type: 'next' });
  expect(where(a)).toEqual(['playing', 1, 2]);
  expect(current(a.getSnapshot().context)).toMatchObject({ isFirst: false, isLast: true, step: { id: 'b3' } });
});

test('open by ids, unknown ids fall back, goto clamps', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b2' });
  expect(where(a)).toEqual(['playing', 1, 1]);
  a.send({ type: 'open', chapter: 'b', step: 'nope' });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'open', chapter: 'nope' });
  expect(where(a)).toEqual(['playing', 0, 0]);
  a.send({ type: 'goto', chapter: 7, step: 7 });
  expect(where(a)).toEqual(['playing', 1, 2]);
});

test('pause then resume keeps the step; close then open starts over', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b3' });
  a.send({ type: 'pause' });
  expect(where(a)).toEqual(['paused', 1, 2]);
  a.send({ type: 'resume' });
  expect(where(a)).toEqual(['playing', 1, 2]);
  a.send({ type: 'close' });
  a.send({ type: 'open' });
  expect(where(a)).toEqual(['playing', 0, 0]);
});

test('reloading keeps the position where it exists; a removed document closes', () => {
  const a = start();
  a.send({ type: 'open', chapter: 'b', step: 'b3' });
  a.send({ type: 'load', doc: { ...doc, chapters: [doc.chapters[0], { ...doc.chapters[1], steps: steps('b1') }] } });
  expect(where(a)).toEqual(['playing', 1, 0]);
  a.send({ type: 'load', doc: null });
  expect(where(a)).toEqual(['closed', 1, 0]);
});

test('the code pane target: own ref, last ref in the chapter, an earlier ref (never the lead\'s diagram), nothing', () => {
  const d: Walkthrough = {
    version: 1,
    title: 'T',
    chapters: [
      { id: 'a', title: 'A', steps: [{ id: 'a1', text: 'x' }, { id: 'a2', text: 'x', ref: 'rr:code/a.go#L1' }, { id: 'a3', text: 'x' }] },
      { id: 'b', title: 'B', lead: '<p>p</p><rr-flow><rr-node>n</rr-node></rr-flow><p>then</p><rr-flow><rr-node>m</rr-node></rr-flow>', steps: [{ id: 'b1', text: 'x' }] },
      { id: 'c', title: 'C', steps: [{ id: 'c1', text: 'x' }] },
    ],
  };
  const at = (chapter: number, step: number) => target({ doc: d, chapter, step });
  const a1: PaneWant = { kind: 'refs', refs: ['rr:code/a.go#L1'] };
  expect([at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(2, 0)]).toEqual<PaneWant[]>([{ kind: 'empty' }, a1, a1, a1, a1]);
});

test('deep link: ?walkthrough=<chapter>/<step>, either part optional', () => {
  expect(deepLink('?walkthrough=latency/s3')).toEqual({ chapter: 'latency', step: 's3' });
  expect(deepLink('?x=1&walkthrough=latency')).toEqual({ chapter: 'latency', step: undefined });
  expect(deepLink('?walkthrough')).toEqual({ chapter: undefined, step: undefined });
  expect(deepLink('?x=1')).toBeNull();
});

// ------------------------------------------------------------------ the pane

const code = (path: string) => ({ path, side: 'head' as const, view: 'diff' as const });
/** A pane whose lookups resolve when told to, recording what it rendered; its code panels land at once unless `held`. */
function pane({ held = false } = {}) {
  const log: string[] = [];
  const pending: { want: PaneWant; done: (v: PaneShown) => void }[] = [];
  const shown = (s: PaneShown) => (s.kind === 'refs' ? s.slots.map((x) => x.ref).join('+') : s.kind);
  // each code chunk's panel reports back once it has landed, a moment after it is mounted or moved
  const land = (s: PaneShown) => !held && s.kind === 'refs' && s.slots.forEach((x) => x.code && setTimeout(() => a.send({ type: 'landed' })));
  const a = createActor(
    paneMachine.provide({
      actors: { resolve: fromPromise(({ input }: { input: PaneWant }) => new Promise<PaneShown>((done) => pending.push({ want: input, done }))) },
      actions: {
        fadeIn: () => log.push('fadeIn'),
        fadeOut: () => log.push('fadeOut'),
        mount: ({ context }) => (log.push('mount ' + shown(context.next!)), land(context.next!)),
        glide: ({ context }) => (log.push('glide ' + shown(context.next!)), land(context.next!)),
        unmount: () => log.push('unmount'),
      },
      delays: { fade: 30, land: 60 },
    }),
    { input: null },
  ).start();
  const settle = (i: number, refs: string[], paths: string[]) => pending[i].done({ kind: 'refs', slots: refs.map((ref, j) => ({ ref, code: code(paths[j]) })) });
  return { a, log, pending, settle };
}

test('pane: a new show cancels a lookup still running; only the newest is mounted', async () => {
  const { a, log, settle } = pane();
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r1'] } });
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r2', 'r3'] } });
  settle(0, ['r1'], ['a.go']); // stale: its state is gone
  settle(1, ['r2', 'r3'], ['a.go', 'b.go']);
  await waitFor(a, (s) => s.matches('showing'));
  expect(log).toEqual(['fadeOut', 'mount r2+r3', 'fadeIn']);
});

test('pane: same files glide without a fade; other files fade and remount; clear unmounts', async () => {
  const { a, log, settle } = pane();
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r1'] } });
  settle(0, ['r1'], ['a.go']);
  await waitFor(a, (s) => s.matches('showing'));
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r1b'] } });
  settle(1, ['r1b'], ['a.go']);
  await waitFor(a, (s) => s.matches('showing') && s.context.shown?.kind === 'refs' && s.context.shown.slots[0].ref === 'r1b');
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r4'] } });
  settle(2, ['r4'], ['c.go']);
  await waitFor(a, (s) => s.matches('showing') && s.context.shown?.kind === 'refs' && s.context.shown.slots[0].ref === 'r4');
  a.send({ type: 'clear' });
  expect(log).toEqual(['fadeOut', 'mount r1', 'fadeIn', 'glide r1b', 'fadeIn', 'fadeOut', 'mount r4', 'fadeIn', 'unmount']);
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('the player aims its pane at every step and stops it on close', async () => {
  const d: Walkthrough = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [{ id: 's1', text: 'x', ref: ['rr:code/a.go#L1', 'rr:code/b.go#L2'] }, { id: 's2', text: 'y', ref: 'rr:code/a.go#L5' }] }] };
  const shows: string[] = [];
  let unmounts = 0;
  const p = paneMachine.provide({
    actors: { resolve: fromPromise(async ({ input }: { input: PaneWant }): Promise<PaneShown> => (input.kind === 'refs' ? { kind: 'refs', slots: input.refs.map((ref) => ({ ref, code: null })) } : input)) },
    actions: { mount: ({ context: { next } }) => shows.push(next!.kind === 'refs' ? next!.slots.map((s) => s.ref).join(' ') : next!.kind), unmount: () => unmounts++ },
    delays: { fade: 0 },
  });
  const a = createActor(walkthroughMachine.provide({ actors: { pane: p } })).start();
  a.send({ type: 'load', doc: d });
  a.send({ type: 'open' });
  await until(() => shows.length === 1);
  a.send({ type: 'next' });
  await until(() => shows.length === 2);
  a.send({ type: 'focus', refs: ['rr:sym/Fetcher'] });
  await until(() => shows.length === 3);
  a.send({ type: 'close' });
  expect([shows, unmounts]).toEqual([['rr:code/a.go#L1 rr:code/b.go#L2', 'rr:code/a.go#L5', 'rr:sym/Fetcher'], 1]);
});

test('pane: back to what is on screen during a fade glides and fades back in', async () => {
  const { a, log, settle } = pane();
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r1'] } });
  settle(0, ['r1'], ['a.go']);
  await waitFor(a, (s) => s.matches('showing'));
  log.length = 0;
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r9'] } });
  settle(1, ['r9'], ['z.go']);
  await waitFor(a, (s) => s.matches('leaving'));
  a.send({ type: 'show', want: { kind: 'refs', refs: ['r1'] } }); // before the fade ends
  settle(2, ['r1'], ['a.go']);
  await waitFor(a, (s) => s.matches('showing'));
  expect(log).toEqual(['fadeOut', 'glide r1', 'fadeIn']);
});

test('pane: showing waits until every code chunk has landed; a chunk that never lands times out as late', async () => {
  const p = pane({ held: true });
  p.a.send({ type: 'show', want: { kind: 'refs', refs: ['r1', 'r2'] } });
  p.settle(0, ['r1', 'r2'], ['a.go', 'b.go']);
  await waitFor(p.a, (s) => s.matches('landing'));
  p.a.send({ type: 'landed' });
  expect(p.a.getSnapshot().value).toBe('landing');
  p.a.send({ type: 'landed' });
  expect(p.a.getSnapshot()).toMatchObject({ value: 'showing', context: { late: false } });
  p.a.send({ type: 'show', want: { kind: 'refs', refs: ['r3'] } });
  p.settle(1, ['r3'], ['c.go']);
  const s = await waitFor(p.a, (x) => x.matches('showing'));
  expect(s.context.late).toBe(true);
});
