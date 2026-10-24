import { expect, test } from 'bun:test';
import { createActor, fromPromise, waitFor } from 'xstate';
import type { ChangedFile, DiffRange } from '../kernel/state/model.shared';
import { rangeMachine } from './range.machine';
import { tick } from '../testing/wait';
import { fixture, type Fixture } from '../testing/fixture';

const range = (key: string, head = key): DiffRange => ({ key, base: 'base', head, label: key });
const file = (path: string): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 0 });

/** A range machine whose lookups finish (or fail) when told to, recording what it showed. */
function switcher(scope: Fixture) {
  const log: string[] = [];
  const lookups: { key: string; done: (f: ChangedFile[]) => void; fail: (e: Error) => void }[] = [];
  const a = createActor(rangeMachine.provide({ actors: { files: fromPromise(({ input }) => new Promise<ChangedFile[]>((done, fail) => lookups.push({ key: input.key, done, fail }))) } })).start();
  a.on('shown', (e) => log.push(`shown ${e.range.key} ${e.files.map((f) => f.path).join(',')}`));
  a.on('failed', (e) => log.push(`failed ${(e.error as Error).message}`));
  scope.defer(() => a.stop());
  const select = (r: DiffRange) => a.send({ type: 'select', range: r });
  const idle = () => waitFor(a, (s) => s.matches('idle'));
  return { a, log, lookups, select, idle };
}

test('range: the range and its files change together, then shown', async () => {
  using scope = fixture();
  const r = switcher(scope);
  r.select(range('pr-1'));
  expect(r.a.getSnapshot().context.range).toBeNull(); // nothing shown until its files are in
  r.lookups[0].done([file('a.go')]);
  await r.idle();
  expect(r.a.getSnapshot().context).toMatchObject({ range: { key: 'pr-1' }, files: [{ path: 'a.go' }], want: null });
  expect(r.log).toEqual(['shown pr-1 a.go']);
});

test("range: the latest select wins; an older lookup's late answer is dropped", async () => {
  using scope = fixture();
  const r = switcher(scope);
  r.select(range('pr-1'));
  r.select(range('pr-2'));
  r.lookups[1].done([file('b.go')]);
  await r.idle();
  r.lookups[0].done([file('a.go')]); // late
  await tick();
  expect(r.a.getSnapshot().context).toMatchObject({ range: { key: 'pr-2' }, files: [{ path: 'b.go' }] });
  expect(r.log).toEqual(['shown pr-2 b.go']);
});

test('range: the range shown, or on its way, is not looked up again; a restacked one is', async () => {
  using scope = fixture();
  const r = switcher(scope);
  r.select(range('pr-1'));
  r.select(range('pr-1'));
  expect(r.lookups).toHaveLength(1);
  r.lookups[0].done([file('a.go')]);
  await r.idle();
  r.select(range('pr-1'));
  expect(r.a.getSnapshot().matches('idle')).toBe(true);
  r.select(range('pr-1', 'new-head')); // same layer, moved by a restack
  expect(r.lookups.map((l) => l.key)).toEqual(['pr-1', 'pr-1']);
});

test('range: a failed lookup keeps what is shown', async () => {
  using scope = fixture();
  const r = switcher(scope);
  r.select(range('pr-1'));
  r.lookups[0].done([file('a.go')]);
  await r.idle();
  r.select(range('pr-2'));
  r.lookups[1].fail(new Error('gone'));
  await r.idle();
  expect(r.a.getSnapshot().context).toMatchObject({ range: { key: 'pr-1' }, files: [{ path: 'a.go' }], want: null });
  expect(r.log).toEqual(['shown pr-1 a.go', 'failed gone']);
});
