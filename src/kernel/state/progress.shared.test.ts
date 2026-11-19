import { test, expect } from 'bun:test';
import { pendingAssistantWork, parseProgress, reduceProgress, type GenerationState, type ProgressLine } from './progress.shared';
const hash = 'a'.repeat(64);
const at = new Date().toISOString();
type Doc = ProgressLine['artifact'];
const line = (event: 'written' | 'validated', artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event, hash });
const requested = (by: 'assistant' | 'agent' = 'agent', artifact: Doc = 'walkthrough', id = `${by}-1`): ProgressLine => ({ at, artifact, event: 'requested', by, id });
const stopped = (reason: 'failed' | 'interrupted', request: string, artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'stopped', reason, request });
const reset = (artifact: Doc = 'walkthrough'): ProgressLine => ({ at, artifact, event: 'reset' });
const imported = (): ProgressLine => ({ at, artifact: 'walkthrough', event: 'validated', hash, source: 'pr' });

const stale = (h: string): ProgressLine => ({ at, artifact: 'walkthrough', event: 'stopped', reason: 'failed', request: 'assistant-1', stale: h });
const H = { walkthrough: hash }, EDITED = { walkthrough: 'b'.repeat(64) };
const STOPPED = [requested('assistant'), line('written'), stopped('failed', 'assistant-1')];
const VALIDATED = [requested('assistant'), line('validated')];

test.each<[string, ProgressLine[], Partial<Record<Doc, string>>, GenerationState]>([
  ['nothing requested', [], {}, 'idle'],
  ['legacy: a validation with nothing requested', [line('validated')], H, 'idle'],
  ['legacy: a stop with nothing requested', [stopped('failed', 'agent-1')], {}, 'idle'],
  ['written under a request', [requested('assistant'), line('written')], {}, 'writing'],
  ['validated, with those bytes', VALIDATED, H, 'validated'],
  ['validated, then edited', VALIDATED, EDITED, 'writing'],
  ['validated, then deleted', VALIDATED, {}, 'writing'],
  ['stopped', STOPPED, {}, 'stopped'],
  ['a save leaves a stop stopped', [...STOPPED, line('written')], {}, 'stopped'],
  ['a validation leaves a stop', [...STOPPED, line('validated')], H, 'validated'],
  ['a new request leaves a stop', [...STOPPED, requested('agent')], {}, 'requested'],
  ['a late stop never lands on a newer request (an old server after a takeover)', [requested('assistant'), requested('agent'), stopped('interrupted', 'assistant-1')], {}, 'requested'],
  ['a stop leaves a validation alone', [...VALIDATED, stopped('failed', 'assistant-1')], H, 'validated'],
  ['a stop naming the stale validation stops it', [...VALIDATED, stale(hash)], EDITED, 'stopped'],
  ['a stop naming another validation does not', [...VALIDATED, stale('c'.repeat(64))], EDITED, 'writing'],
  ['reset, whatever it was', [...VALIDATED, reset()], H, 'idle'],
  ['a save after a reset', [requested('agent'), reset(), line('written')], {}, 'idle'],
  ['a new request after a validation', [requested(), line('validated'), requested()], {}, 'requested'],
  ['a PR import counts with nothing requested (pr --no-agent)', [imported()], H, 'validated'],
  ['a PR import after a reset', [reset(), imported()], H, 'validated'],
  ['a PR import edited since: idle, never pending', [imported()], EDITED, 'idle'],
  ['a PR import, then a save', [imported(), line('written')], H, 'idle'],
  ['a request after a PR import', [imported(), requested('assistant')], H, 'requested'],
])('%s', (_, lines, hashes, state) => expect(reduceProgress(lines, hashes).walkthrough.state).toBe(state));

test('a document carries who was asked, the request, what was written, and the stale validation', () => {
  expect(reduceProgress([requested('assistant')], {}).walkthrough).toEqual({ state: 'requested', by: 'assistant', request: 'assistant-1', since: at });
  expect(reduceProgress(STOPPED, {}).walkthrough).toMatchObject({ state: 'stopped', reason: 'failed', by: 'assistant', request: 'assistant-1', hash });
  expect(reduceProgress(VALIDATED, EDITED).walkthrough).toMatchObject({ state: 'writing', stale: hash });
  expect(reduceProgress([imported()], H).walkthrough).toEqual({ state: 'validated', hash, source: 'pr' });
});
test('pending assistant work names its request; an agent request made since is not the assistant\'s to stop', () => {
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), line('written'), requested('agent', 'report')], {}))).toEqual([{ artifact: 'walkthrough', request: 'assistant-1' }]);
  expect(pendingAssistantWork(reduceProgress(STOPPED, {}))).toEqual([]);
  expect(pendingAssistantWork(reduceProgress(VALIDATED, EDITED))).toEqual([{ artifact: 'walkthrough', request: 'assistant-1', stale: hash }]); // edited since: a stop names it
  expect(pendingAssistantWork(reduceProgress([requested('assistant'), requested('agent')], {}))).toEqual([]);
});
test('malformed and partial lines are ignored; a by-less request was an agent\'s', () => {
  expect(parseProgress(JSON.stringify(line('written')) + '\n{"at":')).toHaveLength(1);
  expect(parseProgress(JSON.stringify({ at, artifact: 'report', event: 'requested' }))).toEqual([{ at, artifact: 'report', event: 'requested', by: 'agent' }]);
});
test('each save with new bytes under a request is a pass; validating the same bytes is not; a new request starts over', () => {
  const save = (h: string, slides: number, event: 'written' | 'validated' = 'written'): ProgressLine => ({ at, artifact: 'walkthrough', event, hash: h.repeat(64), slides, chapters: 3 });
  const lines = [requested('assistant'), save('a', 7), save('b', 8), save('b', 8, 'validated')];
  expect(reduceProgress(lines, { walkthrough: 'b'.repeat(64) }).walkthrough).toMatchObject({ state: 'validated', since: at, passes: [{ at, slides: 7, chapters: 3 }, { at, slides: 8, chapters: 3 }] });
  expect(reduceProgress([...lines, requested('assistant', 'walkthrough', 'assistant-2')], {}).walkthrough.passes).toBeUndefined();
  expect(reduceProgress([imported()], { walkthrough: hash }).walkthrough.passes).toBeUndefined(); // nothing requested: no passes
});
