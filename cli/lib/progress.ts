// The CLI/server alone append generation facts. File bytes, never parsed JSON, identify a validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseProgress, reduceProgress, ProgressLine, type Artifact } from '../../src/kernel/state/progress.shared.ts';
import { parseWalkthrough } from '../../src/slides/model.shared.ts';

const filename = (dir: string, artifact: Artifact) => path.join(dir, artifact === 'review' ? 'review.html' : 'walkthrough.json');
export const progressHash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export function artifactHash(dir: string, artifact: Artifact) {
  const file = filename(dir, artifact);
  return fs.existsSync(file) ? progressHash(fs.readFileSync(file)) : undefined;
}
export function progressLines(dir: string) {
  const file = path.join(dir, 'progress.jsonl');
  return parseProgress(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}
export const readProgress = (dir: string) => reduceProgress(progressLines(dir), { walkthrough: artifactHash(dir, 'walkthrough'), review: artifactHash(dir, 'review') });
export function appendProgress(dir: string, line: Omit<ProgressLine, 'at'> & { hash?: string }) {
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
