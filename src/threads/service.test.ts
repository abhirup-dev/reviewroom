import { expect, test } from 'bun:test';
import { type Anchor, type GitHubSnapshot, type Op, type Thread } from '../kernel/state/model.shared';
import { applyOp } from '../kernel/state/ops.shared';
import type { GitHubAction } from '../kernel/state/schema.shared';
import { createThreadService } from './service';
import { build } from '../testing/build';

const at = '2026-01-01T00:00:00.000Z';
const general = build.anchor.general();
const code = build.anchor.code('a.ts', 1, 2);
const doc = build.anchor.doc();
const local = (id: string): Thread => build.thread(id, { messages: [build.message({ id: 'm_' + id, body: id })] });
const remote = (id: string, conversation = false): Thread => ({ ...local(id), gh: { node: id, url: 'https://github.com/o/r/pull/1', canReply: true, conversation } });

function setup() {
  const live = { state: build.state(), github: null as GitHubSnapshot | null, mode: 'agent' as 'agent' | 'team' | 'all', accepted: true, githubResult: true };
  const ops: Op[] = [];
  const actions: GitHubAction[] = [];
  let serial = 0;
  const service = createThreadService({
    getState: () => live.state,
    getGitHub: () => live.github,
    getReviewMode: () => live.mode,
    apply: (op) => {
      ops.push(op);
      if (live.accepted) live.state = applyOp(live.state, op);
      return live.accepted;
    },
    githubAct: (action) => { actions.push(action); return Promise.resolve(live.githubResult); },
    uid: (prefix) => prefix + ++serial,
    now: () => at,
  });
  return { live, ops, actions, service };
}

test('local creation is synchronous and mutations use current state and injected ids/time', () => {
  const { service, live, ops, actions } = setup();
  const created = service.createThread(general, 'question');
  expect(created).toBe(live.state.threads[0]);
  expect(created).not.toBeInstanceOf(Promise);
  expect(ops[0]).toEqual({ op: 'createThread', id: 't_1', anchor: general, msgId: 'm_2', body: 'question', author: 'you', at });
  expect(service.reply('t_1', 'answer', 'agent')).toBeUndefined();
  expect(live.state.threads[0].messages[1]).toMatchObject({ id: 'm_3', author: 'agent', round: 1, at });
  expect(service.editMessage('t_1', 'm_2', 'edited')).toBeUndefined();
  expect(live.state.threads[0].messages[0].body).toBe('edited');
  expect(service.setStatus('t_1', 'resolved')).toBeUndefined();
  expect(live.state.threads[0].status).toBe('resolved');
  expect(service.deleteMessage('t_1', 'm_3')).toBeUndefined();
  void service.deleteMessage('t_1', 'm_2');
  expect(service.threads()).toEqual([]);
  expect(actions).toEqual([]);
});

test('rejected local creation returns undefined without pretending it succeeded', () => {
  const { service, live } = setup();
  live.accepted = false;
  expect(service.createThread(general, 'question')).toBeUndefined();
  expect(live.state.threads).toEqual([]);
});

test('queries merge live snapshots, prefer exact matches, and only prefix-match local threads', () => {
  const { service, live } = setup();
  expect(service.threads()).toBe(live.state.threads);
  const first = local('t_long');
  const exact = local('t_');
  live.state = { ...live.state, threads: [first, exact] };
  const gh = remote('gh_123');
  live.github = { ok: true, threads: [gh] };
  expect(service.threads()).toEqual([first, exact, gh]);
  expect(service.thread('t_')).toBe(exact);
  expect(service.thread('t_l')).toBe(first);
  expect(service.thread('gh_123')).toBe(gh);
  expect(service.thread('gh_12')).toBeUndefined();
  live.github = { ok: false, threads: [] };
  expect(service.threads()).toBe(live.state.threads);
  expect(service.thread('gh_123')).toBeUndefined();
});

test('mode and availability getters update defaults and comment targets live', () => {
  const { service, live } = setup();
  live.mode = 'team';
  expect(service.teamMode).toBe(false);
  expect(service.commentTargets(code)[0].off).toBeUndefined();
  expect(service.commentTargets(code)[1].off).toContain('not of a GitHub');
  live.github = { ok: true, threads: [] };
  expect(service.teamMode).toBe(true);
  expect(service.commentsToGitHub(code)).toBe(true);
  expect(service.commentsToGitHub(general)).toBe(true);
  expect(service.commentsToGitHub(doc)).toBe(false);
  expect(service.commentTargets(code)[0].off).toContain('Team review mode');
  expect(service.commentTargets(code)[1].off).toBeUndefined();
  for (const anchor of [doc, { kind: 'symbol', name: 'Foo' }, { kind: 'tour', chapter: 'one', step: 'two' }] satisfies Anchor[]) {
    expect(service.commentTargets(anchor)).toEqual([{ to: 'agent', label: 'Agent', title: 'A thread for the agent to answer this round', off: undefined }]);
  }
  live.mode = 'all';
  expect(service.teamMode).toBe(false);
  expect(service.commentTargets(general).every((t) => !t.off)).toBe(true);
  live.mode = 'agent';
  expect(service.commentTargets(code)[1].off).toContain('Agent review mode');
  expect(service.commentTargets(code)[1].title).toContain('posted when you submit');
  expect(service.commentTargets(general)[1].title).toContain('PR conversation');
});

test('GitHub creation preserves promises, defaults, explicit overrides and agent authorship', async () => {
  const { service, live, actions, ops } = setup();
  live.github = { ok: true, threads: [] };
  live.mode = 'team';
  const result = service.createThread(code, 'code');
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toBe(true);
  live.githubResult = false;
  expect(await service.createThread(general, 'conversation')).toBe(false);
  expect(actions).toEqual([{ action: 'comment', anchor: code, body: 'code' }, { action: 'conversation', body: 'conversation' }]);
  expect(ops).toEqual([]);
  expect(service.createThread(code, 'local override', 'you', false)).not.toBeInstanceOf(Promise);
  expect(service.createThread(code, 'agent stays local', 'agent', true)).not.toBeInstanceOf(Promise);
  live.mode = 'agent';
  await service.createThread(doc, 'explicit remote', 'you', true);
  expect(actions[2]).toEqual({ action: 'conversation', body: 'explicit remote' });
  expect(ops).toHaveLength(2);
});

test('GitHub replies route by thread metadata and other mutations route by id prefix', async () => {
  const { service, live, actions, ops } = setup();
  live.github = { ok: true, threads: [remote('gh_review'), remote('gh_conversation', true)] };
  expect(service.reply('gh_review', 'reply', 'agent')).toBeInstanceOf(Promise);
  await service.reply('gh_conversation', 'conversation');
  await service.editMessage('gh_absent', 'gh_42', 'edited');
  await service.deleteMessage('gh_absent', 'gh_42');
  await service.setStatus('gh_absent', 'resolved');
  await service.setStatus('gh_absent', 'open');
  expect(actions).toEqual([
    { action: 'reply', thread: 'gh_review', body: 'reply' },
    { action: 'conversation', body: 'conversation' },
    { action: 'edit', message: 'gh_42', body: 'edited' },
    { action: 'delete', message: 'gh_42' },
    { action: 'resolve', thread: 'gh_absent', resolved: true },
    { action: 'resolve', thread: 'gh_absent', resolved: false },
  ]);
  expect(ops).toEqual([]);
  // A missing thread still attempts the local op, even with a GitHub-looking id.
  live.accepted = false;
  expect(service.reply('gh_missing', 'missing')).toBeUndefined();
  expect(ops[0]).toMatchObject({ op: 'addMessage', threadId: 'gh_missing', author: 'you' });
});

test('feedback is local and round-scoped; unread means the final message is a current-round agent reply', () => {
  const { service, live } = setup();
  void service.createThread(general, 'question');
  void service.createThread(general, 'agent only', 'agent');
  live.github = { ok: true, threads: [remote('gh_remote')] };
  expect(service.pendingFeedback().map((t) => t.id)).toEqual(['t_1']);
  expect(service.unreadAgent(live.state.threads[0])).toBe(false);
  expect(service.unreadAgent(live.state.threads[1])).toBe(true);
  expect(service.unreadAgent({ ...local('empty'), messages: [] })).toBe(false);
  void service.setStatus('t_1', 'resolved');
  expect(service.pendingFeedback()).toHaveLength(1);
  live.state = { ...live.state, round: 2 };
  expect(service.pendingFeedback()).toEqual([]);
  expect(service.unreadAgent(live.state.threads[1])).toBe(false);
  void service.reply('t_1', 'next round');
  void service.reply('t_1', 'answer', 'agent');
  expect(service.pendingFeedback().map((t) => t.id)).toEqual(['t_1']);
  expect(service.unreadAgent(live.state.threads[0])).toBe(true);
  void service.reply('t_1', 'follow up');
  expect(service.unreadAgent(live.state.threads[0])).toBe(false);
});

test('GitHub links resolve supported comment fragments only on the current PR', () => {
  const { service, live } = setup();
  const url = 'https://github.com/o/r/pull/1';
  expect(service.githubThreadFor(url + '#discussion_r42')).toBeUndefined();
  live.github = { ok: true, url, threads: [{ ...remote('gh_thread'), messages: [{ ...local('x').messages[0], id: 'gh_42' }] }] };
  for (const suffix of ['#discussion_r42', '/files#r42', '#issuecomment-42', '#pullrequestreview-42']) {
    expect(service.githubThreadFor(url.toUpperCase() + suffix)).toBe('gh_thread');
  }
  for (const href of [url + '#r43', url + '#r42extra', url + '0#r42', url + '?x#r42', 'https://github.com/other/r/pull/1#r42']) {
    expect(service.githubThreadFor(href)).toBeUndefined();
  }
  live.github = { ok: true, url, threads: [] };
  expect(service.githubThreadFor(url + '#r42')).toBeUndefined();
});
