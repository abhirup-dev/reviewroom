// The hub starts reviews: reviews on disk (running or not), Add a PR by URL, Play. Who writes a review is chosen per
// review: Play is the built-in assistant (it turns it on for that review and generates); the page's "Use my own agent"
// hands the reviewer a prompt for an external agent instead, and the hub starts nothing for it.
//   reviews on disk   <home>/reviews/*/* with a config.json, read on each poll (no timer)
//   Add a PR          clone (or fetch) under <home>/repos/<owner>/<repo>, then `reviewroom pr <url> --no-agent --no-serve`
//   Play              `assistant: true` in the review's config.json, `review --forever` in the background on the existing
//                     folder (startDetached), then POST api/generate on its own loopback URL (the proxy refuses it by design)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { branchDir, configPath, readConfig } from '../lib/config.ts';
import { answers } from '../lib/lock.ts';
import { homeDir, reviewsDir } from '../lib/paths.ts';
import { readProgress } from '../lib/progress.ts';
import { liveServer, reviewId, startDetached, type ServerRecord } from '../lib/registry.ts';
import { pendingArtifact, type Progress } from '../../src/kernel/state/progress.shared.ts';
import type { GenerationState } from '../../src/hub/model.shared.ts';

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

/** A running review's generation state, from its own folder (a custom --dir too); undefined if it can't be read. */
export function generationOf(dir: string): GenerationState | undefined {
  try {
    return generationState(readProgress(dir));
  } catch {
    return undefined;
  }
}

export type DiskReview = { dir: string; id: string; repo: string; title: string | null; number: number | string | null; prUrl: string | null; branch: string | null; generation: GenerationState; updatedAt: string | null };

/** Every review folder with a config.json (a broken one is skipped: the hub lists, it doesn't repair). */
export function diskReviews(): DiskReview[] {
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    } catch {
      return [];
    }
  };
  return dirs(reviewsDir()).flatMap(dirs).flatMap((dir) => {
    const file = path.join(dir, 'config.json');
    if (!fs.existsSync(file)) return [];
    try {
      const c = readConfig(dir);
      return [{
        dir, id: reviewId(dir), repo: c.repoPath ?? '', title: c.title ?? null, number: c.number ?? null, prUrl: c.url ?? null, branch: c.headLabel ?? c.head ?? null,
        generation: generationState(readProgress(dir)), updatedAt: fs.statSync(file).mtime.toISOString(),
      }];
    } catch {
      return [];
    }
  });
}

// ------------------------------------------------------------ Add a PR
/** A GitHub pull request URL: owner, repo and number, or null. */
export function parsePrUrl(v: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d{1,9})(?:\/[^?#]*)?(?:[?#].*)?$/.exec(v.trim());
  if (!m) return null;
  const [owner, repo] = [m[1], m[2].replace(/\.git$/, '')];
  // checked after normalizing: each is one path segment under repos/, never empty, `.` or `..`
  const segment = (s: string) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !/^\.+$/.test(s);
  return segment(owner) && segment(repo) ? { owner, repo, number: +m[3] } : null;
}

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
  const err = e as { stderr?: string; message?: string; code?: string };
  if (err.code === 'ENOENT') return null;
  const line = (err.stderr ?? err.message ?? String(e)).trim().split('\n').filter(Boolean).at(-1) ?? '';
  return line.replace(/^(fatal|error|reviewroom):\s*/i, '');
};

/** Clones (or fetches) the PR's repository and sets its review up without a server or an agent. The review's id. */
export async function addPr(url: string, entry = process.argv[1]): Promise<{ ok: true; id: string; dir: string } | { ok: false; error: string }> {
  const pr = parsePrUrl(url);
  if (!pr) return { ok: false, error: 'That is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>).' };
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
    // the folder `pr` sets up (pr-<n>, or a legacy review of this PR in its head branch's folder: pr.ts prDir): a re-add
    // stops its server, so it waits for a Play or close of it, and they for it
    const own = branchDir(dest, `pr-${pr.number}`);
    const folder = fs.existsSync(own) ? own : (diskReviews().find((r) => Number(r.number) === pr.number && r.repo === dest)?.dir ?? own);
    const { stdout } = await serialized(folder, () =>
      run(process.execPath, [entry, 'pr', `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, '--no-agent', '--no-serve', '--no-open', '--repo', dest], { maxBuffer: 1 << 24 }));
    const dir = stdout.trim().split('\n').at(-1) ?? '';
    return { ok: true, id: reviewId(dir), dir };
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
  const call = (p: string, init: RequestInit = {}) => fetch(rec.url + p, { ...init, signal: AbortSignal.timeout(timeoutMs) }).then(async (r) => ({ r, text: await r.text() }));
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const meta = await call('api/meta').then(({ text }) => parse(text), (e: Error) => e);
  if (meta instanceof Error) return { ok: false, code: null, error: `The review did not answer: ${meta.message}` };
  if (!meta.generate) return { ok: false, code: 'assistant_off', error: 'The review did not turn the built-in assistant on, so nothing was generated.' };
  for (let i = 0; ; i++) {
    const res = await call('api/generate', { method: 'POST' }).catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, code: null, error: `The review did not answer: ${res.message}` };
    const { r } = res;
    const body = parse(res.text) as { started?: boolean; code?: string; error?: string };
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
export async function play(id: string, entry = process.argv[1]): Promise<PlayResult> {
  const found = diskReviews().find((r) => r.id === id);
  if (!found) return { ok: false, error: 'No such review on this machine.' };
  // one at a time with other Plays, closes and re-adds of it: only the Play that starts the server asks it to generate,
  // and a later one finds that server and just opens it
  return serialized(found.dir, async (): Promise<PlayResult> => {
    const review = diskReviews().find((r) => r.id === id); // as it is now, after whatever held the lock before
    if (!review) return { ok: false, error: 'No such review on this machine.' };
    const live = liveServer(review.dir);
    const rec = live && (await answers(live.pid, live.port, 1500)) !== false ? live : null;
    if (rec) return { ok: true, url: rec.url, pid: rec.pid, started: false, generate: null };
    if (!review.repo || !fs.existsSync(review.repo)) return { ok: false, error: `The review's repository is gone: ${review.repo || 'not recorded'}` };
    const file = configPath(review.dir);
    fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), assistant: true }, null, 2));
    const started = await startDetached(review.repo, review.dir, ['--no-open'], entry);
    if (!started) return { ok: false, error: `The review did not start: see ${path.join(review.dir, 'server.log')}` };
    const gen = review.generation === 'ready' ? null : await generate(started);
    return { ok: true, url: started.url, pid: started.pid, started: true, generate: gen };
  });
}
