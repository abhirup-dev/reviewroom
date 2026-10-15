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
import fs from 'node:fs';
import path from 'node:path';
import { parseAnchor } from './state.ts';
import type { Provider, ReviewConfig } from './git.ts';
import type { Anchor, CiCommit, CiState, GitHubComment, GitHubSnapshot, Message, Thread } from '../../src/core/types.ts';

// The parts of GitHub's GraphQL schema that PR_QUERY asks for (field names as in the query).
type Nodes<T> = { nodes: T[] };
type GhAuthor = { login: string; avatarUrl: string } | null;
interface GhComment {
  id: string;
  databaseId: number | null;
  body: string;
  createdAt: string;
  url: string;
  viewerCanUpdate?: boolean;
  viewerCanDelete?: boolean;
  author: GhAuthor;
  state?: string;
}
interface GhReviewThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  originalLine: number | null;
  originalStartLine: number | null;
  subjectType: 'LINE' | 'FILE';
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: Nodes<GhComment>;
}
interface GhReview extends GhComment {
  state: string;
}
type GhCheck =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null; detailsUrl: string | null; checkSuite: { workflowRun: { workflow: { name: string } } | null } | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null };
interface GhCommit {
  commit: { oid: string; abbreviatedOid: string; messageHeadline: string; committedDate: string; url: string; statusCheckRollup: { contexts: Nodes<GhCheck> } | null };
}
export interface GhPullRequest {
  id: string;
  url: string;
  headRefOid: string;
  body: string | null;
  createdAt: string;
  author: GhAuthor;
  reviewThreads: Nodes<GhReviewThread>;
  comments: Nodes<GhComment>;
  reviews: Nodes<GhReview>;
  commits?: Nodes<GhCommit>;
}
type PrQuery = { viewer: { login: string }; repository: { pullRequest: (GhPullRequest & { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } }) | null } | null };
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
const GH = Octokit.plugin(paginateGraphQL);
const clients = new Map<string, Promise<InstanceType<typeof GH>>>();
// github.com and GHE.com (Enterprise Cloud) serve the API on api.<host>; GitHub Enterprise Server on <host>/api/v3
const apiUrl = (host: string) => (host === 'github.com' || host.endsWith('.ghe.com') ? `https://api.${host}` : `https://${host}/api/v3`);
/** An Octokit for `host` with gh's token (`gh auth token`): no login of our own, the token stays in this process. */
function client(cwd: string, host: string) {
  let c = clients.get(host);
  if (!c) {
    c = execFileP('gh', ['auth', 'token', '--hostname', host], { cwd, timeout: 10_000 }).then(
      ({ stdout }) => {
        const gh = new GH({ auth: stdout.trim(), baseUrl: apiUrl(host) });
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
export async function gql<T extends object = any>(cwd: string, host: string, query: string, variables: Record<string, unknown> = {}, { paginate = false } = {}): Promise<T> {
  const c = await client(cwd, host);
  try {
    return await (paginate ? c.graphql.paginate<T>(query, variables) : c.graphql<T>(query, variables));
  } catch (e: any) {
    if (e.status === 401) clients.delete(host); // token revoked or rotated: ask gh again next time
    throw new Error(e.errors?.length ? e.errors.map((x: { message: string }) => x.message).join('; ') : e.message, { cause: e });
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
      comments(first: 100) { nodes { ${COMMENT} } }
      reviews(last: 100) { nodes { id databaseId body state createdAt url viewerCanUpdate ${AUTHOR} } }
      commits(last: 30) { nodes { commit { oid abbreviatedOid messageHeadline committedDate url statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

/** Fetch everything and normalize. shortcut: conversation comments and reviews stop at 100 each, page them if a PR ever has more. */
export async function fetchPr(cwd: string, t: PrTarget, localHead: string | null) {
  const data = await gql<PrQuery>(cwd, t.host, PR_QUERY, { owner: t.owner, name: t.name, number: t.number }, { paginate: true });
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`PR #${t.number} not found in ${t.owner}/${t.name}`);
  return normalize(pr, data.viewer.login, localHead);
}

const VERDICT: Record<string, string | undefined> = { APPROVED: '**Approved**', CHANGES_REQUESTED: '**Requested changes**', DISMISSED: '_Review dismissed_' };

/** GitHub's GraphQL shape -> reviewroom threads (ids `gh_<databaseId>`, never stored in state.json). Pure, for tests. */
export function normalize(pr: GhPullRequest, viewer: string, localHead: string | null) {
  const msg = (c: GhComment, kind: GitHubComment['kind']): Message & { gh: GitHubComment } => ({
    id: `gh_${c.databaseId}`,
    author: 'github',
    round: 0,
    body: c.body,
    at: c.createdAt,
    gh: { kind, node: c.id, login: c.author?.login ?? 'ghost', avatar: c.author?.avatarUrl, url: c.url, pending: c.state === 'PENDING' || undefined, mine: c.author?.login === viewer, canEdit: !!c.viewerCanUpdate, canDelete: !!c.viewerCanDelete },
  });
  const threads: GitHubThread[] = pr.reviewThreads.nodes
    .filter((t) => t.comments.nodes.length)
    .map((t): GitHubThread => {
      const line = t.line ?? t.originalLine ?? 1;
      return {
        id: `gh_${t.comments.nodes[0].databaseId}`,
        anchor: { kind: 'code', path: t.path, rev: t.diffSide === 'LEFT' ? 'base' : 'head', start: (t.line ? t.startLine : t.originalStartLine) ?? line, end: line },
        status: t.isResolved ? 'resolved' : 'open',
        createdRound: 0,
        messages: t.comments.nodes.map((c) => msg(c, 'review')),
        // no current line: the code moved on (outdated) or the comment is on the whole file
        gh: { node: t.id, url: t.comments.nodes[0].url, outdated: t.line == null && t.subjectType !== 'FILE', file: t.subjectType === 'FILE', canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve, canReply: t.viewerCanReply },
      };
    });
  const reviews = pr.reviews.nodes.filter((r) => r.state !== 'PENDING');
  const conversation = [
    ...pr.comments.nodes.map((c) => msg(c, 'issue')),
    ...reviews.filter((r) => r.body?.trim() || VERDICT[r.state]).map((r) => ({ ...msg(r, 'review-body'), body: [VERDICT[r.state], r.body?.trim()].filter(Boolean).join('\n\n') })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (conversation.length)
    threads.push({ id: 'gh_conversation', title: 'PR conversation', anchor: { kind: 'general' }, status: 'open', createdRound: 0, messages: conversation, gh: { node: pr.id, url: pr.url, conversation: true, canReply: true } });
  const pending = pr.reviews.nodes.find((r) => r.state === 'PENDING');
  const drafts = threads.flatMap((t) => t.messages).filter((m) => m.gh.pending).length;
  return { ok: true as const, viewer, url: pr.url, pr: pr.id, headSha: pr.headRefOid, localHead, stale: !!localHead && pr.headRefOid !== localHead, pending: pending ? { id: pending.id, drafts } : null, description: { body: pr.body ?? '', login: pr.author?.login ?? 'ghost', avatar: pr.author?.avatarUrl, at: pr.createdAt }, threads, ci: ciOf(pr.commits?.nodes ?? []) };
}

const CHECK: Record<string, CiState | undefined> = { SUCCESS: 'success', NEUTRAL: 'success', SKIPPED: 'success', PENDING: 'pending', EXPECTED: 'pending' };

/** The PR's commits with their checks, newest first: GitHub Actions and any CI that reports a commit status (Jenkins, TeamCity, …). */
export function ciOf(commits: GhCommit[]): CiCommit[] {
  return commits
    .map(({ commit: c }) => {
      const checks = (c.statusCheckRollup?.contexts.nodes ?? []).map((x): CiCommit['checks'][number] =>
        x.__typename === 'CheckRun'
          ? { name: [x.checkSuite?.workflowRun?.workflow.name, x.name].filter(Boolean).join(' / '), state: x.status !== 'COMPLETED' ? 'pending' : (CHECK[x.conclusion!] ?? 'failure'), url: x.detailsUrl }
          : { name: x.context, state: CHECK[x.state] ?? 'failure', url: x.targetUrl },
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
    const a = parseAnchor(ref);
    if (a.kind !== 'code') return label;
    const sha = a.rev === 'base' ? shas.base : shas.head;
    return `[${label || a.path}](https://${t.host}/${t.owner}/${t.name}/blob/${sha}/${a.path}#L${a.start}${a.end !== a.start ? `-L${a.end}` : ''})`;
  });
}

const M: Record<string, string | undefined> = {
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
};

class GitHubError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Per-server GitHub link: cached snapshot (also written to <dir>/github.json), refresh, actions. */
/** POST /api/github body. Untrusted: perform() checks every field it uses. */
export interface GitHubAction {
  action: string;
  body?: unknown;
  thread?: string;
  message?: string;
  anchor?: Anchor;
  resolved?: boolean;
  event?: string;
}

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
      } catch (e: any) {
        // keep showing the last good threads; say why they may be old
        snap = { ...(snap?.ok ? snap : { ok: false, threads: [] }), error: e.message };
      } finally {
        inflight = null;
      }
      onChange?.(snap);
      return snap;
    })());

  // a failed action may still have changed something (a half-made review): refetch either way
  const act = (a: GitHubAction) => perform(a).then(refresh, async (e) => { await refresh(); throw e; });
  async function perform(a: GitHubAction) {
    if (!target) throw new GitHubError('this review is not about a GitHub pull request', 400);
    if (!snap?.ok) await refresh();
    if (!snap?.ok) throw new GitHubError(snap?.error || 'GitHub is not reachable');
    // snap is re-read live below (a refresh may land between awaits); the checks above guarantee it
    const run = (name: string, vars: Record<string, unknown>) => gql(repo, target.host, M[name]!, vars).catch((e) => Promise.reject(new GitHubError(e.message)));
    const body = () => {
      if (typeof a.body !== 'string' || !a.body.trim()) throw new GitHubError('body must be a non-empty string', 400);
      return toGitHubMarkdown(a.body.trim(), target, { base: prov.base, head: localHead || snap!.headSha! });
    };
    const threadNode = () => snap!.threads.find((t) => t.id === a.thread)?.gh!.node || Promise.reject(new GitHubError(`no GitHub thread ${a.thread}`, 404));
    const msg = () => (snap!.threads.flatMap((t) => t.messages).find((m) => m.id === a.message) as (Message & { gh: GitHubComment }) | undefined) || (() => { throw new GitHubError(`no GitHub comment ${a.message}`, 404); })();
    switch (a.action) {
      case 'comment': {
        // a new line comment: a draft in the viewer's pending review (started on the commit being reviewed)
        const an = a.anchor;
        if (an?.kind !== 'code' || !Number.isInteger(an.start) || !Number.isInteger(an.end)) throw new GitHubError('GitHub comments need a code line range', 400);
        const text = body();
        const started = !snap.pending;
        const review = snap.pending?.id ?? (await run('startReview', { pr: snap.pr, commit: localHead })).addPullRequestReview.pullRequestReview.id;
        const side = an.rev === 'base' ? 'LEFT' : 'RIGHT';
        const multi = an.start < an.end;
        const r = await run('thread', { review, path: an.path, line: an.end, side, startLine: multi ? an.start : null, startSide: multi ? side : null, body: text });
        // GitHub answers a line outside the diff with no thread and no error
        if (!r.addPullRequestReviewThread?.thread) {
          if (started) await run('discard', { review }).catch(() => {});
          throw new GitHubError(`GitHub only takes comments on lines in the PR's diff (changed lines and the few around them); ${an.path}:${an.end} is not one`, 422);
        }
        break;
      }
      case 'reply':
        await run('reply', { thread: await threadNode(), body: body() });
        break;
      case 'conversation':
        await run('comment', { pr: snap.pr, body: body() });
        break;
      case 'edit': {
        const m = msg();
        if (!m.gh.canEdit || !M['edit:' + m.gh.kind]) throw new GitHubError('you cannot edit that comment', 403);
        await run('edit:' + m.gh.kind, { id: m.gh.node, body: body() });
        break;
      }
      case 'delete': {
        const m = msg();
        if (!m.gh.canDelete || !M['delete:' + m.gh.kind]) throw new GitHubError('you cannot delete that comment', 403);
        await run('delete:' + m.gh.kind, { id: m.gh.node });
        break;
      }
      case 'resolve':
        await run(a.resolved ? 'resolve' : 'unresolve', { thread: await threadNode() });
        break;
      case 'submit': {
        const event = ({ comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' } as Record<string, string | undefined>)[a.event!];
        if (!event) throw new GitHubError('event must be comment, approve or request_changes', 400);
        const text = typeof a.body === 'string' && a.body.trim() ? body() : null;
        if (snap.pending) await run('submit', { review: snap.pending.id, event, body: text });
        else await run('review', { pr: snap.pr, commit: localHead, event, body: text });
        break;
      }
      case 'discard':
        if (snap.pending) await run('discard', { review: snap.pending.id });
        break;
      default:
        throw new GitHubError(`unknown action ${JSON.stringify(a.action)}`, 400);
    }
  }

  return { target, cached: () => snap, snapshot: () => snap ?? refresh(), refresh, act };
}
