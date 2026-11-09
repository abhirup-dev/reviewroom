import { expect, test } from 'bun:test';
import { browser, setupSlides } from './fixture.ts';

const { d, cli } = setupSlides(true);
const lint = (args: string[]) => cli(['slide-lint', '--json', ...args, ...d]);
const outcome = (r: { code: number; stdout: string }) => {
  const { jobs: _jobs, ...report } = JSON.parse(r.stdout);
  return { code: r.code, report };
};

test.skipIf(!browser)('parallel workers preserve adversarial findings, ordering, startup errors and exit codes', async () => {
  const serial = await lint([]);
  expect(serial.code).toBe(1);
  for (const jobs of [2, 4]) expect(outcome(await lint(['--jobs', String(jobs)]))).toEqual(outcome(serial));
}, 30_000);
