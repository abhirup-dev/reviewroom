import { afterEach, expect, test } from 'bun:test';
import type { SearchHit } from '../kernel/state/model.shared';
import { mountReview } from '../testing/mount-review';

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
  f.app.provider.search = async (q) => (queries.push(q), q === 'Build' ? hits : []);
  const { codeAt } = await import('./player');
  expect(await codeAt(f.app, 'rr:sym/Builder.Build')).toMatchObject({ path: 'pkg/builder.go', start: 9, end: 9, side: 'head' });
  expect(await codeAt(f.app, 'rr:sym/pkg/cache.go:Build')).toMatchObject({ path: 'pkg/cache.go', start: 3 });
  expect(queries.every((q) => q === 'Build')).toBe(true);
});
