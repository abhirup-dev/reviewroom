import { afterEach, expect, test } from 'bun:test';
import type { SearchHit } from '../kernel/state/model.shared';
import { mountReview } from '../testing/mount-review';
import { fixture as scope } from '../testing/fixture';

let fixture: Awaited<ReturnType<typeof mountReview>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

test("a slide's rr:sym link lands on the definition its qualifier names, like every other symbol link", async () => {
  const f = fixture = await mountReview('');
  const queries: string[] = [];
  const hits: SearchHit[] = [
    { path: 'pkg/cache.go', line: 3, text: 'func (c *Cache) Build() {', rev: 'head', kind: 'definition' },
    { path: 'pkg/builder.go', line: 9, text: 'func (b *Builder) Build() {', rev: 'head', kind: 'definition' },
  ];
  // a real symbol search knows words, not `Owner.Name`
  f.app.provider.search = async (q) => { queries.push(q); return q === 'Build' ? hits : []; };
  const { codeAt } = await import('./player');
  expect(await codeAt(f.app, 'rr:sym/Builder.Build')).toMatchObject({ path: 'pkg/builder.go', start: 9, end: 9, side: 'head' });
  expect(await codeAt(f.app, 'rr:sym/pkg/cache.go:Build')).toMatchObject({ path: 'pkg/cache.go', start: 3 });
  expect(queries.every((q) => q === 'Build')).toBe(true);
});

test('a close cancels an open the reader did not ask for: a late walkthrough answer never reopens the player', async () => {
  const f = fixture = await mountReview('');
  using t = scope();
  t.global('location', f.window.location);
  t.global('history', f.window.history);
  const doc = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [{ id: 'a1', text: 'one' }] }] };
  const answers: ((d: unknown) => void)[] = [];
  f.app.backend.walkthrough = () => new Promise((r) => answers.push(r));
  const { mountWalkthrough } = await import('./player');
  mountWalkthrough(f.app);
  const mode = () => document.querySelector<HTMLElement>('.rr-tour')?.dataset.mode;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  answers.shift()!(doc); // the boot's load
  f.app.bus.emit('walkthrough-show', undefined);
  answers.shift()!(doc);
  await settle();
  expect(mode()).toBe('playing');
  f.app.bus.emit('walkthrough-show', undefined); // generation shows it again; its fetch is slow
  document.querySelector<HTMLElement>('.rr-tour__top [title="Close the walkthrough"], .rr-tour__top [aria-label="Close the walkthrough"]')!.click();
  answers.shift()!(doc);
  await settle();
  expect([mode(), location.search.includes('walkthrough')]).toEqual(['closed', false]);
});
