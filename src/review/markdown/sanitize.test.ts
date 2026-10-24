import { afterAll, expect, test } from 'bun:test';
import { installDOM } from '../../testing/dom';

// DOMPurify binds to the global window when it loads
const dom = installDOM();
afterAll(() => dom.restore());
const { sanitizeDiagram } = await import('./diagram.ts');

const svg = (href: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="${href}"><text>x</text></a><a xlink:href="${href}"><text>y</text></a><rect fill="var(--_s)" transform="translate(1,2)" style="rx:var(--_r)"/></svg>`;
const links = (href: string) => [...sanitizeDiagram(svg(href)).querySelectorAll('a')].map((a) => a.getAttribute('href') ?? a.getAttribute('xlink:href'));

test('a diagram keeps http(s) and rr: links, and nothing else', () => {
  for (const ok of ['rr:code/a.ts#L1-2', 'https://example.com/x', 'http://example.com']) expect(links(ok)).toEqual([ok, ok]);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'foo1:x', '//evil.example']) expect(links(bad)).toEqual([null, null]);
});

test('geometry and CSS values pass the link filter', () => {
  const rect = sanitizeDiagram(svg('#a')).querySelector('rect')!;
  expect([rect.getAttribute('fill'), rect.getAttribute('transform'), rect.getAttribute('style')]).toEqual(['var(--_s)', 'translate(1,2)', 'rx:var(--_r)']);
});
