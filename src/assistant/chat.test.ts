import { afterEach, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { createAssistantChat } from './chat';
import { TURN_HEADER } from './context.shared';

const real = globalThis.fetch;
afterEach(() => void (globalThis.fetch = real));
const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });
const history = (messages: UIMessage[], activeStreamId: string | null = null) => Response.json({ model: 'm', status: activeStreamId ? 'working' : 'idle', messages, activeStreamId, origin: activeStreamId && 'question' });
const frames = (...chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
/** A turn's UI message stream, as the server names it. */
const sse = (turn: string, body: BodyInit) => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', [TURN_HEADER]: turn } });
const answer = (id: string, said: string) => frames({ type: 'start', messageId: id }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: said }, { type: 'text-end', id: 't' }, { type: 'finish' });
const none = () => new Response(null, { status: 204 });
const until = async (ok: () => boolean) => { for (let i = 0; !ok(); i++) { if (i > 100) throw new Error('timed out'); await Bun.sleep(10); } };
/** Answers each `METHOD url` (GET by default) from its queue (the last answer repeats); `asked` records them. */
function serve(routes: Record<string, ((init?: RequestInit) => Response | Promise<Response>)[]>) {
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const key = `${init?.method && init.method !== 'GET' ? `${init.method} ` : ''}${String(u)}`;
    asked.push(key);
    const q = routes[key];
    return (q.length > 1 ? q.shift()! : q[0])(init);
  }) as typeof fetch;
  return asked;
}
const text = (m: UIMessage | undefined) => m?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

test('sync: the history goes in; the turn it names is followed from the resume route, then the history again at its end', async () => {
  const q = msg('q', 'user', 'generate');
  const asked = serve({
    'api/assistant': [() => history([q], 's1'), () => history([q, msg('a', 'assistant', 'done')])],
    'api/assistant/review/stream?turn=s1': [() => sse('s1', answer('a', 'done'))],
  });
  const c = createAssistantChat();
  await c.sync();
  expect([asked, c.chat.messages.map((m) => m.id), text(c.chat.messages[1]), c.getState().activeStreamId]).toEqual([['api/assistant', 'api/assistant/review/stream?turn=s1', 'api/assistant'], ['q', 'a'], 'done', null]);
});

test('sync: a turn over by the time it is followed (204) is not followed again; its end, told by the server, brings the history', async () => {
  const q = msg('q', 'user', 'question');
  const asked = serve({
    'api/assistant': [() => history([q], 's1'), () => history([q, msg('a', 'assistant', 'answer')])],
    'api/assistant/review/stream?turn=s1': [none],
  });
  const c = createAssistantChat();
  await c.sync();
  expect(asked).toEqual(['api/assistant', 'api/assistant/review/stream?turn=s1']);
  await c.sync(); // SSE `assistant`: the turn ended
  expect(text(c.chat.messages[1])).toBe('answer');
});

test('sync is single-flight: asked again while one is out, one more runs after it, and the newest history wins', async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const asked = serve({ 'api/assistant': [async () => {
    await slow;
    return history([msg('old', 'user', 'old')]);
  }, () => history([msg('new', 'user', 'new')])] });
  const c = createAssistantChat();
  const all = [c.sync(), c.sync(), c.sync()];
  release();
  await Promise.all(all);
  expect([asked.length, c.chat.messages.map((m) => m.id)]).toEqual([2, ['new']]);
});

test('a question refused (another window asked first): the history again, the question back in the composer, why shown', async () => {
  const a = msg('a', 'user', 'from another window');
  serve({
    'POST api/assistant': [() => new Response('This conversation changed in another window.', { status: 409 })],
    'api/assistant': [() => history([a])],
  });
  const c = createAssistantChat();
  await c.chat.sendMessage({ text: 'mine' });
  await until(() => c.getState().draft !== undefined);
  expect([c.chat.messages.map((m) => m.id), c.getState().draft, c.getState().error]).toEqual([['a'], 'mine', 'This conversation changed in another window.']);
});

test('Stop names the running turn; a reconnect follows it again', async () => {
  const stopped: unknown[] = [];
  const asked = serve({
    'api/assistant': [() => history([], 's1')],
    'api/assistant/review/stream?turn=s1': [none],
    'POST api/assistant/stop': [(init) => {
      stopped.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 204 });
    }],
  });
  const c = createAssistantChat();
  await c.sync();
  await c.stop();
  expect(stopped).toEqual([{ streamId: 's1' }]);
  c.connected({ live: false, started: null });
  c.connected({ live: true, started: null });
  await until(() => asked.filter((u) => u.includes('stream')).length === 2);
});

test('two pages ask at once: the losing page shows its question until refused, then follows the winner\'s turn', async () => {
  let refuse!: () => void;
  const refused = new Promise<void>((r) => (refuse = r));
  const theirs = msg('b', 'user', 'theirs');
  const asked = serve({
    'POST api/assistant': [async () => {
      await refused;
      return new Response('This conversation changed in another window.', { status: 409 });
    }],
    'api/assistant': [() => history([theirs], 'B'), () => history([theirs], 'B'), () => history([theirs, msg('a', 'assistant', 'answered')])],
    'api/assistant/review/stream?turn=B': [() => sse('B', answer('a', 'answered'))],
  });
  const c = createAssistantChat();
  const sending = c.chat.sendMessage({ text: 'mine' });
  await until(() => asked.includes('POST api/assistant'));
  await c.sync(); // SSE: their turn started, while this page's question is out
  expect([text(c.chat.messages[0]), asked.includes('api/assistant/review/stream?turn=B')]).toEqual(['mine', false]);
  refuse();
  await sending;
  await until(() => c.chat.messages.length === 2 && c.getState().draft === 'mine');
  expect([c.chat.messages.map((m) => m.id), text(c.chat.messages[1]), asked.filter((u) => u.includes('stream'))]).toEqual([['b', 'a'], 'answered', ['api/assistant/review/stream?turn=B']]);
});

test('a stream that drops while the page\'s event stream stays up: the history again, and the turn followed again', async () => {
  const q = msg('q', 'user', 'question');
  const dropped = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(frames({ type: 'start', messageId: 'a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'part' })));
    c.error(new Error('network'));
  } });
  const asked = serve({
    'api/assistant': [() => history([q], 's1'), () => history([q], 's1'), () => history([q, msg('a', 'assistant', 'whole')])],
    'api/assistant/review/stream?turn=s1': [() => sse('s1', dropped), () => sse('s1', answer('a', 'whole'))],
  });
  const c = createAssistantChat();
  await c.sync();
  await until(() => text(c.chat.messages[1]) === 'whole' && asked.length === 5);
  expect(asked.filter((u) => u.includes('stream'))).toHaveLength(2);
});

test('a failed snapshot still runs the sync queued behind it', async () => {
  let fail!: () => void;
  const failing = new Promise<void>((r) => (fail = r));
  serve({ 'api/assistant': [async () => {
    await failing;
    throw new Error('offline');
  }, () => history([msg('q', 'user', 'saved')])] });
  const c = createAssistantChat();
  const first = c.sync();
  const queued = c.sync();
  fail();
  await Promise.all([first, queued]);
  expect([c.chat.messages.map((m) => m.id), c.getState().error]).toEqual([['q'], undefined]);
});

test('a failed sync keeps the transcript and leaves no turn running, so Send is usable', async () => {
  const q = msg('q', 'user', 'saved');
  serve({ 'api/assistant': [() => history([q], 's1'), () => new Response('Invalid assistant settings', { status: 503 })], 'api/assistant/review/stream?turn=s1': [none] });
  const c = createAssistantChat();
  await c.sync();
  expect(c.getState().activeStreamId).toBe('s1');
  await c.sync();
  expect([c.chat.messages.map((m) => m.id), c.getState().activeStreamId, c.getState().error]).toEqual([['q'], null, 'Invalid assistant settings']);
});
