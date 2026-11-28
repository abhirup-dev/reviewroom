import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Global, WAIT_HOW, hint } from '../lib/args.ts';
import { makeProvider } from '../lib/git.ts';
import { loadConfig, readConfig, reviewArgs, shellArg } from '../lib/config.ts';
import { reviewStore } from '../lib/review-store.ts';
import { readState } from '../lib/state.ts';
import { countsOf } from '../lib/review-summary.ts';
import { liveServer, stopServer } from '../lib/registry.ts';
import { readReviewroom } from '../hub/sources.ts';
import { runningServer } from './serve.ts';

export type StatusOpts = Global & { all?: boolean; json?: boolean; full?: boolean };

/** What an agent needs next about a review: where it is, which revisions, where the round stands. */
export function summary(repo: string | null, dir: string) {
  const s = countsOf(readState(dir, { repair: false }));
  let base, head;
  try {
    if (repo) ({ base, head } = makeProvider(repo, loadConfig(dir, repo))); // no repo, or git fails: no base/head
  } catch {}
  const cfg = readConfig(dir);
  const role = process.env.REVIEWROOM_ASSISTANT_DIR && path.resolve(process.env.REVIEWROOM_ASSISTANT_DIR) === dir ? 'assistant' : 'external';
  return { ...s, id: cfg.id, dir, role, review: reviewStore(dir).report.file, profile: cfg.profile, url: liveServer(dir)?.url ?? null, base, head };
}

export function printSummary(x: ReturnType<typeof summary>) {
  console.log([
    ...(x.id ? [`review: ${shellArg(x.id)}`] : []), `url: ${x.url ?? 'not running'}`, `dir: ${x.dir}`, `report: ${x.review} (profile ${x.profile ?? 'explainer'})`,
    `base: ${x.base ?? '?'}  head: ${x.head ?? '?'}`, `round: ${x.round} (${x.roundStatus})  role: ${x.role}`,
    `threads: ${x.open} open, ${x.awaitingAgent} awaiting your reply`,
    ...(x.unread.length ? [`feedback: round ${x.unread.join(', ')} sent and not read yet`] : []),
  ].join('\n'));
}

export function cmdStatus(repo: string | null, dir: string, o: StatusOpts) {
  const x = summary(repo, dir);
  if (o.json) return console.log(JSON.stringify(x));
  printSummary(x);
  const args = reviewArgs(repo ?? '', dir);
  hint(
    x.unread.length && `Run \`reviewroom wait ${args}\`: it prints the unread feedback now`,
    !x.url && x.role === 'external' && `Run \`reviewroom start ${args}\` to serve it`,
    x.open && `Run \`reviewroom status ${args} --threads\` to read the open threads`,
    x.awaitingAgent && `Answer with \`reviewroom reply ${args} <thread> --file <reply.md>\``,
  );
}

export async function cmdStop(_repo: string | null, dir: string) {
  const rec = await stopServer(dir);
  console.log(rec ? `stopped server on port ${rec.port}` : 'no server running for this review (no-op)');
}

async function runningReviews() {
  const sessions = await Promise.all(readReviewroom().map(async ({ dir, pid, port, title, url }) => {
    if (!dir) return null;
    const server = await runningServer(dir);
    if (server?.pid !== pid || server.port !== port) return null;
    try {
      return { id: readConfig(dir).id, dir, url, pid, title };
    } catch { return null; }
  }));
  return sessions.filter((review) => review !== null).sort((a, b) => (a.id ?? a.dir).localeCompare(b.id ?? b.dir));
}

function printReviews(reviews: Awaited<ReturnType<typeof runningReviews>>) {
  console.log(`reviews: ${reviews.length || 'none'} running`);
  for (const { id, dir, url } of reviews) {
    const s = countsOf(readState(dir, { repair: false }));
    console.log(`  ${shellArg(id ?? dir)}  round ${s.round}, ${s.open} open, ${url}`);
  }
}

export async function cmdList({ json }: { json?: boolean }) {
  const reviews = await runningReviews();
  if (json) return console.log(JSON.stringify(reviews));
  printReviews(reviews);
  hint(!reviews.length && "Run `reviewroom pr '<owner/repo#n>'` to start one");
}

/** `reviewroom` with no command: who it is, the live reviews, and where to go from here. */
export async function cmdHome() {
  const self = fs.realpathSync(process.argv[1] ?? '');
  const onPath = Bun.which('reviewroom');
  const bin = onPath && fs.realpathSync(onPath) === self ? onPath : self;
  console.log(`bin: ${bin.replace(os.homedir(), '~')}\ndescription: Agent-guided code review: write a walkthrough and a report of a diff, then answer the reviewer's threads round by round`);
  printReviews(await runningReviews());
  hint(
    "Run `reviewroom pr '<owner/repo#n>'` (a PR, URL or branch; add `--head worktree` for uncommitted work) to start a review",
    `Run \`reviewroom wait <review>\` (${WAIT_HOW}) to resume one`,
    'Run `reviewroom --help` for every command and `reviewroom <command> --help` for its flags',
  );
}
