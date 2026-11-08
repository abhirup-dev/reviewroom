import { expect, test } from 'bun:test';
import { BrowserState } from './browser-state';
import { fixture, type Fixture } from '../../testing/fixture';

/** A localStorage of the test's own: the map behind it. */
function storage(t: Fixture) {
  const store = new Map<string, string>();
  t.global('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return store;
}

test('a corrupt stored state reads as nothing saved', async () => {
  using t = fixture();
  storage(t).set('reviewroom:state:r', '{not json');
  expect(await new BrowserState('r').load()).toBeNull();
});

test('browser walkthrough returns embedded text unchanged, including malformed JSON, or null when absent', async () => {
  using t = fixture();
  storage(t);
  for (const text of ['{broken', '{"version":999}', '']) {
    expect(await new BrowserState('review', undefined, text).walkthrough()).toBe(text);
  }
  expect(await new BrowserState('review').walkthrough()).toBeNull();
});
