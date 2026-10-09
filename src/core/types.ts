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
  /** Free-form pills shown in the header. */
  tags?: string[];
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
  author: Author;
  round: number;
  body: string; // markdown; may contain rr: links and embeds
  at: string; // ISO
}

export interface Thread {
  id: string;
  anchor: Anchor;
  status: 'open' | 'resolved';
  createdRound: number;
  messages: Message[];
  /** Optional short label; defaults to the first line of the first message. */
  title?: string;
}

export interface Round {
  n: number;
  status: 'open' | 'sent' | 'approved';
  startedAt: string;
  sentAt?: string;
  note?: string;
}

export interface ReviewState {
  version: 1;
  round: number;
  rounds: Round[];
  threads: Thread[];
  /** path -> true once marked viewed (per round). */
  viewed: Record<string, number>;
  pins: string[]; // rr: refs pinned by the reviewer
  /** <rr-check> sign-offs keyed by check id. */
  checks?: Record<string, 'todo' | 'pass' | 'fail'>;
}

export const emptyState = (): ReviewState => ({
  version: 1,
  round: 1,
  rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }],
  threads: [],
  viewed: {},
  pins: [],
});
