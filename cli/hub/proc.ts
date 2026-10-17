// Read-only process introspection for sessions of other tools: their cwd (lsof), launch command and
// the agent that started them (ps). Same-user processes only; never another process's environment.

/** Run a command (argv, never a shell string) and capture its output. Never throws; a timeout kills it. */
export async function runCapture(cmd: string[], timeoutMs = 3000): Promise<{ ok: boolean; stdout: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    timer = setTimeout(() => proc.kill(), timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    return { ok: (await proc.exited) === 0, stdout };
  } catch {
    return { ok: false, stdout: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** The full launch command, used only to tell what kind of session it is. */
export async function processCommand(pid: number): Promise<string | null> {
  const r = await runCapture(['ps', '-ww', '-o', 'command=', '-p', String(pid)], 2000);
  return (r.ok && r.stdout.trim()) || null;
}

/** A same-user process's working directory. */
export async function lsofCwd(pid: number): Promise<string | null> {
  const r = await runCapture(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!r.ok) return null;
  return r.stdout.split('\n').find((l) => l.startsWith('n') && l.length > 1)?.slice(1) ?? null;
}

// Agent CLIs by process name (the names plannotator's origin detection knows).
const AGENTS: [RegExp, string][] = [
  [/^claude(-code)?$/i, 'claude-code'],
  [/^codex$/i, 'codex'],
  [/^copilot(-cli)?$/i, 'copilot-cli'],
  [/^opencode$/i, 'opencode'],
  [/^gemini(-cli)?$/i, 'gemini-cli'],
  [/^droid$/i, 'droid'],
  [/^kiro(-cli)?$/i, 'kiro-cli'],
  [/^amp$/i, 'amp'],
  [/^pi$/i, 'pi'],
  [/^oh-my-pi$/i, 'oh-my-pi'],
];

export interface Agent {
  name: string;
  pid: number;
}

/** The nearest agent CLI among `pid`'s ancestors, from one `ps` listing. A hint, not proof: null when the chain
 *  is broken (a detached server is reparented once its launcher exits), so reviewroom records it at start. */
export async function agentAncestor(pid: number, maxDepth = 12): Promise<Agent | null> {
  const r = await runCapture(['ps', '-A', '-o', 'pid=,ppid=,comm='], 2000);
  if (!r.ok) return null;
  const procs = new Map<number, { ppid: number; comm: string }>();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (m) procs.set(+m[1], { ppid: +m[2], comm: m[3].trim() });
  }
  for (let p = pid, depth = 0; p > 1 && depth < maxDepth; depth++) {
    const proc = procs.get(p);
    if (!proc) break;
    const stem = (proc.comm.split('/').pop() ?? proc.comm).replace(/\.(exe|command)$/i, '');
    const hit = AGENTS.find(([re]) => re.test(stem));
    if (hit) return { name: hit[1], pid: p };
    p = proc.ppid;
  }
  return null;
}
