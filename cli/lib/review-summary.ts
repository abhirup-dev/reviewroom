// One review's status, from its folder alone: what the hub lists for every review, running or not, and /api/summary.
// Counts only, never thread text.
import { reviewStore } from './review-store.ts';
import { readState } from './state.ts';
import { artifactHash, readProgress } from './progress.ts';
import { awaitingAgent, currentRound, undelivered } from '../../src/kernel/state/ops.shared.ts';
import { pendingArtifact, type Progress } from '../../src/kernel/state/progress.shared.ts';
import type { ReviewState } from '../../src/kernel/state/model.shared.ts';
import type { GenerationState, WaitingOn } from '../../src/hub/model.shared.ts';

export function generationState({ walkthrough: w, report: r }: Progress): GenerationState {
  if (w.state === 'validated' && r.state === 'validated') return 'ready';
  if (pendingArtifact(w) || pendingArtifact(r)) return 'generating';
  if (w.state === 'stopped' || r.state === 'stopped') return 'stopped';
  return 'idle';
}

// Sent feedback the agent hasn't answered (it replies in a later round; the built-in assistant never runs `wait`, so
// delivery alone can't tell), or threads it owes a reply since: the agent's move. Comments of the open round aren't
// sent yet, so they don't count. Documents written with no generation recorded (a review older than progress.jsonl,
// the demo) are ready for the reviewer too.
function waitingOn(s: ReviewState, generation: GenerationState, written: boolean): WaitingOn {
  const answered = (n: number) => s.threads.some((t) => t.messages.some((m) => m.author === 'agent' && m.round > n));
  if (currentRound(s)?.status === 'approved') return null;
  if (undelivered(s).some((r) => !answered(r.n))) return 'agent';
  const owed = s.threads.some((t) => {
    const last = t.messages.at(-1);
    return t.status === 'open' && last?.author === 'you' && last.round < s.round;
  });
  if (generation === 'generating' || owed) return 'agent';
  return generation === 'ready' || (generation === 'idle' && written) ? 'reviewer' : null;
}

// What Remove would lose. A finished round always wrote state.json.
const WORK = ['walkthrough', 'state', 'assistant'] as const;

/** Where the rounds and threads stand. `unread`: finished rounds `wait` hasn't printed yet. */
export const countsOf = (s: ReviewState) => ({
  round: s.round,
  roundStatus: currentRound(s)?.status ?? 'open',
  rounds: s.rounds.length,
  threads: s.threads.length,
  open: s.threads.filter((t) => t.status === 'open').length,
  awaitingAgent: awaitingAgent(s).length,
  unread: undelivered(s).map((r) => r.n),
  comments: s.threads.reduce((n, t) => n + t.messages.length, 0),
});
const NO_COUNTS = { round: null, roundStatus: null, rounds: null, threads: null, open: null, awaitingAgent: null, unread: null, comments: null };

function stateOf(dir: string) {
  try {
    return readState(dir, { repair: false });
  } catch {
    return null; // a broken state.json is the review's to repair; it still lists, without counts
  }
}

export function reviewSummary(dir: string) {
  const store = reviewStore(dir);
  const s = stateOf(dir);
  const progress = readProgress(dir);
  const generation = generationState(progress);
  const reportHash = artifactHash(dir, 'report');
  const editedReport = reportHash !== undefined && reportHash !== store.config.read()?.reportScaffoldHash;
  const last = Math.max(...[store.config, store.state, store.progress, store.report, store.walkthrough].map((f) => f.modifiedAt() ?? 0));
  return {
    ...(s ? countsOf(s) : NO_COUNTS),
    generation,
    waitingOn: s ? waitingOn(s, generation, editedReport || store.walkthrough.exists()) : null,
    // one to play: validated, or one nobody asked to (re)write (older than progress.jsonl); never one still being written
    walkthrough: store.walkthrough.exists() && (progress.walkthrough.state === 'validated' || progress.walkthrough.state === 'idle'),
    hasWork: editedReport || generation !== 'idle' || WORK.some((f) => store[f].exists()),
    updated: last ? new Date(last).toISOString() : null,
  };
}
export type ReviewSummary = ReturnType<typeof reviewSummary>;
