// No server: CLI writes take state.lock; a dead holder's lock is stale.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredThread } from '../src/kernel/state/schema.shared.ts';
import { setup } from './fixture.ts';

describe('lock', () => {
  const { dir, d, cli, state } = setup();

  test('concurrent CLI writes both land (stale lock taken over, then released)', async () => {
    fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: 999999, port: null }));
    const rs = await Promise.all([cli(['comment', 'general', 'one', ...d]), cli(['comment', 'general', 'two', ...d])]);
    expect([rs.map((r) => r.code), state().threads.map((t: StoredThread) => t.messages[0].body).sort(), fs.existsSync(path.join(dir, 'state.lock'))]).toEqual([[0, 0], ['one', 'two'], false]);
  });
});
