// Missing targets list candidates; explicit stop releases the server.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture.ts';

describe('discovery', () => {
  const { repo, dir, d, cli, serve, git, sessions } = setup();
  beforeAll(async () => {
    await serve();
    await cli(['comment', ...d, 'general', 'why?']);
    await git('checkout', '-q', 'main');
  });

  test('missing review lists explicit candidates', async () => {
    expect(await cli(['status', '--threads', '--repo', repo])).toMatchObject({ code: 1, stderr: expect.stringContaining(dir) });
  });
  test('stop finds and stops the server and releases the lock', async () => {
    await git('checkout', '-q', 'feat/upload-rate-limit');
    expect((await cli(['stop', ...d])).stdout).toStartWith('stopped');
    expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(false);
  });
  test('a stopped server leaves the session registry', () => expect(sessions()).toEqual([]));
});
