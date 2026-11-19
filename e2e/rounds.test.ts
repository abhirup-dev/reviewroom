// Finishing rounds and handing the feedback to the agent.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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
  const { tmp, repo, reviews: localReviews, cli, git, spawn } = setup();
  const reviews = path.dirname(localReviews);
  const pull = path.join(reviews, 'acme_api', 'pulls', '32');
  const old = path.join(reviews, 'acme-api');
  const legacy = path.join(old, 'pr-32');
  const headLegacy = path.join(old, 'old-head');
  const changed = path.join(reviews, 'acme_api', 'pulls', '34');
  const inRepo = ['--repo', repo];
  const quiet = ['--no-open', '--port', '0'];
  const id = 'acme/api#32';
  const url = 'https://example.invalid/acme/api/pull/32';
  const run = (args: string[]) => cli([...args, ...inRepo]);
  const config = (dir: string, cfg: object) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  const legacyCases = [[legacy, 32, undefined], [headLegacy, 33, 'https://example.invalid/acme/api/pull/33']] as const;
  const asLegacy = ([dir, number, url]: typeof legacyCases[number]) => config(dir, { ...JSON.parse(read(dir, 'config.json')), number, url });

  test('resolves PR and local targets and keeps one server through feedback and approval', async () => {
    try {
      await git('remote', 'add', 'origin', path.join(tmp, 'acme', 'api.git'));
      const mirror = path.join(tmp, 'other', 'api.git');
      fs.mkdirSync(path.dirname(mirror), { recursive: true });
      await git('init', '--bare', mirror);
      await git('remote', 'add', 'mirror', mirror);
      await git('push', 'mirror', 'feat/upload-rate-limit:refs/pull/35/head', 'main:refs/heads/main');
      for (const branch of ['pr-32', 'old-head', '32/topic', 'pr-33']) await git('branch', branch, 'feat/upload-rate-limit');

      // Present a live branch folder as a pre-upgrade PR review with a pending server.
      const oldServer = await run(['pr', 'pr-32', ...quiet]);
      expect(oldServer.code).toBe(0);
      asLegacy(legacyCases[0]);
      expect(await run(['pr', '32', ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining(`stop it first: reviewroom stop ${id}`) });
      expect(fs.existsSync(pull)).toBe(false);
      expect((await cli(['stop', id])).stdout).toStartWith('stopped server');

      const started = await cli(['start', id, ...quiet]);
      expect(started.code).toBe(0);
      const u = started.stdout.trim();
      const meta = await fetch(u + 'api/meta');
      expect(await meta.json()).toMatchObject({ prReviewId: id });
      const hub = (await cli(['hub', 'serve', '--detach', ...quiet])).stdout.trim();
      const { sessions } = await fetch(hub + 'api/sessions').then((r) => r.json());
      expect(sessions).toContainEqual(expect.objectContaining({ reviewPath: pull, prReviewId: id }));
      const pid = meta.headers.get('x-reviewroom-pid');
      expect(pid).toBeString();
      expect(fs.existsSync(legacy)).toBe(false);
      expect(JSON.parse(read(pull, 'config.json')).id).toBe(id);

      expect((await run(['pr', 'old-head', ...quiet])).code).toBe(0);
      await run(['stop', 'old-head']);
      asLegacy(legacyCases[1]);
      const adopted = await run(['pr', '33', '--base', 'main', ...quiet]);
      expect(adopted).toMatchObject({ code: 0, stderr: expect.stringContaining('reviewroom wait acme/api#33') });
      expect(fs.existsSync(headLegacy)).toBe(false);

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
        [['pr-32', ...inRepo], legacy, undefined],
        [['32/topic', ...inRepo], path.join(old, '32-topic'), undefined],
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
      expect((await cli(['pr', id, ...quiet])).stdout.trim()).toBe(u);

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
      const state = JSON.parse(read(pull, 'state.json'));
      expect(state.rounds.map((r: { deliveredAt: string | null }) => r.deliveredAt)).toEqual([expect.any(String), expect.any(String)]);
      expect((await fetch(u + 'api/meta')).headers.get('x-reviewroom-pid')).toBe(pid);
      const saved = read(pull, 'config.json');
      try {
        config(pull, { ...JSON.parse(saved), id: 'acme/api#34' });
        expect((await fetch(u + 'api/meta')).status).toBe(409);
      } finally {
        fs.writeFileSync(path.join(pull, 'config.json'), saved);
      }
    } finally {
      for (const target of [id, 'acme/api#33', 'pr-32', 'old-head', '32/topic']) await run(['stop', target]);
      await cli(['stop', 'other/api#35']);
      await cli(['hub', 'stop']);
    }
  });
});
