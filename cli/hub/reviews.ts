// The hub starts reviews: reviews on disk (running or not), Add a PR by URL, Play. Who writes a review is chosen per
// review: Play is the built-in assistant (it turns it on for that review and generates); the page's "Use my own agent"
// hands the reviewer a prompt for an external agent instead, and the hub starts nothing for it.
//   reviews on disk   every review folder (allReviewFolders) with a config.json, read on each poll (no timer)
//   Add a PR          clone (or fetch) under <home>/repos/<owner>/<repo>, then `reviewroom pr <owner/repo#n> --no-agent --no-serve`
//   Play              `assistant: true` in the review's config.json, `start` in the background on the existing
//                     folder (startDetached), then POST api/generate on its own loopback URL (the proxy refuses it by design)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { configPath, readConfig } from '../lib/config.ts';
import { allReviewFolders, formatReviewId, parseReviewId, reviewFolder, type ReviewId } from '../lib/review-id.ts';
import { homeDir } from '../lib/paths.ts';
import { artifactHash, readProgress } from '../lib/progress.ts';
import { routeId, runningServer, startDetached, type ServerRecord } from '../lib/registry.ts';
import { pendingArtifact, type Progress } from '../../src/kernel/state/progress.shared.ts';
import type { GenerationState } from '../../src/hub/model.shared.ts';
import { WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';

const run = promisify(execFile);

// The hub is one process, so an in-memory queue per key is the lock: Add, Play, close and re-add of one review (keyed by
// its folder) run one at a time, as do clones and fetches of one repository (keyed by its clone path).
const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = path.resolve(key);
  const result = (queues.get(k) ?? Promise.resolve()).then(fn);
  const settled = result.catch(() => {}); // a failure releases the lock too
  queues.set(k, settled);
  void settled.then(() => queues.get(k) === settled && queues.delete(k));
  return result;
}

/** Where generation stands, from the review's progress log: ready once both documents validated. */
export function generationState({ walkthrough: w, report: r }: Progress): GenerationState {
  if (w.state === 'validated' && r.state === 'validated') return 'ready';
  if (pendingArtifact(w) || pendingArtifact(r)) return 'generating';
  if (w.state === 'stopped' || r.state === 'stopped') return 'stopped';
  return 'idle';
}

/** A running review's generation state, from its own folder; undefined if it can't be read. */
export function generationOf(dir: string): GenerationState | undefined {
  try {
    return generationState(readProgress(dir));
  } catch {
    return undefined;
  }
}

export type DiskReview = { dir: string; routeId: string; reviewId?: string; repo: string; title: string | null; branch: string | null; generation: GenerationState; hasWork: boolean; updatedAt: string | null };
// what Remove would lose; Add writes only config.json, a scaffolded report and the PR snapshot
const WORK = [WALKTHROUGH_FILE, 'state.json', 'assistant.json', 'rounds'];

/** Every review folder with a config.json (a broken one is skipped: the hub lists, it doesn't repair). */
export function diskReviews(): DiskReview[] {
  return allReviewFolders().flatMap((dir) => {
    const file = path.join(dir, 'config.json');
    if (!fs.existsSync(file)) return [];
    try {
      const c = readConfig(dir);
      const generation = generationState(readProgress(dir));
      const reportHash = artifactHash(dir, 'report');
      const editedReport = reportHash !== undefined && reportHash !== c.reportScaffoldHash;
      return [{
        dir, routeId: routeId(dir), reviewId: c.id, repo: c.repoPath ?? '', title: c.title ?? null, branch: c.headLabel ?? c.head ?? null,
        generation, hasWork: editedReport || generation !== 'idle' || WORK.some((f) => fs.existsSync(path.join(dir, f))), updatedAt: fs.statSync(file).mtime.toISOString(),
      }];
    } catch {
      return [];
    }
  });
}

// ------------------------------------------------------------ Add a PR
/** Where Add a PR clones a repository: `<home>/repos/<owner>/<repo>`, asserted to stay inside `<home>/repos`. */
export function clonePath(owner: string, repo: string) {
  const root = path.resolve(homeDir(), 'repos');
  const dest = path.resolve(root, owner.toLowerCase(), repo.toLowerCase()); // GitHub names ignore case, as macOS does: one clone, one queue key
  if (!dest.startsWith(root + path.sep)) throw new Error(`not a repository path: ${owner}/${repo}`);
  return dest;
}

// Test seam: REVIEWROOM_TEST_CLONE_ROOT=<dir> clones <dir>/<owner>/<repo>.git instead of GitHub (e2e has no GitHub).
// Only the tests set it; nothing documents it for users.
const cloneSource = (owner: string, repo: string) => (process.env.REVIEWROOM_TEST_CLONE_ROOT ? path.join(process.env.REVIEWROOM_TEST_CLONE_ROOT, owner, `${repo}.git`) : null);

/** What went wrong, readable: the command's last line, without git's or the CLI's prefixes. */
const why = (e: unknown) => {
  const err = e as { stdout?: string; stderr?: string; message?: string; code?: string };
  if (err.code === 'ENOENT') return null;
  const line = (err.stdout || err.stderr || err.message || String(e)).trim().split('\n').filter(Boolean).at(-1) ?? '';
  return line.replace(/^(fatal|error|reviewroom):\s*/i, '');
};

/** Clones (or fetches) the PR's repository and sets its review up without a server or an agent. Returns the hub route ID. */
export async function addPr(url: string, entry = process.argv[1]): Promise<{ ok: true; routeId: string; dir: string; running: boolean } | { ok: false; error: string }> {
  const raw = url.trim();
  const page = URL.parse(raw);
  let pr: ReviewId;
  try {
    if (page?.origin !== 'https://github.com' || page.username || page.password) throw new Error('not a GitHub URL');
    pr = parseReviewId(raw);
  } catch {
    return { ok: false, error: 'That is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>).' };
  }
  const dest = clonePath(pr.owner, pr.repo);
  const source = cloneSource(pr.owner, pr.repo);
  try {
    // one clone or fetch of a repository at a time: a second Add of a new one waits, then fetches
    await serialized(dest, async () => {
      if (fs.existsSync(path.join(dest, '.git'))) return void (await run('git', ['-C', dest, 'fetch', '--prune', 'origin']));
      // into a fresh temporary folder outside repos/ (same disk, for the rename): a failed clone leaves no half clone
      fs.mkdirSync(path.join(homeDir(), 'tmp'), { recursive: true });
      const tmp = fs.mkdtempSync(path.join(homeDir(), 'tmp', 'clone-'));
      try {
        if (source) await run('git', ['clone', '--quiet', source, tmp]);
        else await run('gh', ['repo', 'clone', `${pr.owner}/${pr.repo}`, tmp, '--', '--quiet']);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(tmp, dest);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  } catch (e) {
    const w = why(e);
    if (w === null) return { ok: false, error: source ? 'git is not installed.' : 'Adding a PR needs the GitHub CLI (gh): install it and sign in with `gh auth login`.' };
    return { ok: false, error: `Could not get ${pr.owner}/${pr.repo}: ${w}` };
  }
  try {
    // the Review ID names the folder: a re-add waits for a Play or close of it, and they for it
    const id = formatReviewId(pr);
    const dir = reviewFolder(pr);
    const running = await serialized(dir, async () => {
      await run(process.execPath, [entry, 'pr', id, '--no-agent', '--no-serve', '--no-open', '--repo', dest], { maxBuffer: 1 << 24 });
      return !!(await runningServer(dir));
    });
    return { ok: true, routeId: routeId(dir), dir, running };
  } catch (e) {
    return { ok: false, error: `Could not set up the review: ${why(e) || 'reviewroom pr failed'}` };
  }
}

// ------------------------------------------------------------ Play
export type GenerateResult = { ok: true; started: boolean } | { ok: false; code: string | null; error: string };
export type PlayResult = { ok: true; url: string; pid: number; started: boolean; generate: GenerateResult | null } | { ok: false; error: string };

/** api/generate on the review's own loopback URL: `starting` (the server is still recovering) is retried a few times. */
export async function generate(rec: Pick<ServerRecord, 'url'>, timeoutMs = 5000): Promise<GenerateResult | null> {
  // each request, body included, is bounded: Play holds the review's lock, and a close or re-add waits behind it
  const call = (p: string, init: RequestInit = {}) => fetch(rec.url + p, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    // a body that isn't JSON (a plain-text error) reads as {}; one that never ends is a timeout
    .then(async (r) => ({ r, body: (await r.json().catch((e: Error) => { if (e.name !== 'SyntaxError') throw e; return {}; })) as { generate?: boolean; started?: boolean; code?: string; error?: string } }));
  const meta = await call('api/meta').then(({ body }) => body, (e: Error) => e);
  if (meta instanceof Error) return { ok: false, code: null, error: `The review did not answer: ${meta.message}` };
  if (!meta.generate) return { ok: false, code: 'assistant_off', error: 'The review did not turn the built-in assistant on, so nothing was generated.' };
  for (let i = 0; ; i++) {
    const res = await call('api/generate', { method: 'POST' }).catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, code: null, error: `The review did not answer: ${res.message}` };
    const { r, body } = res;
    if (r.ok) return { ok: true, started: !!body.started };
    if (body.code === 'starting' && i < 20) {
      await new Promise((res) => setTimeout(res, 250));
      continue;
    }
    return { ok: false, code: body.code ?? null, error: body.error ?? `Generate failed (HTTP ${r.status}).` };
  }
}

/** Play, the built-in path: a running review just opens. A stopped one is marked as the built-in assistant's
 *  (`assistant: true` in its config.json), started, and asked for both documents unless they are validated already.
 *  ("Use my own agent" is the client's: a prompt to paste, and nothing started here.) */
export async function play(route: string, entry = process.argv[1]): Promise<PlayResult> {
  const found = diskReviews().find((r) => r.routeId === route);
  if (!found) return { ok: false, error: 'No such review on this machine.' };
  // one at a time with other Plays, closes and re-adds of it: only the Play that starts the server asks it to generate,
  // and a later one finds that server and just opens it
  return serialized(found.dir, async (): Promise<PlayResult> => {
    const review = diskReviews().find((r) => r.routeId === route); // as it is now, after whatever held the lock before
    if (!review) return { ok: false, error: 'No such review on this machine.' };
    const rec = await runningServer(review.dir);
    if (rec) return { ok: true, url: rec.url, pid: rec.pid, started: false, generate: null };
    if (!review.repo || !fs.existsSync(review.repo)) return { ok: false, error: `The review's repository is gone: ${review.repo || 'not recorded'}` };
    const file = configPath(review.dir);
    fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), assistant: true }, null, 2));
    try {
      const { server, started } = await startDetached(review.repo, review.dir, ['--no-open'], entry);
      const gen = started && review.generation !== 'ready' ? await generate(server) : null;
      return { ok: true, url: server.url, pid: server.pid, started, generate: gen };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}

/** Remove a stopped review: its folder is deleted (the page asked first if it held work). The repository's clone stays:
 *  other reviews may use it. A running one is refused: Close it first. */
export async function remove(route: string, confirmed: boolean): Promise<{ ok: true } | { ok: false; error: string; status: 404 | 409 }> {
  const found = diskReviews().find((r) => r.routeId === route); // the folder comes from disk, never from the request
  if (!found) return { ok: false, error: 'No such review on this machine.', status: 404 };
  // one at a time with Plays, closes and re-adds of it: a Play waiting behind this finds nothing to start
  return serialized(found.dir, async () => {
    if (await runningServer(found.dir)) return { ok: false, error: 'It is running: Close it first.', status: 409 };
    const current = diskReviews().find((r) => r.routeId === route);
    if (!current) return { ok: false, error: 'No such review on this machine.', status: 404 };
    if (current.hasWork && !confirmed) return { ok: false, error: 'This review has saved work. Choose Remove again to confirm.', status: 409 };
    fs.rmSync(found.dir, { recursive: true, force: true });
    return { ok: true };
  });
}
