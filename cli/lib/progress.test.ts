import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProgress, artifactHash, importToRetry, progressLines, readProgress, recordArtifact, recordRead, requestGeneration, resetGeneration, staleArtifacts } from './progress.ts';

test('writers deduplicate bytes and validation retains the bytes checked, not a later edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
  try {
    appendProgress(dir, { artifact: 'report', event: 'requested', by: 'agent' });
    const file = path.join(dir, REPORT_FILE);
    fs.writeFileSync(file, '<rr-app><rr-review><section id="summary"><section id="nested"></section></section></rr-review></rr-app>');
    recordArtifact(dir, 'report', 'written');
    recordArtifact(dir, 'report', 'written');
    expect(progressLines(dir)).toHaveLength(2);
    expect(readProgress(dir).report).toMatchObject({ state: 'writing' });
    const checked = artifactHash(dir, 'report');
    fs.appendFileSync(file, 'changed while checking');
    recordArtifact(dir, 'report', 'validated', {}, checked);
    expect(readProgress(dir).report.state).toBe('writing');
    recordArtifact(dir, 'report', 'validated');
    expect(readProgress(dir).report.state).toBe('validated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const inTemp = (fn: (dir: string, log: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
  try { fn(dir, path.join(dir, 'progress.jsonl')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('a cut-off last line stays alone: the next append starts on its own line', () => inTemp((dir, log) => {
  fs.writeFileSync(log, '{"at":"2026-');
  requestGeneration(dir, 'agent');
  expect(progressLines(dir).map((l) => l.artifact)).toEqual(['walkthrough', 'report']);
}));

test('both requests land in one write, each with its own id', () => inTemp((dir, log) => {
  requestGeneration(dir, 'assistant');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.artifact, l.by])).toEqual([['walkthrough', 'assistant'], ['report', 'assistant']]);
  expect(new Set(lines.map((l) => l.id)).size).toBe(2);
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(path.join(blocked, 'progress.jsonl'), { recursive: true }); // appending fails: nothing is requested
  expect(() => requestGeneration(blocked, 'assistant')).toThrow();
}));

test('read names the walkthrough request; nothing requested records nothing, and twice writes once', () => inTemp((dir) => {
  expect(recordRead(dir)).toBe(false);
  requestGeneration(dir, 'agent');
  expect([recordRead(dir), recordRead(dir)]).toEqual([true, true]);
  const reads = progressLines(dir).filter((l) => l.event === 'read');
  expect(reads).toEqual([expect.objectContaining({ artifact: 'walkthrough', request: readProgress(dir).walkthrough.request })]);
  expect(readProgress(dir).walkthrough).toMatchObject({ state: 'writing', read: true });
}));

test('stale after the PR moved: each document by its own validation head, never one event for both', () => {
  const [A, B] = ['a'.repeat(40), 'b'.repeat(40)];
  const docs = (dir: string) => {
    fs.writeFileSync(path.join(dir, REPORT_FILE), '<rr-app></rr-app>');
    fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), '{}');
  };
  // the walkthrough still validated at A; the report validated at B, later: only the walkthrough is stale
  inTemp((dir) => {
    docs(dir);
    requestGeneration(dir, 'agent', A);
    recordArtifact(dir, 'walkthrough', 'validated', { head: A });
    recordArtifact(dir, 'report', 'validated', { head: B });
    expect(staleArtifacts(dir, B)).toEqual(['walkthrough']);
    resetGeneration(dir, staleArtifacts(dir, B));
    expect([readProgress(dir).walkthrough.state, readProgress(dir).report.state]).toEqual(['idle', 'validated']);
  });
  // the PR's walkthrough imported at B, then a report event for A: the walkthrough stays, only the report is stale
  inTemp((dir) => {
    docs(dir);
    recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', head: B });
    requestGeneration(dir, 'agent', A, ['report']);
    recordArtifact(dir, 'report', 'validated', { head: A });
    expect(staleArtifacts(dir, B)).toEqual(['report']);
    expect(staleArtifacts(dir, A)).toEqual(['walkthrough']);
  });
  // a request for an old head is stale on a re-add at a new head: no loading screen for an abandoned request
  inTemp((dir) => {
    requestGeneration(dir, 'agent', A);
    expect(staleArtifacts(dir, A)).toEqual([]);
    expect(staleArtifacts(dir, B)).toEqual(['walkthrough', 'report']);
    resetGeneration(dir, staleArtifacts(dir, B));
    expect([readProgress(dir).walkthrough.state, readProgress(dir).report.state]).toEqual(['idle', 'idle']);
  });
});

test('a PR walkthrough import is retried while the untouched import is not validated at the head; an edit makes it local', () => {
  const [A, B] = ['a'.repeat(40), 'b'.repeat(40)];
  inTemp((dir) => {
    expect(importToRetry(dir, A)).toBe(false); // nothing imported
    fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), '{}');
    recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', head: A });
    expect([importToRetry(dir, A), importToRetry(dir, B)]).toEqual([false, true]);
    resetGeneration(dir, staleArtifacts(dir, B)); // the re-add at B, whose fetch then failed
    expect(importToRetry(dir, B)).toBe(true); // the next re-add fetches again
    fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), '{"edited":1}');
    expect(importToRetry(dir, B)).toBe(false);
  });
});
