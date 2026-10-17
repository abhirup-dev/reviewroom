import { expect, test } from 'bun:test';
import { BrowserState } from './index';

const w = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [{ id: 's1', text: 'x' }] }] };

test('BrowserState serves the embedded walkthrough, its issues, or none', async () => {
  expect((await new BrowserState('x', undefined, JSON.stringify(w)).walkthrough()) as unknown).toEqual(w);
  expect(await new BrowserState('x', undefined, JSON.stringify({ ...w, version: 2 })).walkthrough()).toEqual({ issues: [expect.stringContaining('version')] });
  expect(await new BrowserState('x', undefined, '{').walkthrough()).toEqual({ issues: [expect.stringContaining('not JSON')] });
  expect(await new BrowserState('x').walkthrough()).toBeNull();
});
