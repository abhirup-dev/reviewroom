import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UIMessage } from 'ai';
import { assistantEnabled, assistantLaunch, assistantRoutes, instructions, readAssistantSettings, withContext } from './assistant.ts';
import { fakeAgent } from '../../e2e/fake-assistant.ts';
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

test('machine settings default when absent, accept a model alongside existing settings, and refuse invalid ones; the assistant is on per review', () => {
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
    // the assistant is on per review, by `assistant: true` in its config.json; anything else leaves it off
    fs.rmSync(file);
    expect(assistantEnabled(dir)).toBe(false);
    for (const [config, on] of [['{"assistant": true}', true], ['{"assistant": "yes"}', false], ['{broken', false]] as const) {
      fs.writeFileSync(file, config);
      expect(assistantEnabled(dir)).toBe(on);
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

// The routes run AI SDK's real stream through the one fake agent (e2e/fake-assistant.ts), shaped like the harness.
const answers = async ({ say }: { say: (t: string) => void }) => say('partial answer');
const hangs = async ({ say }: { say: (t: string) => void }) => {
  say('partial answer');
  await new Promise(() => {}); // runs until it is stopped
};
const HUB = { 'x-reviewroom-via-hub': '1' };
type Told = { activeStreamId: string | null; origin: string | null; generation: { awaitingApproval: boolean } };
/** A review's assistant over a temp dir: the server's routes, opened (and `restart`ed) as serve.ts does. */
function review({ script = answers, held, starting, ready = true, readSettings = () => settings }: { script?: Parameters<typeof fakeAgent>[0]; held?: () => boolean; starting?: Promise<void>; ready?: boolean; readSettings?: () => typeof settings & { claudeExecutable?: string } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-routes-'));
  const agent = fakeAgent(script, { starting, held });
  const sent: { event: string; data: Told }[] = [];
  const open = () => {
    const r = assistantRoutes({ repo: dir, dir, cfg: { base: 'b', head: 'h' }, readSettings, launch: agent.launch, send: (event, data) => void sent.push({ event, data: data as Told }) });
    if (ready) r.ready(); // as serve.ts does once it holds the lock
    return r;
  };
  let routes = open();
  const post = (messages: UIMessage[], headers: Record<string, string> = {}) => routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ trigger: 'submit-message', messages }) });
  const generate = async (headers: Record<string, string> = {}) => {
    const res = await routes.generate.request('/', { method: 'POST', headers });
    const text = await res.text();
    return [res.status, (() => { try { return JSON.parse(text); } catch { return { text }; } })()] as const;
  };
  const get = async () => (await routes.app.request('/')).json();
  const turn = async (): Promise<string | null> => (await get()).activeStreamId;
  return {
    dir, sent, post, generate, get, turn,
    get routes() { return routes; },
    calls: agent.calls,
    /** Another window following a turn (the running one by default), as the AI SDK resumes it. */
    follow: async (id?: string | null, headers: Record<string, string> = {}) => routes.app.request(`/x/stream?turn=${id ?? (await turn())}`, { headers }),
    stop: (streamId: string | null) => routes.app.request('/stop', { method: 'POST', body: JSON.stringify({ streamId }) }),
    saved: () => assistantStore(dir, dir).saved,
    events: () => progressLines(dir).map((l) => `${l.artifact} ${l.event}${'by' in l ? ` ${l.by}` : ''}${'reason' in l ? ` ${l.reason}` : ''}`),
    /** Until the pages are told the generation waits on an approval. */
    awaiting: () => until(() => sent.some((s) => s.event === 'assistant' && s.data.generation.awaitingApproval)),
    /** The server closing and a new one starting over the same review. */
    restart: async () => {
      await routes.close();
      routes = open();
    },
    [Symbol.dispose]: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
/** Reads `res` until `done` holds of what it said so far (or it ends). */
async function readUntil(res: Response, done: (said: string) => boolean = () => false) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let said = '';
  for (let x; !done(said); said += x.value) if ((x = await reader.read()).done) return { said, ended: true, reader };
  return { said, ended: false, reader };
}
const partial = (said: string) => said.includes('partial answer');

test('one turn at a time, told to every page; a window that leaves only detaches; Stop takes only its turn\'s id, and saves what was said', async () => {
  using r = review({ script: hangs });
  expect((await r.routes.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status).toBe(400);
  const asked = await r.post([user('q1')]);
  const id = await r.turn();
  expect(r.sent.slice(1).map((s) => [s.event, s.data.activeStreamId, s.data.origin])).toEqual([['assistant', id, 'question']]); // after ready's
  await (await readUntil(asked, partial)).reader.cancel(); // the asker's page reloads
  expect((await readUntil(await r.follow(), partial)).ended).toBe(false); // the turn runs on, for the next window
  const second = await r.post([user('q1'), user('q2')]);
  expect([second.status, await second.text()]).toEqual([409, 'The assistant is already answering a question.']);
  expect((await r.generate())[1].code).toBe('busy');
  await r.stop('another-turn');
  expect(await r.turn()).toBe(id);
  await r.stop(id);
  await until(() => r.saved().status === 'interrupted');
  expect([await r.turn(), r.saved().messages.map((m) => m.role), r.events()]).toEqual([null, ['user', 'assistant'], []]);
});

test('everything is refused through the hub: questions, the turn\'s stream, Stop and generate', async () => {
  using r = review({ script: hangs });
  await r.generate();
  const id = await r.turn();
  const [status, body] = await r.generate(HUB);
  const stop = await r.routes.app.request('/stop', { method: 'POST', headers: HUB, body: JSON.stringify({ streamId: id }) });
  expect([status, body.code, (await r.post([user('q')], HUB)).status, (await r.follow(id, HUB)).status, (await r.routes.app.request('/', { headers: HUB })).status, stop.status]).toEqual([403, 'via_hub', 403, 403, 403, 403]);
  expect(await r.turn()).toBe(id); // nothing stopped
  await r.routes.close();
});

test('the conversation is saved: a window that missed a turn is refused and nothing is written; an approval continues the last answer in place', async () => {
  using r = review();
  const res = await r.post([user('q1')]);
  const id = (await res.text()).match(/"type":"start","messageId":"([^"]+)"/)![1]; // the id the window got
  const transcript = r.saved().messages;
  expect(transcript.map((m) => m.id)).toEqual(['q1', id]);
  const stale = await r.post([user('q2')]); // another window, still showing nothing
  expect([stale.status, await stale.text(), r.saved().messages]).toEqual([409, 'This conversation changed in another window.', transcript]);
  const answered = { ...transcript[1], parts: [...transcript[1].parts, { type: 'text' as const, text: 'approval answered' }] };
  await (await r.post([transcript[0], answered])).text();
  expect([r.saved().messages.map((m) => m.id), JSON.stringify(r.saved().messages[1]).includes('approval answered'), r.calls.launched]).toEqual([['q1', id], true, 1]);
});

test('closing stops a running answer and saves it, stops the agent once; the next server finds it interrupted, as it does a turn the last one never ended', async () => {
  using r = review({ script: hangs });
  void (await r.post([user('q1')])).text();
  await until(() => r.calls.launched === 1);
  await Promise.all([r.routes.close(), r.routes.close()]);
  expect([r.saved().messages.map((m) => m.role), r.calls.stopped]).toEqual([['user', 'assistant'], 1]);
  await r.restart();
  const restored = await r.get();
  expect([restored.status, restored.messages.map((m: UIMessage) => m.id)]).toEqual(['interrupted', r.saved().messages.map((m) => m.id)]);
  // a server killed mid-turn left it working on disk: the next one keeps every message, marked interrupted
  const store = assistantStore(r.dir, r.dir);
  store.saved.messages = [...store.saved.messages, user('asked as it died', { custom: { quote } })];
  store.saved.status = 'working';
  store.write();
  const before = structuredClone(store.saved.messages);
  await r.restart();
  const after = await r.get();
  expect([after.status, after.messages, r.saved().messages]).toEqual(['interrupted', before, before]);
});

test('the store is private to its review and writes atomically', () => {
  using r = review();
  const store = assistantStore(r.dir, r.dir);
  store.saved.messages = [user('why?', { custom: { quote } })];
  store.write();
  expect(assistantStore(r.dir, r.dir).saved.messages).toEqual(store.saved.messages);
  expect(fs.statSync(path.join(r.dir, 'assistant.json')).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(r.dir)).toEqual(['assistant.json']);
});

test('a failed start keeps the question, so the same window can ask again', async () => {
  let fail!: (e: Error) => void;
  using r = review({ starting: new Promise<void>((_, no) => (fail = no)) });
  const res = await r.post([user('q1')]);
  fail(new Error('bridge did not start'));
  expect([res.status, await res.text()]).toEqual([200, expect.stringContaining('"errorText":"bridge did not start"')]); // the chat's error
  expect(r.saved().messages.map((m) => m.id)).toEqual(['q1']);
  expect((await r.post([user('q1'), user('q2')])).status).toBe(200); // in step: not refused
});

test('a broken conversation or settings disable only the assistant, keep what was saved, and save nothing new', async () => {
  using r = review();
  const file = path.join(r.dir, 'assistant.json');
  fs.writeFileSync(file, '{broken');
  const read = async (res: Response) => [res.status, await res.text()] as const;
  expect(await read(await r.routes.app.request('/'))).toEqual([503, expect.stringContaining('is not valid JSON')]);
  const aside = fs.readdirSync(r.dir).filter((f) => f.startsWith('assistant.json.corrupt-'));
  expect([aside.length, fs.readFileSync(path.join(r.dir, aside[0]), 'utf8')]).toEqual([1, '{broken']);
  expect(await read(await r.routes.app.request('/'))).toEqual([503, expect.stringContaining('was moved aside')]); // never a silent new conversation
  fs.renameSync(path.join(r.dir, aside[0]), file);
  fs.writeFileSync(file, JSON.stringify({ version: 1, repo: '/another/checkout', messages: [user('mine')] }));
  expect(await read(await r.routes.app.request('/'))).toEqual([503, expect.stringContaining('was started in /another/checkout')]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).messages).toEqual([user('mine')]);
  fs.rmSync(file);
  using bad = review({ readSettings: () => { throw new Error('Invalid assistant settings in config.json'); } });
  expect(await read(await bad.routes.app.request('/'))).toEqual([503, 'Invalid assistant settings in config.json']);
  expect(await read(await bad.post([user('q1')]))).toEqual([503, 'Invalid assistant settings in config.json']);
  expect(fs.existsSync(path.join(bad.dir, 'assistant.json'))).toBe(false); // read before the question is saved
});

test('the resume route: the named turn from its start, even while Claude starts, to its end; 204 for a turn not running (a failed start ends it with why)', async () => {
  let started!: () => void;
  using r = review({ script: hangs, starting: new Promise<void>((ok) => (started = ok)) });
  expect([await r.turn(), (await r.follow('none')).status]).toEqual([null, 204]);
  await r.generate();
  const id = await r.turn();
  expect((await r.follow('another-turn')).status).toBe(204); // a turn that ended: the page fetches the history again
  const res = await r.follow(id); // before Claude has said anything
  started();
  expect([res.status, res.headers.get('x-vercel-ai-ui-message-stream'), res.headers.get('x-reviewroom-turn'), (await readUntil(res, partial)).said]).toEqual([200, 'v1', id, expect.stringContaining('"type":"start"')]);
  await r.routes.close();
  expect([await r.turn(), (await r.follow(id)).status]).toEqual([null, 204]);
  let failed!: (e: Error) => void;
  using f = review({ starting: new Promise<void>((_, no) => (failed = no)) });
  await f.generate();
  const waiting = await f.follow();
  failed(new Error('Claude did not start'));
  expect(await readUntil(waiting)).toMatchObject({ said: expect.stringContaining('"errorText":"Claude did not start"'), ended: true });
});

test('generate requests only what is not validated and starts one turn; meanwhile it starts nothing, a question is refused, Stop does nothing; closing interrupts what it requested, not an agent\'s request', async () => {
  using r = review({ script: hangs });
  const [status, body] = await r.generate();
  expect([status, body.started, body.generation, body.walkthrough]).toEqual([200, true, { running: true, awaitingApproval: false }, { state: 'requested', by: 'assistant', request: expect.any(String), since: expect.any(String) }]);
  expect(r.events()).toEqual(['walkthrough requested assistant', 'report requested assistant']);
  await until(() => r.calls.launched === 1);
  const [, again] = await r.generate();
  const chat = await r.post([user('q1')]);
  expect([again.started, r.events().length, chat.status, await chat.text()]).toEqual([false, 2, 409, 'The assistant is writing the review.']);
  expect(r.saved().messages.map((m) => [m.role, m.metadata])).toEqual([['user', { custom: { generate: true } }]]); // the generate prompt, marked (shown folded)
  await r.stop(await r.turn());
  expect(await r.turn()).not.toBeNull(); // a generation is never stopped from a page
  fs.appendFileSync(path.join(r.dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), artifact: 'report', event: 'requested', by: 'agent' }) + '\n'); // pr --force meanwhile
  await r.routes.close();
  expect([r.events().slice(2), r.calls.launched]).toEqual([['report requested agent', 'walkthrough stopped interrupted'], 1]);

  using kept = review();
  fs.writeFileSync(path.join(kept.dir, 'walkthrough.json'), '{}');
  requestGeneration(kept.dir, 'agent', undefined, ['walkthrough']);
  recordArtifact(kept.dir, 'walkthrough', 'validated', { source: 'pr' }); // a PR walkthrough kept
  const [, one] = await kept.generate();
  expect([one.started, one.walkthrough.state, one.report]).toEqual([true, 'validated', expect.objectContaining({ state: 'requested', by: 'assistant' })]);
  await until(() => kept.events().includes('report stopped failed'));
  expect(readProgress(kept.dir).walkthrough.state).toBe('validated'); // not failed with the turn
});

test('a generation turn ends: failed what it did not validate, told to the pages; paused on an approval it keeps running until the panel continues it', async () => {
  let waiting = true;
  using r = review({ held: () => waiting });
  await r.generate();
  await r.awaiting();
  const [, paused] = await r.generate();
  expect([paused.started, paused.generation, paused.report.state, r.events().length]).toEqual([false, { running: true, awaitingApproval: true }, 'requested', 2]); // neither failed nor stopped
  waiting = false;
  const [ask, answer] = r.saved().messages;
  await (await r.post([ask, { ...answer, parts: [...answer.parts, { type: 'text' as const, text: 'approved' }] }])).text();
  await until(() => r.events().length === 4);
  expect([r.events().slice(2), r.sent.slice(-2).map((s) => s.event)]).toEqual([['walkthrough stopped failed', 'report stopped failed'], ['assistant', 'progress']]);
  expect((await r.generate())[1].started).toBe(true); // a new generation may start
});

test.each([[true], [false]])('closing a generation paused on an approval stops it as interrupted and the native session once (journal writable: %p)', async (writable) => {
  using r = review({ held: () => true });
  await r.generate();
  await r.awaiting();
  const log = path.join(r.dir, 'progress.jsonl');
  if (!writable) fs.chmodSync(log, 0o444);
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
  if (writable) expect(r.events().slice(2)).toEqual(['walkthrough stopped interrupted', 'report stopped interrupted']);
  else if (process.getuid?.() !== 0) expect(String(errors[0])).toContain('could not record the stopped generation');
});

test('a failed log append starts nothing and leaves nothing running or half-requested', async () => {
  using r = review({ script: hangs });
  fs.mkdirSync(path.join(r.dir, 'progress.jsonl')); // appending fails
  expect((await r.generate())[0]).toBe(500);
  expect(r.calls.launched).toBe(0);
  fs.rmdirSync(path.join(r.dir, 'progress.jsonl'));
  const [again, body] = await r.generate(); // not wedged as running
  expect([again, body.started, r.events()]).toEqual([200, true, ['walkthrough requested assistant', 'report requested assistant']]);
  await r.routes.close();
});

test.each([
  ['a configured Claude that is missing', { claudeExecutable: '/nonexistent/claude' }, [503, 'assistant_unavailable'], '/nonexistent/claude'],
  ['a missing role prompt', { reviewAgentPromptFile: '/nonexistent/role.md' }, [503, 'assistant_unavailable'], '/nonexistent/role.md'],
  ['nothing left to write: started false, before it looks for Claude', { claudeExecutable: '/nonexistent/claude' }, [200, undefined], undefined],
] as const)('generate checks what a turn needs before answering: %s, nothing requested', async (_, override, [status, code], why) => {
  using r = review({ readSettings: () => ({ ...settings, ...override }) });
  if (status === 200)
    for (const [artifact, file] of [['walkthrough', 'walkthrough.json'], ['report', 'report.html']] as const) {
      fs.writeFileSync(path.join(r.dir, file), artifact === 'report' ? '<rr-review></rr-review>' : '{}');
      recordArtifact(r.dir, artifact, 'validated', { source: 'pr' }); // imported, nothing requested (pr --no-agent)
    }
  const [got, body] = await r.generate();
  expect([got, body.code, body.started]).toEqual([status, code, status === 200 ? false : undefined]);
  if (why) expect(body.error).toContain(why);
  expect(r.events().filter((e) => e.includes('requested'))).toEqual([]);
});
