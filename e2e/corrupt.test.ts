// A corrupt state.json is kept aside, never replaced by an empty review.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';

describe('corrupt state', () => {
  const { dir, d, cli } = setup();
  const state = path.join(dir, 'state.json');
  const corrupt = () => fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  const fails = async (args: string[], stderr: RegExp) => {
    const r = await cli([...args, ...d]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(stderr);
  };

  test('corrupt state.json is preserved as .corrupt-* and not overwritten', async () => {
    fs.writeFileSync(state, '{"threads": [ broken');
    await fails(['reply', 't_one', 'x'], /not valid JSON/);
    expect(corrupt().map((f) => read(dir, f))).toEqual([expect.stringContaining('broken')]);
    expect(fs.existsSync(state)).toBe(false);
  });
  test('a state.json that breaks the schema is preserved as .corrupt-* with the reason', async () => {
    for (const f of corrupt()) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(state, JSON.stringify({ version: 1, round: 'two', rounds: [], threads: [] }));
    await fails(['reply', 't_one', 'x'], /does not match schema.*round/);
    expect([corrupt().length, fs.existsSync(state)]).toEqual([1, false]);
  });
  test('after a state.json is moved aside, writes stay blocked instead of starting an empty review', async () => {
    await fails(['comment', 'general', 'after'], /moved aside/);
    expect(fs.existsSync(state)).toBe(false);
  });
});
