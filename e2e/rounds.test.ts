// Finishing rounds and handing the feedback to the agent.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { op, post, read, readJson, setup } from './fixture.ts';
import { reviewEvents } from './transport.ts';

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
  const { tmp, repo, reviews: localReviews, cli, git, spawn, state } = setup();
  const reviews = path.dirname(localReviews);
  const pull = path.join(reviews, 'acme_api', 'pulls', '32');
  const branchReviews = path.join(reviews, 'acme-api');
  const changed = path.join(reviews, 'acme_api', 'pulls', '34');
  const inRepo = ['--repo', repo];
  const quiet = ['--no-open', '--port', '0'];
  const id = 'acme/api#32';
  const url = 'https://example.invalid/acme/api/pull/32';
  const run = (args: string[]) => cli([...args, ...inRepo]);
  const config = (dir: string, cfg: object) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  const addPullRemote = async (remote: string, owner: string, number: number) => {
    const bare = path.join(tmp, owner, 'api.git');
    await git('init', '--bare', bare);
    await git('remote', 'add', remote, bare);
    await git('push', remote, `feat/upload-rate-limit:refs/pull/${number}/head`, 'main:refs/heads/main');
  };

  test('resolves PR and local targets and keeps one server through feedback and approval', async () => {
    try {
      await addPullRemote('origin', 'acme', 32);
      await addPullRemote('mirror', 'other', 35);
      for (const branch of ['pr-32', '32/topic']) await git('branch', branch, 'feat/upload-rate-limit');

      const started = await run(['pr', '32', ...quiet]);
      expect(started).toMatchObject({ code: 0, stderr: expect.stringContaining(`reviewroom wait ${id}`) });
      const u = started.stdout.trim();
      const meta = await fetch(u + 'api/meta');
      expect(await meta.json()).toMatchObject({ prReviewId: id });
      const hub = (await cli(['hub', 'serve', '--detach', ...quiet])).stdout.trim();
      const { sessions } = await fetch(hub + 'api/sessions').then((r) => r.json());
      expect(sessions).toContainEqual(expect.objectContaining({ reviewPath: pull, prReviewId: id }));
      const pid = meta.headers.get('x-reviewroom-pid');
      expect(pid).toBeString();
      expect(readJson(pull, 'config.json').id).toBe(id);

      for (const branch of ['pr-32', '32/topic']) expect((await run(['pr', branch, ...quiet])).code).toBe(0);
      const remoteCases = [
        [[id, '--remote', 'mirror', ...inRepo], { code: 1, stderr: expect.stringContaining('selected repository is other/api') }],
        [['35', '--remote', 'mirror', ...inRepo], { code: 0, stderr: expect.stringContaining('reviewroom wait other/api#35') }],
        [['other/api#35'], { code: 0, stderr: expect.stringContaining('reviewroom wait other/api#35') }],
      ] as const;
      for (const [args, expected] of remoteCases) {
        expect(await cli(['pr', ...args, '--base', 'main', ...quiet])).toMatchObject(expected);
      }
      const cases = [
        [[id], pull, id],
        [['#32', ...inRepo], pull, id],
        [['32', ...inRepo], pull, id],
        [[url, ...inRepo], pull, id],
        [['--dir', pull], pull, id],
        [['pr-32', ...inRepo], path.join(branchReviews, 'pr-32'), undefined],
        [['32/topic', ...inRepo], path.join(branchReviews, '32-topic'), undefined],
      ] as const;
      for (const [target, dir, expectedId] of cases) {
        const r = await cli(['status', '--json', ...target]);
        expect(r.code).toBe(0);
        const status = JSON.parse(r.stdout);
        expect(status.dir).toBe(dir);
        expect(status.id).toBe(expectedId);
        if (expectedId) expect(status.url).toBe(u);
      }
      expect(await run(['stop', 'https://example.invalid/other/api/pull/32'])).toMatchObject({ code: 1, stderr: expect.stringContaining('selected repository is acme/api') });
      expect(await run(['pr', 'pr-32', '--dir', pull, '--force', ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot use a branch target') });
      fs.mkdirSync(changed, { recursive: true });
      config(changed, { id, repoPath: repo });
      const before = read(changed, 'config.json');
      for (const [verb, args] of [['pr', ['--force']], ['start', []], ['wait', []]] as const) {
        expect(await cli([verb, 'acme/api#34', ...args, ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining('saved acme/api#32, folder expects acme/api#34') });
      }
      expect(fs.readdirSync(changed)).toEqual(['config.json']);
      expect(read(changed, 'config.json')).toBe(before);

      const wait = async (args: string[]) => {
        const p = spawn(['wait', '--no-open', ...args], tmp);
        const reader = p.stderr.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(`waiting for feedback | ${pull} | ${u}`);
        reader.releaseLock();
        return p;
      };
      const waiting = await wait([id]);
      await op(u, { op: 'createThread', id: 't_loop', anchor: { kind: 'code', path: 'x.go', rev: 'head', start: 1, end: 2 }, msgId: 'm_l1', body: 'rename this', author: 'you' });
      await cli(['reply', 't_loop', 'renamed', '--dir', pull]);
      await op(u, { op: 'addMessage', threadId: 't_loop', id: 'm_l3', body: 'thanks, one more', author: 'you' });
      expect((await post(u + 'api/finish', { kind: 'feedback', round: 1 })).status).toBe(200);
      const feedback = await new Response(waiting.stdout).text();
      expect(await waiting.exited).toBe(0);
      expect(feedback).toMatch(/t_loop[^]*renamed[^]*thanks, one more/);
      expect(feedback).toContain(`reviewroom wait ${id}`);
      expect(feedback).toBe(read(pull, 'rounds', '1', 'feedback.md') + '\n');
      const next = await wait(['--dir', pull]);
      expect((await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid); // case G
      expect((await post(u + 'api/finish', { kind: 'approve', round: 2 })).status).toBe(200);
      expect(await new Response(next.stdout).text()).toStartWith('# Review round 2: APPROVED');
      expect(await next.exited).toBe(0);
      expect(state(pull).rounds.map((r: { deliveredAt: string | null }) => r.deliveredAt)).toEqual([expect.any(String), expect.any(String)]);
      expect((await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid);
      const saved = read(pull, 'config.json');
      try {
        config(pull, { ...JSON.parse(saved), id: 'acme/api#34' });
        expect((await fetch(u + 'api/meta')).status).toBe(409);
      } finally {
        fs.writeFileSync(path.join(pull, 'config.json'), saved);
      }

      const helloHash = async () => {
        const stream = await reviewEvents(u);
        try {
          return JSON.parse((await stream.find('hello')).data).hash;
        } finally { await stream.close(); }
      };
      const hash = await helloHash();
      expect(hash).toBeString();
      const report = read(pull, 'report.html');
      await git('push', 'origin', '+main:refs/pull/32/head');
      expect((await cli(['pr', id, ...quiet])).stdout.trim()).toBe(u);
      expect(await fetch(u + 'api/patch').then((r) => r.text())).toContain('diff --git');
      expect((await cli(['stop', id])).code).toBe(0);
      expect(await cli(['pr', id, '--no-open', '--port', new URL(u).port])).toMatchObject({ code: 0, stdout: u + '\n' });
      expect(read(pull, 'report.html')).toBe(report);
      expect(await fetch(u + 'api/patch').then((r) => r.text())).toBe('');
      const newHash = await helloHash();
      expect(newHash).toBeString();
      expect(newHash).not.toBe(hash);
    } finally {
      for (const target of [id, 'pr-32', '32/topic']) await run(['stop', target]);
      await cli(['stop', 'other/api#35']);
      await cli(['hub', 'stop']);
    }
  });
});
