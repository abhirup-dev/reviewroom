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
    late = await cli(['review', '--forever', '--no-open', ...d]);
    expect([late.code, late.stdout]).toEqual([0, expect.stringMatching(/t_one[^]*and\?/)]);
  });
  test('delivery recorded; the running server kept running', async () => {
    expect(state().rounds[0].deliveredAt).toBeString();
    expect((await fetch(url + 'api/meta')).ok).toBe(true);
  });
  test('feedback uses the review target for the next wait', () => expect(late.stdout).toContain('`reviewroom wait feat/upload-rate-limit`'));
});

describe('the external agent round loop', () => {
  const { dir, repo, d, cli, state, serve, spawn } = setup();

  test('pr serves through feedback and approval while wait delivers each round', async () => {
    const u = await serve();
    const pid = (await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid');
    expect(pid).toBeString();
    const wait = async (args: string[]) => {
      const p = spawn(['wait', '--no-open', ...args]);
      const reader = p.stderr.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(`waiting for feedback | ${dir} | ${u}`);
      reader.releaseLock();
      return p;
    };
    const waiting = await wait(['feat/upload-rate-limit', '--repo', repo]);
    await op(u, { op: 'createThread', id: 't_loop', anchor: { kind: 'code', path: 'x.go', rev: 'head', start: 1, end: 2 }, msgId: 'm_l1', body: 'rename this', author: 'you' });
    await cli(['reply', 't_loop', 'renamed', ...d]);
    await op(u, { op: 'addMessage', threadId: 't_loop', id: 'm_l3', body: 'thanks, one more', author: 'you' });
    expect((await post(u + 'api/finish', { kind: 'feedback', round: 1 })).status).toBe(200);
    const feedback = await new Response(waiting.stdout).text();
    expect(await waiting.exited).toBe(0);
    expect(feedback).toMatch(/t_loop[^]*renamed[^]*thanks, one more/);
    expect(feedback).toBe(read(dir, 'rounds', '1', 'feedback.md') + '\n');
    const next = await wait(d);
    expect((await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid); // case G: wait reused the existing server
    expect((await post(u + 'api/finish', { kind: 'approve', round: 2 })).status).toBe(200);
    expect(await new Response(next.stdout).text()).toStartWith('# Review round 2: APPROVED');
    expect(await next.exited).toBe(0);
    expect(state().rounds.map((r: { deliveredAt: string | null }) => r.deliveredAt)).toEqual([expect.any(String), expect.any(String)]);
    expect((await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid);
  });
});
