// The teaching demo (examples/uploads) must pass check and a full slide-lint without a warning: agents learn from it,
// and a warning sends an agent that answers feedback on it off to fix slides it never touched.
import { expect, test } from 'bun:test';
import { browser, setupSlides } from './fixture.ts';

const { d, cli } = setupSlides();

test('check finds nothing to warn about in the demo', async () => {
  const r = await cli(['check', ...d]);
  expect(r.stdout + r.stderr).not.toContain('warn ');
  expect(r.code).toBe(0);
});

test.skipIf(!browser)('the demo walkthrough passes a full slide-lint', async () => {
  const r = await cli(['slide-lint', ...d, '--jobs', '4']);
  expect(r.stdout + r.stderr).not.toContain('warn ');
  expect(r.code).toBe(0);
}, 60_000);
