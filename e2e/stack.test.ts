// A review of a stack of PRs: one review dir for the stack, its layers served, found from any of its branches.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Commit, ReviewMeta } from '../src/core/types.ts';
import { op, post, read, stackSetup, until } from './fixture.ts';

describe('a stacked review', () => {
  const { repo, dir, d, cli, git, ready, state } = stackSetup();
  let url = '';
  beforeAll(async () => {
    await ready;
    url = (await cli(['pr', '--detach', '--no-open', '--port', '0', ...d])).stdout.trim();
  });

  test('meta has the stack, bottom first; each commit its PR; each layer its own files', async () => {
    const meta: ReviewMeta = await (await fetch(url + 'api/meta')).json();
    expect(meta.stack!.map((p) => [p.number, p.state, p.files])).toEqual([[1, 'merged', 1], [2, 'open', 1], [3, 'open', 2]]);
    expect(meta.stack![1].base).toBe(meta.stack![0].head);
    const commits: Commit[] = await (await fetch(url + 'api/commits')).json();
    expect(commits.map((c) => c.pr)).toEqual([1, 1, 2, 2, 3]);
    const l = meta.stack![1];
    expect((await (await fetch(url + `api/files?base=${l.base}&head=${l.head}`)).json()).map((f: { path: string }) => f.path)).toEqual(['cache/cache.go']);
  });

  test("feedback quotes a layer's thread at that layer's lines", async () => {
    // line 10 of store.go at #1's head; #3 has since split it over three lines
    await op(url, { op: 'createThread', id: 't_l1', anchor: { kind: 'code', path: 'store/store.go', rev: 'head', start: 10, end: 10, pr: 1 }, msgId: 'm_l1', body: 'why not ok?', author: 'you' });
    expect((await post(url + 'api/finish', { kind: 'feedback', round: 1 })).status).toBe(200);
    const md = read(dir, 'rounds', '1', 'feedback.md');
    expect(md).toContain('store/store.go:10 (#1, new/head side)');
    expect(md).toContain('  10  func (s *Store) Get(k string) string { return s.m[k] }');
  });

  test('a push to #2 and a restack of #3 between rounds: the round records them, the agent hears of them', async () => {
    await git('checkout', '-q', 'stack-2');
    await git('commit', '-q', '--allow-empty', '-m', 'cache: answer review');
    await git('rebase', '-q', 'stack-2', 'stack-3');
    url = (await cli(['pr', '--detach', '--no-open', '--port', '0', ...d])).stdout.trim();
    const [r1, r2] = await until(() => state().rounds[1].heads && state().rounds.map((r: { heads: Record<string, string> }) => r.heads));
    expect(Object.keys(r2)).toEqual(['base', 'head', '#1', '#2', '#3']);
    expect(['#1', '#2', '#3', 'base'].map((k) => r1[k] === r2[k])).toEqual([true, false, false, true]);
    const log = read(dir, 'server.log');
    expect(log).toMatch(/since round 1:\n {2}#2: 1 new commit \([0-9a-f]{7}\.\.[0-9a-f]{7}\)\n {2}#3: rewritten[^\n]*git range-diff[^\n]*\n +1: +[0-9a-f]+ = 1: +[0-9a-f]+ cache: Forget/);
    expect((await post(url + 'api/finish', { kind: 'feedback', round: 2 })).status).toBe(200);
    expect(read(dir, 'rounds', '2', 'feedback.md')).toContain('## The stack since round 1 (what the reviewer saw this round)\n\n```\n#2: 1 new commit');
  });

  test('status on any branch of the stack finds its review', async () => {
    for (const b of ['stack-1', 'stack-3']) {
      await git('checkout', '-q', b);
      const r = await cli(['status', '--json', '--repo', repo]);
      expect(JSON.parse(r.stdout).dir).toBe(dir);
    }
  });
});
