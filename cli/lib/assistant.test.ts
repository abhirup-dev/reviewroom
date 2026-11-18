import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamText, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { assistantEnabled, assistantLaunch, assistantRoutes, instructions, readAssistantSettings, withContext, type Live } from './assistant.ts';
import { PKG } from './paths.ts';
import { assistantStore } from './assistant-store.ts';
import { progressLines } from './progress.ts';
/** Polls until `fn` holds (CLI tests import only shared modules, so not src/testing/wait.ts). */
async function until(fn: () => unknown, timeout = 5000) {
  for (const end = Date.now() + timeout; !fn(); await Bun.sleep(10)) if (Date.now() > end) throw new Error('until: timed out');
}

const revs = { base: 'b0', head: 'h0' };
const settings = { defaultAgentHarness: 'claude' as const, defaultReviewModel: 'sonnet', reviewAgentPromptFile: path.join(PKG, 'templates/assistant-prompt.md') };
const quote = { text: 'return x;', messageId: '', ref: 'rr:code/src/a.ts#L4-6', label: 'src/a.ts:4-6' };
const user = (text: string, metadata?: unknown): UIMessage => ({ id: text, role: 'user', parts: [{ type: 'text', text }], metadata });

test('the agent bootstrap includes the pinned harness bridge dependencies', () => {
  const bridge = path.join(path.dirname(Bun.resolveSync('@ai-sdk/harness-acp', PKG)), 'bridge/package.json');
  const { dependencies } = JSON.parse(fs.readFileSync(bridge, 'utf8'));
  const agent = JSON.parse(fs.readFileSync(path.join(PKG, 'cli/lib/assistant-agent/package.json'), 'utf8'));
  expect(agent.dependencies).toMatchObject(dependencies);
});

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

test('a configured role replaces the default; instance context references the native skill without embedding it', () => {
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
    expect(text).toContain('"base": "base-sha"');
    expect(text).toContain('"directory": "review-directory"');
    expect(text).toContain('native reviewroom:reviewroom skill');
    expect(text).not.toContain(fs.readFileSync(path.join(PKG, 'skills/reviewroom/SKILL.md'), 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ reviewAgentPromptFile: prompt }));
    expect(readAssistantSettings(file).reviewAgentPromptFile).toBe(prompt);
    fs.writeFileSync(file, JSON.stringify({ claudeExecutable: './bin/claude-custom' }));
    expect(readAssistantSettings(file).claudeExecutable).toBe(path.join(dir, 'bin/claude-custom'));
    fs.writeFileSync(file, JSON.stringify({ claudeExecutable: 'claude-custom' }));
    expect(readAssistantSettings(file).claudeExecutable).toBe('claude-custom');
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
/** `unfinished`: what the native session says after a turn (true: it waits on an approval). */
function reviewWithAgent(finish = true, unfinished = () => false) {
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
    return { agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) }, session: { hasUnfinishedTurn: unfinished }, checkpoint: async () => {}, stop: async () => void calls.stopped++ } as unknown as Live;
  };
  const sent: string[] = [];
  const routes = assistantRoutes({ repo: dir, dir, cfg: { base: 'b', head: 'h' }, readSettings: () => settings, launch, send: (event) => void sent.push(event) });
  const generate = async (headers: Record<string, string> = {}) => { const res = await routes.generate.request('/', { method: 'POST', headers }); return [res.status, await res.json()] as const; };
  const events = () => progressLines(dir).map((l) => `${l.artifact} ${l.event}${'by' in l ? ` ${l.by}` : ''}${'reason' in l ? ` ${l.reason}` : ''}`);
  const post = (messages: UIMessage[], init: RequestInit = {}) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages }), ...init });
  const saved = () => assistantStore(dir, dir).saved.messages;
  return { dir, calls, routes, post, saved, sent, generate, events, [Symbol.dispose]: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
  expect((await (await r.routes.app.request('/model')).json()).status).toBe('interrupted');
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
  const reopened = assistantRoutes({ repo: r.dir, dir: r.dir, cfg: { base: 'b', head: 'h' }, readSettings: () => settings });
  const restored = await (await reopened.app.request('/')).json();
  expect(restored.status).toBe('interrupted');
  expect(restored.messages.map((m: UIMessage) => m.id)).toEqual(r.saved().map((m) => m.id));
  expect((await r.post([...r.saved(), user('q2')])).status).toBe(409);
});

test('a server restart marks an unfinished turn interrupted and keeps the transcript', async () => {
  using r = reviewWithAgent();
  const store = assistantStore(r.dir, r.dir);
  store.saved.messages = [user('unfinished')];
  store.saved.status = 'working';
  store.write();
  const restored = await (await r.routes.app.request('/')).json();
  expect(restored.status).toBe('interrupted');
  expect(restored.messages).toEqual(store.saved.messages);
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

test('generate requests both documents of the assistant and starts one turn; asking again while it runs starts nothing', async () => {
  using r = reviewWithAgent(false);
  const [status, body] = await r.generate();
  expect([status, body.started, body.generation]).toEqual([200, true, { running: true, awaitingApproval: false }]);
  expect(body.walkthrough).toEqual({ state: 'requested', by: 'assistant' });
  expect(r.events()).toEqual(['walkthrough requested assistant', 'report requested assistant']);
  await until(() => r.calls.launched === 1);
  const [again, running] = await r.generate();
  expect([again, running.started, running.generation.running]).toEqual([200, false, true]);
  expect(r.events()).toHaveLength(2);
  const chat = await r.post([user('q1')]);
  expect([chat.status, await chat.text()]).toEqual([409, 'The assistant is writing the review.']);
  expect(r.saved().map((m) => m.role)).toEqual(['user']); // the generate prompt, in the transcript
  await r.routes.close(); // the server closing: what the turn did not validate was interrupted, not failed
  expect(r.events().slice(2)).toEqual(['walkthrough stopped interrupted', 'report stopped interrupted']);
  expect(r.calls.launched).toBe(1);
});

test('a generation turn that ends without validating stops its documents as failed and tells the pages', async () => {
  using r = reviewWithAgent();
  expect((await r.generate())[0]).toBe(200);
  await until(() => r.events().length === 4);
  expect(r.events().slice(2)).toEqual(['walkthrough stopped failed', 'report stopped failed']);
  expect(r.sent).toContain('assistant');
  expect(r.sent.at(-2)).toBe('progress');
  expect(r.saved().map((m) => m.role)).toEqual(['user', 'assistant']);
  const [, after] = await r.generate(); // a new generation may start
  expect(after.started).toBe(true);
});

test('generate is busy while the assistant answers the reviewer, and refused through the hub', async () => {
  using r = reviewWithAgent(false);
  const chat = await r.post([user('q1')]);
  void chat.text();
  const [status, body] = await r.generate();
  expect([status, body.code]).toEqual([409, 'busy']);
  expect(r.events()).toEqual([]);
  const [hub, refused] = await r.generate({ 'x-reviewroom-via-hub': '1' });
  expect([hub, refused.code]).toEqual([403, 'via_hub']);
  await r.routes.close();
});

test('a generation turn paused with nothing it can approve keeps running until the panel continues it', async () => {
  let waiting = true;
  using r = reviewWithAgent(true, () => waiting);
  await r.generate();
  await until(() => r.sent.includes('assistant'));
  const [, paused] = await r.generate();
  expect([paused.started, paused.generation]).toEqual([false, { running: true, awaitingApproval: true }]);
  expect(paused.report.state).toBe('requested'); // neither failed nor stopped
  expect(r.events()).toHaveLength(2);
  waiting = false;
  const [ask, answer] = r.saved();
  const res = await r.post([ask, { ...answer, parts: [...answer.parts, { type: 'text' as const, text: 'approved' }] }]);
  expect(res.status).toBe(200);
  await res.text();
  await until(() => r.events().length === 4);
  expect(r.events().slice(2)).toEqual(['walkthrough stopped failed', 'report stopped failed']);
  expect((await r.generate())[1].started).toBe(true);
});

test('the assistant is on by REVIEWROOM_ASSISTANT or `assistant: true` in the settings; bad settings leave it off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-on-'));
  const file = path.join(dir, 'config.json');
  const env = process.env.REVIEWROOM_ASSISTANT;
  delete process.env.REVIEWROOM_ASSISTANT;
  try {
    expect(assistantEnabled(file)).toBe(false);
    fs.writeFileSync(file, '{"assistant": true}');
    expect(assistantEnabled(file)).toBe(true);
    fs.writeFileSync(file, '{"assistant": "yes", "defaultAgentHarness": "other"}');
    expect(assistantEnabled(file)).toBe(false);
    fs.writeFileSync(file, '{broken');
    expect(assistantEnabled(file)).toBe(false);
    process.env.REVIEWROOM_ASSISTANT = '1';
    expect(assistantEnabled(file)).toBe(true);
  } finally {
    if (env === undefined) delete process.env.REVIEWROOM_ASSISTANT; else process.env.REVIEWROOM_ASSISTANT = env;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a generation turn approves its own tool requests and finishes without pausing for the reviewer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-approve-'));
  const prompts: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt);
      const first = calls++ === 0;
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        if (first) {
          c.enqueue({ type: 'tool-call', toolCallId: 'c1', toolName: 'Write', input: '{"file_path":"walkthrough.json"}', providerExecuted: true, dynamic: true });
          c.enqueue({ type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' });
        } else {
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'done' });
          c.enqueue({ type: 'text-end', id: 't' });
        }
        c.enqueue({ type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage });
        c.close();
      } }) };
    },
  });
  const sent: unknown[] = [];
  const launch = async () => ({ agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) }, session: { hasUnfinishedTurn: () => calls === 1 }, checkpoint: async () => {}, stop: async () => {} }) as unknown as Live;
  const routes = assistantRoutes({ repo: dir, dir, cfg: { base: 'b', head: 'h' }, readSettings: () => settings, launch, send: (event, data) => void sent.push([event, data]) });
  try {
    expect((await routes.generate.request('/', { method: 'POST' })).status).toBe(200);
    await until(() => progressLines(dir).length === 4);
    expect(calls).toBe(2); // the approval continued the same turn
    expect(JSON.stringify(prompts[1])).toContain('"approved":true');
    expect(JSON.stringify(sent)).not.toContain('"awaitingApproval":true');
    const parts = assistantStore(dir, dir).saved.messages.at(-1)!.parts as { type: string; state?: string }[];
    expect(parts.find((p) => p.type === 'dynamic-tool')?.state).toBe('approval-responded');
  } finally {
    await routes.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing a generation leaves an agent\'s request made meanwhile (pr --force) alone', async () => {
  using r = reviewWithAgent(false);
  await r.generate();
  fs.appendFileSync(path.join(r.dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), artifact: 'report', event: 'requested', by: 'agent' }) + '\n');
  await r.routes.close();
  expect(r.events().slice(2)).toEqual(['report requested agent', 'walkthrough stopped interrupted']);
});
