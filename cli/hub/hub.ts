// The hub's poll: read the three registries, drop dead sessions, then fill in git, agent, counts and health.
// reviewroom sessions are first-party: a record counts only while its server answers with its own pid
// (x-reviewroom-pid), a record whose server is gone is deleted, and counts come from GET /api/summary.
// Crit and Plannotator sessions are checked with kill -0 and only hidden when dead; their files stay.
import fs from 'node:fs';
import path from 'node:path';
import { classifySession, sessionOpenUrl } from './classify.ts';
import { GitMetaCache } from './gitmeta.ts';
import { critLoopbackUrl, sanitizeLoopbackUrl } from './loopback.ts';
import { type Agent, agentAncestor, lsofCwd, processCommand, runCapture } from './proc.ts';
import { defaultCritHome, readCritRaw, readPlanRaw, readReviewroom, resolvePlannotatorDataDir } from './sources.ts';
import type { HubSnapshot, SessionInfo, ToolName } from '../../src/hub/model.shared.ts';
import { alive } from '../lib/lock.ts';
import { stopServer, unregister } from '../lib/registry.ts';

export interface HubOptions {
  /** How often the page refreshes (ms). */
  pollIntervalMs?: number;
  /** Override ~/.crit and the Plannotator data dir (tests). reviewroom's follows REVIEWROOM_HOME. */
  critHome?: string;
  plannotatorDataDir?: string;
  healthTimeoutMs?: number;
  gitTtlMs?: number;
}

const CRIT_MODES = new Set(['review', 'live', 'preview', 'plan']);
const basename = (p: string | null) => (p ? path.basename(p.replace(/\/+$/, '')) || p : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A session with nothing known beyond what the caller sets. */
function session(id: string, tool: ToolName, now: string, fields: Partial<SessionInfo>): SessionInfo {
  return {
    id, tool, pid: null, port: null, url: null, urlNote: null, cwd: null, branch: null, worktree: null, repoRoot: null, repository: null,
    category: 'other', kind: 'unknown', target: null, classificationSource: '', origin: null, originSource: null, parentAgentPid: null,
    parentAgentGroup: null, author: null, mode: null, label: null, project: null, reviewPath: null, startedAt: null, updatedAt: null, commentCount: null,
    resolvedCommentCount: null, unresolvedCommentCount: null, reviewRound: null, browserClients: null, interacted: null,
    firstSeenAt: now, lastSeenAt: now, health: 'unknown', notes: [], ...fields,
  };
}

function withClassification(info: SessionInfo, c: ReturnType<typeof classifySession>) {
  Object.assign(info, { category: c.category, kind: c.kind, target: c.target, classificationSource: c.source });
}

function withAgent(info: SessionInfo, agent: Agent | null, source: string) {
  if (agent) Object.assign(info, { origin: agent.name, originSource: source, parentAgentPid: agent.pid, parentAgentGroup: `${agent.name}:${agent.pid}` });
}

const getJson = async (url: string, timeout: number) => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  return { res, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
};

export class Hub {
  readonly pollIntervalMs: number;
  readonly critHome: string;
  readonly plannotatorDataDir: string;
  lastPollAtMs = 0;

  private readonly healthTimeoutMs: number;
  private readonly git: GitMetaCache;
  private readonly agents = new Map<number, { at: number; value: Promise<Agent | null> }>();
  private readonly cwds = new Map<number, { at: number; value: Promise<string | null> }>();
  private sessions = new Map<string, SessionInfo>();
  private lastError: string | null = null;
  private polling: Promise<SessionInfo[]> | null = null;
  private versions: Promise<Record<string, string | null>> | null = null;

  constructor(opts: HubOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.critHome = opts.critHome ?? defaultCritHome();
    this.plannotatorDataDir = opts.plannotatorDataDir ?? resolvePlannotatorDataDir();
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 800;
    this.git = new GitMetaCache(opts.gitTtlMs ?? 10_000);
  }

  /** Crit's and Plannotator's `--version`, once (shown when they differ from the verified ones). */
  toolVersions(): Promise<Record<string, string | null>> {
    const grab = async (bin: string) => {
      const r = await runCapture([bin, '--version'], 2000);
      return r.ok ? (r.stdout.trim().split('\n')[0]?.trim() ?? null) : null;
    };
    this.versions ??= Promise.all([grab('crit'), grab('plannotator')]).then(([crit, plannotator]) => ({ crit, plannotator }));
    return this.versions;
  }

  private cached<T>(map: Map<number, { at: number; value: Promise<T> }>, pid: number, ttl: number, load: () => Promise<T>) {
    const hit = map.get(pid);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = load();
    map.set(pid, { at: Date.now(), value });
    return value;
  }
  private agentOf = (pid: number) => this.cached(this.agents, pid, 30_000, () => agentAncestor(pid));
  private cwdOf = (pid: number) => this.cached(this.cwds, pid, 15_000, () => lsofCwd(pid));

  private async withGit(info: SessionInfo, cwd: string | null, fallbackBranch: string | null = null) {
    const git = await this.git.get(cwd);
    info.branch = git.repo ? git.branch : fallbackBranch;
    info.worktree = git.worktree;
    info.repoRoot = git.repositoryRoot ?? git.toplevel;
    info.repository = basename(info.repoRoot);
  }

  /** Poll unless the last one is younger than `maxAgeMs`; concurrent callers share one poll. */
  fresh(maxAgeMs = this.pollIntervalMs / 2): Promise<SessionInfo[]> {
    if (this.polling) return this.polling;
    if (Date.now() - this.lastPollAtMs < maxAgeMs) return Promise.resolve([...this.sessions.values()]);
    return this.poll();
  }

  poll(): Promise<SessionInfo[]> {
    this.polling ??= this.doPoll().finally(() => (this.polling = null));
    return this.polling;
  }

  private async doPoll(): Promise<SessionInfo[]> {
    const now = new Date().toISOString();
    const next = new Map<string, SessionInfo>();
    const enrich: Promise<unknown>[] = [];
    const errors: string[] = [];
    const read = <T>(what: string, fn: () => T[]) => {
      try {
        return fn();
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message}`);
        return [];
      }
    };

    for (const e of read('crit registry', () => readCritRaw(this.critHome))) {
      const pid = e.pid;
      if (pid === null || !alive(pid)) continue; // stale daemon entry: hidden, not deleted
      const notes: string[] = [];
      let { url, note } = e.publicUrl ? sanitizeLoopbackUrl(e.publicUrl) : { url: null, note: null };
      if (e.publicUrl && !url) notes.push(`recorded public_url rejected: ${note}`);
      if (!url && e.port !== null) ({ url, note } = critLoopbackUrl(e.host, e.port));
      else if (!url) note ??= 'no port in registry';
      const mode = e.args.length === 0 ? 'review' : CRIT_MODES.has(e.args[0]) ? e.args[0] : 'file';
      const label = e.args.join(' ') || null;
      const c = classifySession({ tool: 'crit', mode, label, args: e.args });
      const info = session(`crit:${e.key}`, 'crit', now, {
        pid, port: e.port, url: sessionOpenUrl('crit', url, c.kind), urlNote: note, cwd: e.cwd, branch: e.branch, mode, label,
        project: basename(e.cwd), reviewPath: e.reviewPath, startedAt: e.startedAt, updatedAt: e.registryUpdatedAt, notes,
      });
      withClassification(info, c);
      next.set(info.id, info);
      enrich.push((async () => {
        if (e.cwd) await this.withGit(info, e.cwd, e.branch || null); // live git state beats the branch crit recorded at start
        withAgent(info, await this.agentOf(pid), 'ancestor process name (heuristic)');
        if (!info.url || info.port === null) return;
        const base = `http://127.0.0.1:${info.port}`;
        try {
          const { res, body } = await getJson(`${base}/api/health`, this.healthTimeoutMs);
          info.health = res.status < 500 ? 'ok' : 'unreachable';
          const bc = body?.browser_clients;
          info.browserClients = typeof bc === 'number' || typeof bc === 'boolean' ? bc : null;
        } catch {
          info.health = 'unreachable';
        }
        try {
          const rounds = (await getJson(`${base}/api/rounds`, this.healthTimeoutMs)).body;
          info.reviewRound = num(rounds?.current_round);
          if (Array.isArray(rounds?.rounds)) {
            const rs = rounds.rounds.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
            info.commentCount = rs.reduce((n, r) => n + (num(r.comment_count) ?? 0), 0);
            info.updatedAt = rs.map((r) => r.captured_at).filter((v): v is string => typeof v === 'string').sort().at(-1) ?? info.updatedAt;
          }
        } catch {} // optional
        info.interacted = (info.commentCount ?? 0) > 0 || (info.reviewRound ?? 1) > 1 || info.browserClients === true || (num(info.browserClients) ?? 0) > 0;
      })());
    }

    for (const e of read('plannotator registry', () => readPlanRaw(this.plannotatorDataDir))) {
      const pid = e.pid;
      if (pid === null || !alive(pid)) continue;
      const notes: string[] = [];
      let { url, note } = sanitizeLoopbackUrl(e.url);
      // no recorded URL: rebuild it from the port (loopback by construction); a remote one is never linked
      if (!url && e.port !== null && !e.url) ({ url, note } = { url: `http://localhost:${e.port}`, note: 'url reconstructed from registry port' });
      else if (!url && e.url) notes.push(`recorded url rejected: ${note}`);
      const info = session(`plannotator:${pid}`, 'plannotator', now, {
        pid, port: e.port, url, urlNote: note, mode: e.mode, label: e.label, project: e.project, startedAt: e.startedAt, updatedAt: e.registryUpdatedAt, notes,
      });
      withClassification(info, classifySession({ tool: 'plannotator', mode: e.mode, label: e.label }));
      next.set(info.id, info);
      enrich.push((async () => {
        info.cwd = await this.cwdOf(pid); // plannotator does not record it
        await this.withGit(info, info.cwd);
        withClassification(info, classifySession({ tool: 'plannotator', mode: e.mode, label: e.label, command: await processCommand(pid) }));
        withAgent(info, await this.agentOf(pid), 'ancestor process name (heuristic)');
        if (!info.url) return;
        try {
          const res = await fetch(info.url, { redirect: 'manual', signal: AbortSignal.timeout(this.healthTimeoutMs) });
          info.health = res.status < 500 ? 'ok' : 'unreachable';
        } catch {
          info.health = 'unreachable';
        }
      })());
    }

    for (const r of read('reviewroom sessions', readReviewroom)) {
      const info = session(`reviewroom:${r.pid}`, 'reviewroom', now, {
        pid: r.pid, port: r.port, url: r.url, cwd: r.repo, author: r.author ?? null, mode: r.mode, label: r.title, project: basename(r.repo), reviewPath: r.dir,
        startedAt: r.startedAt || null, updatedAt: r.registryUpdatedAt,
      });
      withClassification(info, classifySession({ tool: 'reviewroom', mode: r.mode, label: r.title, pr: r.number, head: r.head }));
      next.set(info.id, info);
      // nothing answers as this server: it died without cleaning up (SIGKILL, crash)
      const gone = () => (next.delete(info.id), unregister(r.pid));
      enrich.push((async () => {
        let res: Response | null = null;
        try {
          res = await fetch(`${r.url}api/summary`, { redirect: 'manual', signal: AbortSignal.timeout(this.healthTimeoutMs) });
        } catch (e) {
          if ((e as Error).name !== 'TimeoutError') return gone();
          info.health = 'unreachable'; // busy (git calls are synchronous), not gone
        }
        if (res && res.headers.get('x-reviewroom-pid') !== String(r.pid)) return gone(); // another process on its port
        if (res) {
          info.health = res.ok ? 'ok' : 'unreachable';
          // counts only (rounds, threads, tabs): /api/summary never carries thread text. Optional: a bad body is not a dead server.
          const body = res.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
          info.reviewRound = num(body?.round);
          info.commentCount = num(body?.threads);
          info.unresolvedCommentCount = num(body?.open);
          info.resolvedCommentCount = info.commentCount !== null && info.unresolvedCommentCount !== null ? info.commentCount - info.unresolvedCommentCount : null;
          info.browserClients = num(body?.browserClients);
          info.walkthrough = body?.walkthrough === true;
          info.interacted = (info.commentCount ?? 0) > 0 || (info.reviewRound ?? 1) > 1 || (info.browserClients ?? 0) > 0;
        }
        await this.withGit(info, r.repo);
        withAgent(info, r.agent ?? (await this.agentOf(r.pid)), r.agent ? 'recorded by reviewroom' : 'ancestor process name (heuristic)');
      })());
    }

    await Promise.allSettled(enrich);
    for (const info of next.values()) info.firstSeenAt = this.sessions.get(info.id)?.firstSeenAt ?? info.firstSeenAt;
    this.sessions = next;
    this.lastError = errors.join('; ') || null;
    this.lastPollAtMs = Date.now();
    return [...next.values()];
  }

  /** SIGTERM one session that a fresh poll still finds; the client names a session, never a pid. A reviewroom
   *  server is stopped the way `reviewroom stop` does it (only if it answers with that pid). */
  async closeSession(id: string): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: 'not-found' | 'refused' }> {
    await this.poll();
    this.lastPollAtMs = 0; // whatever happens next, the next look polls again
    const s = this.sessions.get(id);
    if (!s?.pid) return { ok: false, reason: 'not-found' };
    if (s.pid === process.pid || s.pid <= 1) return { ok: false, reason: 'refused' };
    if (s.tool === 'reviewroom') {
      const stopped = s.reviewPath && fs.existsSync(s.reviewPath) ? await stopServer(s.reviewPath, s.pid) : null;
      return stopped ? { ok: true, session: s } : { ok: false, reason: 'refused' };
    }
    // the pid may have been reused since the tool wrote its registry: signal it only if it still runs that tool
    if (!(await processCommand(s.pid))?.includes(s.tool)) return { ok: false, reason: 'refused' };
    try {
      process.kill(s.pid, 'SIGTERM');
      return { ok: true, session: s };
    } catch {
      return { ok: false, reason: 'not-found' };
    }
  }

  snapshot(): HubSnapshot {
    const sessions = [...this.sessions.values()].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt) || a.id.localeCompare(b.id));
    return { generatedAt: new Date().toISOString(), pollIntervalMs: this.pollIntervalMs, count: sessions.length, sessions, lastError: this.lastError };
  }
}
