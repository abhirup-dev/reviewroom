// Experimental assistant (REVIEWROOM_ASSISTANT=1, rr-2l7): one native Claude Code conversation per review server,
// through AI SDK's ACP harness. The harness owns the ACP protocol and the native session; AI SDK owns message
// conversion and the UI message stream (`toUIMessageStreamResponse`). This file owns only the session's lifetime and
// the route. The packages are experimental: pinned runtime dependencies, kept out of the CLI bundle (scripts/build.ts)
// and loaded only when enabled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import type { HarnessAgent } from '@ai-sdk/harness/agent';
import { PKG, settingsFile, assistantHome } from './paths.ts';
import type { ReviewConfig } from './config.ts';
import { readState } from './state.ts';
import { astGrepBinary } from './source/outline.ts';
import { AskMetadata, contextPrompt } from '../../src/assistant/context.shared.ts';
import { assistantStore, type SavedAssistant } from './assistant-store.ts';

export const assistantEnabled = () => !!process.env.REVIEWROOM_ASSISTANT;
/** The hub's proxy sets it on everything it forwards (cli/hub/proxy.ts). The assistant runs Claude Code with the
 *  reviewer's login, so it answers only this machine's direct review URL until the hub knows who is asking (ADR 0001). */
export const VIA_HUB = 'x-reviewroom-via-hub';

const AssistantSettings = z.object({
  defaultAgentHarness: z.literal('claude', { error: 'Only the claude agent harness is supported.' }).default('claude'),
  defaultReviewModel: z.string().trim().min(1).default('sonnet'),
  claudeExecutable: z.string().trim().min(1).optional(),
  reviewAgentPromptFile: z.string().trim().min(1).default(path.join(PKG, 'templates/assistant-prompt.md')),
});

/** Machine-wide defaults: the model is read for each new question, the rest when the native session starts. */
export function readAssistantSettings(file = settingsFile()) {
  try {
    const settings = AssistantSettings.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    return { ...settings,
      ...(settings.claudeExecutable && /[/\\]/.test(settings.claudeExecutable) ? { claudeExecutable: path.resolve(path.dirname(file), settings.claudeExecutable) } : {}),
      reviewAgentPromptFile: path.resolve(path.dirname(file), settings.reviewAgentPromptFile),
    };
  } catch (error) {
    throw new Error(`Invalid assistant settings in ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// API-key, gateway and nested-session overrides would replace the reviewer's native subscription login
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AI_GATEWAY_API_KEY', 'CLAUDECODE'];

/** @ai-sdk/harness-acp's bootstrap command (its PNPM_INSTALL_COMMAND, not exported): checked on upgrades by the first start. */
const PNPM_INSTALL = 'pnpm install --frozen-lockfile --prod --store-dir .pnpm-store';
const bunCommand = `'${process.execPath.replaceAll("'", "'\\''")}'`;

/** Scope subscription overrides to the bridge process; upstream currently launches it as `node <bridge>`. */
export function assistantLaunch(command: string) {
  return `env ${OVERRIDES.map((key) => `-u ${key}`).join(' ')} ${command.replace(/^node /, `${bunCommand} `)}`;
}

/** The native agent's package and lock: the harness installs them once under assistantHome() and reuses them. */
const agentFile = (f: string) => fs.readFileSync(path.join(PKG, 'cli/lib/assistant-agent', f), 'utf8');

export function instructions(repo: string, dir: string, cfg: ReviewConfig, promptFile = path.join(PKG, 'templates/assistant-prompt.md')) {
  const prompt = fs.readFileSync(promptFile, 'utf8').trim();
  if (!prompt) throw new Error(`The agent prompt file is empty: ${promptFile}`);
  return `${prompt}\n\nReview instance:\n${JSON.stringify({
    repository: repo, directory: dir, base: cfg.base, head: cfg.head,
    title: cfg.title, url: cfg.url, number: cfg.number, round: readState(dir).round,
  }, null, 2)}\n\nUse the native reviewroom:reviewroom skill before working on this review. Its files are loaded by the session's Review Room plugin.`;
}

type Settings = ReturnType<typeof readAssistantSettings>;
type Store = ReturnType<typeof assistantStore>;

/** The review's native session: started on its first question, resumed from the review's saved state when there is one. */
async function start({ repo, dir, cfg, settings, store, model }: { repo: string; dir: string; cfg: ReviewConfig; settings: Settings; store: Store; model: () => string }) {
  const previous = store.saved.session;
  const requested = settings.claudeExecutable ?? process.env.CLAUDE_CODE_EXECUTABLE;
  const claudeExecutable = Bun.which(requested ?? 'claude');
  if (requested && !claudeExecutable) throw new Error(`Claude executable not found or not executable: ${requested}. Fix claudeExecutable in ${settingsFile()} or CLAUDE_CODE_EXECUTABLE.`);
  const prompt = instructions(repo, dir, cfg, settings.reviewAgentPromptFile);
  const [{ HarnessAgent }, { createACP }, { createLocalSandbox }] = await Promise.all([import('@ai-sdk/harness/agent'), import('@ai-sdk/harness-acp'), import('ai-sdk-sandbox-local')]);
  // Keep the session's CLI and plugin on the running build, without changing the host PATH.
  const home = assistantHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const bin = fs.mkdtempSync(path.join(home, 'bin-'));
  let local: Awaited<ReturnType<ReturnType<typeof createLocalSandbox>['createSession']>> | undefined;
  const cleanup = async () => {
    await local?.stop(); // the local runner's stop ends every process it spawned (the bridge and, through it, Claude Code)
    fs.rmSync(bin, { recursive: true, force: true });
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
      } } } },
    });
    // allow-reads: only what the native agent asks about (edits, most commands) comes to the reviewer as an AI SDK tool
    // approval, never approved here. Its own permission mode decides first: the reviewer's Claude Code defaultMode
    // (`auto` included) may approve an edit itself, and no permission mode mapping overrides it.
    const agent: HarnessAgent = new HarnessAgent({ harness, model: model(), prepareCall: (options) => ({ ...options, model: model() }), permissionMode: 'allow-reads', instructions: prompt, sandboxConfig: { workDir: '.' } });
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
      spawn: (o: Parameters<typeof view.spawn>[0]) => view.spawn({
        ...o,
        command: assistantLaunch(o.command),
        // Claude keeps its native login, plugins and connectors; do not redirect its HOME with the harness state.
        env: { ...launchEnv(o.env), HOME: process.env.HOME ?? os.homedir(),
          ...(claudeExecutable ? { CLAUDE_CODE_EXECUTABLE: claudeExecutable } : {}),
        },
      }),
    });
    const sandbox = Object.assign(adapt(runner), { restricted: () => adapt(runner.restricted()) });
    let session: Awaited<ReturnType<HarnessAgent['createSession']>>;
    try {
      session = await agent.createSession({ sandboxSession: sandbox, ...(previous ? { sessionId: previous.id, resumeFrom: previous.resume } : {}) });
    } catch (error) {
      if (!previous) throw error;
      throw new Error(`Could not resume this review's Claude Code session (${error instanceof Error ? error.message : String(error)}). The conversation is preserved in ${store.file}. Move that file aside to keep it, or delete it to start a new conversation.`, { cause: error });
    }
    const remember = (resume: NonNullable<SavedAssistant['session']>['resume']) => {
      store.saved.session = { id: session.sessionId, sandboxId: runner.id, resume };
      store.write();
    };
    let stopped: Promise<void> | undefined;
    return {
      agent,
      get session() { return session; },
      async checkpoint() {
        if (session.hasUnfinishedTurn()) return; // approvals stay with the harness's active turn
        const resume = await session.detach();
        remember(resume);
        session = await agent.createSession({ sandboxSession: sandbox, sessionId: session.sessionId, resumeFrom: resume });
      },
      stop: () => (stopped ??= session.stop().then(remember).finally(cleanup)),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type Live = Pick<Awaited<ReturnType<typeof start>>, 'agent' | 'session' | 'checkpoint' | 'stop'>;

/**
 * A new question carries what the reviewer attached (its quote, validated by AskMetadata) as text before it. Only a
 * last user message: the harness sends just that to the native session, and approval continuations end otherwise.
 */
export function withContext(messages: UIMessage[], revs: { base: string; head: string }): UIMessage[] {
  const last = messages.at(-1);
  const quote = last?.role === 'user' ? AskMetadata.parse(last.metadata)?.custom?.quote : undefined;
  if (!last || !quote) return messages;
  return [...messages.slice(0, -1), { ...last, parts: [{ type: 'text', text: contextPrompt(quote, revs) }, ...last.parts] }];
}

type RouteOpts = { repo: string; dir: string; cfg: ReviewConfig; readSettings?: typeof readAssistantSettings; launch?: typeof start };

/**
 * /api/assistant: GET the saved conversation and the model the next question uses; POST AI SDK's chat request, its UI
 * message stream out. One question at a time; the server keeps the history, and a window that missed a turn must
 * reload. Failures (settings, a moved-aside or another checkout's assistant.json) disable only the assistant.
 */
export function assistantRoutes({ repo, dir, cfg, readSettings = readAssistantSettings, launch = start }: RouteOpts) {
  let store: Store | undefined;
  let live: Promise<Live> | undefined;
  let turn: { abort: AbortController; done: Promise<void> } | undefined;
  let turnModel = '';
  let closed: Promise<void> | undefined;
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
  const model = () => (turn ? turnModel : readSettings().defaultReviewModel);
  const instance = randomUUID();
  const status = () => ({ model: model(), instance, status: load().saved.status });
  const app = new Hono();
  // errors as text: AI SDK's transport shows a failed request's body as the chat's error
  app.onError((e, c) => c.text(e instanceof Error ? e.message : String(e), 503));
  app.use(async (c, next) => {
    if (c.req.header(VIA_HUB)) return c.text('The assistant runs Claude Code with your login, so it answers only on this machine: open the review from its own URL.', 403);
    await next();
  });
  app.get('/model', (c) => c.json(status()));
  app.get('/', async (c) => {
    const { saved } = load();
    const { validateUIMessages } = await import('ai');
    const messages = saved.messages.length ? await validateUIMessages<UIMessage>({ messages: saved.messages, metadataSchema: AskMetadata }) : [];
    return c.json({ messages, ...status() });
  });
  app.post('/', async (c) => {
    // taken before anything awaits, released on every exit (a stream's after it is saved)
    if (turn || closed) return c.text(closed ? 'The review is closing.' : 'The assistant is already answering a question.', 409);
    let release!: () => void;
    const abort = new AbortController();
    turn = { abort, done: new Promise((r) => (release = r)) };
    const end = () => { turn = undefined; release(); };
    let streaming = false;
    try {
      const body: { trigger?: string; messages?: unknown } = await c.req.json().catch(() => ({}));
      // the native session cannot branch: regenerating or editing a past message would desync it from the transcript
      if (body.trigger !== 'submit-message') return c.text('The assistant only takes new messages.', 400);
      const s = load();
      const { validateUIMessages, convertToModelMessages } = await import('ai');
      let incoming: UIMessage[];
      try {
        incoming = await validateUIMessages<UIMessage>({ messages: body.messages, metadataSchema: AskMetadata });
      } catch (e) {
        return c.text(e instanceof Error ? e.message : String(e), 400);
      }
      // a new question follows the saved messages; an approval continues the last one (same id, its parts answered)
      const last = incoming.at(-1)!;
      const asking = last.role === 'user';
      const saved = s.saved.messages;
      const prior = asking ? incoming.slice(0, -1) : incoming;
      if (prior.length !== saved.length || prior.some((m, i) => m.id !== saved[i].id)) return c.text('This conversation changed in another window. Reload the page to continue it.', 409);
      if (asking || !turnModel) turnModel = readSettings().defaultReviewModel;
      const valid = asking ? [...saved, last] : [...saved.slice(0, -1), last];
      const messages = await convertToModelMessages(withContext(valid, revs));
      s.saved.messages = valid; // before starting: a failed start keeps the question, so the window stays in step
      s.saved.status = 'working';
      s.write();
      live ??= launch({ repo, dir, cfg, settings: readSettings(), store: s, model: () => turnModel }).catch((e: unknown) => {
        live = undefined; // let the next message retry
        throw e;
      });
      const current = await live;
      let result: Awaited<ReturnType<Live['agent']['stream']>>;
      try {
        // the harness sends only the last user message to the native session, or continues the paused turn
        result = await current.agent.stream({ session: current.session, messages, abortSignal: AbortSignal.any([c.req.raw.signal, abort.signal]) });
      } catch (error) {
        live = undefined;
        await current.stop().catch(() => {});
        throw error;
      }
      const response = result.toUIMessageStreamResponse({
        originalMessages: valid, generateMessageId: randomUUID,
        // also when the reviewer stops or leaves: the partial answer is saved under the id their window has
        onEnd: async ({ messages: completed, isAborted, isCancelled, outcome }) => {
          try {
            const answer = completed.at(-1);
            const resolved = await Promise.resolve(result.response).catch(() => undefined);
            if (answer?.role === 'assistant') answer.metadata = { model: turnModel, resolvedModel: resolved?.modelId };
            s.saved.messages = completed;
            s.saved.status = isAborted || isCancelled ? 'interrupted' : outcome.status === 'failed' ? 'failed' : 'idle';
            s.write();
            if (!closed) await current.checkpoint();
          } catch (error) {
            console.error(`reviewroom: assistant: ${error instanceof Error ? error.message : String(error)}`);
            live = undefined; // recover from the saved checkpoint on the next question
            await current.stop().catch(() => {});
          } finally {
            end();
          }
        },
        onError: (e) => (e instanceof Error ? e.message : String(e)),
      });
      streaming = true;
      return response;
    } catch (error) {
      if (store?.saved.status === 'working') {
        store.saved.status = abort.signal.aborted || c.req.raw.signal.aborted ? 'interrupted' : 'failed';
        store.write();
      }
      throw error;
    } finally {
      if (!streaming) end();
    }
  });
  /** Stops a running turn (its answer is saved), then the native session, saving where it can resume. */
  const close = () => (closed ??= (async () => {
    turn?.abort.abort();
    await turn?.done;
    await (await live?.catch(() => undefined))?.stop();
  })());
  return { app, close };
}
