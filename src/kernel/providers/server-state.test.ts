import { expect, test } from 'bun:test';
import { emptyState } from '../state/model.shared';
import { ServerState } from './server-state';
import { fixture, type Fixture } from '../../testing/fixture';

import { tick } from '../../testing/wait';

class Stream extends EventTarget {
  static opened: Stream[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    Stream.opened.push(this);
  }
  close() {
    this.closed = true;
  }
}
function server(t: Fixture) {
  const page = new EventTarget();
  t.global('addEventListener', page.addEventListener.bind(page));
  t.global('removeEventListener', page.removeEventListener.bind(page));
  Stream.opened = [];
  t.global('EventSource', Stream);
  const backend = new ServerState('/test-api');
  t.defer(() => backend.dispose());
  return { backend, page };
}
const listen = (backend: ServerState, state = () => {}) => backend.subscribe({ state, error: () => {}, review: () => {} });

test('walkthrough transport preserves 200 and 422 JSON, returns null on 404, and rejects other failures', async () => {
  using t = fixture();
  const { backend } = server(t);
  const raw = { version: 999, unexpected: true }; // transport must not validate the feature schema
  for (const [status, body] of [[200, raw], [422, { issues: ['invalid chapter'] }]] as const) {
    t.global('fetch', async () => Response.json(body, { status }));
    expect(await backend.walkthrough()).toEqual(body);
  }
  t.global('fetch', async () => new Response('not JSON', { status: 404 }));
  expect(await backend.walkthrough()).toBeNull();
  t.global('fetch', async () => new Response('', { status: 503, statusText: 'Unavailable' }));
  expect(backend.walkthrough()).rejects.toThrow('walkthrough.json: 503 Unavailable');
  t.global('fetch', async () => new Response('not JSON', { status: 200 }));
  expect(backend.walkthrough()).rejects.toThrow();
});

test('dispose closes the stream, aborts actor requests, removes unload prevention, and is idempotent', async () => {
  using t = fixture();
  let posting: AbortSignal | undefined;
  t.global('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/ops')) {
      posting = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return Response.json(emptyState());
  });
  const { backend, page } = server(t);
  await backend.load();
  let states = 0;
  listen(backend, () => states++);
  backend.apply({ op: 'setPin', ref: 'rr:file/a.ts', pinned: true });
  expect(posting?.aborted).toBe(false);
  const leaving = new Event('beforeunload', { cancelable: true });
  page.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  const stream = Stream.opened[0];
  expect(stream.url).toBe('/test-api/events');
  backend.dispose();
  backend.dispose();
  expect(stream.closed).toBe(true);
  expect(posting?.aborted).toBe(true);
  const after = new Event('beforeunload', { cancelable: true });
  page.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
  stream.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(emptyState()) }));
  expect(states).toBe(0);
  expect(backend.load()).rejects.toThrow('ServerState is disposed');
});

test('dispose aborts a live state refetch', async () => {
  using t = fixture();
  let refetch: AbortSignal | undefined;
  let calls = 0;
  t.global('fetch', async (_url: string, init?: RequestInit) => {
    if (++calls === 1) return Response.json(emptyState());
    refetch = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const { backend } = server(t);
  await backend.load();
  listen(backend);
  Stream.opened[0].dispatchEvent(new MessageEvent('hello', { data: JSON.stringify({ hash: 'hash', started: 'now' }) }));
  expect(refetch?.aborted).toBe(false);
  backend.dispose();
  expect(refetch?.aborted).toBe(true);
});

test('dispose during initial load cannot start an actor after a late response', async () => {
  using t = fixture();
  let reply!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  t.global('fetch', (_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { reply = resolve; });
  });
  const { backend } = server(t);
  const loading = backend.load();
  backend.dispose();
  expect(signal?.aborted).toBe(true);
  reply(Response.json(emptyState())); // simulate a transport that ignores cancellation
  expect(loading).rejects.toThrow();
  expect(Stream.opened).toHaveLength(0);
});

test('reloading replaces the previous actor and stream', async () => {
  using t = fixture();
  t.global('fetch', async () => Response.json(emptyState()));
  const { backend } = server(t);
  await backend.load();
  listen(backend);
  const first = Stream.opened[0];
  await backend.load();
  expect(first.closed).toBe(true);
  listen(backend);
  expect(Stream.opened).toHaveLength(2);
  backend.dispose();
  await tick();
  expect(Stream.opened[1].closed).toBe(true);
});
