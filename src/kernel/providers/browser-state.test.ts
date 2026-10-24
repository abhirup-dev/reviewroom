import { expect, test } from 'bun:test';
import { BrowserState } from './browser-state';
import { fixture, type Fixture } from '../../testing/fixture';

/** A localStorage of the test's own: the map behind it. */
function storage(t: Fixture) {
  const store = new Map<string, string>();
  t.global('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return store;
}

test('a corrupt stored entry reads as nothing saved, and saving over it works', async () => {
  using t = fixture();
  const store = storage(t);
  for (const key of ['reviewroom:state:r', 'reviewroom:layouts', 'reviewroom:layout:r']) store.set(key, '{not json');
  const b = new BrowserState('r');
  expect(await b.load()).toBeNull();
  expect(await b.layouts()).toEqual({ layouts: {}, default: null });
  expect(await b.lastLayout()).toBeNull();
  const layout = { title: 'Mine', root: { tabs: ['code'] } };
  expect(await b.saveLayout('mine', layout)).toBe(true);
  expect(await b.layouts()).toEqual({ layouts: { mine: layout }, default: null });
});

test('saved layouts keep their rules: a taken name is refused, deleting the default clears it', async () => {
  using t = fixture();
  storage(t);
  const b = new BrowserState('r');
  const layout = { title: 'Mine', root: { tabs: ['code'] } };
  await b.saveLayout('mine', layout);
  await b.setDefaultLayout('mine');
  expect(await b.saveLayout('mine', layout)).toBe(false);
  await b.saveLayout('mine', null);
  expect(await b.layouts()).toEqual({ layouts: {}, default: null });
});

test('browser walkthrough returns embedded text unchanged, including malformed JSON, or null when absent', async () => {
  using t = fixture();
  storage(t);
  for (const text of ['{broken', '{"version":999}', '']) {
    expect(await new BrowserState('review', undefined, text).walkthrough()).toBe(text);
  }
  expect(await new BrowserState('review').walkthrough()).toBeNull();
});
