import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState } from './state.ts';

test('an older state.json reads with the defaults filled in and unknown keys kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-state-'));
  const thread = { id: 't', status: 'open', createdRound: 1, anchor: { kind: 'general' }, messages: [], future: 1 };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: 'x' }], threads: [thread], extra: true }));
  const s = readState(dir);
  expect([s.pins, s.viewed]).toEqual([[], {}]); // the client calls state.pins.includes()
  expect(s).toMatchObject({ extra: true, threads: [{ future: 1 }] });
});
