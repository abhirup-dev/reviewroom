// GitHub side of a PR review: read the PR's human comment threads and post to them, through the
// `gh` CLI (its login, its host config; no token ever reaches the browser). GitHub stays the source
// of truth: nothing here is written to state.json, only cached in github.json for the CLI.
//
// New comments go into the viewer's pending review (GitHub's own drafts, also visible on github.com)
// until submitted; replies and PR conversation comments post at once.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnchor } from './state.mjs';

/** The last fetched GitHub threads of a review dir (the CLI reads them; only the server fetches). */
export function cachedThreads(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'github.json'), 'utf8')).threads ?? [];
  } catch {
    return [];
  }
}

/** Which PR a review is about: from config.url (any GitHub host), else repo + number. */
export function prTarget(cfg) {
  const m = String(cfg.url || '').match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { host: m[1], owner: m[2], name: m[3], number: +m[4] };
  const r = String(cfg.repo || '').match(/^([\w.-]+)\/([\w.-]+)$/);
  return r && cfg.number ? { host: 'github.com', owner: r[1], name: r[2], number: +cfg.number } : null;
}

/** `gh api graphql`, variables passed as JSON on stdin. Rejects with GitHub's own error text. */
export function gql(cwd, host, query, variables = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', ['api', 'graphql', '--hostname', host, '--input', '-'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), 30000);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => (clearTimeout(timer), reject(new Error(e.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : e.message))));
    p.on('close', (code) => {
      clearTimeout(timer);
      let b = null;
      try {
        b = JSON.parse(out);
      } catch {}
      if (b?.errors?.length) return reject(new Error(b.errors.map((e) => e.message).join('; ')));
      if (code !== 0 || !b) return reject(new Error((err || out).trim().split('\n')[0] || `gh exited with ${code}`));
      resolve(b.data);
    });
    p.stdin.end(JSON.stringify({ query, variables }));
  });
}

const AUTHOR = 'author { login avatarUrl }';
const COMMENT = `id databaseId body createdAt url viewerCanUpdate viewerCanDelete ${AUTHOR}`;
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id url headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line startLine diffSide startDiffSide originalLine originalStartLine subjectType
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 100) { nodes { ${COMMENT} state pullRequestReview { id } } }
        }
      }
      comments(first: 100) { nodes { ${COMMENT} } }
      reviews(last: 100) { nodes { id databaseId body state createdAt url viewerCanUpdate ${AUTHOR} } }
    }
  }
}`;

/** Fetch everything and normalize. shortcut: conversation comments and reviews stop at 100 each, page them if a PR ever has more. */
export async function fetchPr(cwd, t, localHead) {
  let data;
  const threads = [];
  let after = null;
  do {
    data = await gql(cwd, t.host, PR_QUERY, { owner: t.owner, name: t.name, number: t.number, after });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error(`PR #${t.number} not found in ${t.owner}/${t.name}`);
    threads.push(...pr.reviewThreads.nodes);
    after = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (after);
  const pr = data.repository.pullRequest;
  return normalize({ ...pr, reviewThreads: { nodes: threads } }, data.viewer.login, localHead);
}

const VERDICT = { APPROVED: '**Approved**', CHANGES_REQUESTED: '**Requested changes**', DISMISSED: '_Review dismissed_' };

/** GitHub's GraphQL shape -> reviewroom threads (ids `gh_<databaseId>`, never stored in state.json). Pure, for tests. */
export function normalize(pr, viewer, localHead) {
  const msg = (c, kind) => ({
    id: `gh_${c.databaseId}`,
    author: 'github',
    round: 0,
    body: c.body,
    at: c.createdAt,
    gh: { kind, node: c.id, login: c.author?.login ?? 'ghost', avatar: c.author?.avatarUrl, url: c.url, pending: c.state === 'PENDING' || undefined, mine: c.author?.login === viewer, canEdit: !!c.viewerCanUpdate, canDelete: !!c.viewerCanDelete },
  });
  const threads = pr.reviewThreads.nodes
    .filter((t) => t.comments.nodes.length)
    .map((t) => {
      const line = t.line ?? t.originalLine ?? 1;
      return {
        id: `gh_${t.comments.nodes[0].databaseId}`,
        anchor: { kind: 'code', path: t.path, rev: t.diffSide === 'LEFT' ? 'base' : 'head', start: (t.line ? t.startLine : t.originalStartLine) ?? line, end: line },
        status: t.isResolved ? 'resolved' : 'open',
        createdRound: 0,
        messages: t.comments.nodes.map((c) => msg(c, 'review')),
        // no current line: the code moved on (outdated) or the comment is on the whole file
        gh: { node: t.id, url: t.comments.nodes[0].url, outdated: t.line == null && t.subjectType !== 'FILE', file: t.subjectType === 'FILE', canResolve: !!t.viewerCanResolve, canUnresolve: !!t.viewerCanUnresolve, canReply: !!t.viewerCanReply },
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
  return { ok: true, viewer, url: pr.url, pr: pr.id, headSha: pr.headRefOid, localHead, stale: !!localHead && pr.headRefOid !== localHead, pending: pending ? { id: pending.id, drafts } : null, threads };
}

/** rr: links mean nothing on github.com: code links become blob links at the reviewed commit, the rest plain text. */
export function toGitHubMarkdown(body, t, shas) {
  const pr = `https://${t.host}/${t.owner}/${t.name}/pull/${t.number}`;
  return body.replace(/(!?)\[([^\]]*)\]\((rr:[^)\s]+)\)/g, (_m, _bang, label, ref) => {
    // a link to a GitHub thread keeps pointing at it there
    const gh = ref.match(/^rr:thread\/gh_(\d+|conversation)$/);
    if (gh) return `[${label || 'thread'}](${gh[1] === 'conversation' ? pr : `${pr}#discussion_r${gh[1]}`})`;
    const a = parseAnchor(ref);
    if (a.kind !== 'code') return label;
    const sha = a.rev === 'base' ? shas.base : shas.head;
    return `[${label || a.path}](https://${t.host}/${t.owner}/${t.name}/blob/${sha}/${a.path}#L${a.start}${a.end !== a.start ? `-L${a.end}` : ''})`;
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
};

class GitHubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Per-server GitHub link: cached snapshot (also written to <dir>/github.json), refresh, actions. */
export function makeGitHub({ repo, dir, cfg, prov, onChange }) {
  const target = prTarget(cfg);
  const localHead = /^[0-9a-f]{40}$/.test(prov.head) ? prov.head : null;
  const file = path.join(dir, 'github.json');
  let snap = null;
  let inflight = null;
  try {
    snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        if (!target) return (snap = { ok: false, error: 'not a GitHub pull request' });
        snap = { ...(await fetchPr(repo, target, localHead)), at: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(snap, null, 2));
      } catch (e) {
        // keep showing the last good threads; say why they may be old
        snap = { ...(snap?.ok ? snap : { ok: false, threads: [] }), error: e.message };
      } finally {
        inflight = null;
      }
      onChange?.(snap);
      return snap;
    })());

  // a failed action may still have changed something (a half-made review): refetch either way
  const act = (a) => perform(a).then(refresh, async (e) => { await refresh(); throw e; });
  async function perform(a) {
    if (!target) throw new GitHubError('this review is not about a GitHub pull request', 400);
    if (!snap?.ok) await refresh();
    if (!snap?.ok) throw new GitHubError(snap?.error || 'GitHub is not reachable');
    const run = (name, vars) => gql(repo, target.host, M[name], vars).catch((e) => Promise.reject(new GitHubError(e.message)));
    const body = () => {
      if (typeof a.body !== 'string' || !a.body.trim()) throw new GitHubError('body must be a non-empty string', 400);
      return toGitHubMarkdown(a.body.trim(), target, { base: prov.base, head: localHead || snap.headSha });
    };
    const threadNode = () => snap.threads.find((t) => t.id === a.thread)?.gh.node || Promise.reject(new GitHubError(`no GitHub thread ${a.thread}`, 404));
    const msg = () => snap.threads.flatMap((t) => t.messages).find((m) => m.id === a.message) || (() => { throw new GitHubError(`no GitHub comment ${a.message}`, 404); })();
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
        const event = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' }[a.event];
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
