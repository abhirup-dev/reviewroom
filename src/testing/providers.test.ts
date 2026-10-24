import { afterEach, expect, test } from 'bun:test';
import { emptyState } from '../kernel/state/model.shared';
import { BrowserState } from '../kernel/providers/browser-state';
import { ServerState } from '../kernel/providers/server-state';
import { LocalProvider } from '../review/providers/local';
import { tick } from './wait';

const restore: (() => void)[] = [];
const backends: ServerState[] = [];
function replaceGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
}
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
  for (const reset of restore.splice(0).reverse()) reset();
});

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
function server() {
  const page = new EventTarget();
  replaceGlobal('addEventListener', page.addEventListener.bind(page));
  replaceGlobal('removeEventListener', page.removeEventListener.bind(page));
  Stream.opened = [];
  replaceGlobal('EventSource', Stream);
  const backend = new ServerState('/test-api');
  backends.push(backend);
  return { backend, page };
}
const listen = (backend: ServerState, state = () => {}) => backend.subscribe({ state, error: () => {}, review: () => {} });

test('walkthrough transport preserves 200 and 422 JSON, returns null on 404, and rejects other failures', async () => {
  const { backend } = server();
  const raw = { version: 999, unexpected: true }; // transport must not validate the feature schema
  for (const [status, body] of [[200, raw], [422, { issues: ['invalid chapter'] }]] as const) {
    replaceGlobal('fetch', async () => Response.json(body, { status }));
    expect(await backend.walkthrough()).toEqual(body);
  }
  replaceGlobal('fetch', async () => new Response('not JSON', { status: 404 }));
  expect(await backend.walkthrough()).toBeNull();
  replaceGlobal('fetch', async () => new Response('', { status: 503, statusText: 'Unavailable' }));
  expect(backend.walkthrough()).rejects.toThrow('walkthrough.json: 503 Unavailable');
  replaceGlobal('fetch', async () => new Response('not JSON', { status: 200 }));
  expect(backend.walkthrough()).rejects.toThrow();
});

test('browser walkthrough returns embedded text unchanged, including malformed JSON, or null when absent', async () => {
  for (const text of ['{broken', '{"version":999}', '']) {
    expect(await new BrowserState('review', undefined, text).walkthrough()).toBe(text);
  }
  expect(await new BrowserState('review').walkthrough()).toBeNull();
});

test('dispose closes the stream, aborts actor requests, removes unload prevention, and is idempotent', async () => {
  let posting: AbortSignal | undefined;
  replaceGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/ops')) {
      posting = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return Response.json(emptyState());
  });
  const { backend, page } = server();
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
  let refetch: AbortSignal | undefined;
  let calls = 0;
  replaceGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (++calls === 1) return Response.json(emptyState());
    refetch = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const { backend } = server();
  await backend.load();
  listen(backend);
  Stream.opened[0].dispatchEvent(new MessageEvent('hello', { data: JSON.stringify({ hash: 'hash', started: 'now' }) }));
  expect(refetch?.aborted).toBe(false);
  backend.dispose();
  expect(refetch?.aborted).toBe(true);
});

test('dispose during initial load cannot start an actor after a late response', async () => {
  let reply!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  replaceGlobal('fetch', (_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { reply = resolve; });
  });
  const { backend } = server();
  const loading = backend.load();
  backend.dispose();
  expect(signal?.aborted).toBe(true);
  reply(Response.json(emptyState())); // simulate a transport that ignores cancellation
  expect(loading).rejects.toThrow();
  expect(Stream.opened).toHaveLength(0);
});

test('reloading replaces the previous actor and stream', async () => {
  replaceGlobal('fetch', async () => Response.json(emptyState()));
  const { backend } = server();
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

test('local read treats only 404 as absent; patch falls back on any HTTP failure', async () => {
  const provider = new LocalProvider('/test-api');
  replaceGlobal('fetch', async () => new Response('', { status: 404 }));
  expect(await provider.read('a.ts', 'HEAD')).toBeNull();
  replaceGlobal('fetch', async () => new Response('', { status: 503 }));
  expect(provider.read('a.ts', 'HEAD')).rejects.toThrow('read a.ts@HEAD: 503');
  expect(await provider.patch({ base: 'base', head: 'head', label: 'all', key: 'all' }, false)).toBeNull();
});

test('JSON transport preserves server and GitHub errors with an HTTP fallback', async () => {
  const provider = new LocalProvider();
  for (const [body, message] of [[{ error: 'state moved aside' }, 'state moved aside'], [{ message: 'API limit' }, 'API limit']] as const) {
    replaceGlobal('fetch', async () => Response.json(body, { status: 500 }));
    expect(provider.meta()).rejects.toThrow(message);
  }
  replaceGlobal('fetch', async () => new Response('not JSON', { status: 503, statusText: 'Unavailable' }));
  expect(provider.meta()).rejects.toThrow('503 Unavailable');
});
