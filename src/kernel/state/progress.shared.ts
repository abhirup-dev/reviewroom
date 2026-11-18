import { z } from 'zod';

// Events (on disk, appended by the CLI and server) are facts; states (reduced) are what the page shows.
// idle -> requested(by) -> writing -> validated; editing a validated file goes back to writing.
// stopped(reason): an assistant generation turn ended unvalidated (`failed`), or a server started while an assistant
// generation was pending (`interrupted`: turns live in the server process). `by: 'agent'` is never auto-stopped.
// A stop names the request it stops (`request`: that request's `id`) and applies only while that request is current, so
// a stop written late (an old server's turn ending after a takeover) never lands on a newer request. reset: back to idle.
const facts = { head: z.string().optional(), slides: z.number().int().nonnegative().optional(), chapters: z.number().int().nonnegative().optional(), source: z.literal('pr').optional() };
const identity = { at: z.iso.datetime(), artifact: z.enum(['walkthrough', 'report']), ...facts };
export const Requester = z.enum(['assistant', 'agent']);
export const StopReason = z.enum(['failed', 'interrupted']);
export const ProgressLine = z.discriminatedUnion('event', [
  // `by` defaults to agent and `id` is optional: lines written before they existed still parse
  z.object({ ...identity, event: z.literal('requested'), by: Requester.default('agent'), id: z.string().optional() }),
  z.object({ ...identity, event: z.enum(['written', 'validated']), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ ...identity, event: z.literal('stopped'), reason: StopReason, request: z.string() }),
  z.object({ ...identity, event: z.literal('reset') }),
]);
export type ProgressLine = z.infer<typeof ProgressLine>;
export type Artifact = ProgressLine['artifact'];
export type Requester = z.infer<typeof Requester>;
export type StopReason = z.infer<typeof StopReason>;
export type GenerationState = 'idle' | 'requested' | 'writing' | 'validated' | 'stopped';
export type ArtifactProgress = { state: GenerationState; by?: Requester; request?: string; reason?: StopReason; hash?: string; slides?: number; chapters?: number; head?: string; source?: 'pr' };
/** `generation`: the built-in assistant's generation turn, from the server (absent where no assistant runs).
 *  `awaitingApproval`: the turn waits for the reviewer in the assistant panel; its documents stay requested/writing. */
export type Progress = Record<Artifact, ArtifactProgress> & { generation?: { running: boolean; awaitingApproval: boolean } };
export const ARTIFACTS: readonly Artifact[] = ['walkthrough', 'report'];
/** Generation is under way: someone was asked and has not finished. */
export const pendingArtifact = (p: ArtifactProgress) => p.state === 'requested' || p.state === 'writing';
/** Pending assistant work, with the request to stop: what a starting server stops as `interrupted` (its turn died with
 *  the previous server), and what an ended generation turn stops (never an agent's request made since). */
export const pendingAssistantWork = (progress: Progress) =>
  ARTIFACTS.flatMap((a) => (pendingArtifact(progress[a]) && progress[a].by === 'assistant' && progress[a].request ? [{ artifact: a, request: progress[a].request }] : []));

/** Ignore incomplete/malformed lines (including a writer's unfinished final append). */
export function parseProgress(text: string): ProgressLine[] {
  return text.split('\n').flatMap((line) => {
    try { const r = ProgressLine.safeParse(JSON.parse(line)); return r.success ? [r.data] : []; } catch { return []; }
  });
}

/** `hashes`: each file's current content hash; `validated` holds only while the file still has the validated bytes. */
export function reduceProgress(lines: ProgressLine[], hashes: Partial<Record<Artifact, string>>): Progress {
  const result: Progress = { walkthrough: { state: 'idle' }, report: { state: 'idle' } };
  for (const line of lines) {
    const prev = result[line.artifact];
    if (line.event === 'reset') { result[line.artifact] = { state: 'idle' }; continue; }
    if (line.event === 'requested') {
      const { id, by, head } = line;
      result[line.artifact] = { state: 'requested', by, ...(id && { request: id }), ...(head && { head }) };
      continue;
    }
    // nothing was requested: a legacy review, whatever was validated in it; but a walkthrough imported from the PR
    // (`pr --no-agent`) counts as validated while it has those bytes, asked for or not
    if (prev.state === 'idle' && !(line.event === 'validated' && line.source === 'pr')) continue;
    // an unrequested import edited since: nobody is writing it, so it is idle again (never pending)
    if (prev.state === 'validated' && !prev.by && line.event === 'written') { result[line.artifact] = { state: 'idle' }; continue; }
    if (line.event === 'stopped') {
      // only the current request, and only while it is unfinished; it keeps what was written (slides, hash) and who was asked
      if (line.request === prev.request && prev.state !== 'validated') result[line.artifact] = { ...prev, state: 'stopped', reason: line.reason };
      continue;
    }
    const { at: _at, artifact: _a, event, ...rest } = line;
    // stopped is sticky against saves (nothing is generating any more); only a validation or a new request leaves it
    if (event === 'written' && prev.state === 'stopped') result[line.artifact] = { ...prev, ...rest };
    else result[line.artifact] = { ...rest, ...(prev.by && { by: prev.by }), ...(prev.request && { request: prev.request }), state: event === 'validated' ? 'validated' : 'writing' };
  }
  for (const a of ARTIFACTS) {
    if (result[a].state === 'validated' && result[a].hash !== hashes[a]) result[a] = result[a].by ? { ...result[a], state: 'writing' } : { state: 'idle' };
  }
  return result;
}
