import { REPORT_FILE } from '../src/kernel/state/files.shared.ts';
// Stale links through the CLI and a running server; the move/fix logic is in cli/lib/links.test.ts.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';
import { until } from '../src/testing/wait.ts';
import { reviewEvents } from './transport.ts';

describe('links', () => {
  const { repo, dir, d, cli, git, state } = setup();
  const reviewFile = path.join(dir, REPORT_FILE);
  const prepend = (lines: string) => fs.writeFileSync(path.join(repo, file), lines + read(repo, file));
  let file = '';
  beforeAll(async () => (file = (await git('diff', '--name-only', '--diff-filter=d', 'main...feat/upload-rate-limit')).text().split('\n')[0]));

  test('check fingerprints a new link and reports a broken section link', async () => {
    fs.writeFileSync(reviewFile, `<rr-review><section id="s"><a href="rr:code/${file}#L3-4">x</a> <a href="rr:sym/Take">y</a> <a href="rr:doc/nope">z</a></section></rr-review>`);
    expect(await cli(['check', ...d])).toMatchObject({ code: 1, stdout: expect.stringContaining('rr:doc/nope') });
    expect(state().links[`rr:code/${file}#L3-4`]).toBeString();
  });
  test('a running server fingerprints new links at the current head, not the one it started on', async () => {
    const start = await cli(['start', '--no-open', '--port', '0', ...d]);
    expect(start.code).toBe(0);
    const url = start.stdout.trim();
    prepend('added 3\n');
    await git('commit', '-qam', 'shift again');
    fs.writeFileSync(reviewFile, `<rr-review><a href="rr:code/${file}#L6-7">x</a></rr-review>`);
    await until(() => state().links[`rr:code/${file}#L6-7`]);
    expect(await cli(['check', ...d])).toMatchObject({ code: 0, stdout: expect.not.stringContaining('moved') });

    const revision = async () => {
      const stream = await reviewEvents(url);
      try {
        const { hash } = JSON.parse((await stream.find('hello')).data);
        const { head } = await fetch(url + 'api/meta').then((r) => r.json());
        return { hash, head };
      } finally { await stream.close(); }
    };
    const before = await revision();
    const report = read(reviewFile);
    expect((await cli(['stop', ...d])).code).toBe(0);
    expect(await cli(['start', '--no-open', '--port', new URL(url).port, ...d])).toMatchObject({ code: 0, stdout: start.stdout });
    const after = await revision();
    expect(read(reviewFile)).toBe(report);
    expect(after.head).not.toBe(before.head);
    expect(after.hash).not.toBe(before.hash);
  });
});
