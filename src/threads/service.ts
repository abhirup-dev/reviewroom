import type { Commit, DiffRange, GitHubSnapshot, ReviewMeta, ReviewState, Thread } from '../kernel/state/model.shared';
import type { Walkthrough } from '../slides/model.shared';
import { sideSha } from '../kernel/anchors';
import type { GitHubAction } from '../kernel/state/schema.shared';
import { threadPr, yoursIn } from './feedback.shared';
import type { Anchor, Author, Op } from '../kernel/state/schema.shared';

interface ThreadServiceDeps {
  getState(): ReviewState;
  getGitHub(): GitHubSnapshot | null;
  getReviewMode(): 'agent' | 'team' | 'all';
  apply(op: Op): boolean;
  githubAct(action: GitHubAction): Promise<boolean>;
  uid: (prefix: string) => string;
  /** The review around the threads, for stacks and per-commit pinning (missing: one plain diff). */
  getScope?(): { meta: Pick<ReviewMeta, 'number' | 'stack'>; range?: DiffRange; commits: readonly Pick<Commit, 'sha'>[]; walkthrough: Walkthrough | null };
  now?: () => string;
}

/** Thread queries and routing; the caller owns state changes and GitHub effects. */
export function createThreadService(deps: ThreadServiceDeps) {
  const { uid } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  function threads(): Thread[] {
    const state = deps.getState();
    const github = deps.getGitHub();
    return github?.threads.length ? [...state.threads, ...github.threads] : state.threads;
  }

  const scope = () => deps.getScope?.() ?? { meta: {}, range: undefined, commits: [], walkthrough: null };

  function thread(id: string) {
    // a link from before stacks to the PR conversation: the requested PR's, in a stack
    const { meta } = scope();
    const old = id === 'gh_conversation' && meta.stack ? threads().find((t) => t.gh?.conversation && t.pr === Number(meta.number)) : undefined;
    return old ?? threads().find((t) => t.id === id) ?? deps.getState().threads.find((t) => t.id.startsWith(id));
  }

  /** In a stack: the PR a thread is about (its GitHub PR, its layer, its walkthrough chapter's PR); undefined: the whole stack. */
  function prOf(t: Thread): number | undefined {
    const { meta, walkthrough } = scope();
    return meta.stack ? threadPr(t, walkthrough) : undefined;
  }

  /** Your draft comments on GitHub, per PR (a stack: each PR's pending review; else the PR's, under its number). */
  function drafts(): Map<number, number> {
    const g = deps.getGitHub();
    const { meta } = scope();
    if (!meta.stack || !g?.prs) return new Map(g?.pending?.drafts ? [[Number(meta.number), g.pending.drafts]] : []);
    return new Map(Object.entries(g.prs).flatMap(([n, p]) => (p.pending?.drafts ? [[+n, p.pending.drafts] as [number, number]] : [])));
  }

  /** The GitHub conversation of the PR in scope (in a stack: the scoped PR's, else the requested one's). */
  function conversation() {
    const { meta, range } = scope();
    const n = range?.pr ?? Number(meta.number);
    return threads().find((t) => t.gh?.conversation && (!meta.stack || t.pr === n));
  }

  function teamMode() {
    return deps.getReviewMode() === 'team' && !!deps.getGitHub()?.ok;
  }

  function commentsToGitHub(anchor: Anchor) {
    return teamMode() && (anchor.kind === 'code' || anchor.kind === 'general');
  }

  function commentTargets(anchor: Anchor): { to: 'agent' | 'github'; label: string; title: string; off?: string }[] {
    const pr = anchor.kind === 'code' || anchor.kind === 'general';
    const gh = !!deps.getGitHub()?.ok;
    const mode = gh ? deps.getReviewMode() : 'agent';
    const agent = {
      to: 'agent' as const,
      label: 'Agent',
      title: 'A thread for the agent to answer this round',
      off: pr && mode === 'team' ? 'Unavailable in Team review mode. Switch to Agent or All to comment for the agent' : undefined,
    };
    if (!pr) return [agent];
    return [agent, {
      to: 'github',
      label: 'PR',
      title: anchor.kind === 'code' ? 'A comment in your GitHub review, posted when you submit it' : 'A comment in the PR conversation on GitHub',
      off: !gh ? 'Unavailable: this review is not of a GitHub pull request' : mode === 'agent' ? 'Unavailable in Agent review mode. Switch to Team or All to comment on the PR' : undefined,
    }];
  }

  function createThread(anchor: Anchor, body: string, author: Author = 'you', toGitHub = commentsToGitHub(anchor)): Thread | undefined | Promise<boolean> {
    const { range, commits } = scope();
    // made on one commit's diff: pinned to that commit, so other ranges don't draw it on their same line numbers.
    // Not on All changes: a push moves its head, and its threads must stay on it.
    if (range && anchor.kind === 'code' && !anchor.sha && commits.some((c) => c.sha === range.key)) anchor = { ...anchor, sha: sideSha(range, anchor.rev) };
    // made on a stack PR's layer (or a commit in it): that PR's
    if (range && anchor.kind === 'code' && anchor.pr === undefined && range.pr !== undefined) anchor = { ...anchor, pr: range.pr };
    if (author === 'you' && toGitHub)
      return anchor.kind === 'code' ? deps.githubAct({ action: 'comment', anchor, body }) : deps.githubAct({ action: 'conversation', body });
    const id = uid('t_');
    deps.apply({ op: 'createThread', id, anchor, msgId: uid('m_'), body, author, at: now() });
    return thread(id);
  }

  function reply(threadId: string, body: string, author: Author = 'you') {
    const t = thread(threadId);
    if (t?.gh) return deps.githubAct(t.gh.conversation ? { action: 'conversation', body, pr: t.pr } : { action: 'reply', thread: t.id, body });
    deps.apply({ op: 'addMessage', threadId, id: uid('m_'), body, author, at: now() });
  }

  function editMessage(threadId: string, msgId: string, body: string) {
    if (threadId.startsWith('gh_')) return deps.githubAct({ action: 'edit', message: msgId, body });
    deps.apply({ op: 'editMessage', threadId, msgId, body });
  }

  function deleteMessage(threadId: string, msgId: string) {
    if (threadId.startsWith('gh_')) return deps.githubAct({ action: 'delete', message: msgId });
    deps.apply({ op: 'deleteMessage', threadId, msgId });
  }

  function setStatus(threadId: string, status: Thread['status']) {
    if (threadId.startsWith('gh_')) return deps.githubAct({ action: 'resolve', thread: threadId, resolved: status === 'resolved' });
    deps.apply({ op: 'setThreadStatus', threadId, status });
  }

  function pendingFeedback() {
    const state = deps.getState();
    return state.threads.filter((t) => t.messages.some((m) => yoursIn(m, state.round)));
  }

  function unreadAgent(t: Thread) {
    const last = t.messages[t.messages.length - 1];
    return last?.author === 'agent' && last.round === deps.getState().round;
  }

  function githubThreadFor(href: string): string | undefined {
    const github = deps.getGitHub();
    const pr = github?.url;
    if (!pr || !href.toLowerCase().startsWith(pr.toLowerCase())) return;
    const m = href.slice(pr.length).match(/^(?:\/[^#]*)?#(?:discussion_r|r|issuecomment-|pullrequestreview-)(\d+)$/);
    return m ? github.threads.find((t) => t.messages.some((x) => x.id === 'gh_' + m[1]))?.id : undefined;
  }

  return {
    threads, thread, prOf, drafts, conversation,
    get teamMode() { return teamMode(); },
    commentsToGitHub, commentTargets, createThread, reply, editMessage, deleteMessage, setStatus,
    pendingFeedback, unreadAgent, githubThreadFor,
  };
}

export type ThreadService = ReturnType<typeof createThreadService>;
