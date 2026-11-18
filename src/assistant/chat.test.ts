import { afterEach, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { createAssistantChat } from './chat';

const real = globalThis.fetch;
afterEach(() => void (globalThis.fetch = real));
const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });
const history = (messages: UIMessage[], running: boolean) => Response.json({ model: 'm', instance: 'i', status: running ? 'working' : 'idle', messages, running });
const sse = (...chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
const until = async (ok: () => boolean) => { for (let i = 0; !ok(); i++) { if (i > 100) throw new Error('timed out'); await Bun.sleep(10); } };
/** Answers each URL from its queue (the last answer repeats); `asked` records the URLs. */
function serve(routes: Record<string, (() => Response)[]>) {
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    const url = String(u);
    asked.push(url);
    const q = routes[url];
    return (q.length > 1 ? q.shift()! : q[0])();
  }) as typeof fetch;
  return asked;
}
const text = (m: UIMessage | undefined) => m?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

test('sync: the history goes in; a running turn is followed from the resume route, then synced again at its end', async () => {
  const q = msg('q', 'user', 'generate');
  const asked = serve({
    'api/assistant': [() => history([q], true), () => history([q, msg('a', 'assistant', 'done')], false)],
    'api/assistant/review/stream': [() => sse({ type: 'start', messageId: 'a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish' })],
  });
  const c = createAssistantChat();
  expect((await c.sync()).running).toBe(true);
  await until(() => asked.filter((u) => u === 'api/assistant').length === 2); // the turn's end synced again
  expect([c.chat.messages.map((m) => m.id), text(c.chat.messages[1]), c.asked()]).toEqual([['q', 'a'], 'done', false]); // followed, not sent
});

test('sync: a resume that finds the turn over (204) takes the fresh history instead', async () => {
  const q = msg('q', 'user', 'question');
  const asked = serve({
    'api/assistant': [() => history([q], true), () => history([q, msg('a', 'assistant', 'answer')], false)],
    'api/assistant/review/stream': [() => new Response(null, { status: 204 })],
  });
  const c = createAssistantChat();
  await c.sync();
  await until(() => c.chat.messages.length === 2);
  expect([text(c.chat.messages[1]), asked]).toEqual(['answer', ['api/assistant', 'api/assistant/review/stream', 'api/assistant']]);
});
