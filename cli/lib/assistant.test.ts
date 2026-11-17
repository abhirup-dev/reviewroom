import { expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { assistantLaunch, assistantRoutes, instructions, withContext } from './assistant.ts';
import { LINK_IN_TEXT, parseRef } from '../../src/kernel/refs/refs.shared.ts';

const revs = { base: 'b0', head: 'h0' };
const quote = { text: 'return x;', messageId: '', ref: 'rr:code/src/a.ts#L4-6', label: 'src/a.ts:4-6' };
const user = (text: string, metadata?: unknown): UIMessage => ({ id: text, role: 'user', parts: [{ type: 'text', text }], metadata });

test('a new question carries its attached context, once, before the question', () => {
  const earlier = user('first', { custom: { quote } });
  const out = withContext([earlier, { id: 'a', role: 'assistant', parts: [] }, user('why?', { custom: { quote } })], revs);
  expect(out[0]).toBe(earlier); // history the native session already has is not repeated
  const parts = out.at(-1)!.parts as { text: string }[];
  expect(parts.map((p) => p.text)).toEqual([expect.stringContaining('rr:code/src/a.ts#L4-6 (head = h0)'), 'why?']);
});

test('an approval continuation and a plain question are left as they are', () => {
  const continuation = [user('do it', { custom: { quote } }), { id: 'a', role: 'assistant' as const, parts: [] }];
  expect(withContext(continuation, revs)).toBe(continuation);
  const plain = [user('hi')];
  expect(withContext(plain, revs)).toBe(plain);
});

test('a question with an invalid context is refused', async () => {
  const { app } = assistantRoutes({ repo: '.', dir: '.', cfg: { base: 'main', head: 'HEAD' } });
  const bad = user('x', { custom: { quote: { ...quote, ref: 'rr:thread/t1' } } });
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages: [bad] }) });
  expect(res.status).toBe(400);
});

test('every link the agent is shown as an example is one Review Room opens', () => {
  const links = instructions('repo', 'dir', { base: 'main', head: 'HEAD' }).split('The Review Room skill follows')[0].match(LINK_IN_TEXT)!;
  expect(links.map((l) => parseRef(l)?.type)).toEqual(['code', 'code', 'sym', 'doc']);
  expect(parseRef(links[1])).toMatchObject({ rev: 'base', start: 8 });
});

test('the assistant takes only new messages: the native session cannot branch', async () => {
  const { app } = assistantRoutes({ repo: '.', dir: '.', cfg: { base: 'main', head: 'HEAD' } });
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'regenerate-message', messages: [] }) });
  expect(res.status).toBe(400);
});

// This runs a real child: subscription overrides and PATH changes must not leak back into the review server.
test('Bun bridge launch clears only child auth overrides and preserves host PATH', async () => {
  const before = process.env.PATH;
  const script = 'console.log(JSON.stringify({key:process.env.ANTHROPIC_API_KEY??null,path:process.env.PATH}))';
  const child = Bun.spawn(['sh', '-c', assistantLaunch(`node -e '${script}'`)], { env: { ...process.env, ANTHROPIC_API_KEY: 'probe-not-a-real-key' }, stdout: 'pipe', stderr: 'pipe' });
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out.key).toBeNull();
  expect(out.path).toBe(before);
  expect(process.env.PATH).toBe(before);
});
