// Code providers: where diffs, file contents and symbol search come from.
// Order of preference: local CLI server (git on your clone) -> GitHub -> static fixture.
// Implement CodeProvider to plug in anything else (GitLab, a monorepo index, …).
import type { ChangedFile, Commit, ReviewMeta, ReviewState, Rev, SearchHit, DiffRange, Op } from '../core/types';
import { applyOp } from '../../cli/lib/ops.mjs';

export interface CodeProvider {
  readonly name: string;
  meta(): Promise<Partial<ReviewMeta>>;
  commits(): Promise<Commit[]>;
  files(range: DiffRange): Promise<ChangedFile[]>;
  read(path: string, rev: Rev): Promise<string | null>;
  /** Text search at a revision. symbol=true biases to definitions. Optional: the shell falls back to searching loaded files. */
  search?(query: string, opts: { rev: Rev; symbol?: boolean; limit?: number }): Promise<SearchHit[]>;
  /** All file paths at a revision (for browsing outside the diff). */
  tree?(rev: Rev): Promise<string[]>;
}

/** Where threads/rounds live. The CLI server writes .readingroom/state.json; the browser fallback uses localStorage. */
export interface StateBackend {
  readonly kind: 'server' | 'browser';
  load(): Promise<ReviewState | null>;
  /** Store an op the app has already applied locally (`next` is the state after it). */
  apply(op: Op, next: ReviewState): void;
  /** Resolves once every applied op is stored; false if some are still unsaved. */
  flush?(): Promise<boolean>;
  /** Live updates (agent replied, review.html changed) and save problems. */
  subscribe?(on: { state(s: ReviewState): void; review(): void; error(text: string): void }): void;
  /** End round `round`: send feedback to the agent, or approve. */
  finish?(kind: 'feedback' | 'approve', note: string | undefined, round: number): Promise<{ ok: boolean; message?: string }>;
  /** Narrative HTML as it was at the end of round n. */
  snapshot?(round: number): Promise<string | null>;
}

const json = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${r.url}`);
  return r.json();
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

// The server is the only writer of state.json. The browser applies ops optimistically and sends them
// in order; what it shows is the last state the server broadcast plus the ops not yet in it.
export class ServerState implements StateBackend {
  readonly kind = 'server';
  private base!: ReviewState;
  /** Applied locally, not yet in `base`. ackRev: stored by the server at that rev. */
  private queue: { op: Op; ackRev?: number }[] = [];
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  private on?: { state(s: ReviewState): void; review(): void; error(text: string): void };
  constructor(private api = '/api') {
    addEventListener('beforeunload', (e) => this.queue.some((q) => !q.ackRev) && e.preventDefault());
  }
  private fetchState(): Promise<ReviewState> {
    return fetch(`${this.api}/state`).then(json);
  }
  async load() {
    return (this.base = await this.fetchState());
  }
  apply(op: Op) {
    this.queue.push({ op });
    this.pump();
  }
  private view() {
    // ops are idempotent, so one that already reached `base` re-applies as a no-op
    return this.queue.reduce((s, q) => {
      try {
        return applyOp(s, q.op);
      } catch {
        return s; // can't apply any more; the server rejects it and pump() drops it
      }
    }, this.base);
  }
  private receive(s: ReviewState) {
    if ((s.rev ?? 0) < (this.base.rev ?? 0)) return; // older than what we already have
    this.base = s;
    this.settle();
    this.on?.state(this.view());
  }
  private settle() {
    this.queue = this.queue.filter((q) => !(q.ackRev && q.ackRev <= (this.base.rev ?? 0)));
  }
  private pump() {
    return (this.running ??= this.drain());
  }
  private async drain() {
    await null; // let pump() store the promise before anything below can clear it
    try {
      for (;;) {
        const batch = this.queue.filter((q) => !q.ackRev);
        if (!batch.length) return;
        let r: Response;
        try {
          r = await fetch(`${this.api}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: batch.map((q) => q.op) }) });
        } catch {
          return this.stalled();
        }
        const b = await r.json().catch(() => ({}));
        if (r.ok) {
          batch.forEach((q) => (q.ackRev = b.rev));
          this.warned = false;
          this.settle();
        } else if (r.status < 500 && typeof b.index === 'number') {
          // that op can never apply (e.g. its thread is gone): drop it so the rest still save
          this.queue = this.queue.filter((q) => q !== batch[b.index]);
          this.on?.error('Not saved: ' + b.error);
          this.on?.state(this.view());
        } else return this.stalled(b.error);
      }
    } finally {
      this.running = null;
    }
  }
  private stalled(why?: string) {
    if (!this.warned) this.on?.error(`Not saved yet${why ? ` (${why})` : ': the readingroom server is not answering'}. Retrying.`);
    this.warned = true;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.pump(), 3000);
  }
  async flush() {
    while (this.running) await this.running;
    await this.pump();
    return !this.queue.some((q) => !q.ackRev);
  }
  subscribe(on: { state(s: ReviewState): void; review(): void; error(text: string): void }) {
    this.on = on;
    let hash: string | null = null;
    const connect = () => {
      const es = new EventSource(`${this.api}/events`);
      es.addEventListener('hello', async (e) => {
        const h = JSON.parse((e as MessageEvent).data).hash;
        // reconnected to a new `readingroom review` run: pick up whatever the agent changed meanwhile
        if (hash !== null && h !== hash) return on.review();
        if (hash !== null) this.receive(await this.fetchState());
        hash = h;
        this.pump();
      });
      es.addEventListener('state', (e) => this.receive(JSON.parse((e as MessageEvent).data)));
      es.addEventListener('review', () => on.review());
      es.onerror = () => {
        es.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
  }
  async finish(kind: 'feedback' | 'approve', note: string | undefined, round: number) {
    if (!(await this.flush())) return { ok: false, message: 'some changes are not saved yet' };
    const r = await fetch(`${this.api}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, note, round }) });
    const b = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, message: b.error || `${r.status} ${r.statusText}` };
  }
  async snapshot(n: number) {
    const r = await fetch(`${this.api}/rounds/${n}/review.html`);
    return r.ok ? r.text() : null;
  }
}

// ------------------------------------------------------------------ GitHub (fallback)
// File contents come from raw.githubusercontent.com (not the REST API), so a
// review costs ~2 API calls (compare + commits) regardless of PR size.

export class GitHubProvider implements CodeProvider {
  readonly name = 'github';
  private cmp: any;
  constructor(private repo: string, private base: string, private head: string, private token?: string) {}
  private gh(path: string) {
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
    return c.commits.map((x: any) => ({ sha: x.sha, short: x.sha.slice(0, 7), subject: x.commit.message.split('\n')[0], author: x.commit.author?.name, date: x.commit.author?.date }));
  }
  async files(range: DiffRange): Promise<ChangedFile[]> {
    const c = range.base === this.base && range.head === this.head ? await this.compare() : await this.gh(`/compare/${range.base}...${range.head}`);
    const st: Record<string, ChangedFile['status']> = { added: 'added', removed: 'deleted', renamed: 'renamed', modified: 'modified', changed: 'modified' };
    return c.files.map((f: any) => ({ path: f.filename, prevPath: f.previous_filename, status: st[f.status] ?? 'modified', additions: f.additions, deletions: f.deletions }));
  }
  async read(path: string, rev: Rev) {
    const r = await fetch(`https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(rev)}/${path}`);
    return r.ok ? r.text() : null;
  }
}

// ------------------------------------------------------------------ static fixture
// <script type="application/json" id="rr-fixture">{ meta, commits, files, contents: { "<rev>:<path>": "…" } }</script>

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

const LS_KEY = (id: string) => `readingroom:state:${id}`;

export class BrowserState implements StateBackend {
  readonly kind = 'browser';
  constructor(private id: string, private seed?: ReviewState) {}
  async load() {
    try {
      const raw = localStorage.getItem(LS_KEY(this.id));
      if (raw) return JSON.parse(raw);
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
}
