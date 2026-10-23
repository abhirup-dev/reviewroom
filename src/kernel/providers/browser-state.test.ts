import { afterEach, expect, test } from 'bun:test';
import { BrowserState } from './browser-state';

const store = new Map<string, string>();
globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
afterEach(() => store.clear());

test('a corrupt stored entry reads as nothing saved, and saving over it works', async () => {
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
  const b = new BrowserState('r');
  const layout = { title: 'Mine', root: { tabs: ['code'] } };
  await b.saveLayout('mine', layout);
  await b.setDefaultLayout('mine');
  expect(await b.saveLayout('mine', layout)).toBe(false);
  await b.saveLayout('mine', null);
  expect(await b.layouts()).toEqual({ layouts: {}, default: null });
});
