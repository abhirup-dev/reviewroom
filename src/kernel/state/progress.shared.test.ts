import { test, expect } from 'bun:test';
import { pendingAssistantWork, parseProgress, reduceProgress, type ProgressLine } from './progress.shared';
const hash = 'a'.repeat(64);
const at = new Date().toISOString();
const line = (event: 'written' | 'validated', artifact: ProgressLine['artifact'] = 'walkthrough'): ProgressLine => ({ at, artifact, event, hash });
const requested = (by: 'assistant' | 'agent' = 'agent', artifact: ProgressLine['artifact'] = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'requested', by });
const stopped = (reason: 'failed' | 'interrupted', artifact: ProgressLine['artifact'] = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'stopped', reason });

test('absent request preserves legacy behavior, even with validation or stop records', () => {
  expect(reduceProgress([], {}).walkthrough.state).toBe('idle');
  expect(reduceProgress([line('validated')], { walkthrough: hash }).walkthrough.state).toBe('idle');
  expect(reduceProgress([stopped('failed')], {}).walkthrough.state).toBe('idle');
});
test('requested -> writing -> validated, carrying who was asked', () => {
  expect(reduceProgress([requested('assistant')], {}).walkthrough).toEqual({ state: 'requested', by: 'assistant' });
  expect(reduceProgress([requested('assistant'), line('written')], {}).walkthrough).toMatchObject({ state: 'writing', by: 'assistant', hash });
  expect(reduceProgress([requested('agent'), line('written'), line('validated')], { walkthrough: hash }).walkthrough).toMatchObject({ state: 'validated', by: 'agent' });
});
test('validation holds only for the checked bytes, including deletion', () => {
  const lines = [requested(), line('written'), line('validated')];
  expect(reduceProgress(lines, { walkthrough: hash }).walkthrough.state).toBe('validated');
  expect(reduceProgress(lines, { walkthrough: 'b'.repeat(64) }).walkthrough.state).toBe('writing');
  expect(reduceProgress(lines, {}).walkthrough.state).toBe('writing');
});
test('stopped keeps what was written; saves leave it stopped; a validation or a new request leaves it', () => {
  const base = [requested('assistant'), line('written'), stopped('failed')];
  expect(reduceProgress(base, {}).walkthrough).toMatchObject({ state: 'stopped', reason: 'failed', by: 'assistant', hash });
  expect(reduceProgress([...base, line('written')], {}).walkthrough.state).toBe('stopped');
  expect(reduceProgress([...base, line('validated')], { walkthrough: hash }).walkthrough.state).toBe('validated');
  expect(reduceProgress([...base, requested('agent')], {}).walkthrough).toEqual({ state: 'requested', by: 'agent' });
});
test('a starting server interrupts only pending assistant work; an ended turn fails what is not validated', () => {
  const p = reduceProgress([requested('assistant'), line('written'), requested('agent', 'report')], {});
  expect(pendingAssistantWork(p)).toEqual(['walkthrough']);
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), stopped('failed')], {}))).toEqual([]);
  const done = reduceProgress([requested('assistant'), line('validated'), requested('assistant', 'report')], { walkthrough: hash });
  expect(pendingAssistantWork(done)).toEqual(['report']);
  // an agent asked (pr --force) while the assistant was generating: its request is not the turn's to stop
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), requested('agent')], {}))).toEqual([]);
});
test('a new request resets the artifact; malformed, partial and by-less request lines are ignored', () => {
  expect(reduceProgress([requested(), line('validated'), requested()], {}).walkthrough.state).toBe('requested');
  expect(parseProgress(JSON.stringify(line('written')) + '\n{"at":')).toHaveLength(1);
  expect(parseProgress(JSON.stringify({ at, artifact: 'report', event: 'requested' }))).toHaveLength(0);
});
