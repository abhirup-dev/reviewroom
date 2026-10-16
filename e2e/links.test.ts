// Stale links: fingerprint, head moves 2 lines, check reports, --fix heals; a server fingerprints at the current head.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup, until } from './fixture.ts';

describe('links', () => {
  const { repo, dir, d, cli, git, state, spawn } = setup();
  const reviewFile = path.join(dir, 'review.html');
  const prepend = (lines: string) => fs.writeFileSync(path.join(repo, file), lines + read(repo, file));
  let file = '';
  beforeAll(async () => (file = (await git('diff', '--name-only', '--diff-filter=d', 'main...feat/habit-events')).text().split('\n')[0]));

  test('check fingerprints a new link and reports a broken section link', async () => {
    fs.writeFileSync(reviewFile, `<rr-review><section id="s"><a href="rr:code/${file}#L3-4">x</a> <a href="rr:sym/RecentEvents">y</a> <a href="rr:doc/nope">z</a></section></rr-review>`);
    expect(await cli(['check', ...d])).toMatchObject({ code: 1, stdout: expect.stringContaining('rr:doc/nope') });
    expect(state().links[`rr:code/${file}#L3-4`]).toBeString();
  });
  test('check reports a link whose code moved', async () => {
    fs.writeFileSync(reviewFile, read(reviewFile).replace(' <a href="rr:doc/nope">z</a>', ''));
    prepend('added 1\nadded 2\n');
    await git('commit', '-qam', 'shift');
    expect(await cli(['check', ...d])).toMatchObject({ code: 1, stdout: expect.stringMatching(/moved[^]*#L5-6/) });
  });
  test('check --fix rewrites the moved link and re-fingerprints it', async () => {
    expect((await cli(['check', '--fix', ...d])).code).toBe(0);
    expect(read(reviewFile)).toContain(`rr:code/${file}#L5-6"`);
    expect(Object.keys(state().links)).toEqual([`rr:code/${file}#L5-6`, 'rr:sym/RecentEvents']);
  });
  test('a running server fingerprints new links at the current head, not the one it started on', async () => {
    spawn(['review', '--forever', '--no-open', '--port', '0', ...d]);
    await until(() => fs.existsSync(path.join(dir, 'server.json')));
    prepend('added 3\n');
    await git('commit', '-qam', 'shift again');
    fs.writeFileSync(reviewFile, `<rr-review><a href="rr:code/${file}#L6-7">x</a></rr-review>`);
    await until(() => state().links[`rr:code/${file}#L6-7`]);
    expect(await cli(['check', ...d])).toMatchObject({ code: 0, stdout: expect.not.stringContaining('moved') });
  });
});
