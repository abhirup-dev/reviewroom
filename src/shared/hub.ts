// The hub's sessions (`reviewroom hub`: every review running on this machine, from reviewroom, Crit and
// Plannotator), as cli/hub/ serves them and the hub page (src/hub/) shows them.

export type ToolName = 'crit' | 'plannotator' | 'reviewroom';
export type SessionCategory = 'review' | 'annotate' | 'live-artifact' | 'browse' | 'other';
export type SessionKind =
  | 'code-review'
  | 'pull-request-review'
  | 'merge-request-review'
  | 'commit-range-review'
  | 'plan-review'
  | 'story-review'
  | 'artifact-annotation'
  | 'folder-annotation'
  | 'web-page-annotation'
  | 'last-message-annotation'
  | 'live-web-review'
  | 'html-preview'
  | 'guided-review'
  | 'archive-browser'
  | 'goal-setup'
  | 'unknown';

/** Did the session's server answer a short loopback request? */
export type Health = 'ok' | 'unreachable' | 'unknown';

/** `~/.crit/sessions/<key>.json` (schema per crit 0.18.1). */
export interface RawCritEntry {
  /** Registry filename key (12 hex chars on current crit; tolerant to other lengths). */
  key: string;
  pid: number | null;
  port: number | null;
  host: string;
  publicUrl: string | null;
  cwd: string | null;
  args: string[];
  branch: string | null;
  reviewPath: string | null;
  startedAt: string | null;
  registryUpdatedAt: string | null;
}

/** `<plannotator-data-dir>/sessions/<pid>.json`. */
export interface RawPlanEntry {
  pid: number | null;
  port: number | null;
  url: string | null;
  mode: string | null;
  project: string | null;
  startedAt: string | null;
  registryUpdatedAt: string | null;
  label: string | null;
}

/** A live session as the API and page show it. */
export interface SessionInfo {
  /** Stable across polls: `<tool>:<registry-key-or-pid>`. */
  id: string;
  tool: ToolName;
  pid: number | null;
  port: number | null;
  /** Loopback-validated click target; null when no safe URL is known. */
  url: string | null;
  /** Why `url` is null, when it is. */
  urlNote: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: boolean | null;
  /** Git repository root when the cwd is inside a repository. */
  repoRoot: string | null;
  repository: string | null;
  /** What kind of review, from launch metadata only. */
  category: SessionCategory;
  kind: SessionKind;
  target: string | null;
  classificationSource: string;
  /** The agent that started the session: recorded by reviewroom, guessed from process ancestry for the others. */
  origin: string | null;
  originSource: string | null;
  parentAgentPid: number | null;
  parentAgentGroup: string | null;
  mode: string | null;
  label: string | null;
  project: string | null;
  reviewPath: string | null;
  startedAt: string | null;
  /** Registry or round timestamp: a proxy for activity. */
  updatedAt: string | null;
  commentCount: number | null;
  resolvedCommentCount: number | null;
  unresolvedCommentCount: number | null;
  reviewRound: number | null;
  browserClients: number | boolean | null;
  interacted: boolean | null;
  /** When the hub first saw this session (kept across polls). */
  firstSeenAt: string;
  lastSeenAt: string;
  health: Health;
  notes: string[];
}

export interface HubSnapshot {
  generatedAt: string;
  pollIntervalMs: number;
  count: number;
  sessions: SessionInfo[];
  /** Non-fatal discovery errors from the latest poll. */
  lastError: string | null;
}
