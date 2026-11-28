import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewStore } from './review-store.ts';
import { reviewSummary } from './review-summary.ts';
import { recordArtifact, requestGeneration } from './progress.ts';

test('sent feedback is the agent\'s move until it answers in a later round, delivered or not (the assistant never runs wait); approval is nobody\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-summary-'));
  try {
    const store = reviewStore(dir);
    store.walkthrough.write('{}');
    const message = (author: 'you' | 'agent', round: number) => ({ id: `${author}${round}`, author, round, body: 'x', at: 'x' });
    const write = (...messages: ReturnType<typeof message>[]) => store.state.write({
      version: 1, round: 2, viewed: {}, pins: [],
      rounds: [{ n: 1, status: 'sent', startedAt: 'x', sentAt: 'x' }, { n: 2, status: 'open', startedAt: 'x' }],
      threads: [{ id: 't', anchor: { kind: 'general' }, status: 'open', createdRound: 1, messages }],
    });
    write(message('you', 1));
    expect(reviewSummary(dir).waitingOn).toBe('agent');
    write(message('you', 1), message('agent', 2));
    expect(reviewSummary(dir).waitingOn).toBe('reviewer');
    store.state.write({ version: 1, round: 1, viewed: {}, pins: [], threads: [], rounds: [{ n: 1, status: 'approved', startedAt: 'x', sentAt: 'x' }] });
    expect(reviewSummary(dir).waitingOn).toBe(null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the walkthrough is offered to play once validated, never while it is being written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-summary-'));
  try {
    reviewStore(dir).walkthrough.write('{}');
    expect(reviewSummary(dir).walkthrough).toBe(true); // nobody asked for one: an older review's
    requestGeneration(dir, 'assistant');
    expect(reviewSummary(dir).walkthrough).toBe(false);
    recordArtifact(dir, 'walkthrough', 'validated');
    expect(reviewSummary(dir).walkthrough).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
