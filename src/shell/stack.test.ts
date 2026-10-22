import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const w = new JSDOM('', { url: 'http://localhost/', pretendToBeVisual: true }).window;
Object.assign(globalThis, { window: w, Window: w.Window, document: w.document, navigator: w.navigator, localStorage: w.localStorage, customElements: w.customElements, HTMLElement: w.HTMLElement, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle, requestAnimationFrame: () => 0 });
const { ReviewApp } = await import('./app.ts');
const { parseRef } = await import('../core/refs.ts');

const pr = (number: number, base: string, head: string) => ({ number, title: `pr ${number}`, state: 'open' as const, headLabel: `b${number}`, base, head, additions: 1, deletions: 0, files: 1 });
function stackApp() {
  const app = new ReviewApp(document.createElement('div'));
  app.meta = { id: 'x', title: 't', base: 'm', head: 'c', number: 2, stack: [pr(1, 'm', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c')] };
  app.commits = [{ sha: 'a', short: 'a', subject: 'one', pr: 1 }, { sha: 'b1', short: 'b1', subject: 'two', pr: 2 }, { sha: 'b', short: 'b', subject: 'three', parent: 'b1', pr: 2 }];
  app.provider = { files: async () => [] } as never;
  return app;
}

test('a stack offers the whole stack, then each layer before its commits', () => {
  expect(stackApp().ranges().map((r) => r.key)).toEqual(['all', 'pr-1', 'a', 'pr-2', 'b1', 'b', 'pr-3']);
});

test('stepping goes layer by layer and stops at the ends', async () => {
  const app = stackApp();
  await app.setRange(app.ranges()[0]);
  app.stepPr(-1); // from the whole stack: the top
  await Promise.resolve();
  expect(app.range.key).toBe('pr-3');
  app.stepPr(1);
  await Promise.resolve();
  expect(app.range.key).toBe('pr-3');
  app.stepPr(-1);
  await Promise.resolve();
  expect(app.range.key).toBe('pr-2');
});

test("a plain link inside a data-pr element means that PR's layer; @pr and revs are kept", () => {
  const app = stackApp();
  const sec = document.createElement('section');
  sec.dataset.pr = '3';
  const a = sec.appendChild(document.createElement('a'));
  expect(app.inLayer(parseRef('rr:code/x.go#L4')!, a)).toMatchObject({ pr: 3 });
  expect(app.inLayer(parseRef('rr:code/x.go@pr:1#L4')!, a)).toMatchObject({ pr: 1 });
  expect(app.inLayer(parseRef('rr:code/x.go@abc123#L4')!, a)).not.toHaveProperty('pr');
  expect(app.inLayer(parseRef('rr:code/x.go#L4')!, document.createElement('a'))).not.toHaveProperty('pr');
});
