import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { render, schemaFile } from '../../scripts/schema';

test('schema/state.schema.json is generated from the Zod schema (run `bun run schema`)', () => {
  expect(readFileSync(schemaFile, 'utf8')).toBe(render());
});
