import { afterEach, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { createAssistantChat } from './chat';

const real = globalThis.fetch;
afterEach(() => void (globalThis.fetch = real));
const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });
const history = (messages: UIMessage[], activeStreamId: string | null = null) => Response.json({ model: 'm', status: activeStreamId ? 'working' : 'idle', messages, activeStreamId, origin: activeStreamId && 'question' });
const sse = (...chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
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
    'api/assistant/review/stream?turn=s1': [() => sse({ type: 'start', messageId: 'a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish' })],
  });
  const c = createAssistantChat();
  await c.sync();
  expect([asked, c.chat.messages.map((m) => m.id), text(c.chat.messages[1]), c.getState().activeStreamId]).toEqual([['api/assistant', 'api/assistant/review/stream?turn=s1', 'api/assistant'], ['q', 'a'], 'done', null]);
});

test('sync: a turn over by the time it is followed (204) leaves the fresh history', async () => {
  const q = msg('q', 'user', 'question');
  const asked = serve({
    'api/assistant': [() => history([q], 's1'), () => history([q, msg('a', 'assistant', 'answer')])],
    'api/assistant/review/stream?turn=s1': [() => new Response(null, { status: 204 })],
  });
  const c = createAssistantChat();
  await c.sync();
  expect([text(c.chat.messages[1]), asked]).toEqual(['answer', ['api/assistant', 'api/assistant/review/stream?turn=s1', 'api/assistant']]);
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
    'api/assistant/review/stream?turn=s1': [() => new Response(null, { status: 204 })],
    'POST api/assistant/stop': [(init) => {
      stopped.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 204 });
    }],
  });
  const c = createAssistantChat();
  await c.sync(); // followed once: the same turn again is not followed twice
  await c.stop();
  expect(stopped).toEqual([{ streamId: 's1' }]);
  c.connected(false);
  c.connected(true);
  await until(() => asked.filter((u) => u.includes('stream')).length === 2);
});
