// A PR's stack: the chain of PRs it sits in, each PR's base the head of the PR below. Found, in order, from
// GitHub's native stack, the base/head branch chain, or (once a lower PR merged and this one was retargeted)
// markers in the PR description such as "stacked on #148", each checked by git ancestry.
import type { PrTarget } from './github.ts';
import { git } from './git.ts';

export type StackSource = 'native' | 'chain' | 'body' | 'local';
/** One PR as GitHub describes it (the fields MEMBER fetches). */
export type Member = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** the base branch's tip now (GitHub moves it with the branch) */
  baseRefOid?: string;
  /** its head is in a fork */
  isCrossRepository?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string } | null;
  body?: string;
};
/** Bottom first. id: the native stack's number, else the bottom PR's. base: the branch the bottom PR merges into. */
export type DetectedStack = { id: number; source: StackSource; base: string; prs: Member[] };
/** GraphQL against the PR's repository (`$owner`, `$name` are filled in). */
export type Query = <T extends object>(query: string, vars?: Record<string, unknown>) => Promise<T>;
/** Whether commit `a` is an ancestor of commit `b`, after fetching PR `n`'s head if needed. */
export type IsAncestor = (a: string, b: string, n: number) => boolean;

export const MAX_STACK = 20;
const MEMBER = 'number title url state baseRefName headRefName headRefOid baseRefOid isCrossRepository additions deletions changedFiles reviewDecision author { login }';
const NATIVE = `stack { number baseRefName entries(first: ${MAX_STACK}) { nodes { position pullRequest { number } } } }`;
const pr = (native: boolean) => `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { name }
  pullRequest(number: $number) { ${MEMBER} body ${native ? NATIVE : ''} }
} }`;
const byRef = (field: 'headRefName' | 'baseRefName') => `query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) {
  pullRequests(${field}: $ref, states: [OPEN, MERGED], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${MEMBER} body } }
} }`;
type Native = { number: number; baseRefName: string; entries: { nodes: { position: number; pullRequest: { number: number } }[] } } | null;
type PrData = { repository: { defaultBranchRef: { name: string } | null; pullRequest: (Member & { stack?: Native }) | null } };
type ListData = { repository: { pullRequests: { nodes: Member[] } } };

const MARKER = /\b(?:stacked\s+(?:on(?:\s+top\s+of)?|after)|depends\s+on|based\s+on|builds\s+on)\s*:?\s*(?:PR\s*)?(?:#|https?:\/\/\S+?\/pull\/)(\d+)/gi;
// stack lists written by tools: spr's "Stack:", "Current dependencies on/for this PR:", `<!-- branch-stack -->`; the list runs to a blank line
const LIST_HEAD = /^\W*(?:Stack|Current dependencies (?:on\/for|on|for) this PR)\W*$|<!--\s*branch-stack\s*-->/i;

/** The PR numbers a description names as what it is stacked on: markers first, then the PRs of a stack list. */
export function bodyCandidates(body: string, self: number): number[] {
  const out = [...body.matchAll(MARKER)].map((m) => +m[1]);
  const lines = body.split('\n');
  lines.forEach((l, i) => {
    if (!LIST_HEAD.test(l)) return;
    for (const x of lines.slice(i + 1)) {
      if (!x.trim() || /<!--\s*\/branch-stack/.test(x)) break;
      out.push(...[...x.matchAll(/#(\d+)/g)].map((m) => +m[1]));
    }
  });
  return [...new Set(out)].filter((n) => n !== self);
}

/** The stack `t` is in, or null when it is in none (or GitHub can't say). */
export async function detectStack(t: PrTarget, q: Query, isAncestor: IsAncestor): Promise<DetectedStack | null> {
  const one = async (number: number) => {
    // GitHub Enterprise Server may not have native stacks: ask again without them
    const d = await q<PrData>(pr(true), { number }).catch(() => q<PrData>(pr(false), { number }));
    return d.repository;
  };
  const repo = await one(t.number);
  const self = repo.pullRequest;
  if (!self) return null;
  const native = self.stack;
  if (native?.entries.nodes.length) {
    const order = [...native.entries.nodes].sort((a, b) => a.position - b.position).map((e) => e.pullRequest.number).slice(0, MAX_STACK);
    const prs = await members(q, order);
    return { id: native.number, source: 'native', base: native.baseRefName, prs };
  }
  const main = repo.defaultBranchRef?.name ?? 'main';
  const list = async (field: 'headRefName' | 'baseRefName', ref: string) => (await q<ListData>(byRef(field), { ref })).repository.pullRequests.nodes;
  const openKids = async (ref: string) => (await list('baseRefName', ref)).filter((p) => p.state === 'OPEN' && !p.isCrossRepository);
  const seen = new Set([self.number]);
  let source: StackSource = 'chain';
  // up: the PR whose head is this one's base; at the default branch (merged below, retargeted), the description
  const below: Member[] = [];
  let named: Member[] = []; // a stack list names the PRs further down too: they stay candidates
  for (let cur = self; below.length + 1 < MAX_STACK; ) {
    let parent: Member | undefined;
    if (cur.baseRefName !== main) {
      // same repo; merged only if its branch hasn't moved since (else a long-lived branch's old PR, e.g. develop -> main);
      // and this PR its only open child (several: a branch PRs are cut from, not a stack)
      const c = cur;
      const p = (await list('headRefName', c.baseRefName)).find((p) => !seen.has(p.number) && p.headRefName === c.baseRefName && !p.isCrossRepository && (p.state === 'OPEN' || p.headRefOid === c.baseRefOid));
      if (p && (await openKids(p.headRefName)).length === 1) parent = p;
    } else {
      const found = named.filter((p) => isAncestor(p.headRefOid, cur.headRefOid, p.number));
      for (const n of bodyCandidates(cur.body ?? '', cur.number).filter((n) => !seen.has(n))) {
        // "#12" can be an issue, or a PR we can't see: not a member, not a reason to give up
        const p = await one(n).then((r) => r.pullRequest, () => null);
        if (p && p.state !== 'CLOSED' && isAncestor(p.headRefOid, cur.headRefOid, p.number)) found.push(p);
      }
      // several named (a stack list): the nearest is the one every other is below
      parent = found.find((p) => found.every((o) => o === p || isAncestor(o.headRefOid, p.headRefOid, o.number)));
      if (parent) source = 'body';
      named = found.filter((p) => p !== parent);
    }
    if (!parent) break;
    seen.add(parent.number);
    below.unshift(parent);
    cur = parent;
  }
  // down: the open PR based on this one's head (a merged one is in this branch already); two children is a fork, not a
  // stack: stop there
  const above: Member[] = [];
  for (let cur = self; below.length + above.length + 1 < MAX_STACK; ) {
    const kids = (await openKids(cur.headRefName)).filter((p) => !seen.has(p.number));
    if (kids.length !== 1) break;
    seen.add(kids[0].number);
    above.push(kids[0]);
    cur = kids[0];
  }
  const prs = [...below, self, ...above];
  if (prs.length < 2) return null;
  return { id: prs[0].number, source, base: prs[0].baseRefName, prs };
}

/** Every PR of `numbers`, in that order, in one aliased query. */
async function members(q: Query, numbers: number[]): Promise<Member[]> {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${MEMBER} }`).join('\n');
  const d = await q<{ repository: Record<string, Member | null> }>(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`);
  return numbers.map((n) => d.repository[`p${n}`]).filter((m): m is Member => !!m);
}

/** A local stack of branches (no PRs needed): every local branch tip on `branch`'s first-parent path down to its
 *  merge-base with `base` ends a layer, bottom first; `branch` is the top. Null: no branch below it on that path. */
export function localStack(repo: string, branch: string, base: string): { number: number; title: string; state: 'open'; headLabel: string; head: string }[] | null {
  const head = git(['rev-parse', branch + '^{commit}'], repo).trim();
  const from = (git(['merge-base', base, head], repo, { soft: true }) || '').trim();
  const path = git(['rev-list', '--first-parent', '--reverse', from ? `${from}..${head}` : head], repo).split('\n').filter(Boolean);
  const tips = new Map<string, string>();
  for (const l of git(['for-each-ref', '--sort=refname', '--format=%(objectname) %(refname:short)', 'refs/heads'], repo).split('\n').filter(Boolean)) {
    const [sha, name] = l.split(' ');
    if (name !== branch && name !== base && !tips.has(sha)) tips.set(sha, name); // the first name, sorted, when a commit has several
  }
  tips.set(head, branch);
  const names = path.filter((c) => tips.has(c)).map((c) => tips.get(c)!);
  // numbered 1..n bottom first, not by any PR a branch has: a real PR's number could equal another layer's position
  return names.length < 2 ? null : names.map((name, i) => ({ number: i + 1, title: name, state: 'open', headLabel: name, head: name }));
}
