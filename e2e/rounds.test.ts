// Finishing rounds and handing the feedback to the agent.
import { beforeAll, describe, expect, test } from 'bun:test';
import { op, post, read, setup } from './fixture.ts';

describe('a round finished while no agent waits', () => {
  const { d, cli, serve, state } = setup();
  let url = '';
  let late: Awaited<ReturnType<typeof cli>>;
  beforeAll(async () => {
    url = await serve();
    await op(url, { op: 'createThread', id: 't_one', anchor: { kind: 'general' }, msgId: 'm_one', body: 'why?', author: 'you' });
    await op(url, { op: 'addMessage', threadId: 't_one', id: 'm_two', body: 'and?', author: 'you' });
  });

  test('double finish: one wins, the other gets 409', async () => {
    const rs = await Promise.all([post(url + 'api/finish', { kind: 'feedback', round: 1 }), post(url + 'api/finish', { kind: 'feedback', round: 1 })]);
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });
  test('review prints feedback sent while no agent was waiting', async () => {
    late = await cli(['review', '--no-open', ...d]);
    expect([late.code, late.stdout]).toEqual([0, expect.stringMatching(/t_one[^]*and\?/)]);
  });
  test('delivery recorded; the running server kept running', async () => {
    expect(state().rounds[0].deliveredAt).toBeString();
    expect((await fetch(url + 'api/meta')).ok).toBe(true);
  });
  // git may report the repo via /private/var on macOS
  test('feedback names the review dir in the commands it asks for', () => expect(late.stdout).toMatch(/--dir '[^']*\/\.reviewroom\/feat-habit-events'/));
});

describe('the blocking round loop', () => {
  const { dir, d, cli, state, url } = setup();

  // review waits, reviewer comments, agent replies, reviewer sends
  test('blocked review prints the round with the agent reply in it', async () => {
    const waiting = cli(['review', '--no-open', '--port', '0', ...d]);
    const u = await url();
    await op(u, { op: 'createThread', id: 't_loop', anchor: { kind: 'code', path: 'x.go', rev: 'head', start: 1, end: 2 }, msgId: 'm_l1', body: 'rename this', author: 'you' });
    await cli(['reply', 't_loop', 'renamed', ...d]);
    await op(u, { op: 'addMessage', threadId: 't_loop', id: 'm_l3', body: 'thanks, one more', author: 'you' });
    expect((await post(u + 'api/finish', { kind: 'feedback', round: 1 })).status).toBe(200);
    const loop = await waiting;
    expect(loop).toMatchObject({ code: 0, stdout: expect.stringMatching(/t_loop[^]*renamed[^]*thanks, one more/) });
  });
  test('feedback.md saved and delivery recorded', () => {
    expect(read(dir, 'rounds', '1', 'feedback.md')).toContain('thanks, one more');
    expect(state().rounds[0].deliveredAt).toBeString();
  });
});
