// The CLI/server alone append generation facts. File bytes, never parsed JSON, identify a validation.
import crypto from 'node:crypto';
import { reviewStore } from './review-store.ts';
import { ARTIFACTS, parseProgress, pendingArtifact, reduceProgress, pendingAssistantWork, ProgressLine, type Artifact, type Requester } from '../../src/kernel/state/progress.shared.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';

const document = (dir: string, artifact: Artifact) => reviewStore(dir)[artifact];
export const progressHash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export function artifactHash(dir: string, artifact: Artifact) {
  const bytes = document(dir, artifact).bytes();
  return bytes ? progressHash(bytes) : undefined;
}
export const progressLines = (dir: string) => parseProgress(reviewStore(dir).progress.read());
/** The file has changed since it last passed validation, or never passed: true for any edit a round made. */
export function unvalidated(dir: string, artifact: Artifact) {
  const hash = artifactHash(dir, artifact);
  const last = progressLines(dir).findLast((l) => l.artifact === artifact && l.event === 'validated');
  return !!hash && !(last && 'hash' in last && last.hash === hash);
}
export const readProgress = (dir: string) => reduceProgress(progressLines(dir), { walkthrough: artifactHash(dir, 'walkthrough'), report: artifactHash(dir, 'report') });
type NewLine = ProgressLine extends infer L ? (L extends ProgressLine ? Omit<L, 'at'> : never) : never;
export function appendProgress(dir: string, ...lines: NewLine[]) {
  const at = new Date().toISOString();
  reviewStore(dir).progress.append(lines.map((line) => JSON.stringify(ProgressLine.parse({ ...line, at })) + '\n').join(''));
}
export function recordArtifact(dir: string, artifact: Artifact, event: 'written' | 'validated', extra: { head?: string; source?: 'pr' } = {}, checkedHash = artifactHash(dir, artifact)) {
  if (!checkedHash) return;
  // the last hash under the current request (or since a reset): the same bytes written again after a new request are news
  const since = progressLines(dir).filter((l) => l.artifact === artifact);
  const current = since.slice(since.findLastIndex((l) => l.event === 'requested' || l.event === 'reset') + 1);
  const last = current.findLast((l) => 'hash' in l);
  if (event === 'written' && last && 'hash' in last && last.hash === checkedHash) return;
  const raw = document(dir, artifact).read() ?? '';
  let facts = {};
  if (artifact === 'walkthrough') {
    const w = parseWalkthrough(raw);
    if (w.ok) facts = { chapters: w.value.chapters.length, slides: w.value.chapters.reduce((n, c) => n + c.steps.length, 0) };
  }
  appendProgress(dir, { artifact, event, hash: checkedHash, ...facts, ...extra });
}
/** The agent has read the diff (`progress <review> read`): the walkthrough being requested now moves on to writing.
 *  False with no walkthrough requested; twice is harmless (nothing new is written). */
export function recordRead(dir: string) {
  const w = readProgress(dir).walkthrough;
  if (!pendingArtifact(w) || !w.request) return false;
  if (!w.read) appendProgress(dir, { artifact: 'walkthrough', event: 'read', request: w.request });
  return true;
}

const headFact = (head?: string) => (head && /^[a-f0-9]{40}$/.test(head) ? { head } : {});
/** `artifacts` (both by default) requested of `by`, in one write, each with a new request id: a fresh review for an
 *  agent, or the assistant's generate. */
export function requestGeneration(dir: string, by: Requester, head?: string, artifacts: readonly Artifact[] = ARTIFACTS) {
  appendProgress(dir, ...artifacts.map((artifact) => ({ artifact, event: 'requested' as const, by, id: crypto.randomUUID(), ...headFact(head) })));
}
/** Documents back to idle (`pr --force --no-agent`: both): nothing requested any more. */
export const resetGeneration = (dir: string, artifacts: readonly Artifact[] = ARTIFACTS) => artifacts.length && appendProgress(dir, ...artifacts.map((artifact) => ({ artifact, event: 'reset' as const })));
/** The documents whose current state (validated, requested, writing or stopped) is for a head other than `head`, each
 *  by its own last event: stale after the PR moved. A request for an old head is not pending work for the new one. */
export const staleArtifacts = (dir: string, head: string) => {
  const progress = readProgress(dir);
  return ARTIFACTS.filter((a) => progress[a].state !== 'idle' && !!progress[a].head && progress[a].head !== head);
};
/** The walkthrough on disk is the PR's, imported untouched, but not validated at `head` (the PR moved, and fetching it
 *  again failed): the next setup fetches it again. Anyone's edit since makes it theirs, never replaced. */
export function importToRetry(dir: string, head: string) {
  const last = progressLines(dir).findLast((l) => l.artifact === 'walkthrough' && l.event === 'validated');
  if (last?.event !== 'validated' || last.source !== 'pr' || last.hash !== artifactHash(dir, 'walkthrough')) return false;
  const w = readProgress(dir).walkthrough;
  return !(w.state === 'validated' && w.head === head);
}
/** Stops the assistant work pending now, each naming its request: a stop that lands after a newer request is ignored.
 *  `interrupted` when a server starts (the previous server's turn died with it) or closes; `failed` when a turn ends. */
export function stopAssistantWork(dir: string, reason: 'failed' | 'interrupted') {
  const pending = pendingAssistantWork(readProgress(dir));
  if (pending.length) appendProgress(dir, ...pending.map(({ artifact, request, stale }) => ({ artifact, event: 'stopped' as const, reason, request, ...(stale && { stale }) })));
}
