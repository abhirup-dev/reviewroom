import { test, expect } from 'bun:test';
import { pendingAssistantWork, parseProgress, reduceProgress, type ProgressLine } from './progress.shared';
const hash = 'a'.repeat(64);
const at = new Date().toISOString();
type Doc = ProgressLine['artifact'];
const line = (event: 'written' | 'validated', artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event, hash });
const requested = (by: 'assistant' | 'agent' = 'agent', artifact: Doc = 'walkthrough', id = `${by}-1`): ProgressLine => ({ at, artifact, event: 'requested', by, id });
const stopped = (reason: 'failed' | 'interrupted', request: string, artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'stopped', reason, request });
const reset = (artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'reset' });
const imported = (): ProgressLine => ({ at, artifact: 'walkthrough', event: 'validated', hash, source: 'pr' });

test('absent request preserves legacy behavior, even with validation or stop records', () => {
  expect(reduceProgress([], {}).walkthrough.state).toBe('idle');
  expect(reduceProgress([line('validated')], { walkthrough: hash }).walkthrough.state).toBe('idle');
  expect(reduceProgress([stopped('failed', 'agent-1')], {}).walkthrough.state).toBe('idle');
});
test('requested -> writing -> validated, carrying who was asked and the request', () => {
  expect(reduceProgress([requested('assistant')], {}).walkthrough).toEqual({ state: 'requested', by: 'assistant', request: 'assistant-1' });
  expect(reduceProgress([requested('assistant'), line('written')], {}).walkthrough).toMatchObject({ state: 'writing', by: 'assistant', request: 'assistant-1', hash });
  expect(reduceProgress([requested('agent'), line('written'), line('validated')], { walkthrough: hash }).walkthrough).toMatchObject({ state: 'validated', by: 'agent' });
});
test('validation holds only for the checked bytes, including deletion', () => {
  const lines = [requested(), line('written'), line('validated')];
  expect(reduceProgress(lines, { walkthrough: hash }).walkthrough.state).toBe('validated');
  expect(reduceProgress(lines, { walkthrough: 'b'.repeat(64) }).walkthrough.state).toBe('writing');
  expect(reduceProgress(lines, {}).walkthrough.state).toBe('writing');
});
test('stopped keeps what was written; saves leave it stopped; a validation or a new request leaves it', () => {
  const base = [requested('assistant'), line('written'), stopped('failed', 'assistant-1')];
  expect(reduceProgress(base, {}).walkthrough).toMatchObject({ state: 'stopped', reason: 'failed', by: 'assistant', hash });
  expect(reduceProgress([...base, line('written')], {}).walkthrough.state).toBe('stopped');
  expect(reduceProgress([...base, line('validated')], { walkthrough: hash }).walkthrough.state).toBe('validated');
  expect(reduceProgress([...base, requested('agent')], {}).walkthrough).toEqual({ state: 'requested', by: 'agent', request: 'agent-1' });
});
test('a stop applies only to the request it names, while unfinished: a late one never lands on a newer request', () => {
  // an old server's turn ends after a takeover appended the agent's request
  expect(reduceProgress([requested('assistant'), requested('agent'), stopped('interrupted', 'assistant-1')], {}).walkthrough.state).toBe('requested');
  expect(reduceProgress([requested('assistant'), line('validated'), stopped('failed', 'assistant-1')], { walkthrough: hash }).walkthrough.state).toBe('validated');
});
test('pending assistant work names its request; an agent request made since is not the assistant\'s to stop', () => {
  const p = reduceProgress([requested('assistant'), line('written'), requested('agent', 'report')], {});
  expect(pendingAssistantWork(p)).toEqual([{ artifact: 'walkthrough', request: 'assistant-1' }]);
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), stopped('failed', 'assistant-1')], {}))).toEqual([]);
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), requested('agent')], {}))).toEqual([]);
});
test('reset returns a document to idle, whatever it was', () => {
  expect(reduceProgress([requested('assistant'), line('validated'), reset()], { walkthrough: hash }).walkthrough).toEqual({ state: 'idle' });
  expect(reduceProgress([requested('agent'), reset(), line('written')], {}).walkthrough.state).toBe('idle');
});
test('a new request resets the artifact; malformed and partial lines are ignored; a by-less request was an agent\'s', () => {
  expect(reduceProgress([requested(), line('validated'), requested()], {}).walkthrough.state).toBe('requested');
  expect(parseProgress(JSON.stringify(line('written')) + '\n{"at":')).toHaveLength(1);
  expect(parseProgress(JSON.stringify({ at, artifact: 'report', event: 'requested' }))).toEqual([{ at, artifact: 'report', event: 'requested', by: 'agent' }]);
});
test('a walkthrough imported from the PR counts while nothing was requested (pr --no-agent), while it has those bytes', () => {
  expect(reduceProgress([imported()], { walkthrough: hash }).walkthrough).toEqual({ state: 'validated', hash, source: 'pr' });
  expect(reduceProgress([reset(), imported()], { walkthrough: hash }).walkthrough.state).toBe('validated');
  // edited since, nobody asked: idle, never pending
  expect(reduceProgress([imported()], { walkthrough: 'b'.repeat(64) }).walkthrough).toEqual({ state: 'idle' });
  expect(reduceProgress([imported(), line('written')], { walkthrough: hash }).walkthrough).toEqual({ state: 'idle' });
  // a request after it still asks for a new one
  expect(reduceProgress([imported(), requested('assistant')], { walkthrough: hash }).walkthrough.state).toBe('requested');
});
