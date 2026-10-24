// State ops through a running server, racing CLI writes.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { StoredMessage } from '../src/kernel/state/schema.shared.ts';
import { op, read, setup } from './fixture.ts';

describe('ops', () => {
  const { dir, d, cli, serve, state } = setup();
  let url = '';
  beforeAll(async () => {
    url = await serve();
    await op(url, { op: 'createThread', id: 't_one', anchor: { kind: 'general' }, msgId: 'm_one', body: 'why?', author: 'you' });
  });

  test('server holds state.lock', () => expect(JSON.parse(read(dir, 'state.lock')).port).toBe(+new URL(url).port));
  // a CLI reply racing a stream of browser ops (spanning the CLI's whole run): everything must land
  test('concurrent CLI reply and browser ops all survive', async () => {
    const browserOps = async () => {
      const codes = [];
      for (let i = 0; i < 20; i++) codes.push((await op(url, { op: 'addMessage', threadId: 't_one', id: 'm_b' + i, body: i ? 'b' + i : 'and?', author: 'you' })).status);
      codes.push((await op(url, { op: 'setViewed', path: 'x.go', viewed: true })).status);
      return codes;
    };
    const [reply, codes] = await Promise.all([cli(['reply', 't_one', 'because', ...d]), browserOps()]);
    const s = state();
    expect([reply.code, codes.every((c) => c === 200), s.threads[0].messages.length, s.viewed['x.go']]).toEqual([0, true, 22, 1]);
    expect(s.threads[0].messages.some((m: StoredMessage) => m.body === 'because')).toBe(true);
  });
  test('rounds cannot be finished through /api/ops', async () => expect((await op(url, { op: 'finishRound', kind: 'feedback' })).status).toBe(400));
  test('reply --json answers several threads', async () => {
    const second = (await cli(['comment', 'general', 'fyi', ...d])).stdout.trim();
    const bulk = await cli(['reply', '--json', '-', ...d], JSON.stringify([{ thread: 't_one', body: 'bulk one' }, { thread: second, body: 'bulk two', resolve: true }]));
    expect([bulk.code, state().threads[0].messages.at(-1).body, state().threads[1].status]).toEqual([0, 'bulk one', 'resolved']);
  });
  test('reply --json is all-or-nothing', async () => {
    const before = state().threads[0].messages.length;
    const bad = await cli(['reply', '--json', '-', ...d], JSON.stringify([{ thread: 't_one', body: 'x' }, { thread: 't_missing', body: 'y' }]));
    expect(bad.code).not.toBe(0);
    expect(state().threads[0].messages).toHaveLength(before);
  });
});
