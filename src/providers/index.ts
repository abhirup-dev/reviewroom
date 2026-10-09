// Code providers: where diffs, file contents and symbol search come from.
// Order of preference: local CLI server (git on your clone) -> GitHub -> static fixture.
// Implement CodeProvider to plug in anything else (GitLab, a monorepo index, …).
import type { ChangedFile, Commit, ReviewMeta, ReviewState, Rev, SearchHit, DiffRange } from '../core/types';

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
  save(state: ReviewState): Promise<void>;
  /** Live updates (agent replied, review.html changed). */
  subscribe?(on: { state(s: ReviewState): void; review(): void }): void;
  /** End the current round: send feedback to the agent, or approve. */
  finish?(kind: 'feedback' | 'approve', note?: string): Promise<{ ok: boolean; message?: string }>;
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

export class ServerState implements StateBackend {
  readonly kind = 'server';
  constructor(private api = '/api') {}
  async load() {
    return fetch(`${this.api}/state`).then(json);
  }
  async save(s: ReviewState) {
    await fetch(`${this.api}/state`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
  }
  subscribe(on: { state(s: ReviewState): void; review(): void }) {
    let hash: string | null = null;
    const connect = () => {
      const es = new EventSource(`${this.api}/events`);
      es.addEventListener('hello', async (e) => {
        const h = JSON.parse((e as MessageEvent).data).hash;
        // reconnected to a new `readingroom review` run: pick up whatever the agent changed meanwhile
        if (hash !== null && h !== hash) return on.review();
        if (hash !== null) on.state(await this.load());
        hash = h;
      });
      es.addEventListener('state', (e) => on.state(JSON.parse((e as MessageEvent).data)));
      es.addEventListener('review', () => on.review());
      es.onerror = () => {
        es.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
  }
  async finish(kind: 'feedback' | 'approve', note?: string) {
    return fetch(`${this.api}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, note }) }).then(json);
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
  async save(s: ReviewState) {
    try {
      localStorage.setItem(LS_KEY(this.id), JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }
}
