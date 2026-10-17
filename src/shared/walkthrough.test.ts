import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseWalkthrough } from './walkthrough';

const demo = readFileSync(new URL('../../examples/habit-events/walkthrough.json', import.meta.url), 'utf8');
const valid = () => ({
  version: 1,
  title: 'T',
  chapters: [{ id: 'a', title: 'A', steps: [{ id: 's1', text: '<p>x</p>', ref: 'rr:code/x.go#L1-2' }, { id: 's2', text: '<p>y</p>' }] }],
});
const issues = (w: unknown) => {
  const r = parseWalkthrough(JSON.stringify(w));
  return r.ok ? null : r.issues;
};

test('the demo walkthrough parses', () => {
  const r = parseWalkthrough(demo);
  expect(r.ok && r.value.chapters.map((c) => c.steps.length)).toEqual([4, 4, 3]);
});

test('a minimal walkthrough parses', () => expect(issues(valid())).toBeNull());

test('invalid documents fail with a one-line issue', () => {
  const w = valid();
  w.chapters.push({ ...w.chapters[0] });
  expect(issues(w)).toBe('chapters.1.id: duplicate chapter id "a"');

  const s = valid();
  s.chapters[0].steps[1].id = 's1';
  expect(issues(s)).toBe('chapters.0.steps.1.id: duplicate step id "s1"');

  const t = valid();
  t.chapters[0].steps[0].text = '';
  expect(issues(t)).toContain('chapters.0.steps.0.text');

  const r = valid();
  r.chapters[0].steps[0].ref = 'pkg/x.go';
  expect(issues(r)).toContain('chapters.0.steps.0.ref');
  r.chapters[0].steps[0].ref = 'rr:thread/t1';
  expect(issues(r)).toContain('chapters.0.steps.0.ref');

  expect(issues({ ...valid(), version: 2 })).toContain('version');
  expect(issues({ ...valid(), chapters: [] })).toContain('chapters');
  expect(issues({ ...valid(), chapters: [{ id: 'Bad Id', title: 'A', steps: [{ id: 's', text: 'x' }] }] })).toContain('chapters.0.id');
  expect(parseWalkthrough('{').ok).toBe(false);
});

test('every ref form the narrative accepts for code works', () => {
  for (const ref of ['rr:code/a.go', 'rr:code/a.go@base#L1-3', 'rr:file/a.go@head#L4', 'rr:sym/Fetcher', 'rr:doc/latency']) {
    const w = valid();
    w.chapters[0].steps[0].ref = ref;
    expect(issues(w)).toBeNull();
  }
});
