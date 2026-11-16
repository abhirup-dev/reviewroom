import { test, expect } from 'bun:test';
import { parseProgress, reduceProgress, type ProgressLine } from './progress.shared';
const hash = 'a'.repeat(64);
const line = (event: ProgressLine['event']): ProgressLine => ({ at: new Date().toISOString(), artifact: 'walkthrough', event, hash });
test('absent request preserves legacy behavior, even with validation records', () => {
  expect(reduceProgress([], {}).walkthrough.state).toBe('none');
  expect(reduceProgress([line('validated')], { walkthrough: hash }).walkthrough.state).toBe('none');
});
test('validation holds only for the checked bytes, including deletion', () => {
  const lines = [line('requested'), line('written'), line('validated')];
  expect(reduceProgress(lines, { walkthrough: hash }).walkthrough.state).toBe('validated');
  expect(reduceProgress(lines, { walkthrough: 'b'.repeat(64) }).walkthrough.state).toBe('written');
  expect(reduceProgress(lines, {}).walkthrough.state).toBe('written');
});
test('a new request resets the artifact; malformed and partial lines are ignored', () => {
  expect(reduceProgress([line('requested'), line('validated'), line('requested')], {}).walkthrough.state).toBe('requested');
  expect(parseProgress(JSON.stringify(line('written')) + '\n{"at":')).toHaveLength(1);
});
