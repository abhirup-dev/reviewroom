import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { render, schemaFile } from '../../scripts/schema';
import { StoredState } from './schema';

test('schema/state.schema.json is generated from the Zod schema (run `bun run schema`)', () => {
  expect(readFileSync(schemaFile, 'utf8')).toBe(render());
});

test('state.json: older files and unknown keys pass', () => {
  // older files: no viewed/pins, rounds without deliveredAt, keys this version doesn't know
  expect(StoredState.safeParse({ version: 1, round: 1, rounds: [{ n: 1, status: 'sent', startedAt: 'x' }], threads: [], future: true }).success).toBe(true);
});
