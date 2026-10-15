import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { render, schemaFile } from '../../scripts/schema';
import { StoredState } from './schema';
import { emptyState } from '../core/types';

test('schema/state.schema.json is generated from the Zod schema (run `bun run schema`)', () => {
  expect(readFileSync(schemaFile, 'utf8')).toBe(render());
});

test('state.json: a fresh review, older files and unknown keys pass; wrong shapes fail', () => {
  expect(StoredState.safeParse(emptyState()).success).toBe(true);
  // older files: no viewed/pins, rounds without deliveredAt, keys this version doesn't know
  expect(StoredState.safeParse({ version: 1, round: 1, rounds: [{ n: 1, status: 'sent', startedAt: 'x' }], threads: [], future: true }).success).toBe(true);
  expect(StoredState.safeParse({ version: 1, round: 'two', rounds: [], threads: [] }).success).toBe(false);
  expect(StoredState.safeParse({ version: 1, round: 1, rounds: [], threads: [{ id: 't', status: 'open', createdRound: 1, messages: [], anchor: { kind: 'code', path: 'a' } }] }).success).toBe(false);
});
