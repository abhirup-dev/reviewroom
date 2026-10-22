import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bodyCandidates, detectStack, localStack, MAX_STACK, type Member, type Query } from './stack.ts';

// Shaped like GitHub's answers for the two real stacks this was built on (moj-features-airflow #364..#371, a native
// stack; tardis-feature-service-sdk #148 merged, #149 retargeted to main), with names and text made up.
const T = { host: 'github.com', owner: 'o', name: 'r', number: 0 };
const pr = (number: number, base: string, head: string, over: Partial<Member> = {}): Member => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', baseRefName: base, headRefName: head, headRefOid: String(number).padStart(40, '0'),
  additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, author: { login: 'dev' }, body: '', ...over,
});

/** A fake GitHub over `prs`; `native` is the stack field of every PR; requests are counted. */
function github(prs: Member[], native: unknown = null) {
  const calls: string[] = [];
  const by = (n: number) => prs.find((p) => p.number === n) ?? null;
  const q = (async (query: string, vars: Record<string, unknown> = {}) => {
    calls.push(query);
    if (query.includes('headRefName: $ref') || query.includes('baseRefName: $ref')) {
      const field = query.includes('headRefName: $ref') ? 'headRefName' : 'baseRefName';
      return { repository: { pullRequests: { nodes: prs.filter((p) => p[field] === vars.ref && p.state !== 'CLOSED') } } };
    }
    if (query.includes('$number')) return { repository: { defaultBranchRef: { name: 'main' }, pullRequest: by(vars.number as number) && { ...by(vars.number as number), stack: native } } };
    return { repository: Object.fromEntries([...query.matchAll(/p(\d+): pullRequest/g)].map((m) => { const { body: _, ...p } = by(+m[1])!; return [`p${m[1]}`, p]; })) };
  }) as Query;
  return { q, calls };
}
const nums = (s: Awaited<ReturnType<typeof detectStack>>) => s && [s.source, s.id, s.prs.map((p) => p.number)];
const never = () => false;

test('a native stack: its entries in position order, fetched in one query', async () => {
  const prs = [364, 366, 367, 368].map((n, i, a) => pr(n, i ? `b${a[i - 1]}` : 'main', `b${n}`, { state: 'MERGED' }));
  const native = { number: 372, baseRefName: 'main', entries: { nodes: [3, 1, 4, 2].map((position) => ({ position, pullRequest: { number: prs[position - 1].number } })) } };
  const { q, calls } = github(prs, native);
  const s = await detectStack({ ...T, number: 367 }, q, never);
  expect(nums(s)).toEqual(['native', 372, [364, 366, 367, 368]]);
  expect(s!.base).toBe('main');
  expect(s!.prs[0]).not.toHaveProperty('body');
  expect(calls.length).toBe(2);
});

test('no native stack: the branch chain, up to the default branch and down while there is one child', async () => {
  const prs = [pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c'), pr(4, 'c', 'd'), pr(5, 'c', 'e'), pr(9, 'x', 'y')];
  const { q } = github(prs);
  // #3 has two children (#4, #5): a fork, so the stack ends at #3
  expect(nums(await detectStack({ ...T, number: 2 }, q, never))).toEqual(['chain', 1, [1, 2, 3]]);
  // a base no PR heads (a long-lived branch) ends the walk; alone, it is no stack
  expect(await detectStack({ ...T, number: 9 }, q, never)).toBeNull();
});

test('branches that cycle stop, and a stack is capped', async () => {
  const { q } = github([pr(1, 'b', 'a'), pr(2, 'a', 'b')]);
  expect(nums(await detectStack({ ...T, number: 1 }, q, never))).toEqual(['chain', 2, [2, 1]]);
  const long = Array.from({ length: 30 }, (_, i) => pr(i + 1, i ? `h${i}` : 'main', `h${i + 1}`));
  expect((await detectStack({ ...T, number: 1 }, github(long).q, never))!.prs.length).toBe(MAX_STACK);
});

test('retargeted after the PR below merged: the description names it, git ancestry confirms it', async () => {
  // #149 says "stacked on #148"; #148 merged and #149 now merges into main. #150 is named but is not below it.
  const prs = [pr(148, 'main', 'client', { state: 'MERGED' }), pr(149, 'main', 'kind', { body: 'Two changes, stacked on #148:\n\nsee also #150' }), pr(150, 'main', 'other'), pr(151, 'kind', 'top')];
  const below = new Set([`${prs[0].headRefOid}<${prs[1].headRefOid}`]);
  const s = await detectStack({ ...T, number: 149 }, github(prs).q, (a, b) => below.has(`${a}<${b}`));
  expect(nums(s)).toEqual(['body', 148, [148, 149, 151]]);
  expect(s!.prs[0].state).toBe('MERGED');
  // the same description, but #148's head is not in #149's history: no stack
  expect(nums(await detectStack({ ...T, number: 149 }, github(prs.slice(0, 3)).q, never))).toBeNull();
  // a named number GitHub errors on (an issue): skipped, the rest still found
  const { q } = github([prs[0], { ...prs[1], body: 'Stacked on top of PR #12. Based on #148' }, ...prs.slice(2)]);
  const issue: Query = (query, vars) => (vars?.number === 12 ? Promise.reject(new Error('Could not resolve to a PullRequest')) : q(query, vars));
  expect(nums(await detectStack({ ...T, number: 149 }, issue, (a, b) => below.has(`${a}<${b}`)))).toEqual(['body', 148, [148, 149, 151]]);
});

test('a stack list names several PRs: the nearest one below is the parent', async () => {
  const prs = [pr(1, 'main', 'a', { state: 'MERGED' }), pr(2, 'main', 'b', { state: 'MERGED' }), pr(3, 'main', 'c', { body: 'Stack:\n- #3 \u2b05\n- #2\n- #1\n\nmore text #77' })];
  const order = [1, 2, 3].map((n) => prs[n - 1].headRefOid);
  const anc = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
  expect(nums(await detectStack({ ...T, number: 3 }, github(prs).q, anc))).toEqual(['body', 1, [1, 2, 3]]);
});

test('description markers: phrases, PR links and stack lists, not every #N', () => {
  expect(bodyCandidates('Part 2/7, stacked on #366:\n#364 a\n \u2514\u2500 #366 b', 367)).toEqual([366]);
  expect(bodyCandidates('Depends on https://github.com/o/r/pull/12 and fixes #4', 13)).toEqual([12]);
  expect(bodyCandidates('Stacked on top of PR #5. Based on #6', 7)).toEqual([5, 6]);
  expect(bodyCandidates('<!-- branch-stack -->\n- #8\n- #9\n<!-- /branch-stack -->\nrefs #1', 9)).toEqual([8]);
  expect(bodyCandidates('**Current dependencies on/for this PR:**\n* **#20**\n  * **#21** \u{1f448}', 21)).toEqual([20]);
  expect(bodyCandidates('Closes #3', 4)).toEqual([]);
});

test('not a stack: an old merged PR of a long-lived branch, a branch of the same name in a fork, a branch PRs are cut from', async () => {
  // develop -> main merged long ago, develop moved on since: a PR into develop is not stacked on it
  const release = pr(10, 'main', 'develop', { state: 'MERGED' });
  const feature = pr(11, 'develop', 'feat', { baseRefOid: 'f'.repeat(40) });
  expect(await detectStack({ ...T, number: 11 }, github([release, feature]).q, never)).toBeNull();
  // ...but merged with its branch where it was merged (not deleted yet): still the PR below
  expect(nums(await detectStack({ ...T, number: 11 }, github([release, { ...feature, baseRefOid: release.headRefOid }]).q, never))).toEqual(['chain', 10, [10, 11]]);
  // someone:develop, a fork's branch, is not this repo's develop
  expect(await detectStack({ ...T, number: 11 }, github([{ ...release, state: 'OPEN', isCrossRepository: true }, feature]).q, never)).toBeNull();
  // develop open into main with two open PRs into it: neither is stacked on it
  expect(await detectStack({ ...T, number: 11 }, github([{ ...release, state: 'OPEN' }, feature, pr(12, 'develop', 'feat2')]).q, never)).toBeNull();
  // a PR merged into this one's branch is in it already, not a layer on top
  expect(nums(await detectStack({ ...T, number: 2 }, github([pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c', { state: 'MERGED' })]).q, never))).toEqual(['chain', 1, [1, 2]]);
});

test('a local stack of plain branches: one layer per branch tip on the top branch\'s first-parent path', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-local-stack-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  const commit = (m: string) => g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m);
  commit('base');
  for (const [b, ms] of [['one', ['1a', '1b']], ['two', ['2a']]] as const) {
    g('switch', '-q', '-c', b);
    ms.forEach(commit);
  }
  g('branch', 'aside'); // another name on two's tip: one layer, named once
  g('switch', '-q', '-c', 'three');
  commit('3a');
  g('switch', '-q', 'main');
  commit('main moved on');
  expect(localStack(repo, 'three', 'main')?.map((p) => [p.number, p.headLabel])).toEqual([[1, 'one'], [2, 'aside'], [3, 'three']]);
  expect(localStack(repo, 'one', 'main')).toBeNull();
  fs.rmSync(repo, { recursive: true, force: true });
});
