// Finishing rounds and handing the feedback to the agent.
import { describe, expect, test } from 'bun:test';
import { op, post, read, setup } from './fixture.ts';

describe('a round finished while no agent waits', () => {
  const { d, cli, serve, state } = setup();
  test('one finish wins and wait delivers queued feedback', async () => {
    const url = await serve();
    await op(url, { op: 'createThread', id: 't_one', anchor: { kind: 'general' }, msgId: 'm_one', body: 'why?', author: 'you' });
    await op(url, { op: 'addMessage', threadId: 't_one', id: 'm_two', body: 'and?', author: 'you' });
    const outcomes = await Promise.all([1, 2].map(() => post(url + 'api/finish', { kind: 'feedback', round: 1 })));
    expect(outcomes.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);

    const late = await cli(['wait', '--no-open', ...d]);
    expect(late.code).toBe(0);
    expect(late.stdout).toContain('t_one');
    expect(late.stdout).toContain('and?');
    expect(late.stdout).toContain('`reviewroom wait feat/upload-rate-limit`');
    expect(state().rounds[0].deliveredAt).toBeString();
    expect((await fetch(url + 'api/meta')).ok).toBe(true);
  });
});

describe('the external agent round loop', () => {
  const { tmp, repo, cli, spawn, state, addPullRemote } = setup();

  test('wait delivers feedback and approval on the same PR server', async () => {
    const { id, dir } = await addPullRemote();
    const start = await cli(['pr', id, '--repo', repo, '--no-open', '--port', '0']);
    const url = start.stdout.trim();
    expect(start.code).toBe(0);
    try {
      const pid = (await fetch(url + 'api/meta')).headers.get('x-reviewroom-pid');
      expect(pid).toBeString();
      for (const [round, kind, target] of [
        [1, 'feedback', [id]],
        [2, 'approve', ['--dir', dir]],
      ] as const) {
        const waiter = spawn(['wait', '--no-open', ...target], tmp);
        const stderr = waiter.stderr.getReader();
        try {
          expect(new TextDecoder().decode((await stderr.read()).value)).toContain(`waiting for feedback | ${dir} | ${url}`);
        } finally { stderr.releaseLock(); }

        expect((await post(url + 'api/finish', { kind, round, note: 'Check the edge case' })).status).toBe(200);
        const feedback = await new Response(waiter.stdout).text();
        expect(await waiter.exited).toBe(0);
        expect(feedback).toBe(read(dir, 'rounds', String(round), 'feedback.md') + '\n');
        expect(feedback).toContain(kind === 'approve' ? 'APPROVED' : `reviewroom wait ${id}`);
        expect(state(dir).rounds[round - 1].deliveredAt).toBeString();
        expect((await fetch(url + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid);
      }
    } finally { await cli(['stop', id]); }
  });
});
