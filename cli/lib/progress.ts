import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
// The CLI/server alone append generation facts. File bytes, never parsed JSON, identify a validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARTIFACTS, parseProgress, reduceProgress, pendingAssistantWork, ProgressLine, type Artifact, type Requester } from '../../src/kernel/state/progress.shared.ts';
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
  fs.appendFileSync(file, text);
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
/** `artifacts` (both by default) requested of `by`, in one write, each with a new request id: a fresh review for an
 *  agent, or the assistant's generate. */
export function requestGeneration(dir: string, by: Requester, head?: string, artifacts: readonly Artifact[] = ARTIFACTS) {
  appendProgress(dir, ...artifacts.map((artifact) => ({ artifact, event: 'requested' as const, by, id: crypto.randomUUID(), ...headFact(head) })));
}
/** Both documents back to idle (`pr --force --no-agent`): nothing requested any more. */
export const resetGeneration = (dir: string) => appendProgress(dir, ...ARTIFACTS.map((artifact) => ({ artifact, event: 'reset' as const })));
/** Stops the assistant work pending now, each naming its request: a stop that lands after a newer request is ignored.
 *  `interrupted` when a server starts (the previous server's turn died with it) or closes; `failed` when a turn ends. */
export function stopAssistantWork(dir: string, reason: 'failed' | 'interrupted') {
  const pending = pendingAssistantWork(readProgress(dir));
  if (pending.length) appendProgress(dir, ...pending.map(({ artifact, request, stale }) => ({ artifact, event: 'stopped' as const, reason, request, ...(stale && { stale }) })));
}
