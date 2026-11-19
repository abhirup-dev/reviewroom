// Experimental assistant (rr-2l7), on per review (`assistant: true` in its config.json: the hub's Play, `pr --assistant`):
// one native Claude Code conversation per review server,
// through AI SDK's ACP harness. The harness owns the ACP protocol and the native session; AI SDK owns message
// conversion and the UI message stream (`toUIMessageStreamResponse`). This file owns only the session's lifetime and
// the route. The packages are experimental: pinned runtime dependencies, kept out of the CLI bundle (scripts/build.ts)
// and loaded only when enabled.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import type { HarnessAgent } from '@ai-sdk/harness/agent';
import { PKG, settingsFile, assistantHome } from './paths.ts';
import { readConfig, type ReviewConfig } from './config.ts';
import { readState } from './state.ts';
import { astGrepBinary } from './source/outline.ts';
import { AskMetadata, contextPrompt, TURN_HEADER } from '../../src/assistant/context.shared.ts';
import { bunCommand, reapAssistantGroup, spawnAssistantBridge } from './assistant-process.ts';
import { assistantStore, type SavedAssistant } from './assistant-store.ts';
import { readProgress, requestGeneration, stopAssistantWork } from './progress.ts';
import { ARTIFACTS } from '../../src/kernel/state/progress.shared.ts';
import { errorText } from '../../src/kernel/errors.shared.ts';
import { replayStream, type ReplayStream } from './replay-stream.ts';

// Where the review's one conversation with the assistant stands, and what each place allows.
/** What started a turn: the reviewer's question, or api/generate. A paused turn keeps its origin when continued. */
type Origin = 'question' | 'generation';
/** `running`: its stream (`id`, the AI SDK's active stream id), the model it runs on, how to stop it and when it ended.
 *  `paused`: the native session holds the last turn on an approval (allow-all asks nothing; kept so a pause never reads
 *  as failed). `starting`: before the server holds its lock and has recovered (generation's own turn could be stopped
 *  by that recovery). */
type Phase =
  | { name: 'starting' }
  | { name: 'idle' }
  | { name: 'running'; origin: Origin; id: string; model: string; stream: ReplayStream; abort: AbortController; done: Promise<void> }
  | { name: 'paused'; origin: Origin; model: string }
  | { name: 'closing'; done: Promise<void> };
type Running = Extract<Phase, { name: 'running' }>;

type Key = 'starting' | 'idle' | `${'running' | 'paused'}:${Origin}` | 'closing';
const keyOf = (p: Phase): Key => ('origin' in p ? `${p.name}:${p.origin}` : p.name);

const BUSY = { error: 'The assistant is answering a question; generate when it is done.', code: 'busy' };
const CLOSING = 'The review is closing.';
const STARTING = 'The review is still starting';
/** Why a question (POST api/assistant) is refused (409), by phase; null: taken (an approval answers a paused turn). */
const ASK: Record<Key, string | null> = {
  starting: `${STARTING}; ask in a moment.`,
  idle: null,
  'running:question': 'The assistant is already answering a question.',
  'running:generation': 'The assistant is writing the review.',
  'paused:question': null,
  'paused:generation': null,
  closing: CLOSING,
};
/** Why api/generate starts nothing, by phase: refused (409), `running` (it already runs: answered `started: false`), or
 *  null: it starts. */
const GENERATE: Record<Key, { error: string; code: string } | 'running' | null> = {
  starting: { error: `${STARTING}; generate in a moment.`, code: 'starting' },
  idle: null,
  'running:question': BUSY,
  'paused:question': BUSY,
  'running:generation': 'running',
  'paused:generation': 'running',
  closing: { error: CLOSING, code: 'closing' },
};
/** Where a generation stands, as the pages read it (progress' `generation`). */
const generationOf = (p: Phase) => ({ running: 'origin' in p && p.origin === 'generation', awaitingApproval: p.name === 'paused' && p.origin === 'generation' });

/** `assistant: true` in the review's own config.json. Never throws: a bad file only leaves it off. */
export function assistantEnabled(dir: string) {
  try {
    return readConfig(dir).assistant === true;
  } catch {
    return false;
  }
}
/** The hub's proxy sets it on everything it forwards (cli/hub/proxy.ts). The assistant runs Claude Code with the
 *  reviewer's login, so it answers only this machine's direct review URL until the hub knows who is asking (ADR 0001). */
export const VIA_HUB = 'x-reviewroom-via-hub';

const AssistantSettings = z.object({
  defaultAgentHarness: z.literal('claude', { error: 'Only the claude agent harness is supported.' }).default('claude'),
  defaultReviewModel: z.string().trim().min(1).default('sonnet'),
  defaultReviewEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), // unset: Claude Code's own default
  claudeExecutable: z.string().trim().min(1).optional(),
  reviewAgentPromptFile: z.string().trim().min(1).default(path.join(PKG, 'templates/assistant-prompt.md')),
});

/** Machine-wide defaults: the model is read for each new question, the rest when the native session starts. */
function readAssistantSettings(file = settingsFile()) {
  try {
    const settings = AssistantSettings.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    return { ...settings,
      ...(settings.claudeExecutable && /[/\\]/.test(settings.claudeExecutable) ? { claudeExecutable: path.resolve(path.dirname(file), settings.claudeExecutable) } : {}),
      reviewAgentPromptFile: path.resolve(path.dirname(file), settings.reviewAgentPromptFile),
    };
  } catch (error) {
    throw new Error(`Invalid assistant settings in ${file}: ${errorText(error)}`, { cause: error });
  }
}

/** @ai-sdk/harness-acp's bootstrap command (its PNPM_INSTALL_COMMAND, not exported): checked on upgrades by the first start. */
const PNPM_INSTALL = 'pnpm install --frozen-lockfile --prod --store-dir .pnpm-store';

const generationSteps = {
  walkthrough: 'Write the walkthrough (Step 4). Run a full `reviewroom slide-lint <review>` and fix what it reports, repeating until it passes. Scoped runs do not count.',
  report: 'Fill the report sections (Step 4b). Run `reviewroom check <review> --fix` and fix what it reports, repeating until it passes.',
};

/** The native agent's package and lock: the harness installs them once under assistantHome() and reuses them. */
const agentFile = (f: string) => fs.readFileSync(path.join(PKG, 'cli/lib/assistant-agent', f), 'utf8');

function instructions(repo: string, dir: string, cfg: ReviewConfig, promptFile: string) {
  const prompt = fs.readFileSync(promptFile, 'utf8').trim();
  if (!prompt) throw new Error(`The agent prompt file is empty: ${promptFile}`);
  return `${prompt}\n\nReview instance:\n${JSON.stringify({
    repository: repo, directory: dir, base: cfg.base, head: cfg.head,
    title: cfg.title, reviewId: cfg.id, round: readState(dir).round,
  }, null, 2)}\n\nUse the native reviewroom:reviewroom skill before working on this review. Its files are loaded by the session's Review Room plugin.`;
}

type Settings = ReturnType<typeof readAssistantSettings>;
type Store = ReturnType<typeof assistantStore>;

/** The Claude binary: a configured one must exist; otherwise `claude` on PATH, or none (the adapter's bundled one). */
function claudeBinary(settings: Settings) {
  const requested = settings.claudeExecutable ?? process.env.CLAUDE_CODE_EXECUTABLE;
  const found = Bun.which(requested ?? 'claude');
  if (requested && !found) throw new Error(`Claude executable not found or not executable: ${requested}. Fix claudeExecutable in ${settingsFile()} or CLAUDE_CODE_EXECUTABLE.`);
  return found;
}

/** The review's native session: started on its first question, resumed from the review's saved state when there is one. */
async function start({ repo, dir, cfg, settings, store, model }: { repo: string; dir: string; cfg: ReviewConfig; settings: Settings; store: Store; model: () => string }) {
  const previous = store.saved.session;
  const claudeExecutable = claudeBinary(settings);
  const prompt = instructions(repo, dir, cfg, settings.reviewAgentPromptFile);
  const [{ HarnessAgent }, { createACP }, { createLocalSandbox }] = await Promise.all([import('@ai-sdk/harness/agent'), import('@ai-sdk/harness-acp'), import('ai-sdk-sandbox-local')]);
  // Keep the session's CLI and plugin on the running build, without changing the host PATH.
  const home = assistantHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const bin = fs.mkdtempSync(path.join(home, 'bin-'));
  let local: Awaited<ReturnType<ReturnType<typeof createLocalSandbox>['createSession']>> | undefined;
  const cleanup = async () => {
    try {
      reapAssistantGroup(dir);
    } finally {
      await local?.stop(); // the local runner owns the setup commands
      fs.rmSync(bin, { recursive: true, force: true });
    }
  };
  try {
    fs.symlinkSync(path.join(PKG, 'dist/cli/reviewroom.js'), path.join(bin, 'reviewroom'));
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    fs.symlinkSync(astGrepBinary(), path.join(bin, 'ast-grep'));
    if (!Bun.which('node')) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = free.port!;
    await free.stop();
    const harness = createACP({
      harnessId: 'reviewroom-claude', // stable: the installed agent's bootstrap is keyed by it
      source: { type: 'npm-locked', packageJson: agentFile('package.json'), pnpmLockYaml: agentFile('pnpm-lock.yaml') },
      executable: 'claude-agent-acp',
      modelMapping: { type: 'session-config-option', path: 'model' }, // the adapter dropped session/set_model
      isMcpToolCall: (tc) => typeof tc.title === 'string' && tc.title.startsWith('mcp__'),
      resolveHostToolCall: () => undefined,
      port,
      portEndpoint: { url: `ws://127.0.0.1:${port}` }, // ai-sdk-sandbox-local lacks getPortEndpoint
      auth: 'direct',
      session: { meta: { claudeCode: { options: {
        plugins: [{ type: 'local', path: PKG, skipMcpDiscovery: true }],
        // the reviewer's own hooks (settings files and plugins: command guards, output rewriters) are for their sessions,
        // not this one; their MCP servers and login stay. The adapter's programmatic hooks are not settings and still run.
        settings: { disableAllHooks: true },
        ...(settings.defaultReviewEffort ? { effort: settings.defaultReviewEffort } : {}),
      } } } },
    });
    // shortcut: allow-all approves every tool, generation and questions alike, so no turn waits on the reviewer;
    // rr-wd3.17 replaces it with an allowlist aligned with Claude's permission rules.
    const agent: HarnessAgent = new HarnessAgent({ harness, model: model(), prepareCall: (options) => ({ ...options, model: model() }), permissionMode: 'allow-all', instructions: prompt, sandboxConfig: { workDir: '.' } });
    // the local "sandbox" is the harness's process runner on this machine, not isolation. The harness installs the agent
    // through it (restricted() views) with pnpm; Bun installs the same lock instead (it migrates pnpm-lock.yaml).
    const provider = createLocalSandbox({ cwd: repo });
    // resuming creates a new runner with the saved id: it never adopts processes another server started
    local = previous ? await provider.resumeSession!({ sessionId: previous.sandboxId }) : await provider.createSession();
    const runner = local;
    const launchEnv = (env?: Record<string, string>) => ({ ...env, REVIEWROOM_ASSISTANT_DIR: dir, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` });
    const adapt = (view: ReturnType<typeof runner.restricted>) => Object.assign(Object.create(view) as typeof view, {
      run: (o: Parameters<typeof view.run>[0]) => {
        if (o.command.startsWith('pnpm ') && o.command !== PNPM_INSTALL) throw new Error('The ACP bootstrap command changed. Update the Review Room Bun adapter before upgrading the harness.');
        // The harness derives its fixed cache/state path from runner HOME. Only its setup commands use this HOME.
        // Bun writes a migrated lock here; discard it on bootstrap so the shipped pnpm lock remains authoritative on upgrades.
        return view.run({ ...o, env: { ...launchEnv(o.env), HOME: home }, command: o.command === PNPM_INSTALL ? `rm -f bun.lock && ${bunCommand} install --frozen-lockfile --production` : o.command });
      },
      spawn: (o: Parameters<typeof view.spawn>[0]) => spawnAssistantBridge(dir, repo, { ...o, env: launchEnv(o.env) }, claudeExecutable ?? undefined),
    });
    const sandbox = Object.assign(adapt(runner), { restricted: () => adapt(runner.restricted()) });
    let session: Awaited<ReturnType<HarnessAgent['createSession']>>;
    try {
      session = await agent.createSession({ sandboxSession: sandbox, ...(previous ? { sessionId: previous.id, resumeFrom: previous.resume } : {}) });
    } catch (error) {
      if (!previous) throw error;
      throw new Error(`Could not resume this review's Claude Code session (${errorText(error)}). The conversation is preserved in ${store.file}. Move that file aside to keep it, or delete it to start a new conversation.`, { cause: error });
    }
    const remember = (resume: NonNullable<SavedAssistant['session']>['resume']) => {
      store.saved.session = { id: session.sessionId, sandboxId: runner.id, resume };
      store.write();
    };
    let stopped: Promise<void> | undefined;
    return {
      agent,
      session,
      stop: () => (stopped ??= session.stop().then(remember).finally(cleanup)),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type Live = Pick<Awaited<ReturnType<typeof start>>, 'agent' | 'session' | 'stop'>;

/**
 * A new question carries what the reviewer attached (its quote, validated by AskMetadata) as text before it. Only a
 * last user message: the harness sends just that to the native session, and approval continuations end otherwise.
 */
function withContext(messages: UIMessage[], revs: { base: string; head: string }): UIMessage[] {
  const last = messages.at(-1);
  const quote = last?.role === 'user' ? AskMetadata.parse(last.metadata)?.custom?.quote : undefined;
  if (!last || !quote) return messages;
  return [...messages.slice(0, -1), { ...last, parts: [{ type: 'text', text: contextPrompt(quote, revs) }, ...last.parts] }];
}

/** What the server pushes to its pages (SSE): `assistant` when the conversation's phase changes (a turn starts, ends
 *  or pauses), `progress` when generation moves. */
type Send = (event: 'assistant' | 'progress', data: unknown) => void;
const STREAM_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-vercel-ai-ui-message-stream': 'v1', 'x-accel-buffering': 'no' };
type RouteOpts = { repo: string; dir: string; cfg: ReviewConfig; readSettings?: typeof readAssistantSettings; launch?: typeof start; send?: Send };
type TurnEnd = { paused?: boolean; aborted?: boolean };

/**
 * /api/assistant: GET the saved conversation and the turn it ends in; POST AI SDK's chat request, its UI message
 * stream out; the turn's stream again at `<chatId>/stream`; POST stop. One turn at a time, whatever started it (a
 * question, or api/generate); the server keeps the history. Failures (settings, a moved-aside or another checkout's
 * assistant.json) disable only the assistant.
 */
export function assistantRoutes({ repo, dir, cfg, readSettings = readAssistantSettings, launch = start, send = () => {} }: RouteOpts) {
  const generatePrompt = path.join(PKG, 'templates/generate-prompt.md');
  let store: Store | undefined;
  let live: Promise<Live> | undefined;
  let phase: Phase = { name: 'starting' };
  const load = () => {
    if (!store) {
      store = assistantStore(dir, repo);
      // A turn left active on disk belonged to the previous server, never this process.
      if (store.saved.status === 'working') {
        store.saved.status = 'interrupted';
        store.write();
      }
    }
    return store;
  };
  // The caller supplies the diff provider's frozen revisions (including its merge base), not moving branch names.
  const revs = { base: cfg.base, head: cfg.head };
  const modelNow = () => ('model' in phase ? phase.model : readSettings().defaultReviewModel);
  const progressNow = () => ({ ...readProgress(dir), generation: generationOf(phase) });
  /** The turn its pages follow (the AI SDK's active stream id), and what started it. */
  const active = () => (phase.name === 'running' ? { activeStreamId: phase.id, origin: phase.origin } : { activeStreamId: null, origin: null });
  /** Every move is told to the pages: they fetch the conversation again and follow its turn. */
  const setPhase = (next: Phase) => {
    phase = next;
    send('assistant', { ...active(), generation: generationOf(phase) });
  };
  /** A generation's turn ended: whatever it did not validate stopped with it; a paused one is the panel's to continue. */
  const generationEnded = (left: Phase, reason: 'interrupted' | 'failed') => {
    if (left.name !== 'paused') stopAssistantWork(dir, reason);
    send('progress', progressNow());
  };
  /**
   * Starts a turn: the question saved as working and the turn made in one synchronous step, before Claude launches, so
   * a page that looks finds both. Its stream goes to whoever follows it and is let go when it ends. A save that fails
   * starts nothing and throws.
   */
  const startTurn = (valid: UIMessage[], origin: Origin, model: string): Running => {
    const s = load();
    const was = { messages: s.saved.messages, status: s.saved.status };
    Object.assign(s.saved, { messages: valid, status: 'working' });
    try {
      s.write();
    } catch (e) {
      Object.assign(s.saved, was);
      throw e;
    }
    let release!: () => void;
    const id = randomUUID();
    const turn: Running = { name: 'running', origin, model, id, stream: replayStream({ ...STREAM_HEADERS, [TURN_HEADER]: id }), abort: new AbortController(), done: new Promise((r) => (release = r)) };
    setPhase(turn);
    if (origin === 'generation') send('progress', progressNow());
    // after the answer is saved
    const end = ({ paused = false, aborted = false }: TurnEnd = {}) => {
      release();
      // a closing review stays closing; a turn the native session holds waits
      const left: Phase = phase.name === 'closing' ? phase : paused ? { name: 'paused', origin, model } : { name: 'idle' };
      if (left !== phase) setPhase(left);
      if (origin === 'generation') generationEnded(left, aborted || left.name === 'closing' ? 'interrupted' : 'failed');
    };
    void (async () => {
      try {
        const res = await runTurn(valid, turn, end);
        for await (const text of res.body!.pipeThrough(new TextDecoderStream())) turn.stream.say(text);
      } catch (e) {
        // a start that failed: the windows following it show why (the UI message stream's error part)
        turn.stream.say(`data: ${JSON.stringify({ type: 'error', errorText: errorText(e) })}\n\n`);
      } finally {
        turn.stream.close();
      }
    })();
    return turn;
  };
  const app = new Hono();
  // errors as text: AI SDK's transport shows a failed request's body as the chat's error
  app.onError((e, c) => c.text(errorText(e), 503));
  app.use(async (c, next) => {
    if (c.req.header(VIA_HUB)) return c.text('The assistant runs Claude Code with your login, so it answers only on this machine: open the review from its own URL.', 403);
    await next();
  });
  /** The AI SDK's resumable stream (its reconnect URL, `{api}/{chatId}/stream`), for the `turn` the page's history
   *  named: the turn so far, then as it goes on (waiting while Claude starts); 204 when that turn isn't running (it
   *  ended, or another took its place: the page fetches the history again). One conversation per review: no chat id. */
  app.get('/:chatId/stream', (c) => (phase.name === 'running' && phase.id === c.req.query('turn') ? phase.stream.follow() : c.body(null, 204)));
  /** Stop: the named turn, if it is still running. */
  app.post('/stop', async (c) => {
    const { streamId } = await c.req.json<{ streamId?: string }>().catch(() => ({ streamId: undefined }));
    if (phase.name === 'running' && phase.id === streamId) phase.abort.abort();
    return c.body(null, 204);
  });
  app.get('/', async (c) => {
    // read together: the turn these messages end in
    const now = { model: modelNow(), status: load().saved.status, messages: load().saved.messages, ...active() };
    const { validateUIMessages } = await import('ai');
    if (now.messages.length) now.messages = await validateUIMessages<UIMessage>({ messages: now.messages, metadataSchema: AskMetadata });
    return c.json(now);
  });
  /**
   * One turn of the native session: `valid` is the transcript to continue (a new user message last, or an answered
   * approval), saved by startTurn; its UI message stream comes back. `end` runs on every exit, after the answer is saved.
   */
  async function runTurn(valid: UIMessage[], { model, abort: { signal } }: Running, end: (o?: TurnEnd) => void) {
    let streaming = false;
    try {
      const s = load();
      const { convertToModelMessages } = await import('ai');
      const messages = await convertToModelMessages(withContext(valid, revs));
      signal.throwIfAborted();
      live ??= launch({ repo, dir, cfg, settings: readSettings(), store: s, model: modelNow }).catch((e: unknown) => {
        live = undefined; // let the next message retry
        throw e;
      });
      const current = await live;
      signal.throwIfAborted();
      // The harness sends the last user message, or continues the paused turn.
      const result = await current.agent.stream({ session: current.session, messages, abortSignal: signal });
      const response = result.toUIMessageStreamResponse({
        originalMessages: valid, generateMessageId: randomUUID,
        // also when the reviewer stops or leaves: the partial answer is saved under the id their window has
        onEnd: async ({ messages: completed, isAborted, isCancelled, outcome }) => {
          let p = false;
          try {
            const answer = completed.at(-1);
            const resolved = await Promise.resolve(result.response).catch(() => undefined);
            if (answer?.role === 'assistant') answer.metadata = { model, resolvedModel: resolved?.modelId };
            s.saved.messages = completed;
            s.saved.status = isAborted || isCancelled ? 'interrupted' : outcome.status === 'failed' ? 'failed' : 'idle';
            p = !isAborted && !isCancelled && current.session.hasUnfinishedTurn();
            s.write();
          } catch (error) {
            console.error(`reviewroom: assistant: ${errorText(error)}`);
          } finally {
            end({ paused: p, aborted: isAborted || isCancelled });
          }
        },
        onError: (e) => errorText(e),
      });
      streaming = true;
      return response;
    } catch (error) {
      if (store?.saved.status === 'working') {
        store.saved.status = signal.aborted ? 'interrupted' : 'failed';
        store.write();
      }
      throw error;
    } finally {
      if (!streaming) end({ aborted: signal.aborted });
    }
  }

  app.post('/', async (c) => {
    const refused = () => {
      const why = ASK[keyOf(phase)];
      return why ? c.text(why, 409) : undefined;
    };
    const early = refused();
    if (early) return early;
    const body: { trigger?: string; messages?: unknown } = await c.req.json().catch(() => ({}));
    // the native session cannot branch: regenerating or editing a past message would desync it from the transcript
    if (body.trigger !== 'submit-message') return c.text('The assistant only takes new messages.', 400);
    const s = load();
    const { validateUIMessages } = await import('ai');
    let incoming: UIMessage[];
    try {
      incoming = await validateUIMessages<UIMessage>({ messages: body.messages, metadataSchema: AskMetadata });
    } catch (e) {
      return c.text(errorText(e), 400);
    }
    // a new question follows the saved messages; an approval continues the last one (same id, its parts answered)
    const last = incoming.at(-1)!;
    const asking = last.role === 'user';
    const saved = s.saved.messages;
    const prior = asking ? incoming.slice(0, -1) : incoming;
    // the page takes the conversation again (its question stays in the composer) and can ask once it has
    if (prior.length !== saved.length || prior.some((m, i) => m.id !== saved[i].id)) return c.text('This conversation changed in another window.', 409);
    // checked again with nothing awaited before the start: one turn at a time
    const blocked = refused();
    if (blocked) return blocked;
    // read before the question is saved: it may throw. An approval continues what is paused, on its model and origin
    const model = !asking && phase.name === 'paused' ? phase.model : readSettings().defaultReviewModel;
    return startTurn(asking ? [...saved, last] : [...saved.slice(0, -1), last], phase.name === 'paused' ? phase.origin : 'question', model).stream.follow();
  });

  /**
   * POST api/generate: request the unvalidated documents of the assistant and write them in one turn, with no page needed. Answers
   * at once with the progress; the turn's end (or its pause on an approval) is pushed over SSE. Idempotent while a
   * generation runs; `busy` while the assistant answers the reviewer (or waits on their approval).
   */
  const generate = new Hono();
  generate.use(async (c, next) => {
    if (c.req.header(VIA_HUB)) return c.json({ error: 'Generation runs Claude Code with your login, so it starts only on this machine: open the review from its own URL.', code: 'via_hub' }, 403);
    await next();
  });
  generate.post('/', (c) => {
    // decided and taken synchronously: two requests can't both start one
    const refused = GENERATE[keyOf(phase)];
    if (refused === 'running') return c.json({ started: false, ...progressNow() });
    if (refused) return c.json(refused, 409);
    // a validated document (a walkthrough kept from the PR, say) is not asked for again; nothing to do needs no Claude
    const before = readProgress(dir);
    const wanted = ARTIFACTS.filter((a) => before[a].state !== 'validated');
    if (!wanted.length) return c.json({ started: false, ...progressNow() });
    let text: string, settings: ReturnType<typeof readSettings>;
    try {
      text = fs.readFileSync(generatePrompt, 'utf8').trim();
      if (!text) throw new Error(`The generate prompt is empty: ${generatePrompt}`);
      text = text.replace('{{artifacts}}', wanted.join(', ')).replace('{{steps}}', wanted.map((a) => generationSteps[a]).join('\n\n'));
      settings = readSettings();
      claudeBinary(settings);
      instructions(repo, dir, cfg, settings.reviewAgentPromptFile); // the role prompt the turn starts with: there and not empty
      load();
    } catch (e) {
      return c.json({ error: errorText(e), code: 'assistant_unavailable' }, 503);
    }
    requestGeneration(dir, 'assistant', cfg.head, wanted); // one write; if it throws, nothing runs and nothing is pending
    try {
      // marked: the window shows the long prompt folded
      startTurn([...load().saved.messages, { id: randomUUID(), role: 'user', metadata: { custom: { generate: true } }, parts: [{ type: 'text', text }] }], 'generation', settings.defaultReviewModel);
    } catch (e) {
      stopAssistantWork(dir, 'failed'); // nothing will write them
      return c.json({ error: errorText(e), code: 'assistant_unavailable' }, 503);
    }
    return c.json({ started: true, ...progressNow() });
  });

  /** Closing: stops a running turn (its answer is saved; its end sees the review closing), stops a paused one as
   *  interrupted, then the native session, saving where it can resume. Once: closing again waits for the same. */
  const close = () => {
    if (phase.name === 'closing') return phase.done;
    const was = phase;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    setPhase({ name: 'closing', done: promise });
    void (async () => {
      if (was.name === 'running') {
        was.abort.abort();
        await was.done;
      }
      try {
        // a paused turn has no end to come: it stops here
        if (was.name === 'paused' && was.origin === 'generation') generationEnded(phase, 'interrupted');
      } catch (e) {
        // the next server's start stops it as interrupted instead
        console.error(`reviewroom: could not record the stopped generation: ${errorText(e)}`);
      } finally {
        // whatever the journal did: the native session saves where it can resume and ends its processes
        await (await live?.catch(() => undefined))?.stop();
      }
    })().then(resolve, reject);
    return promise;
  };
  return { app, generate, close, progress: progressNow, ready: () => void (phase.name === 'starting' && setPhase({ name: 'idle' })) };
}
