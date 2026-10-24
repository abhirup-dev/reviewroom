// ReviewApp over a stack of PRs: its ranges, stepping between layers, links in a layer, thread labels.
import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const w = new JSDOM('', { url: 'http://localhost/', pretendToBeVisual: true }).window;
Object.assign(globalThis, { window: w, Window: w.Window, document: w.document, navigator: w.navigator, localStorage: w.localStorage, customElements: w.customElements, HTMLElement: w.HTMLElement, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle, requestAnimationFrame: () => 0 });
const { ReviewApp } = await import('./app.ts');
const { parseRef } = await import('./kernel/refs/refs.shared.ts');

const pr = (number: number, base: string, head: string) => ({ number, title: `pr ${number}`, state: 'open' as const, headLabel: `b${number}`, base, head, additions: 1, deletions: 0, files: 1 });
function stackApp() {
  const app = new ReviewApp(document.createElement('div'));
  app.meta = { id: 'x', title: 't', base: 'm', head: 'c', number: 2, stack: [pr(1, 'm', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c')] };
  app.commits = [{ sha: 'a', short: 'a', subject: 'one', pr: 1 }, { sha: 'b1', short: 'b1', subject: 'two', pr: 2 }, { sha: 'b', short: 'b', subject: 'three', parent: 'b1', pr: 2 }];
  app.provider = { files: async () => [] } as never;
  return app;
}

test('a stack offers the whole stack, then each layer before its commits', () => {
  expect(stackApp().services.code.ranges().map((r) => r.key)).toEqual(['all', 'pr-1', 'a', 'pr-2', 'b1', 'b', 'pr-3']);
});

test('stepping goes layer by layer and stops at the ends; two quick steps are two steps', async () => {
  const app = stackApp();
  await app.setRange(app.services.code.ranges()[0]);
  await app.stepPr(-1); // from the whole stack: the top
  expect(app.range.key).toBe('pr-3');
  await app.stepPr(1);
  expect(app.range.key).toBe('pr-3');
  void app.stepPr(-1);
  await app.stepPr(-1);
  expect(app.range.key).toBe('pr-1');
});

test("a plain link inside a data-pr element means that PR's layer; @pr and revs are kept", () => {
  const app = stackApp();
  const sec = document.createElement('section');
  sec.dataset.pr = '3';
  const a = sec.appendChild(document.createElement('a'));
  expect(app.services.code.inLayer(parseRef('rr:code/x.go#L4')!, a)).toMatchObject({ pr: 3 });
  expect(app.services.code.inLayer(parseRef('rr:code/x.go@pr:1#L4')!, a)).toMatchObject({ pr: 1 });
  expect(app.services.code.inLayer(parseRef('rr:code/x.go@abc123#L4')!, a)).not.toHaveProperty('pr');
  expect(app.services.code.inLayer(parseRef('rr:code/x.go#L4')!, document.createElement('a'))).not.toHaveProperty('pr');
});

test("a layer's thread names its PR once: in the label, or in a badge beside it", () => {
  const app = stackApp();
  const a = { kind: 'code', path: 'cache/cache.go', rev: 'head', start: 15, end: 15, pr: 2 } as const;
  expect(app.anchorLabel(a)).toBe('cache.go:15 · #2');
  expect(app.anchorLabel(a, { pr: false })).toBe('cache.go:15');
});
