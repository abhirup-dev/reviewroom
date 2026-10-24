import { afterEach, expect, test } from 'bun:test';
import { mountReview } from '../testing/mount-review';

let fixture: Awaited<ReturnType<typeof mountReview>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

test('a doc preview is a copy without ids or scripts, its widgets reset to their source', async () => {
  const f = fixture = await mountReview('<section id="s"><h2 id="t">T</h2><script>1</script><rr-mermaid id="m" data-src="graph TD; a">drawn</rr-mermaid></section>');
  const { renderPreview } = await import('./previews');
  const el = await renderPreview(f.app, 'rr:doc/s');
  expect(el.querySelectorAll('[id], script').length).toBe(0);
  const w = el.querySelector<HTMLElement>('rr-mermaid')!;
  expect([w.textContent, w.dataset.ready]).toEqual(['graph TD; a', undefined]);
  const alone = await renderPreview(f.app, 'rr:doc/m'); // the widget itself is the element linked to
  expect(alone.firstElementChild!.textContent).toBe('graph TD; a');
});
