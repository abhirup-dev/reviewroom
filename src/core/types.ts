// Shared data model. Everything persisted lives in ReviewState (see schema/state.schema.json).
import type { Author, StoredMessage, StoredState, StoredThread } from '../shared/schema';

export type Rev = string; // 'base' | 'head' | a git sha / ref

export interface ReviewMeta {
  /** Stable id for local persistence (layout, viewed files). */
  id: string;
  title: string;
  repo?: string; // owner/name
  number?: number | string;
  author?: string;
  url?: string;
  /** git refs the diff is computed between. */
  base: Rev;
  head: Rev;
  baseLabel?: string;
  headLabel?: string;
  /** A stack of PRs (`reviewroom pr` on a PR in one): bottom first; base..head spans them all, `number` is the PR asked for. */
  stack?: StackPr[];
}

/** One PR of a stack. Its layer, base..head, is what it adds on the PR below (base = that PR's head). */
export interface StackPr {
  number: number;
  title: string;
  author?: string;
  url?: string;
  /** merged or closed on GitHub; else its review decision (approved, changes wanted) or open */
  state: 'merged' | 'closed' | 'approved' | 'changes' | 'open';
  /** its head branch */
  headLabel: string;
  base: Rev;
  head: Rev;
  /** the PR below was rewritten after this one was pushed: the layer starts where the two still agree */
  restack?: boolean;
  additions: number;
  deletions: number;
  files: number;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  prevPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author?: string;
  date?: string;
  /** Its first parent's sha (the base of its own diff); missing: `sha^` */
  parent?: string;
  /** In a stack: the PR whose layer it is in */
  pr?: number;
}

/** A diff range. 'all' = meta.base..meta.head; a commit sha = its parent..sha. */
export interface DiffRange {
  base: Rev;
  head: Rev;
  label: string;
  key: string;
  /** a stack PR's layer, or a commit in it: that PR's number */
  pr?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  rev: Rev;
  kind?: 'definition' | 'reference' | 'text';
}

// ---------------------------------------------------------------- anchors

// The stored shapes (state.json) and ops are defined once as Zod schemas in src/shared/schema.ts.
export type { Anchor, Author, Op, TextQuote } from '../shared/schema';

/** A stored message, or (author 'github') a comment on the PR on GitHub; those are never stored in state.json. */
export interface Message extends Omit<StoredMessage, 'author'> {
  author: Author | 'github';
  gh?: GitHubComment;
}

export interface Thread extends Omit<StoredThread, 'messages'> {
  messages: Message[];
  /** A GitHub thread of a stack of PRs: the PR it is on */
  pr?: number;
  /** Set on threads that live on GitHub (ids `gh_...`); they come from /api/github, not state.json. */
  gh?: { node: string; url: string; outdated?: boolean; file?: boolean; conversation?: boolean; canResolve?: boolean; canUnresolve?: boolean; canReply: boolean };
}

/** GitHub fields of a message with author 'github'. kind decides how it is edited/deleted. */
export interface GitHubComment {
  kind: 'review' | 'issue' | 'review-body';
  node: string;
  login: string;
  avatar?: string;
  url: string;
  /** In the viewer's not-yet-submitted review. */
  pending?: boolean;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** GET /api/github: the PR's human comment threads (cli/lib/github.ts). */
export interface GitHubSnapshot {
  ok: boolean;
  error?: string;
  at?: string;
  viewer?: string;
  url?: string;
  /** PR head on GitHub vs the commit being reviewed; stale = GitHub has moved on. */
  headSha?: string;
  localHead?: string | null;
  stale?: boolean;
  pending?: { id: string; drafts: number } | null;
  threads: Thread[];
  /** What the PR's author wrote on it (markdown). */
  description?: { body: string; login: string; avatar?: string; at: string };
  /** The PR's commits and their CI checks, newest first. */
  ci?: CiCommit[];
  /** A stack of PRs: each PR's own part by number (the fields above are the requested PR's; threads hold every PR's). */
  prs?: Record<number, GitHubPrPart>;
}

/** One PR of a stack on GitHub: what GitHubSnapshot says of the requested PR, for this one. `pr`: its node id. */
export type GitHubPrPart = Pick<GitHubSnapshot, 'url' | 'headSha' | 'localHead' | 'stale' | 'pending' | 'description' | 'ci'> & { pr: string };

export type CiState = 'success' | 'failure' | 'pending' | 'none';
export interface CiCommit {
  sha: string;
  short: string;
  title: string;
  at: string;
  url: string;
  state: CiState;
  checks: { name: string; state: CiState; url: string | null }[];
}

export interface ReviewState extends Omit<StoredState, 'threads'> {
  threads: Thread[];
}

export const emptyState = (): ReviewState => ({
  version: 1,
  round: 1,
  rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }],
  threads: [],
  viewed: {},
  pins: [],
});
