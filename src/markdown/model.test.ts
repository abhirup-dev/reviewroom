import { expect, test } from 'bun:test';
import { documentDiff, inlineDiff } from './model';

test('renders GFM structures without rewriting or losing their source ranges', () => {
  const source = '# Plan\n\n- [x] Shipped\n- [ ] Pending\n\n| Name | State |\n| --- | --- |\n| API | Ready |\n\n```ts\nconst x = 1;\n```\n';
  const model = documentDiff(source, source);
  expect(model.blocks.map((b) => [b.after?.start, b.after?.end])).toEqual([[1, 1], [3, 4], [6, 8], [10, 12]]);
  expect(model.blocks.every((b) => b.status === 'equal')).toBe(true);
  expect(model.blocks[1].after?.html).toContain('checked');
  expect(model.blocks[2].after?.html).toContain('<table>');
  expect(model.blocks[3].after?.html).toContain('language-ts');
});

test('keeps complete-document reference definitions when rendering individual blocks', () => {
  const before = '# Guide\n\nRead [the guide][docs].\n\n[docs]: https://example.com/old\n';
  const after = before.replace('/old', '/new');
  const model = documentDiff(before, after);
  expect(model.blocks[1].status).toBe('modified');
  expect(model.blocks[1].before?.html).toContain('https://example.com/old');
  expect(model.blocks[1].after?.html).toContain('https://example.com/new');
});

test('maps equal blocks independently when earlier edits move source lines', () => {
  const model = documentDiff('# Title\n\nUnchanged.\n', '# Title\n\nNew paragraph.\n\nUnchanged.\n');
  expect(model.blocks.at(-1)?.before?.start).toBe(3);
  expect(model.blocks.at(-1)?.after?.start).toBe(5);
});

test('preserves table and list formatting on modified blocks and tracks added/deleted files', () => {
  const before = '| Name | State |\n| --- | --- |\n| API | Ready |\n';
  const model = documentDiff(before, before.replace('Ready', '**Running**'));
  expect(model.blocks[0].status).toBe('modified');
  expect(model.blocks[0].after?.html).toContain('<strong>Running</strong>');
  expect(documentDiff(null, 'Hello').blocks[0].status).toBe('added');
  expect(documentDiff('Hello', null).blocks[0].status).toBe('removed');
});

test('returns visible-text offsets for emphasis and bounds expensive refinement', () => {
  const diff = inlineDiff('Ship the old plan.', 'Ship the new plan.');
  expect(diff.before.map((s) => 'Ship the old plan.'.slice(s.start, s.end))).toEqual(['old']);
  expect(diff.after.map((s) => 'Ship the new plan.'.slice(s.start, s.end))).toEqual(['new']);
  expect(inlineDiff('a'.repeat(20_001), 'b')).toEqual({ before: [], after: [] });
  expect(documentDiff(null, 'a'.repeat(500_001)).limited).toBe(true);
  expect(documentDiff(null, 'Paragraph.\n\n'.repeat(501)).limited).toBe(true);
});
