import { expect, test } from 'bun:test';
import { renderAsync } from 'pele/lazy';

// Sai's PR: https://github.com/ShareChat/tardis-feature-service-sdk/pull/149
for (const index of [1, 2, 3]) {
  test(`renders SDK PR #149 diagram ${index} without Mermaid.js`, async () => {
    const source = await Bun.file(new URL(`./fixtures/sdk-149-${index}.mmd`, import.meta.url)).text();
    const result = await renderAsync(source, { images: false, links: false, measurer: { width: (text, size) => text.length * size * 0.6 } });
    expect(result.type).toBe('flowchart');
    expect(result.svg).toContain('<svg');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });
}

test('untrusted diagram directives cannot enable active links or remote images', async () => {
  const result = await renderAsync('flowchart TD\n A[Hello] --> B[World]\n click A "javascript:alert(1)"', { links: false, images: false, measurer: { width: (text, size) => text.length * size * 0.6 } });
  expect(result.svg).not.toContain('javascript:');
  expect(result.svg).not.toContain('<script');
});
