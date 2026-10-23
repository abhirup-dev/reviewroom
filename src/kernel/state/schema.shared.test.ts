import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { schemas } from '../../../scripts/schema';

test('schema/*.schema.json are generated from the Zod schemas (run `bun run schema`)', () => {
  for (const s of schemas()) expect(readFileSync(s.file, 'utf8')).toBe(s.content);
});
