// A corrupt state.json is kept aside, never replaced by an empty review.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { setup } from './fixture.ts';
import { REVIEW_FILES, reviewStore } from '../cli/lib/review-store.ts';

describe('corrupt state', () => {
  const { dir, d, cli } = setup();
  const state = reviewStore(dir).state.file;
  const corrupt = () => fs.readdirSync(dir).filter((f) => f.startsWith(`${REVIEW_FILES.state.name}.corrupt-`));
  const fails = async (args: string[], stderr: RegExp) => {
    const r = await cli([args[0], ...d, ...args.slice(1)]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(stderr);
  };

  test('a state.json that breaks the schema is kept aside with the reason, and writes stay blocked', async () => {
    fs.writeFileSync(state, JSON.stringify({ version: 1, round: 'two', rounds: [], threads: [] }));
    await fails(['reply', 't_one', 'x'], /does not match schema.*round/);
    expect([corrupt().length, fs.existsSync(state)]).toEqual([1, false]);
    await fails(['comment', 'general', 'after'], /moved aside/);
    expect(fs.existsSync(state)).toBe(false);
  });
});
