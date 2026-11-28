// Finishing rounds and handing the feedback to the agent.
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { slideCases, writeSlideCase } from '../testing/slides/cases.ts';
import { field, op, post, read, setup } from './fixture.ts';
import { shellArg } from '../cli/lib/config.ts';
import { reviewStore } from '../cli/lib/review-store.ts';

describe('a round finished while no agent waits', () => {
  const { dir, d, cli, serve, state } = setup();
  test('one finish wins and wait delivers queued feedback', async () => {
    const url = await serve();
    await op(url, { op: 'createThread', id: 't_one', anchor: { kind: 'general' }, msgId: 'm_one', body: 'why?', author: 'you' });
    await op(url, { op: 'addMessage', threadId: 't_one', id: 'm_two', body: 'and?', author: 'you' });
    const outcomes = await Promise.all([1, 2].map(() => post(url + 'api/finish', { kind: 'feedback', round: 1 })));
    expect(outcomes.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);

    const late = await cli(['wait', ...d, '--no-open']);
    expect(late.code).toBe(0);
    expect(late.stdout).toContain('t_one');
    expect(late.stdout).toContain('and?');
    expect(late.stdout).toContain(`reviewroom wait ${shellArg(dir)}`);
    expect(state().rounds[0].deliveredAt).toBeString();
    expect((await fetch(url + 'api/meta')).ok).toBe(true);
  });
});

describe('a review closed while the agent waits', () => {
  const { dir, d, cli, spawn } = setup();
  test('wait exits 3 with REVIEW CLOSED; the next wait reopens it', async () => {
    const waiter = spawn(['wait', '--no-open', '--port', '0', ...d], dir);
    const stderr = waiter.stderr.getReader();
    try {
      expect(new TextDecoder().decode((await stderr.read()).value)).toContain('waiting for feedback');
    } finally { stderr.releaseLock(); }
    expect((await cli(['stop', ...d])).stdout).toContain('stopped server');
    const out = await new Response(waiter.stdout).text();
    expect(await waiter.exited).toBe(3);
    expect(out).toContain('REVIEW CLOSED');
    expect(reviewStore(dir).closed.exists()).toBe(true);

    expect((await cli(['start', ...d, '--no-open', '--port', '0'])).code).toBe(0);
    try {
      expect(reviewStore(dir).closed.exists()).toBe(false);
    } finally { await cli(['stop', ...d]); }
  });
});

describe('the external agent round loop', () => {
  const { tmp, repo, cli, spawn, state, addPullRemote } = setup();

  test('wait delivers feedback and approval on the same PR server', async () => {
    const { id, dir } = await addPullRemote();
    const start = await cli(['pr', id, '--repo', repo, '--no-open', '--port', '0']);
    const url = field(start.stdout, 'url');
    expect(await cli(['pr', id, '--force'])).toMatchObject({ code: 1, stdout: expect.stringContaining(`stop it first: reviewroom stop '${id}'`) });
    expect(start.code).toBe(0);
    try {
      const pid = (await fetch(url + 'api/meta')).headers.get('x-reviewroom-pid');
      expect(pid).toBeString();
      writeSlideCase(dir, slideCases.demo);
      const output = path.join(tmp, 'pull.html');
      expect(await cli(['export', id, '--out', output])).toEqual({ code: 0, stdout: output + '\n', stderr: '' });
      const bundle = /<script type="application\/json" id="rr-bundle">(.*?)<\/script>/s.exec(read(output))?.[1];
      expect(JSON.parse(bundle!).source).toMatchObject({ repo: 'demo/project', pr: 7 });
      for (const [round, kind, target] of [
        [1, 'feedback', [id]],
        [2, 'approve', [dir]],
      ] as const) {
        const waiter = spawn(['wait', '--no-open', ...target], tmp);
        const stderr = waiter.stderr.getReader();
        try {
          expect(new TextDecoder().decode((await stderr.read()).value)).toContain(`waiting for feedback | ${dir} | ${url}`);
        } finally { stderr.releaseLock(); }

        expect((await post(url + 'api/finish', { kind, round, note: 'Check the edge case' })).status).toBe(200);
        const feedback = await new Response(waiter.stdout).text();
        expect(await waiter.exited).toBe(0);
        expect(feedback).toBe(reviewStore(dir).round(round).feedback.read() + '\n');
        expect(feedback).toContain(kind === 'approve' ? 'APPROVED' : `reviewroom wait '${id}'`);
        expect(state(dir).rounds[round - 1].deliveredAt).toBeString();
        expect((await fetch(url + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid);
      }
    } finally { await cli(['stop', id]); }
  });
});
