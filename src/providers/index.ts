// Code providers: where diffs, file contents and symbol search come from.
// Order of preference: local CLI server (git on your clone) -> GitHub -> static fixture.
// Implement CodeProvider to plug in anything else (GitLab, a monorepo index, ...).
import type { ChangedFile, Commit, ReviewMeta, ReviewState, Rev, SearchHit, DiffRange, Op, GitHubSnapshot } from '../core/types';
import { loadRaw } from '../core/store';
import { StoredState, type GitHubAction } from '../shared/schema';
import { parseWalkthrough, type Walkthrough } from '../shared/walkthrough';
import { createActor, fromCallback, fromPromise, waitFor, type ActorRefFrom } from 'xstate';
import { roundStatus, syncMachine, unsent } from '../flows/sync';

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
  /** The reviewer's default panel layout (dockview JSON) for reviews without one of their own; null clears it. */
  defaultLayout?(): Promise<object | null>;
  saveDefaultLayout?(layout: object | null): Promise<boolean>;
  /** The PR's GitHub threads (cached by the server unless refresh). */
  github?(refresh?: boolean): Promise<GitHubSnapshot>;
  /** Post/edit/resolve/submit on GitHub (actions in cli/lib/github.ts); resolves to the refetched threads. */
  githubAct?(action: GitHubAction): Promise<GitHubSnapshot>;
  /** The review's walkthrough.json: null when there is none, `{ issues }` when it breaks the schema. */
  walkthrough?(): Promise<WalkthroughLoad>;
}
export type WalkthroughLoad = Walkthrough | { issues: string[] } | null;
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

const json = async (r: Response) => {
  if (r.ok) return r.json();
  // the reviewroom server says why in {error} (a state.json moved aside, say); GitHub in {message}
  const b = await r.json().catch(() => null);
  throw new Error(b?.error ?? b?.message ?? `${r.status} ${r.statusText} ${r.url}`);
};

// ------------------------------------------------------------------ local (CLI)

export class LocalProvider implements CodeProvider {
  readonly name = 'local';
  constructor(private api = '/api') {}
  meta() {
    return fetch(`${this.api}/meta`).then(json);
  }
  commits() {
    return fetch(`${this.api}/commits`).then(json);
  }
  files(range: DiffRange) {
    return fetch(`${this.api}/files?base=${encodeURIComponent(range.base)}&head=${encodeURIComponent(range.head)}`).then(json);
  }
  async read(path: string, rev: Rev) {
    const r = await fetch(`${this.api}/read?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`read ${path}@${rev}: ${r.status}`);
    return r.text();
  }
  async patch(range: DiffRange, ws: boolean) {
    const r = await fetch(`${this.api}/patch?base=${encodeURIComponent(range.base)}&head=${encodeURIComponent(range.head)}${ws ? '&ws=1' : ''}`);
    return r.ok ? r.text() : null;
  }
  search(q: string, o: { rev: Rev; symbol?: boolean; limit?: number }) {
    const p = new URLSearchParams({ q, rev: o.rev, symbol: o.symbol ? '1' : '', limit: String(o.limit ?? 50) });
    return fetch(`${this.api}/search?${p}`).then(json);
  }
  tree(rev: Rev) {
    return fetch(`${this.api}/tree?rev=${encodeURIComponent(rev)}`).then(json);
  }
  static async detect(api = '/api'): Promise<LocalProvider | null> {
    try {
      const r = await fetch(`${api}/meta`, { headers: { accept: 'application/json' } });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return new LocalProvider(api);
    } catch {
      /* no server */
    }
    return null;
  }
}

// Saving and live updates are src/flows/sync.ts; this is its fetch/EventSource side.
export class ServerState implements StateBackend {
  readonly kind = 'server';
  private sync?: ActorRefFrom<typeof syncMachine>;
  constructor(private api = '/api') {
    addEventListener('beforeunload', (e) => this.sync && unsent(this.sync.getSnapshot().context) && e.preventDefault());
  }
  private fetchState(): Promise<ReviewState> {
    return fetch(`${this.api}/state`).then(json);
  }
  async load() {
    const base = await this.fetchState();
    const api = this.api;
    this.sync = createActor(
      syncMachine.provide({
        actors: {
          post: fromPromise(async ({ input, signal }) => {
            const r = await fetch(`${api}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: input.ops }), signal });
            const b = await r.json().catch(() => ({}));
            if (r.ok) return { rev: b.rev };
            if (r.status < 500 && typeof b.index === 'number') return { rejected: b.index, error: b.error };
            throw new Error(b.error ?? `${r.status} ${r.statusText}`);
          }),
          fetchState: fromPromise(() => this.fetchState()),
          stream: fromCallback(({ sendBack }) => {
            const es = new EventSource(`${api}/events`);
            es.addEventListener('hello', (e) => sendBack({ type: 'hello', ...JSON.parse(e.data) }));
            es.addEventListener('state', (e) => sendBack({ type: 'state', state: JSON.parse(e.data) }));
            es.addEventListener('review', () => sendBack({ type: 'review' }));
            es.addEventListener('github', (e) => sendBack({ type: 'github', snapshot: JSON.parse(e.data) }));
            es.onerror = () => sendBack({ type: 'down' });
            return () => es.close();
          }),
        },
      }),
      { input: { base } },
    ).start();
    return base;
  }
  apply(op: Op) {
    this.sync!.send({ type: 'op', op });
  }
  async flush() {
    const sync = this.sync!;
    sync.send({ type: 'flush' }); // stalled: try now rather than at the next retry
    const s = await waitFor(sync, (s) => !s.hasTag('sending'));
    return !unsent(s.context);
  }
  subscribe(on: BackendEvents) {
    const sync = this.sync!;
    sync.on('state', (e) => on.state(e.state));
    sync.on('error', (e) => on.error(e.text));
    sync.on('github', (e) => on.github?.(e.snapshot));
    sync.on('reload', () => on.review());
    let unsaved = false;
    let status: 'waiting' | 'approved' | 'offline' | null = null;
    sync.subscribe((s) => {
      if ((s.context.failures > 0 && unsent(s.context)) !== unsaved) on.unsaved?.((unsaved = !unsaved));
      if (s.hasTag('catchingUp')) return;
      // offline: it was live once and isn't now
      const now = roundStatus(s.context) ?? (s.context.hash !== null && !s.hasTag('live') ? 'offline' : null);
      if (now === status) return;
      if (status === 'waiting' && now === null) on.ready?.(s.context.base.round);
      on.status?.((status = now));
    });
    sync.send({ type: 'connect' });
  }
  async finish(kind: 'feedback' | 'approve', note: string | undefined, round: number) {
    if (!(await this.flush())) return { ok: false, message: 'some changes are not saved yet' };
    const r = await fetch(`${this.api}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, note, round }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: b.error || `${r.status} ${r.statusText}` };
    // the finish broadcast may have been missed, and this run of the server stops right after: take the state from the answer
    if (b.state) this.sync!.send({ type: 'state', state: b.state });
    return { ok: true };
  }
  async snapshot(n: number) {
    const r = await fetch(`${this.api}/rounds/${n}/review.html`);
    return r.ok ? r.text() : null;
  }
  // kept by the server for every review on this machine (ports change, so localStorage wouldn't follow)
  defaultLayout() {
    return fetch(`${this.api}/layout`).then(json);
  }
  async saveDefaultLayout(layout: object | null) {
    const r = await fetch(`${this.api}/layout`, layout ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layout) } : { method: 'DELETE' });
    return r.ok;
  }
  async walkthrough(): Promise<WalkthroughLoad> {
    const r = await fetch(`${this.api}/walkthrough`);
    if (r.status === 404) return null;
    if (r.ok || r.status === 422) return r.json();
    throw new Error(`walkthrough.json: ${r.status} ${r.statusText}`); // not a schema problem: the player stays off

  }
  github(refresh = false) {
    return fetch(`${this.api}/github${refresh ? '?refresh=1' : ''}`).then(json);
  }
  async githubAct(action: GitHubAction) {
    const r = await fetch(`${this.api}/github`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `${r.status} ${r.statusText}`);
    return b;
  }
}

// ------------------------------------------------------------------ GitHub (fallback)
// File contents come from raw.githubusercontent.com (not the REST API), so a
// review costs ~2 API calls (compare + commits) regardless of PR size.

/** The fields of GitHub's compare response that are read here. */
type Compare = {
  commits: { sha: string; commit: { message: string; author: { name?: string; date?: string } | null } }[];
  files: { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }[];
};

export class GitHubProvider implements CodeProvider {
  readonly name = 'github';
  private cmp?: Compare;
  constructor(private repo: string, private base: string, private head: string, private token?: string) {}
  private gh(path: string): Promise<Compare> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(`https://api.github.com/repos/${this.repo}${path}`, { headers }).then(json);
  }
  private async compare() {
    return (this.cmp ??= await this.gh(`/compare/${encodeURIComponent(this.base)}...${encodeURIComponent(this.head)}`));
  }
  async meta() {
    return { repo: this.repo };
  }
  async commits(): Promise<Commit[]> {
    const c = await this.compare();
    return c.commits.map((x) => ({ sha: x.sha, short: x.sha.slice(0, 7), subject: x.commit.message.split('\n')[0], author: x.commit.author?.name, date: x.commit.author?.date }));
  }
  private compareFor(range: DiffRange) {
    return range.base === this.base && range.head === this.head ? this.compare() : this.gh(`/compare/${range.base}...${range.head}`);
  }
  async files(range: DiffRange): Promise<ChangedFile[]> {
    const c = await this.compareFor(range);
    const st: Record<string, ChangedFile['status']> = { added: 'added', removed: 'deleted', renamed: 'renamed', modified: 'modified', changed: 'modified' };
    return c.files.map((f) => ({ path: f.filename, prevPath: f.previous_filename, status: st[f.status] ?? 'modified', additions: f.additions, deletions: f.deletions }));
  }
  async read(path: string, rev: Rev) {
    const r = await fetch(`https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(rev)}/${path}`);
    return r.ok ? r.text() : null;
  }
  /** From the compare response's per-file hunks: no request beyond the one files() made. GitHub leaves out big and binary files' hunks; those are read. */
  async patch(range: DiffRange, ws: boolean) {
    if (ws) return null; // GitHub's hunks can't ignore whitespace
    return (await this.compareFor(range)).files
      .filter((f) => f.patch)
      .map((f) => {
        const old = f.previous_filename ?? f.filename;
        return `diff --git a/${old} b/${f.filename}\n--- ${f.status === 'added' ? '/dev/null' : 'a/' + old}\n+++ ${f.status === 'removed' ? '/dev/null' : 'b/' + f.filename}\n${f.patch}\n`;
      })
      .join('');
  }
}

// ------------------------------------------------------------------ static fixture
// <script type="application/json" id="rr-fixture">{ meta, commits, files, contents: { "<rev>:<path>": "..." } }</script>

export interface Fixture {
  meta: Partial<ReviewMeta>;
  commits?: Commit[];
  files: ChangedFile[] | Record<string, ChangedFile[]>; // keyed by "base..head" when per-commit file lists are provided
  contents: Record<string, string>;
}

export class StaticProvider implements CodeProvider {
  readonly name = 'static';
  constructor(private fx: Fixture) {}
  async meta() {
    return this.fx.meta;
  }
  async commits() {
    return this.fx.commits ?? [];
  }
  async files(range: DiffRange) {
    if (Array.isArray(this.fx.files)) return this.fx.files;
    return this.fx.files[`${range.base}..${range.head}`] ?? this.fx.files['all'] ?? [];
  }
  async read(path: string, rev: Rev) {
    return this.fx.contents[`${rev}:${path}`] ?? null;
  }
  async tree(rev: Rev) {
    return Object.keys(this.fx.contents)
      .filter((k) => k.startsWith(rev + ':'))
      .map((k) => k.slice(rev.length + 1));
  }
}

const LS_KEY = (id: string) => `reviewroom:state:${id}`;

export class BrowserState implements StateBackend {
  readonly kind = 'browser';
  /** `tour`: the text of the page's #rr-walkthrough script (the static demo embeds one) */
  constructor(private id: string, private seed?: ReviewState, private tour?: string) {}
  async walkthrough(): Promise<WalkthroughLoad> {
    if (this.tour === undefined) return null;
    const r = parseWalkthrough(this.tour);
    return r.ok ? r.value : { issues: r.issues };
  }
  async load() {
    try {
      const raw = localStorage.getItem(LS_KEY(this.id));
      const v: unknown = raw && JSON.parse(raw);
      if (StoredState.safeParse(v).success) return v as ReviewState; // a copy that breaks the schema starts over from the seed
    } catch {
      /* ignore */
    }
    return this.seed ?? null;
  }
  // the only writer: store the whole document
  apply(_op: Op, next: ReviewState) {
    try {
      localStorage.setItem(LS_KEY(this.id), JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  async defaultLayout() {
    return JSON.parse(loadRaw(DEFAULT_LAYOUT_KEY) ?? 'null');
  }
  async saveDefaultLayout(layout: object | null) {
    try {
      if (layout) localStorage.setItem(DEFAULT_LAYOUT_KEY, JSON.stringify(layout));
      else localStorage.removeItem(DEFAULT_LAYOUT_KEY);
      return true;
    } catch {
      return false;
    }
  }
}
const DEFAULT_LAYOUT_KEY = 'reviewroom:default-layout';
