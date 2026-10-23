// GitHub side of a PR review: read the PR's human comment threads and post to them, through GitHub's
// GraphQL API (Octokit) as the `gh` CLI's logged-in user (no token ever reaches the browser). GitHub stays the source
// of truth: nothing here is written to state.json, only cached in github.json for the CLI.
//
// New comments go into the viewer's pending review (GitHub's own drafts, also visible on github.com)
// until submitted; replies and PR conversation comments post at once.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/core';
import { paginateGraphQL } from '@octokit/plugin-paginate-graphql';
import { retry } from '@octokit/plugin-retry';
import type { IssueComment, Maybe, PullRequest, PullRequestCommit, PullRequestReview, PullRequestReviewComment, Query, Mutation } from '@octokit/graphql-schema';
import fs from 'node:fs';
import path from 'node:path';
import { anchorOf } from '../../src/kernel/refs/refs.shared.ts';
import type { Provider } from './git.ts';
import type { ReviewConfig } from './config.ts';
import type { CiCommit, CiState, GitHubComment, GitHubSnapshot, Message, Thread } from '../../src/kernel/state/model.shared.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import type { GitHubAction } from '../../src/kernel/state/schema.shared.ts';
import { fail } from './args.ts';

// GitHub's own GraphQL types: they describe every field, PR_QUERY decides which are fetched.
type Connection<T> = { nodes?: Maybe<Maybe<T>[]> } | null | undefined;
const list = <T>(c: Connection<T>) => (c?.nodes ?? []).filter((x): x is T => x != null);
export type PrTarget = { host: string; owner: string; name: string; number: number };
/** What the server keeps and serves: the snapshot plus the PR's node id for mutations. */
export type Snapshot = GitHubSnapshot & { pr?: string };
type GitHubThread = Thread & { gh: NonNullable<Thread['gh']>; messages: (Message & { gh: GitHubComment })[] };

/** The last fetched GitHub threads of a review dir (the CLI reads them; only the server fetches). */
export function cachedThreads(dir: string): Thread[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'github.json'), 'utf8')).threads ?? [];
  } catch {
    return [];
  }
}

/** Which PR a review is about: from config.url (any GitHub host), else repo + number. */
export function prTarget(cfg: Partial<ReviewConfig>): PrTarget | null {
  // config.json is hand-editable: a non-string url/repo must mean "no PR", not a crash
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
  const m = String(cfg.url || '').match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { host: m[1], owner: m[2], name: m[3], number: +m[4] };
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
  const r = String(cfg.repo || '').match(/^([\w.-]+)\/([\w.-]+)$/);
  return r && cfg.number ? { host: 'github.com', owner: r[1], name: r[2], number: +cfg.number } : null;
}

const execFileP = promisify(execFile);
const GH = Octokit.plugin(paginateGraphQL, retry);
const clients = new Map<string, Promise<InstanceType<typeof GH>>>();
// github.com and GHE.com (Enterprise Cloud) serve the API on api.<host>; GitHub Enterprise Server on <host>/api/v3
const apiUrl = (host: string) => (host === 'github.com' || host.endsWith('.ghe.com') ? `https://api.${host}` : `https://${host}/api/v3`);
/** An Octokit for `host` with gh's token (`gh auth token`): no login of our own, the token stays in this process. */
function client(cwd: string, host: string) {
  let c = clients.get(host);
  if (!c) {
    c = execFileP('gh', ['auth', 'token', '--hostname', host], { cwd, timeout: 10_000 }).then(
      ({ stdout }) => {
        // one retry a second later: GitHub's 5xx and "Something went wrong" (e.g. the PR query right after a review is deleted)
        const gh = new GH({ auth: stdout.trim(), baseUrl: apiUrl(host), retry: { retries: 1 } });
        gh.hook.before('request', (o) => void (o.request = { ...o.request, signal: AbortSignal.timeout(30_000) })); // per request, also per page
        return gh;
      },
      (e) => {
        throw new Error(e.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : String(e.stderr || e.message).trim().split('\n')[0], { cause: e });
      },
    );
    c.catch(() => clients.delete(host)); // a failed lookup (gh not logged in yet) is retried next time
    clients.set(host, c);
  }
  return c;
}

/** GraphQL as gh's user; `paginate` follows the one connection with `pageInfo` (variable `$cursor`). Rejects with GitHub's own error text. */
export async function gql<T extends object>(cwd: string, host: string, query: string, variables: Record<string, unknown> = {}, { paginate = false } = {}): Promise<T> {
  try {
    const c = await client(cwd, host); // a failed `gh auth token` is a GitHub problem too (502)
    if (query.startsWith('mutation')) variables = { ...variables, request: { retries: 0 } }; // never twice: it may have landed
    return await (paginate ? c.graphql.paginate<T>(query, variables) : c.graphql<T>(query, variables));
  } catch (err) {
    const e = err as Error & { status?: number; errors?: { message: string }[] }; // Octokit's RequestError / GraphqlResponseError
    if (e.status === 401) clients.delete(host); // token revoked or rotated: ask gh again next time
    throw new ReviewroomError(e.errors?.length ? e.errors.map((x) => x.message).join('; ') : e.message, 502, { cause: err });
  }
}

const AUTHOR = 'author { login avatarUrl }';
const COMMENT = `id databaseId body createdAt url viewerCanUpdate viewerCanDelete ${AUTHOR}`;
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id url headRefOid body createdAt ${AUTHOR}
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line startLine diffSide startDiffSide originalLine originalStartLine subjectType
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 100) { nodes { ${COMMENT} state pullRequestReview { id } } }
        }
      }
      reviews(last: 100) { nodes { id databaseId body state createdAt url viewerCanUpdate ${AUTHOR} } }
      commits(last: 30) { nodes { commit { oid abbreviatedOid messageHeadline committedDate url statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

// the conversation is its own query: a pagination follows one connection, and "newest guided walkthrough wins" needs them all
const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } } }
  }
}`;

/** Fetch everything and normalize. shortcut: reviews stop at the last 100, page them if a PR ever has more. */
export async function fetchPr(cwd: string, t: PrTarget, localHead: string | null) {
  const vars = { owner: t.owner, name: t.name, number: t.number };
  const [data, conv] = await Promise.all([gql<Pick<Query, 'viewer' | 'repository'>>(cwd, t.host, PR_QUERY, vars, { paginate: true }), gql<Pick<Query, 'repository'>>(cwd, t.host, COMMENTS_QUERY, vars, { paginate: true })]);
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`PR #${t.number} not found in ${t.owner}/${t.name}`);
  return normalize({ ...pr, comments: conv.repository?.pullRequest?.comments ?? pr.comments }, data.viewer.login, localHead);
}

const VERDICT: Record<string, string | undefined> = { APPROVED: '**Approved**', CHANGES_REQUESTED: '**Requested changes**', DISMISSED: '_Review dismissed_' };

/** GitHub's GraphQL shape -> reviewroom threads (ids `gh_<databaseId>`, never stored in state.json). Pure, for tests. */
export function normalize(pr: PullRequest, viewer: string, localHead: string | null) {
  const msg = (c: IssueComment | PullRequestReviewComment | PullRequestReview, kind: GitHubComment['kind']): Message & { gh: GitHubComment } => ({
    id: `gh_${c.databaseId}`,
    author: 'github',
    round: 0,
    body: c.body,
    at: c.createdAt,
    gh: { kind, node: c.id, login: c.author?.login ?? 'ghost', avatar: c.author?.avatarUrl, url: c.url, pending: ('state' in c && c.state === 'PENDING') || undefined, mine: c.author?.login === viewer, canEdit: c.viewerCanUpdate, canDelete: kind !== 'review-body' && c.viewerCanDelete } // no mutation deletes a review's body,
  });
  const threads: GitHubThread[] = list(pr.reviewThreads)
    .filter((t) => list(t.comments).length)
    .map((t): GitHubThread => {
      const comments = list(t.comments);
      const line = t.line ?? t.originalLine ?? 1;
      return {
        id: `gh_${comments[0].databaseId}`,
        anchor: { kind: 'code', path: t.path, rev: t.diffSide === 'LEFT' ? 'base' : 'head', start: (t.line ? t.startLine : t.originalStartLine) ?? line, end: line },
        status: t.isResolved ? 'resolved' : 'open',
        createdRound: 0,
        messages: comments.map((c) => msg(c, 'review')),
        // no current line: the code moved on (outdated) or the comment is on the whole file
        gh: { node: t.id, url: comments[0].url, outdated: t.line == null && t.subjectType !== 'FILE', file: t.subjectType === 'FILE', canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve, canReply: t.viewerCanReply },
      };
    });
  const reviews = list(pr.reviews).filter((r) => r.state !== 'PENDING');
  const conversation = [
    ...list(pr.comments).map((c) => msg(c, 'issue')),
    ...reviews.filter((r) => r.body?.trim() || VERDICT[r.state]).map((r) => ({ ...msg(r, 'review-body'), body: [VERDICT[r.state], r.body?.trim()].filter(Boolean).join('\n\n') })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (conversation.length)
    threads.push({ id: 'gh_conversation', title: 'PR conversation', anchor: { kind: 'general' }, status: 'open', createdRound: 0, messages: conversation, gh: { node: pr.id, url: pr.url, conversation: true, canReply: true } });
  const pending = list(pr.reviews).find((r) => r.state === 'PENDING');
  const drafts = threads.flatMap((t) => t.messages).filter((m) => m.gh.pending).length;
  return { ok: true as const, viewer, url: pr.url, pr: pr.id, headSha: pr.headRefOid, localHead, stale: !!localHead && pr.headRefOid !== localHead, pending: pending ? { id: pending.id, drafts } : null, description: { body: pr.body ?? '', login: pr.author?.login ?? 'ghost', avatar: pr.author?.avatarUrl, at: pr.createdAt }, threads, ci: ciOf(list(pr.commits)) };
}

const CHECK: Record<string, CiState | undefined> = { SUCCESS: 'success', NEUTRAL: 'success', SKIPPED: 'success', PENDING: 'pending', EXPECTED: 'pending' };

/** The PR's commits with their checks, newest first: GitHub Actions and any CI that reports a commit status (Jenkins, TeamCity, ...). */
export function ciOf(commits: PullRequestCommit[]): CiCommit[] {
  return commits
    .map(({ commit: c }) => {
      const checks = list(c.statusCheckRollup?.contexts).map((x): CiCommit['checks'][number] =>
        'context' in x // a StatusContext (Jenkins, ...); else a CheckRun (GitHub Actions)
          ? { name: x.context, state: CHECK[x.state] ?? 'failure', url: x.targetUrl }
          : { name: [x.checkSuite?.workflowRun?.workflow.name, x.name].filter(Boolean).join(' / '), state: x.status !== 'COMPLETED' ? 'pending' : (CHECK[x.conclusion!] ?? 'failure'), url: x.detailsUrl },
      );
      // running wins over failed: the commit isn't done yet
      const state: CiState = !checks.length ? 'none' : checks.some((x) => x.state === 'pending') ? 'pending' : checks.some((x) => x.state === 'failure') ? 'failure' : 'success';
      return { sha: c.oid, short: c.abbreviatedOid, title: c.messageHeadline, at: c.committedDate, url: c.url, state, checks };
    })
    .reverse();
}

/** rr: links mean nothing on github.com: code links become blob links at the reviewed commit, the rest plain text. */
export function toGitHubMarkdown(body: string, t: PrTarget, shas: { base: string; head: string }) {
  const pr = `https://${t.host}/${t.owner}/${t.name}/pull/${t.number}`;
  return body.replace(/(!?)\[([^\]]*)\]\((rr:[^)\s]+)\)/g, (_m, _bang, label: string, ref: string) => {
    // a link to a GitHub thread keeps pointing at it there
    const gh = ref.match(/^rr:thread\/gh_(\d+|conversation)$/);
    if (gh) return `[${label || 'thread'}](${gh[1] === 'conversation' ? pr : `${pr}#discussion_r${gh[1]}`})`;
    const a = anchorOf(ref);
    if (a.kind !== 'code') return label;
    const sha = a.rev === 'base' ? shas.base : shas.head;
    return `[${label || a.path}](https://${t.host}/${t.owner}/${t.name}/blob/${sha}/${a.path.split('/').map(encodeURIComponent).join('/')}#L${a.start}${a.end !== a.start ? `-L${a.end}` : ''})`;
  });
}

const M = {
  startReview: 'mutation($pr: ID!, $commit: GitObjectID) { addPullRequestReview(input: {pullRequestId: $pr, commitOID: $commit}) { pullRequestReview { id } } }',
  thread: 'mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body}) { thread { id } } }',
  reply: 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }',
  comment: 'mutation($pr: ID!, $body: String!) { addComment(input: {subjectId: $pr, body: $body}) { clientMutationId } }',
  'edit:review': 'mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) { clientMutationId } }',
  'edit:issue': 'mutation($id: ID!, $body: String!) { updateIssueComment(input: {id: $id, body: $body}) { clientMutationId } }',
  'edit:review-body': 'mutation($id: ID!, $body: String!) { updatePullRequestReview(input: {pullRequestReviewId: $id, body: $body}) { clientMutationId } }',
  'delete:review': 'mutation($id: ID!) { deletePullRequestReviewComment(input: {id: $id}) { clientMutationId } }',
  'delete:issue': 'mutation($id: ID!) { deleteIssueComment(input: {id: $id}) { clientMutationId } }',
  resolve: 'mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { clientMutationId } }',
  unresolve: 'mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { clientMutationId } }',
  submit: 'mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { clientMutationId } }',
  review: 'mutation($pr: ID!, $commit: GitObjectID, $event: PullRequestReviewEvent!, $body: String) { addPullRequestReview(input: {pullRequestId: $pr, commitOID: $commit, event: $event, body: $body}) { clientMutationId } }',
  discard: 'mutation($review: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId } }',
} as const;

const EVENT = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' } as const;
type Live = Snapshot & { ok: true; pr: string; headSha: string };
const live = (s: Snapshot | null): s is Live => !!s?.ok && !!s.pr && !!s.headSha;

/** Per-server GitHub link: cached snapshot (also written to <dir>/github.json), refresh, actions. */
export function makeGitHub({ repo, dir, cfg, prov, onChange }: { repo: string; dir: string; cfg: ReviewConfig; prov: Provider; onChange?: (snap: Snapshot) => void }) {
  const target = prTarget(cfg);
  const localHead = /^[0-9a-f]{40}$/.test(prov.head) ? prov.head : null;
  const file = path.join(dir, 'github.json');
  let snap: Snapshot | null = null;
  let inflight: Promise<Snapshot> | null = null;
  try {
    snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  const refresh = (): Promise<Snapshot> =>
    (inflight ??= (async () => {
      try {
        if (!target) return (snap = { ok: false, threads: [], error: 'not a GitHub pull request' });
        snap = { ...(await fetchPr(repo, target, localHead)), at: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(snap, null, 2));
      } catch (e) {
        // keep showing the last good threads; say why they may be old
        snap = { ...(snap?.ok ? snap : { ok: false, threads: [] }), error: (e as Error).message };
      } finally {
        inflight = null;
      }
      onChange?.(snap);
      return snap;
    })());

  // a failed action may still have changed something (a half-made review): refetch either way
  const act = (a: GitHubAction) => perform(a).then(refresh, async (e) => { await refresh(); throw e; });
  async function perform(a: GitHubAction) {
    if (!target) throw new ReviewroomError('this review is not about a GitHub pull request', 400);
    const s = live(snap) ? snap : await refresh();
    if (!live(s)) throw new ReviewroomError(s.error || 'GitHub is not reachable', 502);
    const run = (query: string, vars: Record<string, unknown>) => gql<Mutation>(repo, target.host, query, vars);
    const md = (body: string) => toGitHubMarkdown(body, target, { base: prov.base, head: localHead || s.headSha });
    const thread = (id: string) => s.threads.find((t) => t.id === id)?.gh?.node ?? fail(`no GitHub thread ${id}`, 404);
    const comment = (id: string) => s.threads.flatMap((t) => t.messages).find((m) => m.id === id)?.gh ?? fail(`no GitHub comment ${id}`, 404);
    switch (a.action) {
      case 'comment': {
        // a new line comment: a draft in the viewer's pending review (started on the commit being reviewed)
        const an = a.anchor;
        const review = s.pending?.id ?? (await run(M.startReview, { pr: s.pr, commit: localHead })).addPullRequestReview?.pullRequestReview?.id;
        const side = an.rev === 'base' ? 'LEFT' : 'RIGHT';
        const multi = an.start < an.end;
        const r = await run(M.thread, { review, path: an.path, line: an.end, side, startLine: multi ? an.start : null, startSide: multi ? side : null, body: md(a.body) });
        // GitHub answers a line outside the diff with no thread and no error
        if (!r.addPullRequestReviewThread?.thread) {
          if (!s.pending) await run(M.discard, { review }).catch(() => {});
          fail(`GitHub only takes comments on lines in the PR's diff (changed lines and the few around them); ${an.path}:${an.end} is not one`, 422);
        }
        return;
      }
      case 'reply':
        return void (await run(M.reply, { thread: thread(a.thread), body: md(a.body) }));
      case 'conversation':
        return void (await run(M.comment, { pr: s.pr, body: md(a.body) }));
      case 'edit': {
        const c = comment(a.message);
        if (!c.canEdit || !Object.hasOwn(M, `edit:${c.kind}`)) fail('you cannot edit that comment', 403); // github.json is a cache: check the kind
        return void (await run(M[`edit:${c.kind}`], { id: c.node, body: md(a.body) }));
      }
      case 'delete': {
        const c = comment(a.message);
        if (!c.canDelete || c.kind === 'review-body' || !Object.hasOwn(M, `delete:${c.kind}`)) fail('you cannot delete that comment', 403);
        return void (await run(M[`delete:${c.kind}`], { id: c.node }));
      }
      case 'resolve':
        return void (await run(a.resolved ? M.resolve : M.unresolve, { thread: thread(a.thread) }));
      case 'submit': {
        const vars = { event: EVENT[a.event], body: a.body?.trim() ? md(a.body.trim()) : null };
        return void (await (s.pending ? run(M.submit, { review: s.pending.id, ...vars }) : run(M.review, { pr: s.pr, commit: localHead, ...vars })));
      }
      case 'discard':
        if (s.pending) await run(M.discard, { review: s.pending.id });
    }
  }

  return { target, cached: () => snap, snapshot: () => snap ?? refresh(), refresh, act };
}

/** The viewer's own newest PR conversation comment containing `marker` (someone else's is never theirs to update). */
export const ownMarked = (s: Pick<GitHubSnapshot, 'threads'>, marker: string) =>
  s.threads.find((t) => t.gh?.conversation)?.messages.findLast((m) => m.gh?.kind === 'issue' && m.gh.mine && m.body.includes(marker));

/** Post `body` to the PR conversation, or update the viewer's comment carrying `marker` in place; the comment's URL.
 */
export async function upsertComment(cwd: string, t: PrTarget, marker: string, body: string) {
  const s = await fetchPr(cwd, t, null);
  const mine = ownMarked(s, marker);
  if (mine?.gh) {
    const r = await gql<Mutation>(cwd, t.host, 'mutation($id: ID!, $body: String!) { updateIssueComment(input: {id: $id, body: $body}) { issueComment { url } } }', { id: mine.gh.node, body });
    return r.updateIssueComment?.issueComment?.url ?? mine.gh.url;
  }
  const r = await gql<Mutation>(cwd, t.host, 'mutation($pr: ID!, $body: String!) { addComment(input: {subjectId: $pr, body: $body}) { commentEdge { node { url } } } }', { pr: s.pr, body });
  return r.addComment?.commentEdge?.node?.url ?? s.url;
}
