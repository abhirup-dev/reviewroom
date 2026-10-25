import { createActor, fromCallback, fromPromise, waitFor, type ActorRefFrom } from 'xstate';
import type { ReviewState } from '../state/model.shared';
import { roundStatus, syncMachine, unsent } from './sync.machine';
import type { LastLayout, Layout } from '../layouts/layout.shared';
import type { GitHubAction } from '../state/schema.shared';
import type { BackendEvents, StateBackend } from './contracts';
import { json, sendJSON } from './fetch';
import type { Op } from '../state/schema.shared';

// Saving and live updates are src/kernel/providers/sync.machine.ts; this is its fetch/EventSource side.
export class ServerState implements StateBackend {
  readonly kind = 'server';
  private sync?: ActorRefFrom<typeof syncMachine>;
  private disposed = false;
  private loading?: AbortController;
  private subscriptions: { unsubscribe(): void }[] = [];
  private readonly beforeUnload = (e: BeforeUnloadEvent) => {
    if (this.sync && unsent(this.sync.getSnapshot().context)) e.preventDefault();
  };
  constructor(private api = 'api') {
    addEventListener('beforeunload', this.beforeUnload);
  }
  private stopSync() {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
    this.sync?.stop();
    this.sync = undefined;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    removeEventListener('beforeunload', this.beforeUnload);
    this.loading?.abort();
    this.loading = undefined;
    this.stopSync();
  }
  private fetchState(signal?: AbortSignal): Promise<ReviewState> {
    return fetch(`${this.api}/state`, { signal }).then(json);
  }
  async load() {
    if (this.disposed) throw new Error('ServerState is disposed');
    this.loading?.abort();
    const loading = (this.loading = new AbortController());
    let base: ReviewState;
    try {
      base = await this.fetchState(loading.signal);
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
    // A response may settle after disposal or a newer load, even if fetch ignored its signal.
    loading.signal.throwIfAborted();
    this.stopSync();
    const api = this.api;
    this.sync = createActor(
      syncMachine.provide({
        actors: {
          post: fromPromise(async ({ input, signal }) => {
            const r = await sendJSON(`${api}/ops`, 'POST', { ops: input.ops }, { signal });
            const b = await r.json().catch(() => ({}));
            if (r.ok) return { rev: b.rev };
            if (r.status < 500 && typeof b.index === 'number') return { rejected: b.index, error: b.error };
            throw new Error(b.error ?? `${r.status} ${r.statusText}`);
          }),
          fetchState: fromPromise(({ signal }) => this.fetchState(signal)),
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
  pending() {
    const c = this.sync?.getSnapshot().context;
    return { unsent: !!c && unsent(c), started: c?.started ?? null };
  }
  async flush() {
    const sync = this.sync!;
    sync.send({ type: 'flush' }); // stalled: try now rather than at the next retry
    const s = await waitFor(sync, (s) => !s.hasTag('sending'));
    return !unsent(s.context);
  }
  subscribe(on: BackendEvents) {
    const sync = this.sync!;
    this.subscriptions.push(
      sync.on('state', (e) => on.state(e.state)),
      sync.on('error', (e) => on.error(e.text)),
      sync.on('github', (e) => on.github?.(e.snapshot)),
      sync.on('reload', () => on.review()),
    );
    let unsaved = false;
    let status: 'waiting' | 'approved' | 'offline' | null = null;
    this.subscriptions.push(sync.subscribe((s) => {
      if ((s.context.failures > 0 && unsent(s.context)) !== unsaved) on.unsaved?.((unsaved = !unsaved));
      if (s.hasTag('catchingUp')) return;
      // offline: it was live once and isn't now
      const now = roundStatus(s.context) ?? (s.context.hash !== null && !s.hasTag('live') ? 'offline' : null);
      if (now === status) return;
      if (status === 'waiting' && now === null) on.ready?.(s.context.base.round);
      on.status?.((status = now));
    }));
    sync.send({ type: 'connect' });
  }
  async finish(kind: 'feedback' | 'approve', note: string | undefined, round: number) {
    if (!(await this.flush())) return { ok: false, message: 'some changes are not saved yet' };
    const r = await sendJSON(`${this.api}/finish`, 'POST', { kind, note, round });
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
  // files kept by the server (ports change, so localStorage wouldn't follow)
  layouts() {
    return fetch(`${this.api}/layouts`).then(json);
  }
  async saveLayout(id: string, layout: Layout | null) {
    const r = await (layout ? sendJSON(`${this.api}/layouts/${id}`, 'PUT', layout) : fetch(`${this.api}/layouts/${id}`, { method: 'DELETE' }));
    return r.ok;
  }
  async setDefaultLayout(id: string | null) {
    const r = await sendJSON(`${this.api}/default-layout`, 'PUT', { layout: id });
    return r.ok;
  }
  lastLayout() {
    return fetch(`${this.api}/layout`).then(json);
  }
  // one at a time (kernel/layouts/save.machine.ts); keepalive: a save made while leaving the page still lands
  async saveLastLayout(layout: LastLayout) {
    await sendJSON(`${this.api}/layout`, 'PUT', layout, { keepalive: true });
  }
  async walkthrough(): Promise<unknown> {
    const r = await fetch(`${this.api}/walkthrough`);
    if (r.status === 404) return null;
    if (r.ok || r.status === 422) return r.json();
    throw new Error(`walkthrough.json: ${r.status} ${r.statusText}`); // not a schema problem: the player stays off
  }
  github(refresh = false) {
    return fetch(`${this.api}/github${refresh ? '?refresh=1' : ''}`).then(json);
  }
  async githubAct(action: GitHubAction) {
    const r = await sendJSON(`${this.api}/github`, 'POST', action);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `${r.status} ${r.statusText}`);
    return b;
  }
}

