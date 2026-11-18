import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// The CLI/server alone append generation facts. File bytes, never parsed JSON, identify a validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseProgress, reduceProgress, interruptedOnStart, failedOnTurnEnd, ProgressLine, type Artifact, type Requester } from '../../src/kernel/state/progress.shared.ts';
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
export const readProgress = (dir: string) => reduceProgress(progressLines(dir), { walkthrough: artifactHash(dir, 'walkthrough'), report: artifactHash(dir, 'report') });
type NewLine = ProgressLine extends infer L ? (L extends ProgressLine ? Omit<L, 'at'> : never) : never;
export function appendProgress(dir: string, line: NewLine) {
  fs.appendFileSync(path.join(dir, 'progress.jsonl'), JSON.stringify(ProgressLine.parse({ ...line, at: new Date().toISOString() })) + '\n');
}
export function recordArtifact(dir: string, artifact: Artifact, event: 'written' | 'validated', extra: { head?: string; source?: 'pr' } = {}, checkedHash = artifactHash(dir, artifact)) {
  if (!checkedHash) return;
  const lines = progressLines(dir);
  const last = [...lines].reverse().find((l) => l.artifact === artifact && 'hash' in l);
  if (event === 'written' && last && 'hash' in last && last.hash === checkedHash) return;
  const raw = fs.readFileSync(filename(dir, artifact), 'utf8');
  let facts = {};
  if (artifact === 'walkthrough') {
    const w = parseWalkthrough(raw);
    if (w.ok) facts = { chapters: w.value.chapters.length, slides: w.value.chapters.reduce((n, c) => n + c.steps.length, 0) };
  }
  appendProgress(dir, { artifact, event, hash: checkedHash, ...facts, ...extra });
}

const headFact = (head?: string) => (head && /^[a-f0-9]{40}$/.test(head) ? { head } : {});
/** Both documents requested of `by` (a fresh review for an agent, or the assistant's generate). */
export function requestGeneration(dir: string, by: Requester, head?: string) {
  for (const artifact of ['walkthrough', 'report'] as const) appendProgress(dir, { artifact, event: 'requested', by, ...headFact(head) });
}
/** A server starting (it holds the lock): assistant work left pending died with the previous server's turn. */
export function interruptOnStart(dir: string) {
  for (const artifact of interruptedOnStart(readProgress(dir))) appendProgress(dir, { artifact, event: 'stopped', reason: 'interrupted' });
}
/** An assistant generation turn ended (`interrupted`: the server is closing). Returns what it stopped. */
export function stopAfterTurn(dir: string, reason: 'failed' | 'interrupted') {
  const stopped = failedOnTurnEnd(readProgress(dir));
  for (const artifact of stopped) appendProgress(dir, { artifact, event: 'stopped', reason });
  return stopped;
}
