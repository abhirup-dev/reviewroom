import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamText, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { assistantLaunch, assistantRoutes, instructions, readAssistantSettings, withContext, type Live } from './assistant.ts';
import { LINK_IN_TEXT, parseRef } from '../../src/kernel/refs/refs.shared.ts';
import { PKG } from './paths.ts';
import { assistantStore } from './assistant-store.ts';

const revs = { base: 'b0', head: 'h0' };
const settings = { defaultAgentHarness: 'claude' as const, defaultReviewModel: 'sonnet', reviewAgentPromptFile: path.join(PKG, 'templates/assistant-prompt.md') };
const quote = { text: 'return x;', messageId: '', ref: 'rr:code/src/a.ts#L4-6', label: 'src/a.ts:4-6' };
const user = (text: string, metadata?: unknown): UIMessage => ({ id: text, role: 'user', parts: [{ type: 'text', text }], metadata });

test('machine settings default when absent and accept a model alongside existing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-settings-'));
  const file = path.join(dir, 'config.json');
  try {
    const defaultPrompt = path.join(PKG, 'templates/assistant-prompt.md');
    expect(readAssistantSettings(file)).toEqual({ defaultAgentHarness: 'claude', defaultReviewModel: 'sonnet', reviewAgentPromptFile: defaultPrompt });
    const existing = '{"publicOrigin":"https://review.example","defaultReviewModel":"claude-custom-model"}';
    fs.writeFileSync(file, existing);
    expect(readAssistantSettings(file)).toEqual({ defaultAgentHarness: 'claude', defaultReviewModel: 'claude-custom-model', reviewAgentPromptFile: defaultPrompt });
    for (const invalid of ['{', '{"defaultAgentHarness":"codex"}', '{"defaultReviewModel":" "}']) {
      fs.writeFileSync(file, invalid);
      expect(() => readAssistantSettings(file)).toThrow(`Invalid assistant settings in ${file}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a configured prompt resolves beside settings and replaces the default while retaining review context and skill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-prompt-'));
  const file = path.join(dir, 'config.json');
  const prompt = path.join(dir, 'review-agent.md');
  try {
    fs.writeFileSync(file, JSON.stringify({ reviewAgentPromptFile: 'review-agent.md' }));
    fs.writeFileSync(prompt, 'Explain tradeoffs first. Keep {{literal}} unchanged.');
    expect(readAssistantSettings(file).reviewAgentPromptFile).toBe(prompt);
    const text = instructions('repository', 'review-directory', { base: 'base-sha', head: 'head-sha' }, readAssistantSettings(file).reviewAgentPromptFile);
    expect(text).toStartWith('Explain tradeoffs first. Keep {{literal}} unchanged.');
    expect(text).not.toContain('You are the assistant beside');
    expect(text).toContain('base-sha..head-sha of repository');
    expect(text).toContain('review-directory/review.html');
    expect(text).toContain(fs.readFileSync(path.join(PKG, 'skills/reviewroom/SKILL.md'), 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ reviewAgentPromptFile: prompt }));
    expect(readAssistantSettings(file).reviewAgentPromptFile).toBe(prompt);
    fs.writeFileSync(prompt, '  ');
    expect(() => instructions('r', 'd', { base: 'b', head: 'h' }, prompt)).toThrow('prompt file is empty');
    expect(() => instructions('r', 'd', { base: 'b', head: 'h' }, path.join(dir, 'missing.md'))).toThrow('missing.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new question carries its attached context, once, before the question', () => {
  const earlier = user('first', { custom: { quote } });
  const out = withContext([earlier, { id: 'a', role: 'assistant', parts: [] }, user('why?', { custom: { quote } })], revs);
  expect(out[0]).toBe(earlier); // history the native session already has is not repeated
  const parts = out.at(-1)!.parts as { text: string }[];
  expect(parts.map((p) => p.text)).toEqual([expect.stringContaining('rr:code/src/a.ts#L4-6 (head = h0)'), 'why?']);
  // an approval continues the turn that already had its context: nothing is added again
  const continuation = [user('do it', { custom: { quote } }), { id: 'a', role: 'assistant' as const, parts: [] }];
  expect(withContext(continuation, revs)).toEqual(continuation);
});

test('every link the agent is shown as an example is one Review Room opens', () => {
  const links = instructions('repo', 'dir', { base: 'main', head: 'HEAD' }).split('The Review Room skill follows')[0].match(LINK_IN_TEXT)!;
  expect(links.map((l) => parseRef(l)?.type)).toEqual(['code', 'code', 'sym', 'doc']);
  expect(parseRef(links[1])).toMatchObject({ rev: 'base', start: 8 });
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

// The routes below run AI SDK's real stream (a mock model) in place of the native session.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function reviewWithAgent(finish = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-routes-'));
  const calls = { launched: 0, stopped: 0 };
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'partial answer' });
          if (!finish) return; // the answer stays open until it is stopped
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
          c.close();
        },
      }),
    }),
  });
  const launch = async () => {
    calls.launched++;
    return { agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) }, session: {}, checkpoint: async () => {}, stop: async () => void calls.stopped++ } as unknown as Live;
  };
  const routes = assistantRoutes({ repo: dir, dir, cfg: { base: 'b', head: 'h' }, readSettings: () => settings, launch });
  const post = (messages: UIMessage[], init: RequestInit = {}) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages }), ...init });
  const saved = () => assistantStore(dir, dir).saved.messages;
  return { dir, calls, routes, post, saved, [Symbol.dispose]: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** The id the window gets for the answer, once the stream ends. */
const answerId = async (res: Response) => (await res.text()).match(/"type":"start","messageId":"([^"]+)"/)![1];

test('one question at a time: a second one while the first is still arriving is refused; an invalid one frees the turn', async () => {
  using r = reviewWithAgent();
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const slow = r.routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ start: (c) => void (send = c) }), duplex: 'half' } as RequestInit);
  await Bun.sleep(10);
  const second = await r.post([user('q2')]);
  expect([second.status, await second.text()]).toEqual([409, 'The assistant is already answering a question.']);
  send.enqueue(new TextEncoder().encode('{broken'));
  send.close();
  expect((await slow).status).toBe(400);
  expect((await r.post([user('q3')])).status).toBe(200);
});

test('a stopped answer is saved under the id the window has, and the next question follows it', async () => {
  using r = reviewWithAgent(false);
  const stop = new AbortController();
  const res = await r.post([user('q1')], { signal: stop.signal });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const id = first.match(/"messageId":"([^"]+)"/)![1];
  stop.abort();
  await reader.cancel().catch(() => {});
  await Bun.sleep(50);
  expect(r.saved().map((m) => m.id)).toEqual(['q1', id]);
  const next = await r.post([...r.saved(), user('q2')]);
  expect(next.status).toBe(200); // the stopped turn freed the assistant
});

test('a window that missed a turn must reload; an approval, which answers the last message in place, goes on', async () => {
  using r = reviewWithAgent();
  const id = await answerId(await r.post([user('q1')]));
  const transcript = r.saved();
  expect(transcript.map((m) => m.id)).toEqual(['q1', id]);
  // another window, still showing nothing
  const stale = await r.post([user('q2')]);
  expect([stale.status, await stale.text()]).toEqual([409, 'This conversation changed in another window. Reload the page to continue it.']);
  expect(r.saved()).toEqual(transcript); // nothing written
  const answered = { ...transcript[1], parts: [...transcript[1].parts, { type: 'text' as const, text: 'approval answered' }] };
  const res = await r.post([transcript[0], answered]);
  expect(res.status).toBe(200);
  await res.text();
  expect(r.saved().map((m) => m.id)).toEqual(['q1', id]); // the same answer, continued
  expect(JSON.stringify(r.saved()[1])).toContain('approval answered');
  expect(r.calls.launched).toBe(1);
});

test('closing stops a running answer, saves it and stops the agent once', async () => {
  using r = reviewWithAgent(false);
  const res = await r.post([user('q1')]);
  void res.text();
  await Bun.sleep(10);
  await Promise.all([r.routes.close(), r.routes.close()]);
  expect(r.saved().map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(r.calls.stopped).toBe(1);
  expect((await r.post([...r.saved(), user('q2')])).status).toBe(409);
});

test('a failed start keeps the question, so the same window can ask again', async () => {
  using r = reviewWithAgent();
  let fail = true;
  const routes = assistantRoutes({ repo: r.dir, dir: r.dir, cfg: { base: 'b', head: 'h' }, readSettings: () => settings, launch: async () => {
    if (fail) throw new Error('bridge did not start');
    throw new Error('started');
  } });
  const ask = (messages: UIMessage[]) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages }) });
  const res = await ask([user('q1')]);
  expect([res.status, await res.text()]).toEqual([503, 'bridge did not start']);
  fail = false;
  expect(await (await ask([user('q1'), user('q2')])).text()).toBe('started'); // not "reload": the window was in step
});

test('a broken conversation or settings disable only the assistant, and keep what was saved', async () => {
  using r = reviewWithAgent();
  const file = path.join(r.dir, 'assistant.json');
  fs.writeFileSync(file, '{broken');
  const get = async () => { const res = await r.routes.app.request('/'); return [res.status, await res.text()] as const; };
  expect(await get()).toEqual([503, expect.stringContaining('is not valid JSON')]);
  const aside = fs.readdirSync(r.dir).filter((f) => f.startsWith('assistant.json.corrupt-'));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(path.join(r.dir, aside[0]), 'utf8')).toBe('{broken');
  expect(await get()).toEqual([503, expect.stringContaining('was moved aside')]); // never a silent new conversation
  fs.renameSync(path.join(r.dir, aside[0]), file);
  fs.writeFileSync(file, JSON.stringify({ version: 1, repo: '/another/checkout', messages: [user('mine')] }));
  expect(await get()).toEqual([503, expect.stringContaining('was started in /another/checkout')]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).messages).toEqual([user('mine')]);
  const invalid = assistantRoutes({ repo: r.dir, dir: r.dir, cfg: { base: 'b', head: 'h' }, readSettings: () => { throw new Error('Invalid assistant settings in config.json'); } });
  const model = await invalid.app.request('/model');
  expect([model.status, await model.text()]).toEqual([503, 'Invalid assistant settings in config.json']);
});

test('the store is private to its review and writes atomically', () => {
  using r = reviewWithAgent();
  const store = assistantStore(r.dir, r.dir);
  store.saved.messages = [user('why?', { custom: { quote } })];
  store.write();
  expect(assistantStore(r.dir, r.dir).saved.messages).toEqual(store.saved.messages);
  expect(fs.statSync(path.join(r.dir, 'assistant.json')).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(r.dir)).toEqual(['assistant.json']);
});
