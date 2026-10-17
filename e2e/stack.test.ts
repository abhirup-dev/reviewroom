// A review of a stack of PRs: one review dir for the stack, its layers served, found from any of its branches.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { Commit, ReviewMeta } from '../src/core/types.ts';
import { op, post, read, stackSetup, until } from './fixture.ts';

describe('a stacked review', () => {
  const { repo, dir, d, cli, git, ready, state, sessions } = stackSetup();
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
    expect((await (await fetch(url + `api/patch?base=${l.base}&head=${l.head}`)).text()).match(/^diff --git .*$/gm)).toEqual(['diff --git a/cache/cache.go b/cache/cache.go']);
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

  test('walkthrough publish --dry-run: one comment per PR with chapters; a chapter on a PR outside the stack is flagged', async () => {
    const ch = (id: string, pr?: number) => ({ id, title: id, ...(pr && { pr }), steps: [{ id: 's1', text: '<p>See <a href="rr:code/cache/cache.go@pr:2#L1">the cache</a>.</p>' }, { id: 's2', text: '<p>More.</p>' }] });
    fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify({ version: 1, title: 'T', chapters: [ch('intro'), ch('one', 1), ch('two', 2), ch('three', 3)] }));
    const r = await cli(['walkthrough', 'publish', '--dry-run', ...d]);
    expect([r.code, [...r.stdout.matchAll(/^--- PR #(\d+)$/gm)].map((m) => m[1])]).toEqual([0, ['1', '2', '3']]);
    expect((await cli(['walkthrough', 'publish', '--dry-run', '--pr', '3', ...d])).stdout.match(/^--- PR #\d+$/gm)).toEqual(['--- PR #3']);
    // #3 changes store/store.go too; its chapter shows only cache.go
    expect((await cli(['check', '--json', ...d])).stdout).toMatch(/PR #3's chapters: [^"]*store\/store\.go/);
    fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify({ version: 1, title: 'T', chapters: [ch('x', 9), ch('y', 2)] }));
    expect((await cli(['check', '--json', ...d])).stdout).toContain("PR #9 is not in this review's stack");
    fs.rmSync(path.join(dir, 'walkthrough.json'));
  });

  test('one session for the stack, with its PRs; the hub lists it once; summary and status per PR', async () => {
    const [rec] = sessions();
    expect([rec.number, rec.stack.id, rec.stack.prs.map((p: { number: number }) => p.number)]).toEqual([2, 1, [1, 2, 3]]);
    const hub = (await cli(['hub', '--detach', '--no-open', '--port', '0'])).stdout.trim();
    try {
      const list = await until(async () => {
        const all = (await (await fetch(hub + 'api/sessions')).json()).sessions.filter((x: { tool: string }) => x.tool === 'reviewroom');
        return all.length && all[0].health === 'ok' && all;
      });
      expect(list.map((x: { target: string; stack: unknown[] }) => [x.target, x.stack.length])).toEqual([['#1..#3 (3 PRs)', 3]]);
    } finally {
      await cli(['hub', '--stop']);
    }
    const summary = await (await fetch(url + 'api/summary')).json();
    expect(Object.keys(summary.byPr)).toEqual(['1', '2', '3']);
    expect(summary.byPr['1'].threads).toBe(1); // the layer thread from the feedback test
    const status = JSON.parse((await cli(['status', '--json', ...d])).stdout);
    expect(status.stack.map((l: { number: number }) => l.number)).toEqual([1, 2, 3]);
    expect((await cli(['status', ...d])).stdout).toContain('stack of 3 PRs (#1..#3)');
  });

  test('status on any branch of the stack finds its review', async () => {
    for (const b of ['stack-1', 'stack-3']) {
      await git('checkout', '-q', b);
      const r = await cli(['status', '--json', '--repo', repo]);
      expect(JSON.parse(r.stdout).dir).toBe(dir);
    }
  });
});
