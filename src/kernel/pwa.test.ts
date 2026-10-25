import { expect, test } from 'bun:test';
import { chunkReloadDue, once, shouldHoldReload, workerScope } from './pwa.ts';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('a reload waits for unsent ops, a comment being written or an open dialog', () => {
  const idle = { unsent: false, composing: false, dialog: false };
  expect(shouldHoldReload(idle)).toBe(false);
  for (const k of ['unsent', 'composing', 'dialog'] as const) expect(shouldHoldReload({ ...idle, [k]: true })).toBe(true);
});

test('the worker is the hub root one, at a review server root and under the hub proxy', () => {
  expect(workerScope('http://127.0.0.1:4848/_rr/reviewroom.js').href).toBe('http://127.0.0.1:4848/');
  expect(workerScope('http://127.0.0.1:4847/_rr/hub.js').href).toBe('http://127.0.0.1:4847/');
  expect(workerScope('https://box.ts.net/r/0123456789ab/_rr/reviewroom.js').href).toBe('https://box.ts.net/');
  expect(workerScope('https://box.ts.net/rr/r/0123456789ab/_rr/reviewroom.js').href).toBe('https://box.ts.net/rr/');
});

test('once per build: a second reload for the same build is refused, a newer build may reload again', () => {
  const s = store();
  expect(once('k', 'aaa', s)).toBe(true);
  expect(once('k', 'aaa', s)).toBe(false);
  expect(once('k', 'bbb', s)).toBe(true);
});

test('a failed chunk reloads at most once a minute', () => {
  const s = store();
  expect(chunkReloadDue(1_000_000, s)).toBe(true);
  expect(chunkReloadDue(1_030_000, s)).toBe(false);
  expect(chunkReloadDue(1_061_000, s)).toBe(true);
});
