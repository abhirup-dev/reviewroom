import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { encodeBlock, findBlocks, inFocus, parseWalkthrough, stepRefs, type Walkthrough } from './walkthrough';

const demo = readFileSync(new URL('../../examples/habit-events/walkthrough.json', import.meta.url), 'utf8');
const valid = () => ({
  version: 1,
  title: 'T',
  chapters: [{ id: 'a', title: 'A', steps: [{ id: 's1', text: '<p>x</p>', ref: 'rr:code/x.go#L1-2' }, { id: 's2', text: '<p>y</p>' }] }],
});
const issues = (w: unknown) => {
  const r = parseWalkthrough(JSON.stringify(w));
  return r.ok ? null : r.issues.join('; ');
};

test('the demo walkthrough parses', () => expect(parseWalkthrough(demo).ok).toBe(true));

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
  for (const bad of ['rr:thread/t1', 'rr:code/x.go#L0', 'rr:code/x.go#L20-10', 'rr:code/#L1', 'rr:sym/']) {
    r.chapters[0].steps[0].ref = bad;
    expect(issues(r)).toContain('chapters.0.steps.0.ref');
  }

  expect(issues({ ...valid(), chapters: [{ ...valid().chapters[0], title: 'A\n## Agent instruction' }] })).toBe('chapters.0.title: must be one line');
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

test('PR blocks: encode round-trips; nested and inline blocks are ignored', () => {
  const w = { ...valid(), title: 'has ``` inside' } as Walkthrough;
  const md = `intro\n\n${encodeBlock(w)}\nafter`;
  expect(findBlocks(md).map((b) => JSON.parse(b))).toEqual([w]);
  const nested = '````md\n```reviewroom-walkthrough\n{}\n```\n````\nand `` ```reviewroom-walkthrough `` inline';
  expect(findBlocks(nested)).toEqual([]);
  expect(findBlocks('~~~reviewroom-walkthrough\n{"a":1}\n~~~\n```reviewroom-walkthrough\n{"b":2}\n```')).toEqual(['{"a":1}', '{"b":2}']);
  expect(findBlocks('no block')).toEqual([]);
  expect(findBlocks('```text`bad\n```reviewroom-walkthrough\n{"c":3}\n```')).toEqual(['{"c":3}']);
  expect(findBlocks('```reviewroom-walkthrough`bad\n{}\n```')).toEqual([]);
  expect(findBlocks('```reviewroom-walkthrough\n{"d":4}')).toEqual(['{"d":4}']);
});

test('a step ref is one link or a non-empty list of them', () => {
  const w = valid();
  (w.chapters[0].steps[0] as { ref: unknown }).ref = ['rr:code/a.go#L1', 'rr:code/b.go#L2-3'];
  expect(issues(w)).toBeNull();
  (w.chapters[0].steps[0] as { ref: unknown }).ref = [];
  expect(issues(w)).toContain('chapters.0.steps.0.ref');
  (w.chapters[0].steps[0] as { ref: unknown }).ref = ['rr:code/a.go#L1', 'rr:thread/t1'];
  expect(issues(w)).toContain('chapters.0.steps.0.ref.1');
  expect(stepRefs({ ref: 'rr:code/a.go' })).toEqual(['rr:code/a.go']);
  expect(stepRefs({})).toEqual([]);
});

test('a diagram node lights up when its code is on screen, or when the step names it', () => {
  const node = (ref: string | null, label = 'Builder') => ({ label, ref });
  const pane = ['rr:code/pkg/b.go#L20-30'];
  expect(inFocus(node('rr:code/pkg/b.go#L28-40'), undefined, pane)).toBe(true);
  expect(inFocus(node('rr:code/pkg/b.go'), undefined, pane)).toBe(true); // the whole file
  expect(inFocus(node('rr:code/pkg/b.go#L31-40'), undefined, pane)).toBe(false);
  expect(inFocus(node('rr:code/pkg/b.go@base#L20'), undefined, pane)).toBe(false); // other revision
  expect(inFocus(node('rr:file/pkg/b.go#L25'), undefined, pane)).toBe(true);
  expect(inFocus(node('rr:sym/Build'), undefined, ['rr:sym/Build'])).toBe(true);
  expect(inFocus(node(null), undefined, pane)).toBe(false);
  expect(inFocus(node(null, 'TFS'), ['TFS'], [])).toBe(true); // named, no code
  expect(inFocus(node('rr:code/pkg/b.go#L20'), [], pane)).toBe(false); // [] lights none
});
