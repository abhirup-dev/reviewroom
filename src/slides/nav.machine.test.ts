import { expect, test } from 'bun:test';
import { createActor, fromPromise } from 'xstate';
import { navMachine, slotFor } from './nav.machine';
import type { CodeAt, Slot } from './player.machine';

const code = (path: string, start = 1): CodeAt => ({ path, side: 'head', start, end: start, view: 'diff' });
const slots: Slot[] = [
  { ref: 'rr:code/head/a.go#L1', code: code('a.go') },
  { ref: 'rr:code/head/b.go#L5', code: code('b.go', 5) },
];

test('slot identity includes side, revision and view, but not highlighted lines', () => {
  const at = { ...code('a.go'), rev: 'abc123' };
  const shown: Slot[] = [{ ref: 'revision', code: at }, { ref: 'section', code: null }];
  expect(slotFor(shown, { ...at, start: 9, end: 12, view: undefined })).toBe(0);
  expect(slotFor(shown, { ...at, side: 'base' })).toBe(-1);
  expect(slotFor(shown, { ...at, rev: 'def456' })).toBe(-1);
  expect(slotFor(shown, { ...at, rev: undefined })).toBe(-1);
  expect(slotFor(shown, { ...at, view: 'file' })).toBe(-1);
});

/** `where`: what each ref resolves to; a promise held open until `release(ref)`. */
function nav(where: Record<string, CodeAt | null>) {
  const out: string[] = [];
  const held = new Map<string, () => void>();
  const a = createActor(
    navMachine.provide({
      actors: { resolve: fromPromise(({ input }) => new Promise<CodeAt | null>((r) => held.set(input, () => r(where[input] ?? null)))) },
      actions: {
        select: ({ context: { landing } }) => void (landing && 'index' in landing && out.push(`select ${landing.index} ${landing.code?.start ?? '-'}`)),
        focus: ({ context: { landing } }) => void (landing && 'focus' in landing && out.push(`focus ${landing.focus}`)),
      },
    }),
  ).start();
  const release = async (ref: string) => (held.get(ref)!(), await Promise.resolve(), await Promise.resolve());
  return { a, out, release };
}

test('nav: a tab picks a chunk on screen and reveals its own lines, at once', () => {
  const n = nav({});
  n.a.send({ type: 'pane', slots });
  n.a.send({ type: 'go', jump: { index: 1 } });
  expect(n.out).toEqual(['select 1 5']);
  expect(n.a.getSnapshot().value).toBe('ready');
});

test('nav: a link into a file on screen selects that chunk and reveals the link\'s lines', async () => {
  const n = nav({ link: code('b.go', 9) });
  n.a.send({ type: 'pane', slots });
  n.a.send({ type: 'go', jump: { ref: 'link' } });
  await n.release('link');
  expect(n.out).toEqual(['select 1 9']);
});

test('nav: a link (or symbol) elsewhere, or one that resolves to nothing, has the pane show it', async () => {
  const n = nav({ other: code('c.go'), gone: null });
  n.a.send({ type: 'pane', slots });
  n.a.send({ type: 'go', jump: { ref: 'other' } });
  await n.release('other');
  n.a.send({ type: 'go', jump: { ref: 'gone' } });
  await n.release('gone');
  expect(n.out).toEqual(['focus other', 'focus gone']);
});

test('nav: waits while the pane changes, then lands in what it shows', async () => {
  const n = nav({ link: code('a.go', 3) });
  n.a.send({ type: 'pane', slots: null });
  n.a.send({ type: 'go', jump: { ref: 'link' } });
  n.a.send({ type: 'go', jump: { index: 0 } }); // replaced before the pane is back
  expect(n.a.getSnapshot().value).toBe('waiting');
  n.a.send({ type: 'pane', slots });
  expect(n.out).toEqual(['select 0 1']);
});

test('nav: a new go cancels the stale lookup; only the last lands', async () => {
  const n = nav({ first: code('a.go', 2), second: code('b.go', 7) });
  n.a.send({ type: 'pane', slots });
  n.a.send({ type: 'go', jump: { ref: 'first' } });
  n.a.send({ type: 'go', jump: { ref: 'second' } });
  await n.release('first');
  await n.release('second');
  expect(n.out).toEqual(['select 1 7']);
});

test('nav: a slide change cancels a pending jump', async () => {
  const n = nav({ link: code('c.go') });
  n.a.send({ type: 'pane', slots: null });
  n.a.send({ type: 'go', jump: { ref: 'link' } });
  n.a.send({ type: 'cancel' });
  n.a.send({ type: 'pane', slots });
  expect(n.out).toEqual([]);
  expect(n.a.getSnapshot().value).toBe('ready');
});
