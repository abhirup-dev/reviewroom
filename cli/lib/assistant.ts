// Experimental assistant (REVIEWROOM_ASSISTANT=1, rr-2l7): one native Claude Code conversation per review server,
// through AI SDK's ACP harness. The harness owns the ACP protocol and the native session; AI SDK owns message
// conversion and the UI message stream (`toUIMessageStreamResponse`). This file owns only the session's lifetime and
// the route. The packages are experimental: pinned exactly, kept out of the CLI bundle (scripts/build.ts) and loaded
// only when enabled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { UIMessage } from 'ai';
import type { HarnessAgent } from '@ai-sdk/harness/agent';
import { PKG } from './paths.ts';
import type { ReviewConfig } from './config.ts';
import { git } from './git.ts';
import { AskMetadata, contextPrompt } from '../../src/assistant/context.shared.ts';

export const assistantEnabled = () => !!process.env.REVIEWROOM_ASSISTANT;

// API-key, gateway and nested-session overrides would replace the reviewer's native subscription login
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AI_GATEWAY_API_KEY', 'CLAUDECODE'];

/** @ai-sdk/harness-acp's bootstrap command (its PNPM_INSTALL_COMMAND, not exported): checked on upgrades by the first start. */
const PNPM_INSTALL = 'pnpm install --frozen-lockfile --prod --store-dir .pnpm-store';

/** Scope subscription overrides to the bridge process; upstream currently launches it as `node <bridge>`. */
export function assistantLaunch(command: string) {
  const bun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  return `env ${OVERRIDES.map((key) => `-u ${key}`).join(' ')} ${command.replace(/^node /, `${bun} `)}`;
}

/** The native agent's package and lock: the harness installs them once under ~/.ai-sdk-harness and reuses them. */
const agentFile = (f: string) => fs.readFileSync(path.join(PKG, 'cli/lib/assistant-agent', f), 'utf8');

export const instructions = (repo: string, dir: string, cfg: ReviewConfig) =>
  `You are the assistant beside a Review Room code review. The reviewer reads the diff ${cfg.base}..${cfg.head} of ${repo}` +
  ` with the walkthrough in ${dir}. Use git, gh and \`reviewroom <command> --dir ${dir}\` to look things up. Answer briefly.` +
  ` Your reply renders in Review Room, where a Markdown link to an rr: address opens it beside the chat. Name code by its` +
  ` lines, e.g. [src/app.ts:12-20](rr:code/src/app.ts#L12-20) for the head side, [src/app.ts:8](rr:code/src/app.ts@base#L8)` +
  ` for the old side, keeping any @<commit> of a link the reviewer attached; a whole declaration as [ReviewApp](rr:sym/ReviewApp);` +
  ` a walkthrough section or block as [its title](rr:doc/overview), by its id in ${dir}/review.html. Link only lines you` +
  ' have read, symbols you found declared, and ids that exist; write any other name as `code`, never a guessed link.' +
  ` Do not change files unless the reviewer asks. Read relative skill references from ${path.join(PKG, 'skills/reviewroom')};` +
  ` the skill file is ${path.join(PKG, 'skills/reviewroom/SKILL.md')}. The Review Room skill follows.\n\n` +
  fs.readFileSync(path.join(PKG, 'skills/reviewroom/SKILL.md'), 'utf8');

async function start(repo: string, dir: string, cfg: ReviewConfig) {
  const [{ HarnessAgent }, { createACP }, { createLocalSandbox }] = await Promise.all([import('@ai-sdk/harness/agent'), import('@ai-sdk/harness-acp'), import('ai-sdk-sandbox-local')]);
  // The bridge names Node explicitly; adapt its launch to Bun without changing the server's environment.
  // Only a machine without Node needs a private shebang fallback for the native adapter.
  const bin = Bun.which('node') ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'reviewroom-assistant-'));
  if (bin) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const free = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = free.port!;
  void free.stop();
  const harness = createACP({
    harnessId: 'reviewroom-claude', // stable: the installed agent (~/.ai-sdk-harness/.harness-bootstrap/<id>) is keyed by it
    source: { type: 'npm-locked', packageJson: agentFile('package.json'), pnpmLockYaml: agentFile('pnpm-lock.yaml') },
    executable: 'claude-agent-acp',
    modelMapping: { type: 'session-config-option', path: 'model' }, // the adapter dropped session/set_model
    isMcpToolCall: (tc) => typeof tc.title === 'string' && tc.title.startsWith('mcp__'),
    resolveHostToolCall: () => undefined,
    port,
    portEndpoint: { url: `ws://127.0.0.1:${port}` }, // ai-sdk-sandbox-local lacks getPortEndpoint
    auth: 'direct',
  });
  // allow-reads: the native policy decides first; what it would ask about (edits, most commands) comes to the reviewer
  // as an AI SDK tool approval, never approved here.
  const agent: HarnessAgent = new HarnessAgent({ harness, model: 'sonnet', permissionMode: 'allow-reads', instructions: instructions(repo, dir, cfg), sandboxConfig: { workDir: '.' } });
  // the local "sandbox" is the harness's process runner on this machine, not isolation. The harness installs the agent
  // through it (restricted() views) with pnpm; Bun installs the same lock instead (it migrates pnpm-lock.yaml).
  const local = await createLocalSandbox({ cwd: repo }).createSession();
  const adapt = (view: ReturnType<typeof local.restricted>) => Object.assign(Object.create(view) as typeof view, {
    run: (o: Parameters<typeof view.run>[0]) => view.run(o.command === PNPM_INSTALL ? { ...o, command: 'bun install --frozen-lockfile --production' } : o),
    spawn: (o: Parameters<typeof view.spawn>[0]) => view.spawn({
      ...o,
      command: assistantLaunch(o.command),
      ...(bin ? { env: { ...o.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } } : {}),
    }),
  });
  const sandbox = Object.assign(adapt(local), { restricted: () => adapt(local.restricted()) });
  const cleanup = async () => {
    await local.stop();
    if (bin) fs.rmSync(bin, { recursive: true, force: true });
  };
  try {
    const session = await agent.createSession({ sandboxSession: sandbox });
    return { agent, session, stop: () => session.destroy().finally(cleanup) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

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

/** POST /api/assistant: AI SDK's chat request in, its UI message stream out. */
export function assistantRoutes({ repo, dir, cfg }: { repo: string; dir: string; cfg: ReviewConfig }) {
  let live: ReturnType<typeof start> | undefined;
  // base and head as commits now, so a quoted @head line means what the reviewer saw (a rev git can't read stays a name)
  const commit = (rev: string) => git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], repo, { soft: true })?.trim() || rev;
  const app = new Hono();
  app.post('/', async (c) => {
    const body = await c.req.json<{ trigger?: string; messages?: unknown }>();
    // the native session cannot branch: regenerating or editing a past message would desync it from the transcript
    if (body.trigger !== 'submit-message') return c.json({ error: 'The assistant only takes new messages.' }, 400);
    const revs = { base: commit(cfg.base), head: commit(cfg.head) };
    const { validateUIMessages, convertToModelMessages } = await import('ai');
    let valid: UIMessage[];
    try {
      valid = await validateUIMessages<UIMessage>({ messages: body.messages, metadataSchema: AskMetadata });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const messages = await convertToModelMessages(withContext(valid, revs));
    live ??= start(repo, dir, cfg).catch((e: unknown) => {
      live = undefined; // let the next message retry
      throw e;
    });
    const { agent, session } = await live;
    // the harness sends only the last user message to the native session, or continues the paused turn when the
    // messages end in approval responses
    const result = await agent.stream({ session, messages, abortSignal: c.req.raw.signal });
    return result.toUIMessageStreamResponse({ generateMessageId: randomUUID, onError: (e) => (e instanceof Error ? e.message : String(e)) });
  });
  return { app, close: async () => { const current = await live?.catch(() => undefined); await current?.stop(); } };
}
