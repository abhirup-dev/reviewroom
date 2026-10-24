import { expect, test } from 'bun:test';
import { applyOp, awaitingAgent, currentRound, OpError, recapThreads, undelivered } from './ops.shared';
import type { ReviewState } from './model.shared';
import { build } from '../../testing/build';
import type { Op } from './schema.shared';

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
  const s0 = build.state();
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
  const once = run(build.state(), ...ops);
  const twice = run(once, ...ops);
  expect(twice.threads).toEqual(once.threads);
  expect(twice.pins).toEqual(['p']);
});

test('edit, delete, and deleting the last message removes the thread', () => {
  let s = run(build.state(), create, { op: 'addMessage', threadId: 't_1', id: 'm_2', body: 'x', author: 'you' }, { op: 'editMessage', threadId: 't_1', msgId: 'm_2', body: 'y' });
  expect(s.threads[0].messages[1].body).toBe('y');
  s = run(s, { op: 'deleteMessage', threadId: 't_1', msgId: 'm_2' });
  expect(s.threads[0].messages.length).toBe(1);
  s = run(s, { op: 'deleteMessage', threadId: 't_1', msgId: 'm_1' }, { op: 'setPin', ref: 'p', pinned: false });
  expect(s.threads).toEqual([]);
  expect(s.pins).toEqual([]);
});

test('typed errors for unknown targets and bad input', () => {
  const s = run(build.state(), create);
  expect(code(() => applyOp(s, { op: 'editMessage', threadId: 't_1', msgId: 'nope', body: 'b' }))).toBe('not_found');
  expect(code(() => applyOp(s, { op: 'addMessage', threadId: 't_1', id: 'm', body: '', author: 'you' }))).toBe('bad_op');
});

test('finishRound advances once; a second finish of the same round conflicts', () => {
  const s = run(build.state(), create, { op: 'finishRound', kind: 'feedback', round: 1, note: 'n' });
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
  const legacy: ReviewState = { ...build.state(), round: 2, rounds: [{ n: 1, status: 'sent', startedAt: 'x' }, { n: 2, status: 'open', startedAt: 'x' }] };
  expect(undelivered(legacy)).toEqual([]);
  const s = applyOp(legacy, { op: 'finishRound', kind: 'feedback' });
  expect(undelivered(s).map((r) => r.n)).toEqual([2]);
  expect(undelivered(applyOp(s, { op: 'markDelivered', round: 2 }))).toEqual([]);
});

test('awaitingAgent: open threads whose last message is the reviewer’s; currentRound: the round the review is on', () => {
  const t = (id: string, status: 'open' | 'resolved', ...authors: string[]) => ({ id, status, messages: authors.map((author) => ({ author })) });
  const s = { threads: [t('a', 'open', 'agent', 'you'), t('b', 'open', 'you', 'agent'), t('c', 'resolved', 'you'), t('d', 'open')] } as unknown as ReviewState;
  expect(awaitingAgent(s).map((x) => x.id)).toEqual(['a']);
  expect(currentRound({ round: 2, rounds: [{ n: 1 }, { n: 2 }] } as unknown as ReviewState)).toEqual({ n: 2 } as never);
});

test('recap: active (written in last round) beats stale (open over two rounds); resolved ones are left out', () => {
  const msg = (author: 'you' | 'agent', round: number) => build.message({ id: `${author}${round}`, author, round });
  const t = (id: string, createdRound: number, status: 'open' | 'resolved', ...messages: ReturnType<typeof msg>[]) => build.thread(id, { createdRound, status, messages });
  const s = build.state({
    round: 3,
    threads: [t('stale', 1, 'open', msg('you', 1), msg('agent', 2)), t('active', 1, 'open', msg('you', 2), msg('agent', 3)), t('rest', 2, 'open', msg('agent', 2)), t('done', 1, 'resolved', msg('you', 1))],
  });
  const ids = Object.values(recapThreads(s)).map((ts) => ts.map((x) => x.id));
  expect(ids).toEqual([['active'], ['stale'], ['rest']]);
});
