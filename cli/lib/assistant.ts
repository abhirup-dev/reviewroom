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
import type { HarnessAgent, HarnessAgentSession } from '@ai-sdk/harness/agent';
import { PKG } from './paths.ts';
import type { ReviewConfig } from './config.ts';

export const assistantEnabled = () => !!process.env.REVIEWROOM_ASSISTANT;

// API-key, gateway and nested-session overrides would replace the reviewer's native subscription login
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AI_GATEWAY_API_KEY', 'CLAUDECODE'];

/** @ai-sdk/harness-acp's bootstrap command (its PNPM_INSTALL_COMMAND, not exported): checked on upgrades by the first start. */
const PNPM_INSTALL = 'pnpm install --frozen-lockfile --prod --store-dir .pnpm-store';

/** The native agent's package and lock: the harness installs them once under ~/.ai-sdk-harness and reuses them. */
const agentFile = (f: string) => fs.readFileSync(path.join(PKG, 'cli/lib/assistant-agent', f), 'utf8');

const instructions = (repo: string, dir: string, cfg: ReviewConfig) =>
  `You are the assistant beside a Review Room code review. The reviewer reads the diff ${cfg.base}..${cfg.head} of ${repo}` +
  ` with the walkthrough in ${dir}. Use git, gh and \`reviewroom <command> --dir ${dir}\` to look things up. Answer briefly and` +
  ` name code as path:line. Do not change files unless the reviewer asks. The Review Room skill follows.\n\n` +
  fs.readFileSync(path.join(PKG, 'skills/reviewroom/SKILL.md'), 'utf8');

async function start(repo: string, dir: string, cfg: ReviewConfig) {
  const [{ HarnessAgent }, { createACP }, { createLocalSandbox }] = await Promise.all([import('@ai-sdk/harness/agent'), import('@ai-sdk/harness-acp'), import('ai-sdk-sandbox-local')]);
  // shortcut: the local sandbox spawns with process.env, so the overrides go from this server's own env; a sandbox with
  // an env option would scope it to the agent.
  for (const k of OVERRIDES) delete process.env[k];
  // Bun only, no Node: the harness launches its bridge as `node <bridge>` and the agent's bin scripts are `#!/usr/bin/env node`.
  // A `node` that is this Bun (Bun runs as Node when invoked under that name), first on this server's PATH: so its
  // children, the agent's own commands included, get Bun for `node`.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewroom-assistant-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
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
  const bunInstall = <T extends object>(view: T & { run: (o: { command: string }) => unknown }): T =>
    Object.assign(Object.create(view) as T, { run: (o: { command: string }) => view.run(o.command === PNPM_INSTALL ? { ...o, command: 'bun install --frozen-lockfile --production' } : o) });
  const sandbox = Object.assign(Object.create(local) as typeof local, { restricted: () => bunInstall(local.restricted()) });
  const session = await agent.createSession({ sandboxSession: sandbox });
  // no teardown: the bridge and the agent exit with this server (they watch the host connection)
  return { agent, session };
}

/** POST /api/assistant: AI SDK's chat request in, its UI message stream out. */
export function assistantRoutes({ repo, dir, cfg }: { repo: string; dir: string; cfg: ReviewConfig }) {
  let live: Promise<{ agent: HarnessAgent; session: HarnessAgentSession }> | undefined;
  const app = new Hono();
  app.post('/', async (c) => {
    const body = await c.req.json<{ trigger?: string; messages?: unknown }>();
    // the native session cannot branch: regenerating or editing a past message would desync it from the transcript
    if (body.trigger !== 'submit-message') return c.json({ error: 'The assistant only takes new messages.' }, 400);
    const { validateUIMessages, convertToModelMessages } = await import('ai');
    const messages = await convertToModelMessages(await validateUIMessages<UIMessage>({ messages: body.messages }));
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
  return { app };
}
