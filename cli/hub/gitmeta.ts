// Branch and worktree of a session's cwd, cached so the 2 s poll does not run git for unchanged directories.
// A linked worktree has a --git-dir that differs from --git-common-dir. No file contents are read.
import path from 'node:path';
import { runCapture } from './proc.ts';

export interface GitInfo {
  repo: boolean;
  branch: string | null;
  worktree: boolean | null;
  toplevel: string | null;
  /** Main checkout root, shared by its linked worktrees. */
  repositoryRoot: string | null;
}

export const NO_REPO: GitInfo = { repo: false, branch: null, worktree: null, toplevel: null, repositoryRoot: null };

async function probeGit(cwd: string): Promise<GitInfo> {
  const rev = await runCapture(['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], 2500);
  const [toplevel, gitDir, commonDir] = rev.stdout.trim().split('\n').map((l) => l.trim());
  if (!rev.ok || !gitDir || !commonDir) return NO_REPO;
  const norm = (p: string) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p));
  const common = norm(commonDir);
  const b = await runCapture(['git', '-C', cwd, 'branch', '--show-current'], 2500);
  return {
    repo: true,
    branch: (b.ok && b.stdout.trim()) || null, // empty: detached HEAD
    worktree: norm(gitDir) !== common,
    toplevel: toplevel || null,
    repositoryRoot: path.basename(common) === '.git' ? path.dirname(common) : toplevel || null,
  };
}

export class GitMetaCache {
  private readonly cache = new Map<string, { at: number; value: GitInfo }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10_000) {
    this.ttlMs = ttlMs;
  }

  async get(cwd: string | null): Promise<GitInfo> {
    if (!cwd) return NO_REPO;
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await probeGit(cwd);
    this.cache.set(cwd, { at: Date.now(), value });
    return value;
  }
}
