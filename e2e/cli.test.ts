// CLI surface: strict flags, resolve without a body, pr without a target.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredThread } from '../src/shared/schema.ts';
import { read, setup } from './fixture.ts';

describe('cli', () => {
  const { tmp, repo, d, cli, state, spawn, url } = setup();
  let thread = '';
  beforeAll(async () => (thread = (await cli(['comment', 'general', 'why?', ...d])).stdout.trim()));

  test('an unknown flag is an error (exit 2)', async () => expect(await cli(['status', '--jsn', ...d])).toMatchObject({ code: 2, stderr: expect.stringContaining('--jsn') }));
  test('reply --resolve without a body resolves the thread', async () => {
    expect((await cli(['reply', thread, '--resolve', ...d])).code).toBe(0);
    expect(state().threads.find((t: StoredThread) => t.id === thread).status).toBe('resolved');
  });
  test('pr without a target scaffolds from --base/--head and serves', async () => {
    const local = path.join(tmp, 'local-review');
    spawn(['pr', '--base', 'main', '--head', 'feat/habit-events', '--no-open', '--port', '0', '--repo', repo, '--dir', local]);
    expect((await fetch((await url(local)) + 'api/meta')).ok && fs.existsSync(path.join(local, 'review.html'))).toBe(true);
    expect(JSON.parse(read(local, 'config.json')).head).toBe('feat/habit-events');
  });
});
