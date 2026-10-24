// Contracts shared by provider implementations and their callers. No runtime dependencies.
import type { ChangedFile, Commit, ReviewMeta, ReviewState, Rev, SearchHit, DiffRange, GitHubSnapshot } from '../state/model.shared';
import type { GitHubAction } from '../state/schema.shared';
import type { LastLayout, Layout, SavedLayouts } from '../layouts/layout.shared';
import type { Op } from '../state/schema.shared';

export interface CodeProvider {
  readonly name: string;
  meta(): Promise<Partial<ReviewMeta>>;
  commits(): Promise<Commit[]>;
  files(range: DiffRange): Promise<ChangedFile[]>;
  read(path: string, rev: Rev): Promise<string | null>;
  /** The range's unified diff (git format), so files render from their hunks and are read only when expanded. Null: read them. */
  patch?(range: DiffRange, ignoreWhitespace: boolean): Promise<string | null>;
  /** Text search at a revision. symbol=true biases to definitions. Optional: the shell falls back to searching loaded files. */
  search?(query: string, opts: { rev: Rev; symbol?: boolean; limit?: number }): Promise<SearchHit[]>;
  /** All file paths at a revision (for browsing outside the diff). */
  tree?(rev: Rev): Promise<string[]>;
}

/** Where threads/rounds live. The CLI server writes .reviewroom/state.json; the browser fallback uses localStorage. */
export interface StateBackend {
  readonly kind: 'server' | 'browser';
  /** Release live connections, actor work, and page listeners. Terminal and safe to call repeatedly. */
  dispose?(): void;
  load(): Promise<ReviewState | null>;
  /** Store an op the app has already applied locally (`next` is the state after it). */
  apply(op: Op, next: ReviewState): void;
  /** Resolves once every applied op is stored; false if some are still unsaved. */
  flush?(): Promise<boolean>;
  /** Live updates (agent replied, review.html changed, GitHub threads refetched) and save problems. */
  subscribe?(on: BackendEvents): void;
  /** End round `round`: send feedback to the agent, or approve. */
  finish?(kind: 'feedback' | 'approve', note: string | undefined, round: number): Promise<{ ok: boolean; message?: string }>;
  /** Narrative HTML as it was at the end of round n. */
  snapshot?(round: number): Promise<string | null>;
  /** The reviewer's saved layouts and their default, shared by every review. */
  layouts(): Promise<SavedLayouts>;
  /** Save a new layout as `id` (false if that name is taken), or delete it (null). */
  saveLayout(id: string, layout: Layout | null): Promise<boolean>;
  /** Make saved layout `id` the default, or have none (null). */
  setDefaultLayout(id: string | null): Promise<boolean>;
  /** This review's dock as the reviewer left it. */
  lastLayout(): Promise<LastLayout | null>;
  saveLastLayout(layout: LastLayout): Promise<void>;
  /** The PR's GitHub threads (cached by the server unless refresh). */
  github?(refresh?: boolean): Promise<GitHubSnapshot>;
  /** Post/edit/resolve/submit on GitHub (actions in cli/lib/github.ts); resolves to the refetched threads. */
  githubAct?(action: GitHubAction): Promise<GitHubSnapshot>;
  /** Raw walkthrough transport: server JSON (including 422 `{ issues }`), embedded text, or null if absent.
   * Schema parsing belongs to the walkthrough feature. Other HTTP failures reject. */
  walkthrough?(): Promise<unknown>;
  /** For the update flow (src/kernel/pwa.ts): ops not stored yet, and when the server we stream from started. */
  pending?(): { unsent: boolean; started: string | null };
}
export interface BackendEvents {
  state(s: ReviewState): void;
  review(): void;
  error(text: string): void;
  /** Some changes failed to save and are being retried (true), or all are saved again (false). */
  unsaved?(on: boolean): void;
  /** The round is with the agent, approved, or the server is gone while reviewing (null: none of these). */
  status?(s: 'waiting' | 'approved' | 'offline' | null): void;
  /** The agent is back with round `round`. */
  ready?(round: number): void;
  github?(s: GitHubSnapshot): void;
}
