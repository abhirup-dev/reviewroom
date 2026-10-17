// Bare commands find the review (and its server) without --dir; stop releases everything.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture.ts';

describe('discovery', () => {
  const { repo, reviews, dir, d, cli, serve, git, sessions } = setup();
  let thread = '';
  beforeAll(async () => {
    await serve();
    thread = (await cli(['comment', 'general', 'why?', ...d])).stdout.trim();
    await git('checkout', '-q', 'main');
  });

  test('bare `threads` on another branch finds the only review', async () => expect((await cli(['status', '--threads', '--all', '--repo', repo])).stdout).toContain(thread));
  test('bare `threads` with several reviews asks for --dir', async () => {
    fs.mkdirSync(path.join(reviews, 'other'));
    fs.writeFileSync(path.join(reviews, 'other', 'review.html'), '<rr-review></rr-review>');
    expect(await cli(['status', '--threads', '--repo', repo])).toMatchObject({ code: 1, stderr: expect.stringContaining('--dir') });
  });
  test('stop finds and stops the server and releases the lock', async () => {
    await git('checkout', '-q', 'feat/habit-events');
    expect((await cli(['stop', ...d])).stdout).toStartWith('stopped');
    expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(false);
  });
  test('a stopped server leaves the session registry', () => expect(sessions()).toEqual([]));
});
