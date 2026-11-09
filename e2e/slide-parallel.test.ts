import { beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture.ts';
import { auditReview, auditWalkthrough } from '../src/testing/slide-audit.ts';

const { dir, d, cli } = setup();
const demo = path.join(import.meta.dir, '../examples/habit-events');
beforeEach(() => {
  fs.copyFileSync(path.join(demo, 'walkthrough.json'), path.join(dir, 'walkthrough.json'));
  fs.copyFileSync(path.join(demo, 'review.html'), path.join(dir, 'review.html'));
});
const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
const lint = (args: string[]) => cli(['slide-lint', '--json', ...args, ...d]);
const outcome = (r: { code: number; stdout: string }) => {
  const { jobs: _jobs, ...report } = JSON.parse(r.stdout);
  return { code: r.code, report };
};

test('parallel lint rejects invalid worker counts before rendering', async () => {
  for (const n of ['0', '9', '2.5', 'many']) {
    const r = await lint(['--jobs', n]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--jobs: an integer from 1 to 8');
  }
});

test.skipIf(!browser)('full demo reports are identical with one, two and four workers', async () => {
  const serial = await lint([]);
  expect(serial.code).toBe(0);
  for (const jobs of [2, 4]) {
    const parallel = await lint(['--jobs', String(jobs)]);
    expect(JSON.parse(parallel.stdout).jobs).toBe(jobs);
    expect(outcome(parallel)).toEqual(outcome(serial));
  }
}, 30_000);

test.skipIf(!browser)('parallel workers preserve adversarial findings, ordering, startup errors and exit codes', async () => {
  fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify(auditWalkthrough));
  fs.writeFileSync(path.join(dir, 'review.html'), auditReview + '<script>throw new Error("parallel startup failure")</script>');
  const serial = await lint([]);
  expect(serial.code).toBe(1);
  for (const jobs of [2, 4]) expect(outcome(await lint(['--jobs', String(jobs)]))).toEqual(outcome(serial));
}, 30_000);

test.skipIf(!browser)('one viewport can split its slides across workers without changing findings', async () => {
  const args = ['--viewport', '1440x900'];
  expect(outcome(await lint([...args, '--jobs', '4']))).toEqual(outcome(await lint(args)));
}, 30_000);

test.skipIf(!browser)('parallel partial checks preserve context and cap workers at the selected work', async () => {
  for (const args of [['--chapter', 'latency'], ['--slide', 'latency/s2']]) {
    const serial = await lint(args), parallel = await lint([...args, '--jobs', '4']);
    expect(outcome(parallel)).toEqual(outcome(serial));
    expect(JSON.parse(parallel.stdout).jobs).toBe(args[0] === '--slide' ? 2 : 4);
  }
}, 30_000);
