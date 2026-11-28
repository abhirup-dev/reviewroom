// The ACP bridge and its children share a private process group. Keep a recognizable group leader around
// the bridge so a saved PID can be checked before signaling it, even after a server crash.
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reviewStore } from './review-store.ts';

// API-key, gateway and nested-session overrides would replace the reviewer's native subscription login.
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AI_GATEWAY_API_KEY', 'CLAUDECODE'];
export const bunCommand = `'${process.execPath.replaceAll("'", "'\\''")}'`;

type Group = { pid: number; marker: string };

function killGroup({ pid, marker }: Group) {
  const ownsGroup = () => {
    const ps = Bun.spawnSync(['/bin/ps', '-ww', '-o', 'pgid=,command=', '-p', String(pid)]);
    const [pgid, ...command] = ps.stdout.toString().trim().split(/\s+/);
    return Number(pgid) === pid && command.at(-1) === marker;
  };
  if (!ownsGroup()) return;
  const killed = Bun.spawnSync(['/bin/kill', '-KILL', '--', String(-pid)]);
  if (killed.exitCode && ownsGroup()) throw new Error(`Could not stop assistant process group ${pid}: ${killed.stderr.toString().trim()}`);
}

export function reapAssistantGroup(dir: string) {
  const file = reviewStore(dir).assistantProcess;
  const group = file.read();
  if (group) killGroup(group);
  file.remove();
}

export async function spawnAssistantBridge(dir: string, cwd: string, { command, workingDirectory, env, abortSignal }: { command: string; workingDirectory?: string; env: Record<string, string>; abortSignal?: AbortSignal }, claudeExecutable?: string) {
  abortSignal?.throwIfAborted();
  // Upstream launches the bridge as node. Use Bun and keep Claude's own HOME for its login and plugins.
  const bridge = `env ${OVERRIDES.map((key) => `-u ${key}`).join(' ')} ${command.replace(/^node /, `${bunCommand} `)}`;
  const marker = `reviewroom-assistant-${randomUUID()}`;
  // The shell acknowledges that it is running and waits for the parent to save its identity before it
  // launches the bridge. EOF before that handshake means the parent died. Its exit trap reaps any helpers
  // the bridge leaves behind.
  const proc = Bun.spawn(['/bin/sh', '-c', `printf r; read -r start || exit 1; trap 'kill -KILL 0' EXIT; ${bridge}`, marker], {
    cwd: path.resolve(cwd, workingDirectory ?? '.'),
    env: { ...process.env, ...env, HOME: process.env.HOME ?? os.homedir(), ...(claudeExecutable && { CLAUDE_CODE_EXECUTABLE: claudeExecutable }) },
    detached: true, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const group = { pid: proc.pid, marker };
  const reader = proc.stdout.getReader();
  try {
    if ((await reader.read()).done) throw new Error('The assistant process group did not start.');
    abortSignal?.throwIfAborted();
    reviewStore(dir).assistantProcess.write(group);
    await proc.stdin.write('start\n');
    await proc.stdin.end();
  } catch (error) {
    await proc.stdin.end();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const stop = () => killGroup(group);
  if (abortSignal?.aborted) stop();
  else abortSignal?.addEventListener('abort', stop, { once: true });
  void proc.exited.then(() => abortSignal?.removeEventListener('abort', stop));
  return {
    pid: proc.pid, stdout: proc.stdout, stderr: proc.stderr,
    wait: async () => ({ exitCode: await proc.exited }),
    kill: async () => stop(),
  };
}
