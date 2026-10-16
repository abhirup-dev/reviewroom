import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the global window when it loads
Object.assign(globalThis, { window: new JSDOM('').window });
const { renderMarkdown } = await import('./markdown.ts');

test('bare rr: line embeds, but not inside a code block', () => {
  expect(renderMarkdown('see\n\nrr:code/a.go#L1\t\n\nafter')).toContain('<rr-embed ref="rr:code/a.go#L1"></rr-embed>');
  expect(renderMarkdown('```\nrr:code/a.go#L1\n```')).toBe('<pre><code>rr:code/a.go#L1\n</code></pre>\n');
});

test('rr: links and images become chips and embeds', () => {
  expect(renderMarkdown('[x](rr:code/a.go#L1)')).toContain('<rr-ref ref="rr:code/a.go#L1">x</rr-ref>');
  expect(renderMarkdown('![cap](rr:doc/s)')).toContain('<rr-embed ref="rr:doc/s" caption="cap"></rr-embed>');
});

test('sanitises: scripts, handlers, javascript: links and other rr- elements go', () => {
  const html = renderMarkdown('<rr-check id="t">x</rr-check><script>alert(1)</script><img src=x onerror=alert(1)>[a](javascript:alert(1))');
  expect(html).not.toMatch(/rr-check|script|onerror|javascript/);
});

test('outside links open in a new tab, raw HTML ones too; rr: links stay', () => {
  expect(renderMarkdown('[a](https://x.dev)')).toBe('<p><a href="https://x.dev" target="_blank" rel="noopener">a</a></p>\n');
  expect(renderMarkdown('<a href="https://x.dev">a</a>')).toContain('target="_blank"');
  expect(renderMarkdown('<a href="rr:doc/s">a</a>')).not.toContain('target');
});
