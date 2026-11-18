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

const STREAM = 'api/assistant/review/stream?turn=s1';
const q = msg('q', 'user', 'question');
const a = msg('a', 'assistant', 'whole');

test('sync: the history goes in, the turn it names is followed to its end, then the history again; single-flight: asked while one is out, one more runs after it', async () => {
  const asked = serve({ 'api/assistant': [() => history([q], 's1'), () => history([q, a])], [STREAM]: [() => sse('s1', answer('a', 'done'))] });
  const c = createAssistantChat();
  await c.sync();
  await until(() => asked.length === 3);
  expect([asked, c.chat.messages.map((m) => m.id), text(c.chat.messages[1]), c.getState().activeStreamId]).toEqual([['api/assistant', STREAM, 'api/assistant'], ['q', 'a'], 'whole', null]);
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const again = serve({ 'api/assistant': [async () => {
    await slow;
    return history([msg('old', 'user', 'old')]);
  }, () => history([msg('new', 'user', 'new')])] });
  const all = [c.sync(), c.sync(), c.sync()];
  release();
  await Promise.all(all);
  expect([again.length, c.chat.messages.map((m) => m.id)]).toEqual([2, ['new']]);
});

const stalls = () => sse('s1', new ReadableStream({ start: (ctl) => ctl.enqueue(new TextEncoder().encode(frames({ type: 'start', messageId: 'a' }))) }));
const drops = () => sse('s1', new ReadableStream({ start(ctl) {
  ctl.enqueue(new TextEncoder().encode(frames({ type: 'start', messageId: 'a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'part' })));
  ctl.error(new Error('network'));
} }));
type Chat = ReturnType<typeof createAssistantChat>;
// The snapshot is the truth: whatever goes wrong, the page takes it again once and Send is usable (no turn running).
test.each([
  ['a question refused (another window asked first): its text back in the composer, why shown', { 'POST api/assistant': [() => new Response('This conversation changed in another window.', { status: 409 })], 'api/assistant': [() => history([msg('b', 'user', 'theirs')])] },
    async (c: Chat) => {
      await c.chat.sendMessage({ text: 'mine' });
      await until(() => c.getState().draft === 'mine');
      expect(c.getState().error).toBe('This conversation changed in another window.');
    }, ['b']],
  ['its turn over by the time it is followed (204), its end event missed', { 'api/assistant': [() => history([q], 's1'), () => history([q, a])], [STREAM]: [none] }, (c: Chat) => c.sync(), ['q', 'a']],
  ['a stream that drops while the page\'s event stream stays up: no retry until the server says more', { 'api/assistant': [() => history([q], 's1'), () => history([q, a])], [STREAM]: [drops] },
    async (c: Chat) => {
      await c.sync();
      await Bun.sleep(30);
      expect([c.chat.messages.map((m) => m.id), c.getState().activeStreamId]).toEqual([['q'], 's1']); // no snapshot asked again
      await c.sync(); // the turn's end (SSE)
    }, ['q', 'a']],
  ['a stalled replay while the server ends the turn (its event)', { 'api/assistant': [() => history([q], 's1'), () => history([q, a])], [STREAM]: [stalls] },
    async (c: Chat) => {
      await c.sync();
      await Bun.sleep(30); // attached, its stream stalled
      await c.sync();
    }, ['q', 'a']],
  ['a failed snapshot: the transcript kept, the sync queued behind it still runs', { 'api/assistant': [() => history([q], 's1'), () => new Response('Invalid assistant settings', { status: 503 }), () => history([q])], [STREAM]: [stalls] },
    async (c: Chat) => {
      await c.sync();
      await Promise.all([c.sync(), c.sync()]);
    }, ['q']],
] as const)('%s: one resync, Send usable', async (_, routes, act, ids) => {
  serve(routes as never);
  const c = createAssistantChat();
  await act(c);
  await until(() => c.chat.messages.length === ids.length && !c.getState().activeStreamId);
  expect(c.chat.messages.map((m) => m.id)).toEqual([...ids]);
});

test('Stop names the running turn; a reconnect follows it again', async () => {
  const stopped: unknown[] = [];
  const asked = serve({
    'api/assistant': [() => history([], 's1')],
    [STREAM]: [stalls],
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
  await until(() => asked.filter((u) => u === 'api/assistant').length === 2);
});
