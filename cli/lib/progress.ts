import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// The CLI/server alone append generation facts. File bytes, never parsed JSON, identify a validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARTIFACTS, parseProgress, pendingArtifact, reduceProgress, pendingAssistantWork, ProgressLine, type Artifact, type Requester } from '../../src/kernel/state/progress.shared.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';

const filename = (dir: string, artifact: Artifact) => path.join(dir, artifact === 'report' ? REPORT_FILE : WALKTHROUGH_FILE);
export const progressHash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export function artifactHash(dir: string, artifact: Artifact) {
  const file = filename(dir, artifact);
  return fs.existsSync(file) ? progressHash(fs.readFileSync(file)) : undefined;
}
export function progressLines(dir: string) {
  const file = path.join(dir, 'progress.jsonl');
  return parseProgress(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}
/** The file has changed since it last passed validation, or never passed: true for any edit a round made. */
export function unvalidated(dir: string, artifact: Artifact) {
  const hash = artifactHash(dir, artifact);
  const last = progressLines(dir).findLast((l) => l.artifact === artifact && l.event === 'validated');
  return !!hash && !(last && 'hash' in last && last.hash === hash);
}
export const readProgress = (dir: string) => reduceProgress(progressLines(dir), { walkthrough: artifactHash(dir, 'walkthrough'), report: artifactHash(dir, 'report') });
type NewLine = ProgressLine extends infer L ? (L extends ProgressLine ? Omit<L, 'at'> : never) : never;
/** Appends `lines` in one write (all or none of them land). A file whose last line was cut off gets its newline first,
 *  so the cut line stays alone and malformed instead of swallowing the first new one. */
export function appendProgress(dir: string, ...lines: NewLine[]) {
  const file = path.join(dir, 'progress.jsonl');
  const at = new Date().toISOString();
  let text = lines.map((line) => JSON.stringify(ProgressLine.parse({ ...line, at })) + '\n').join('');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, fs.statSync(file).size - 1);
    fs.closeSync(fd);
    if (last[0] !== 0x0a) text = '\n' + text;
  }
  fs.appendFileSync(file, text); // shortcut: a short write (EFBIG, disk full) can land half a batch; rare, and Retry recovers
}
export function recordArtifact(dir: string, artifact: Artifact, event: 'written' | 'validated', extra: { head?: string; source?: 'pr' } = {}, checkedHash = artifactHash(dir, artifact)) {
  if (!checkedHash) return;
  // the last hash under the current request (or since a reset): the same bytes written again after a new request are news
  const since = progressLines(dir).filter((l) => l.artifact === artifact);
  const current = since.slice(since.findLastIndex((l) => l.event === 'requested' || l.event === 'reset') + 1);
  const last = current.findLast((l) => 'hash' in l);
  if (event === 'written' && last && 'hash' in last && last.hash === checkedHash) return;
  const raw = fs.readFileSync(filename(dir, artifact), 'utf8');
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
