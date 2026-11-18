import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProgress, artifactHash, progressLines, readProgress, recordArtifact, requestGeneration, resetGeneration, stopAssistantWork } from './progress.ts';

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

test('a stop read before a takeover\'s request and written after it leaves that request alone', () => inTemp((dir) => {
  requestGeneration(dir, 'assistant');
  const pendingBefore = readProgress(dir);
  requestGeneration(dir, 'agent', undefined, ['report']); // pr --force lands between the old server's read and write
  // the old server's stop names the requests it read
  appendProgress(dir, { artifact: 'report', event: 'stopped', reason: 'interrupted', request: pendingBefore.report.request! });
  expect(readProgress(dir).report).toMatchObject({ state: 'requested', by: 'agent' });
  stopAssistantWork(dir, 'interrupted'); // now: only the assistant's walkthrough is pending
  expect([readProgress(dir).walkthrough.state, readProgress(dir).report.state]).toEqual(['stopped', 'requested']);
}));

test('reset makes both documents idle again', () => inTemp((dir) => {
  requestGeneration(dir, 'agent');
  resetGeneration(dir);
  expect([readProgress(dir).walkthrough.state, readProgress(dir).report.state]).toEqual(['idle', 'idle']);
}));

test('a validated document edited, then its turn ended before the save was recorded, stops; a newer validation wins', () => inTemp((dir) => {
  const file = path.join(dir, REPORT_FILE);
  requestGeneration(dir, 'assistant', undefined, ['report']);
  fs.writeFileSync(file, '<rr-review>one</rr-review>');
  recordArtifact(dir, 'report', 'validated');
  fs.writeFileSync(file, '<rr-review>two</rr-review>'); // saved; the watcher has not recorded it
  expect(readProgress(dir).report.state).toBe('writing');
  stopAssistantWork(dir, 'failed');
  expect(readProgress(dir).report).toMatchObject({ state: 'stopped', reason: 'failed' }); // not pending forever
  expect(progressLines(dir).at(-1)).toMatchObject({ event: 'stopped', stale: expect.stringMatching(/^[a-f0-9]{64}$/) });
  recordArtifact(dir, 'report', 'validated'); // checked again, after the stop
  expect(readProgress(dir).report.state).toBe('validated');
}));

test('the same bytes written again under a new request are recorded: the request is no longer just reading the diff', () => inTemp((dir) => {
  const file = path.join(dir, REPORT_FILE);
  requestGeneration(dir, 'assistant', undefined, ['report']);
  fs.writeFileSync(file, '<rr-review>same</rr-review>');
  recordArtifact(dir, 'report', 'written');
  recordArtifact(dir, 'report', 'written'); // unchanged within one request: once
  expect(progressLines(dir).filter((l) => l.event === 'written')).toHaveLength(1);
  requestGeneration(dir, 'assistant', undefined, ['report']);
  expect(readProgress(dir).report.state).toBe('requested');
  recordArtifact(dir, 'report', 'written'); // identical bytes, new request
  expect(readProgress(dir).report.state).toBe('writing');
  resetGeneration(dir);
  requestGeneration(dir, 'agent', undefined, ['report']);
  recordArtifact(dir, 'report', 'written');
  expect(readProgress(dir).report.state).toBe('writing');
}));
