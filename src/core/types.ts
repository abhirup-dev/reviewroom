// Shared data model. Everything persisted lives in ReviewState (see schema/state.schema.json).

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
}

/** A diff range. 'all' = meta.base..meta.head; a commit sha = sha^..sha. */
export interface DiffRange {
  base: Rev;
  head: Rev;
  label: string;
  key: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  rev: Rev;
  kind?: 'definition' | 'reference' | 'text';
}

// ---------------------------------------------------------------- anchors

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export type Anchor =
  | { kind: 'doc'; target: string; path?: string; quote?: TextQuote } // target = element id in the narrative; path = css path below it (blocks without ids); quote = selected text
  | { kind: 'code'; path: string; rev: 'base' | 'head'; start: number; end: number }
  | { kind: 'symbol'; name: string }
  | { kind: 'general' };

export type Author = 'you' | 'agent';

export interface Message {
  id: string;
  /** 'github': a comment on the PR on GitHub (see GitHubThread); never stored in state.json. */
  author: Author | 'github';
  round: number;
  body: string; // markdown; may contain rr: links and embeds
  at: string; // ISO
  gh?: GitHubComment;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  status: 'open' | 'resolved';
  createdRound: number;
  messages: Message[];
  /** Optional short label; defaults to the first line of the first message. */
  title?: string;
  /** Set on threads that live on GitHub (ids `gh_…`); they come from /api/github, not state.json. */
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

/** GET /api/github: the PR's human comment threads (cli/lib/github.mjs). */
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
}

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

export interface Round {
  n: number;
  status: 'open' | 'sent' | 'approved';
  startedAt: string;
  sentAt?: string;
  note?: string;
  /** When `reviewroom review` printed this round's feedback; null = finished but not yet delivered. */
  deliveredAt?: string | null;
}

export interface ReviewState {
  version: 1;
  /** Bumped by every applied op; missing = 0. */
  rev?: number;
  round: number;
  rounds: Round[];
  threads: Thread[];
  /** path -> true once marked viewed (per round). */
  viewed: Record<string, number>;
  pins: string[]; // rr: refs pinned by the reviewer
  /** <rr-check> sign-offs keyed by check id. */
  checks?: Record<string, 'todo' | 'pass' | 'fail'>;
  /** Narrative rr: links -> fingerprint when first seen: hash of the lines for a line range, 'definition' for a symbol (stale-link check). */
  links?: Record<string, string>;
}

/** Every change to ReviewState (applied by applyOp in src/shared/ops.ts). `at` defaults to now. */
export type Op =
  | { op: 'createThread'; id: string; anchor: Anchor; msgId: string; body: string; author: Author; at?: string }
  | { op: 'addMessage'; threadId: string; id: string; body: string; author: Author; at?: string }
  | { op: 'editMessage'; threadId: string; msgId: string; body: string }
  | { op: 'deleteMessage'; threadId: string; msgId: string }
  | { op: 'setThreadStatus'; threadId: string; status: Thread['status'] }
  | { op: 'setViewed'; path: string; viewed: boolean }
  | { op: 'setPin'; ref: string; pinned: boolean }
  | { op: 'setCheck'; id: string; value: 'todo' | 'pass' | 'fail' }
  | { op: 'setLinks'; links: Record<string, string> }
  | { op: 'finishRound'; kind: 'feedback' | 'approve'; note?: string; round?: number; at?: string }
  | { op: 'markDelivered'; round: number; at?: string };

export const emptyState = (): ReviewState => ({
  version: 1,
  round: 1,
  rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }],
  threads: [],
  viewed: {},
  pins: [],
});
