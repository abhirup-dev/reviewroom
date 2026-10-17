import { expect, test } from 'bun:test';
import { applyOp, OpError, undelivered } from './ops';
import type { Op, ReviewState } from '../core/types';

const empty = (): ReviewState => ({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: '2026-01-01T00:00:00Z' }], threads: [], viewed: {}, pins: [] });
const run = (s: ReviewState, ...ops: Op[]) => ops.reduce(applyOp, s);
const create: Op = { op: 'createThread', id: 't_1', anchor: { kind: 'general' }, msgId: 'm_1', body: 'hi', author: 'you' };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof OpError ? e.code : 'other';
  }
  return 'ok';
};

test('ops apply, bump rev, and leave the input alone', () => {
  const s0 = empty();
  const s = run(s0, create, { op: 'addMessage', threadId: 't_1', id: 'm_2', body: 'reply', author: 'agent' }, { op: 'setViewed', path: 'a.go', viewed: true }, { op: 'setPin', ref: 'rr:doc/x', pinned: true }, { op: 'setCheck', id: 'c1', value: 'pass' }, { op: 'setThreadStatus', threadId: 't_1', status: 'resolved' });
  expect(s0.threads).toEqual([]);
  expect(s0.rev).toBeUndefined();
  expect(s.rev).toBe(6);
  expect(s.threads[0].messages.map((m) => [m.author, m.round, m.body])).toEqual([['you', 1, 'hi'], ['agent', 1, 'reply']]);
  expect(s.threads[0].status).toBe('resolved');
  expect(s.viewed).toEqual({ 'a.go': 1 });
  expect(s.pins).toEqual(['rr:doc/x']);
  expect(s.checks).toEqual({ c1: 'pass' });
});

test('re-applying ops is a no-op (safe to resend)', () => {
  const ops: Op[] = [create, { op: 'addMessage', threadId: 't_1', id: 'm_2', body: 'r', author: 'you' }, { op: 'setPin', ref: 'p', pinned: true }, { op: 'deleteMessage', threadId: 't_1', msgId: 'm_2' }];
  const once = run(empty(), ...ops);
  const twice = run(once, ...ops);
  expect(twice.threads).toEqual(once.threads);
  expect(twice.pins).toEqual(['p']);
});

test('edit, delete, and deleting the last message removes the thread', () => {
  let s = run(empty(), create, { op: 'addMessage', threadId: 't_1', id: 'm_2', body: 'x', author: 'you' }, { op: 'editMessage', threadId: 't_1', msgId: 'm_2', body: 'y' });
  expect(s.threads[0].messages[1].body).toBe('y');
  s = run(s, { op: 'deleteMessage', threadId: 't_1', msgId: 'm_2' });
  expect(s.threads[0].messages.length).toBe(1);
  s = run(s, { op: 'deleteMessage', threadId: 't_1', msgId: 'm_1' }, { op: 'setPin', ref: 'p', pinned: false });
  expect(s.threads).toEqual([]);
  expect(s.pins).toEqual([]);
});

test('typed errors for unknown targets and bad input', () => {
  const s = run(empty(), create);
  expect(code(() => applyOp(s, { op: 'editMessage', threadId: 't_1', msgId: 'nope', body: 'b' }))).toBe('not_found');
  expect(code(() => applyOp(s, { op: 'addMessage', threadId: 't_1', id: 'm', body: '', author: 'you' }))).toBe('bad_op');
});

test('finishRound advances once; a second finish of the same round conflicts', () => {
  const s = run(empty(), create, { op: 'finishRound', kind: 'feedback', round: 1, note: 'n' });
  expect(s.round).toBe(2);
  expect(s.rounds[0]).toMatchObject({ status: 'sent', note: 'n', deliveredAt: null });
  expect(s.rounds[1].status).toBe('open');
  expect(code(() => applyOp(s, { op: 'finishRound', kind: 'feedback', round: 1 }))).toBe('conflict');
  const a = applyOp(s, { op: 'finishRound', kind: 'approve' });
  expect(a.round).toBe(2);
  expect(code(() => applyOp(a, { op: 'finishRound', kind: 'approve' }))).toBe('conflict');
  // a reply after the finish lands in the new round
  expect(applyOp(s, { op: 'addMessage', threadId: 't_1', id: 'm_9', body: 'late', author: 'you' }).threads[0].messages[1].round).toBe(2);
});

test('delivery tracking: null until printed; legacy rounds count as delivered', () => {
  const legacy: ReviewState = { ...empty(), round: 2, rounds: [{ n: 1, status: 'sent', startedAt: 'x' }, { n: 2, status: 'open', startedAt: 'x' }] };
  expect(undelivered(legacy)).toEqual([]);
  const s = applyOp(legacy, { op: 'finishRound', kind: 'feedback' });
  expect(undelivered(s).map((r) => r.n)).toEqual([2]);
  expect(undelivered(applyOp(s, { op: 'markDelivered', round: 2 }))).toEqual([]);
});

test('heads: set on the open round only; a finished round keeps what it showed', () => {
  const s = applyOp(empty(), { op: 'setHeads', round: 1, heads: { base: 'b', head: 'h', '#1': 'h' } });
  expect(s.rounds[0].heads).toEqual({ base: 'b', head: 'h', '#1': 'h' });
  const sent = applyOp(s, { op: 'finishRound', kind: 'feedback' });
  expect(code(() => applyOp(sent, { op: 'setHeads', round: 1, heads: {} }))).toBe('conflict');
  expect(code(() => applyOp(sent, { op: 'setHeads', round: 9, heads: {} }))).toBe('not_found');
});

test('viewed in one layer of a stack is not viewed in another, nor in the whole stack', () => {
  const s = applyOp(empty(), { op: 'setViewed', path: 'a.go', viewed: true, pr: 366 });
  expect(s.viewed).toEqual({ '366:a.go': 1 });
  expect(applyOp(s, { op: 'setViewed', path: 'a.go', viewed: false, pr: 366 }).viewed).toEqual({});
});

test('per-PR verdicts: approve stands only if every PR is approved', () => {
  const changes = applyOp(empty(), { op: 'finishRound', kind: 'approve', verdicts: { 366: 'approve', 368: 'changes' } });
  expect([changes.rounds[0].status, changes.round, changes.rounds[0].verdicts]).toEqual(['sent', 2, { 366: 'approve', 368: 'changes' }]);
  expect(applyOp(empty(), { op: 'finishRound', kind: 'approve', verdicts: { 366: 'approve' } }).rounds[0].status).toBe('approved');
});
