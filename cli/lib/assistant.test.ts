import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamText, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { assistantEnabled, assistantLaunch, assistantRoutes, instructions, readAssistantSettings, withContext, type Live } from './assistant.ts';
import { PKG } from './paths.ts';
import { assistantStore } from './assistant-store.ts';
import { progressLines, readProgress, recordArtifact, requestGeneration } from './progress.ts';
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
    for (const invalid of ['{', '{"defaultAgentHarness":"codex"}', '{"defaultReviewModel":" "}', '{"defaultReviewEffort":"huge"}']) {
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
function reviewWithAgent(finish = true, unfinished = () => false, ready = true, readSettings = () => settings, starting?: Promise<void>) {
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
    await starting; // Claude still starting (or failing to)
    return { agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) }, session: { hasUnfinishedTurn: unfinished }, checkpoint: async () => {}, stop: async () => void calls.stopped++ } as unknown as Live;
  };
  type Told = { activeStreamId: string | null; origin: string | null; generation: { awaitingApproval: boolean } }; // `assistant`'s
  const sent: { event: string; data: Told }[] = [];
  const routes = assistantRoutes({ repo: dir, dir, cfg: { base: 'b', head: 'h' }, readSettings, launch, send: (event, data) => void sent.push({ event, data: data as Told }) });
  if (ready) routes.ready(); // as serve.ts does once it holds the lock
  const generate = async (headers: Record<string, string> = {}) => {
    const res = await routes.generate.request('/', { method: 'POST', headers });
    const text = await res.text();
    return [res.status, (() => { try { return JSON.parse(text); } catch { return { text }; } })()] as const;
  };
  const events = () => progressLines(dir).map((l) => `${l.artifact} ${l.event}${'by' in l ? ` ${l.by}` : ''}${'reason' in l ? ` ${l.reason}` : ''}`);
  const post = (messages: UIMessage[], init: RequestInit = {}) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages }), ...init });
  const saved = () => assistantStore(dir, dir).saved.messages;
  const turn = async (): Promise<string | null> => (await (await routes.app.request('/')).json()).activeStreamId;
  /** Another window following the running turn (or the one named), as the AI SDK resumes it. */
  const follow = async (id?: string | null) => routes.app.request(`/x/stream?turn=${id ?? (await turn())}`);
  const stop = (streamId: string | null) => routes.app.request('/stop', { method: 'POST', body: JSON.stringify({ streamId }) });
  /** Until the pages are told the generation waits on an approval. */
  const awaiting = () => until(() => sent.some((s) => s.event === 'assistant' && s.data.generation.awaitingApproval));
  return { dir, calls, routes, post, saved, sent, generate, events, turn, follow, stop, awaiting, [Symbol.dispose]: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** The id the window gets for the answer, once the stream ends. */
const answerId = async (res: Response) => (await res.text()).match(/"type":"start","messageId":"([^"]+)"/)![1];

test('one question at a time: a second one while the first is answered is refused; an invalid one takes nothing', async () => {
  using r = reviewWithAgent(false);
  expect((await r.routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status).toBe(400);
  const first = await r.post([user('q1')]);
  // the reviewer's other windows follow a question's turn too
  expect([first.status, (await readUntil(await r.follow(), (said) => said.includes('partial answer'))).ended]).toEqual([200, false]);
  const second = await r.post([user('q1'), user('q2')]);
  expect([second.status, await second.text()]).toEqual([409, 'The assistant is already answering a question.']);
  await r.routes.close();
});

test('a window that leaves (the asker\'s too) only stops following: the turn runs on, for the next window', async () => {
  using r = reviewWithAgent(false);
  const asked = await r.post([user('q1')]);
  await (await readUntil(asked, (said) => said.includes('partial answer'))).reader.cancel(); // the page reloads
  expect((await readUntil(await r.follow(), (said) => said.includes('partial answer'))).ended).toBe(false);
  await r.routes.close();
});

test('a window that missed a turn is refused, nothing written (the page syncs, its question kept); an approval, which answers the last message in place, goes on', async () => {
  using r = reviewWithAgent();
  const id = await answerId(await r.post([user('q1')]));
  const transcript = r.saved();
  expect(transcript.map((m) => m.id)).toEqual(['q1', id]);
  // another window, still showing nothing
  const stale = await r.post([user('q2')]);
  expect([stale.status, await stale.text()]).toEqual([409, 'This conversation changed in another window.']);
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
  routes.ready();
  const ask = (messages: UIMessage[]) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages }) });
  const res = await ask([user('q1')]);
  expect([res.status, await res.text()]).toEqual([200, expect.stringContaining('"errorText":"bridge did not start"')]); // the chat's error
  fail = false;
  expect(await (await ask([user('q1'), user('q2')])).text()).toContain('"errorText":"started"'); // not "reload": the window was in step
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
  fs.rmSync(file);
  const invalid = assistantRoutes({ repo: r.dir, dir: r.dir, cfg: { base: 'b', head: 'h' }, readSettings: () => { throw new Error('Invalid assistant settings in config.json'); } });
  invalid.ready();
  const read = async (res: Response) => [res.status, await res.text()];
  expect(await read(await invalid.app.request('/'))).toEqual([503, 'Invalid assistant settings in config.json']);
  const ask = await invalid.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages: [user('q1')] }) });
  expect(await read(ask)).toEqual([503, 'Invalid assistant settings in config.json']);
  expect(fs.existsSync(file)).toBe(false); // read before the question is saved: nothing half-asked
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
  expect(body.walkthrough).toEqual({ state: 'requested', by: 'assistant', request: expect.any(String), since: expect.any(String) });
  expect(r.events()).toEqual(['walkthrough requested assistant', 'report requested assistant']);
  await until(() => r.calls.launched === 1);
  const [again, running] = await r.generate();
  expect([again, running.started, running.generation.running]).toEqual([200, false, true]);
  expect(r.events()).toHaveLength(2);
  const chat = await r.post([user('q1')]);
  expect([chat.status, await chat.text()]).toEqual([409, 'The assistant is writing the review.']);
  expect(r.saved().map((m) => [m.role, m.metadata])).toEqual([['user', { custom: { generate: true } }]]); // the generate prompt, marked (shown folded)
  await r.routes.close(); // the server closing: what the turn did not validate was interrupted, not failed
  expect(r.events().slice(2)).toEqual(['walkthrough stopped interrupted', 'report stopped interrupted']);
  expect(r.calls.launched).toBe(1);
});

/** Reads `res` until `done` holds of what it said so far (or it ends). */
async function readUntil(res: Response, done: (said: string) => boolean = () => false) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let said = '';
  for (let x; !done(said); said += x.value) if ((x = await reader.read()).done) return { said, ended: true, reader };
  return { said, ended: false, reader };
}

test('the resume route: the named turn\'s stream from its start, even while Claude starts, to its end; 204 for a turn not running; refused through the hub (a failed start ends it with why)', async () => {
  let started!: () => void;
  using r = reviewWithAgent(false, () => false, true, () => settings, new Promise<void>((ok) => (started = ok)));
  expect([await r.turn(), (await r.follow('none')).status]).toEqual([null, 204]);
  await r.generate();
  const id = await r.turn();
  expect((await r.routes.app.request(`/x/stream?turn=${id}`, { headers: { 'x-reviewroom-via-hub': '1' } })).status).toBe(403);
  expect((await r.follow('another-turn')).status).toBe(204); // a turn that ended: the page fetches the history again
  const res = await r.follow(id); // before Claude has said anything
  started();
  expect([res.status, res.headers.get('x-vercel-ai-ui-message-stream'), res.headers.get('x-reviewroom-turn'), (await readUntil(res, (said) => said.includes('partial answer'))).said]).toEqual([200, 'v1', id, expect.stringContaining('"type":"start"')]);
  await r.routes.close();
  expect([await r.turn(), (await r.follow(id)).status]).toEqual([null, 204]);

  let failed!: (e: Error) => void;
  using f = reviewWithAgent(false, () => false, true, () => settings, new Promise<void>((_, no) => (failed = no)));
  await f.generate();
  const waiting = await f.follow();
  failed(new Error('Claude did not start'));
  expect(await readUntil(waiting)).toMatchObject({ said: expect.stringContaining('"errorText":"Claude did not start"'), ended: true });
});

test('a generation turn that ends without validating stops its documents as failed and tells the pages', async () => {
  using r = reviewWithAgent();
  expect((await r.generate())[0]).toBe(200);
  await until(() => r.events().length === 4);
  expect(r.events().slice(2)).toEqual(['walkthrough stopped failed', 'report stopped failed']);
  expect(r.sent.slice(-2).map((s) => s.event)).toEqual(['assistant', 'progress']); // the turn ended, then what it left
  expect(r.saved().map((m) => m.role)).toEqual(['user', 'assistant']);
  const [, after] = await r.generate(); // a new generation may start
  expect(after.started).toBe(true);
});

test('a question\'s turn: pages are told it started and ended, with its id; Stop takes only its id; generate is busy meanwhile, and refused through the hub', async () => {
  using r = reviewWithAgent(false);
  const chat = await r.post([user('q1')]);
  void chat.text();
  const id = await r.turn();
  expect(r.sent.slice(1).map((s) => [s.event, s.data.activeStreamId, s.data.origin])).toEqual([['assistant', id, 'question']]); // after ready's
  const [status, body] = await r.generate();
  expect([status, body.code, r.events()]).toEqual([409, 'busy', []]);
  const [hub, refused] = await r.generate({ 'x-reviewroom-via-hub': '1' });
  expect([hub, refused.code]).toEqual([403, 'via_hub']);
  await r.stop('another-turn');
  expect(await r.turn()).toBe(id);
  await r.stop(id);
  await until(() => r.sent.length === 3);
  expect([r.sent[2].data.activeStreamId, assistantStore(r.dir, r.dir).saved.status]).toEqual([null, 'interrupted']);
});

test('Stop never stops a generation (it runs until its turn ends or the server closes)', async () => {
  using r = reviewWithAgent(false);
  await r.generate();
  await r.stop(await r.turn());
  expect(await r.turn()).not.toBeNull();
  await r.routes.close();
});

test('a generation turn paused with nothing it can approve keeps running until the panel continues it', async () => {
  let waiting = true;
  using r = reviewWithAgent(true, () => waiting);
  await r.generate();
  await r.awaiting();
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

test('the assistant is on per review, by `assistant: true` in its config.json; anything else leaves it off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-on-'));
  const file = path.join(dir, 'config.json');
  try {
    expect(assistantEnabled(dir)).toBe(false);
    fs.writeFileSync(file, '{"assistant": true}');
    expect(assistantEnabled(dir)).toBe(true);
    fs.writeFileSync(file, '{"assistant": "yes"}');
    expect(assistantEnabled(dir)).toBe(false);
    fs.writeFileSync(file, '{broken');
    expect(assistantEnabled(dir)).toBe(false);
  } finally {
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

test('nothing starts before the server holds its lock and has recovered: neither generate nor a question', async () => {
  using r = reviewWithAgent(true, () => false, false);
  const [status, body] = await r.generate();
  expect([status, body.code]).toEqual([409, 'starting']);
  expect((await r.post([user('q1')])).status).toBe(409);
  expect(r.events()).toEqual([]);
  expect(fs.existsSync(path.join(r.dir, 'assistant.json'))).toBe(false); // no transcript written either
  r.routes.ready();
  expect((await r.generate())[0]).toBe(200);
  await r.routes.close();
});

test('a failed log append starts nothing and leaves nothing running or half-requested', async () => {
  using r = reviewWithAgent(false);
  fs.mkdirSync(path.join(r.dir, 'progress.jsonl')); // appending fails
  const [status] = await r.generate();
  expect(status).toBe(500);
  expect(r.calls.launched).toBe(0);
  fs.rmdirSync(path.join(r.dir, 'progress.jsonl'));
  const [again, body] = await r.generate(); // not wedged as running
  expect([again, body.started]).toEqual([200, true]);
  expect(r.events()).toEqual(['walkthrough requested assistant', 'report requested assistant']);
  await r.routes.close();
});

test('generate asks only for documents not validated now: a kept PR walkthrough stays validated', async () => {
  using r = reviewWithAgent();
  const walkthrough = path.join(r.dir, 'walkthrough.json');
  fs.writeFileSync(walkthrough, '{}');
  requestGeneration(r.dir, 'agent', undefined, ['walkthrough']);
  recordArtifact(r.dir, 'walkthrough', 'validated', { source: 'pr' });
  const [, body] = await r.generate();
  expect([body.started, body.walkthrough.state, body.report]).toEqual([true, 'validated', expect.objectContaining({ state: 'requested', by: 'assistant' })]);
  await until(() => r.events().includes('report stopped failed'));
  expect(readProgress(r.dir).walkthrough.state).toBe('validated'); // not failed with the turn
  fs.writeFileSync(path.join(r.dir, 'report.html'), '<rr-review></rr-review>');
  recordArtifact(r.dir, 'report', 'validated');
  const [status, both] = await r.generate();
  expect([status, both.started, both.generation.running]).toEqual([200, false, false]);
});

test('closing a generation paused on an approval stops it as interrupted; a closing review answers closing, even then', async () => {
  using r = reviewWithAgent(true, () => true);
  await r.generate();
  await r.awaiting();
  expect((await r.generate())[1].generation).toEqual({ running: true, awaitingApproval: true });
  const closing = r.routes.close();
  const [status, body] = await r.generate();
  expect([status, body.code]).toEqual([409, 'closing']);
  await closing;
  expect(r.events().slice(2)).toEqual(['walkthrough stopped interrupted', 'report stopped interrupted']);
  expect(readProgress(r.dir).report.state).toBe('stopped');
});

test('closing stops the native session even when the progress journal cannot be written', async () => {
  using r = reviewWithAgent(true, () => true);
  await r.generate();
  await r.awaiting();
  const log = path.join(r.dir, 'progress.jsonl');
  fs.chmodSync(log, 0o444);
  const errors: unknown[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(' '));
  try {
    await r.routes.close();
  } finally {
    console.error = error;
    fs.chmodSync(log, 0o644);
  }
  expect(r.calls.stopped).toBe(1);
  if (process.getuid?.() !== 0) expect(String(errors[0])).toContain('could not record the stopped generation');
});

test('generate checks what a turn needs before answering started: a configured Claude that is missing', async () => {
  using r = reviewWithAgent(true, () => false, true, () => ({ ...settings, claudeExecutable: '/nonexistent/claude' }));
  const [status, body] = await r.generate();
  expect([status, body.code]).toEqual([503, 'assistant_unavailable']);
  expect(body.error).toContain('/nonexistent/claude');
  expect(r.events()).toEqual([]);
});

test('generate checks the configured role prompt before answering started: a missing one is unavailable, nothing requested', async () => {
  using r = reviewWithAgent(true, () => false, true, () => ({ ...settings, reviewAgentPromptFile: '/nonexistent/role.md' }));
  const [status, body] = await r.generate();
  expect([status, body.code]).toEqual([503, 'assistant_unavailable']);
  expect(body.error).toContain('/nonexistent/role.md');
  expect(r.events()).toEqual([]);
});

test('generate with nothing left to write answers started: false before it checks for Claude', async () => {
  using r = reviewWithAgent(true, () => false, true, () => ({ ...settings, claudeExecutable: '/nonexistent/claude' }));
  for (const [artifact, file] of [['walkthrough', 'walkthrough.json'], ['report', 'report.html']] as const) {
    fs.writeFileSync(path.join(r.dir, file), artifact === 'report' ? '<rr-review></rr-review>' : '{}');
    recordArtifact(r.dir, artifact, 'validated', { source: 'pr' }); // imported, nothing requested (pr --no-agent)
  }
  const [status, body] = await r.generate();
  expect([status, body.started, body.walkthrough.state, body.report.state]).toEqual([200, false, 'validated', 'validated']);
});
