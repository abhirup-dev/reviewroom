import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the global window when it loads
Object.assign(globalThis, { window: new JSDOM('').window });
const { proseRemoved, renderMarkdown, sanitizeProse } = await import('./markdown.ts');

test('a bare rr: line embeds', () => {
  expect(renderMarkdown('see\n\nrr:code/a.go#L1\t\n\nafter')).toContain('<rr-embed ref="rr:code/a.go#L1"></rr-embed>');
});

test('rr: links and images become chips and embeds', () => {
  expect(renderMarkdown('[x](rr:code/a.go#L1)')).toContain('<rr-ref ref="rr:code/a.go#L1">x</rr-ref>');
  expect(renderMarkdown('![cap](rr:doc/s)')).toContain('<rr-embed ref="rr:doc/s" caption="cap"></rr-embed>');
});

test('only rr-ref and rr-embed survive sanitising; javascript: links go', () => {
  expect(renderMarkdown('<rr-check id="t">x</rr-check>[a](javascript:alert(1))')).not.toMatch(/rr-check|javascript/);
});

test('outside links open in a new tab, raw HTML ones too; rr: links stay', () => {
  expect(renderMarkdown('[a](https://x.dev)')).toBe('<p><a href="https://x.dev" target="_blank" rel="noopener">a</a></p>\n');
  expect(renderMarkdown('<a href="https://x.dev">a</a>')).toContain('target="_blank"');
  expect(renderMarkdown('<a href="rr:doc/s">a</a>')).not.toContain('target');
});

test('proseRemoved names what the walkthrough sanitizer takes out, once each', () => {
  expect(proseRemoved('<p onclick="x()">a</p><script>1</script><script>2</script><rr-ref ref="rr:sym/X">X</rr-ref><rr-check id="c">c</rr-check>')).toEqual(['onclick on <p>', '<script>', '<rr-check>']);
  expect(proseRemoved('<p>fine <a href="rr:code/a.go#L1">a</a></p>')).toEqual([]);
});

test('walkthrough prose keeps a flow diagram\'s direction', () => {
  expect(sanitizeProse('<rr-flow direction="column"><rr-node>a</rr-node></rr-flow>')).toBe('<rr-flow direction="column"><rr-node>a</rr-node></rr-flow>');
});

test('walkthrough prose is display-only: no styles, forms, media, svg or script URLs', () => {
  const html = '<p style="position:fixed">a <a href="javascript:x()">j</a> <a href="rr:code/a.go#L1">r</a></p><form><input></form><img src="https://e.vil/x.png"><svg><script>1</script></svg><rr-flow><rr-node state="new" ref="data:x">n</rr-node></rr-flow>';
  expect(sanitizeProse(html)).toBe('<p>a <a target="_blank" rel="noopener">j</a> <a href="rr:code/a.go#L1">r</a></p><rr-flow><rr-node state="new">n</rr-node></rr-flow>');
  expect(proseRemoved(html)).toEqual(['style on <p>', 'href on <a>', '<form>', '<input>', '<img>', '<svg>', 'ref on <rr-node>']);
});
