import { expect, test } from 'bun:test';
import type { ChangedFile } from '../../src/kernel/state/model.shared.ts';
import type { StepAudit, Walkthrough } from '../../src/slides/model.shared.ts';
import { findingReport, judge, lintTour } from './slide-lint.ts';

const file = (path: string, n: number): ChangedFile => ({ path, status: 'modified', additions: n, deletions: 0 });
const changed = [file('pkg/a.go', 40), file('pkg/b.go', 30), file('pkg/c.go', 3), file('pkg/a_test.go', 50), file('pkg/sym.go', 20), { ...file('logo.png', 0), binary: true }];
const step = (id: string, ref?: string | string[], text = 'x') => ({ id, text, ...(ref ? { ref } : {}) });
const w: Walkthrough = {
  version: 1,
  title: 'T',
  chapters: [
    { id: 'one', title: 'One', steps: [step('s1'), step('s2', 'rr:code/pkg/a.go#L1-80', 'word '.repeat(130))] },
    { id: 'two', title: 'Two', steps: [step('s1', undefined, '<a href="rr:sym/Thing">Thing</a>')] },
  ],
};
const checks = (o = {}) => lintTour(w, changed, (n) => (n === 'Thing' ? 'pkg/sym.go' : undefined), o);

test('unshown files: big source warns (largest first), small and tests are mentioned; symbols, binaries count as shown or skip', () => {
  const [big, rest] = checks().filter((f) => f.check === 'unshown-file');
  expect(big).toMatchObject({ level: 'warn', message: '1 changed file(s) no slide shows: pkg/b.go (+30 -0)' });
  expect(rest).toMatchObject({ level: 'info', message: 'also not shown (small, tests, generated, lock or doc files): pkg/c.go (+3 -0), pkg/a_test.go (+50 -0)' });
});

test('pacing, and the estimates rendering replaces', () => {
  const at = (o = {}) => checks(o).filter((f) => f.check !== 'unshown-file').map((f) => `${f.where} ${f.check}`);
  expect(at()).toEqual(['one/s2 long-text', 'one/s2 wide-range', 'two chapter-size']);
  expect(at({ estimates: false })).toEqual(['two chapter-size']);
});

test('the report groups by place, the whole walkthrough first, then in walkthrough order', () => {
  const r = findingReport(checks(), w);
  expect(r.split('\n').filter((l) => l.startsWith('['))).toEqual(['[guided walkthrough]', '[one/s2]', '[two]']);
  expect(r).toContain('fix: Split the slide');
});

test('a link in an HTML comment shows nothing; Python test_ files are tests; unknown places report last', () => {
  const v: Walkthrough = { version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps: [step('s1', 'rr:code/x.go#L1', '<!-- rr:code/pkg/b.go#L1 -->')] }] };
  const fs = lintTour(v, [file('x.go', 20), file('pkg/b.go', 20), file('pkg/test_svc.py', 20)], () => undefined);
  expect(fs.map((f) => f.message)).toEqual(['1 changed file(s) no slide shows: pkg/b.go (+20 -0)', 'also not shown (small, tests, generated, lock or doc files): pkg/test_svc.py (+20 -0)']);
  const r = findingReport([{ check: 'x', level: 'info', where: 'gone/s9', message: 'm', fix: 'f' }, ...fs], v);
  expect(r.split('\n').filter((l) => l.startsWith('['))).toEqual(['[guided walkthrough]', '[gone/s9]']);
});

test('judge: one finding per problem across viewports; the lead is named when it is the cause; only code links need code', () => {
  const a = (o: Partial<StepAudit> = {}): StepAudit => ({ left: { visible: 600, content: 600, lead: 0 }, chunks: [], wide: [], stripped: { lead: [], text: [] }, settled: true, ...o });
  const chunk = (ref: string, o = {}) => ({ ref, code: true, lines: 5, visible: 30, hidden: 0, ...o });
  const fs = judge([
    { viewport: '1280x800', chapter: 'c', step: 's1', audit: a({ left: { visible: 600, content: 680, lead: 300 }, chunks: [chunk('rr:code/a.go#L1-5', { hidden: 2 })] }), errors: [] },
    { viewport: '1440x900', chapter: 'c', step: 's1', audit: a({ left: { visible: 700, content: 720, lead: 100 } }), errors: [] },
    { viewport: '1280x800', chapter: 'c', step: 's2', audit: a({ chunks: [chunk('rr:sym/Gone', { code: false }), chunk('rr:doc/intro', { code: false }), chunk('rr:code/b.go#L1', { visible: 4 })], stripped: { lead: ['<script>'], text: [] } }), errors: ['boom'] },
  ]);
  const by = (check: string) => fs.filter((f) => f.check === check);
  expect(by('overflow')).toEqual([expect.objectContaining({ where: 'c/s1', message: 'the narration needs scrolling (1280x800: 80px more than the 600px it has; 1440x900: 20px more than the 700px it has)', fix: expect.stringContaining('The chapter lead takes 50%') })]);
  expect(by('hidden-lines')[0]).toMatchObject({ message: expect.stringContaining('(1280x800: 2 of 5, 3 fit)'), fix: expect.stringContaining('rr:code/a.go#L1-3') });
  expect(by('no-code').map((f) => f.message)).toEqual(['rr:sym/Gone shows a preview card, not code (1280x800: preview)']);
  expect(by('short-chunk').map((f) => f.where)).toEqual(['c/s2']);
  expect(by('stripped').map((f) => f.where)).toEqual(['c']);
  expect(by('page-error').map((f) => f.message)).toEqual(['boom (1280x800: console)']);
});

test('lock, generated and doc files are only mentioned; the line budget depends on how many refs stack', () => {
  const lint = (steps: ReturnType<typeof step>[], files: ChangedFile[] = []) => lintTour({ version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', steps }] }, files, () => undefined);
  const skipped = ['bun.lock', 'go.sum', 'go.mod', 'package.json', 'svc/requirements-dev.txt', 'README.md', 'api/x.pb.go', 'pkg/types_generated.ts', 'ui/x.gen.ts', 'dist/a.js'].map((p) => file(p, 50));
  expect(lint([step('s1', 'rr:code/x.go#L1')], skipped).map((f) => f.level)).toEqual(['info']);
  const wide = (steps: ReturnType<typeof step>[]) => lint(steps).map((f) => `${f.check} ${f.message}`);
  expect(wide([step('s1', 'rr:code/x.go#L1-25')])).toEqual([]);
  expect(wide([step('s1', 'rr:code/x.go#L1-26')])).toEqual(['wide-range rr:code/x.go#L1-26 highlights 26 lines']);
  expect(wide([step('s1', ['rr:code/x.go#L1-11', 'rr:code/y.go#L1-10'])])).toEqual(['wide-range rr:code/x.go#L1-11 highlights 11 lines']);
  expect(wide([step('s1', ['rr:code/x.go#L1', 'rr:code/y.go#L1', 'rr:code/z.go#L1'])])).toEqual(['short-chunk 3 refs stacked']);
});

test('a step\'s focus must name a diagram node in the chapter lead or the slide', () => {
  const lead = '<rr-flow><rr-node state="new">habit.<b>RecentEvents</b></rr-node><rr-node>TFS</rr-node></rr-flow>';
  const steps = [{ id: 's1', text: '<p>a</p>', ref: 'rr:code/x.go#L1', focus: ['habit.RecentEvents', 'TFS'] }, { id: 's2', text: '<rr-flow><rr-node>Cache</rr-node></rr-flow>', focus: ['Cache', 'Ranker'] }];
  const fs = lintTour({ version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', lead, steps }] }, [], () => undefined).filter((f) => f.check === 'unknown-focus');
  expect(fs.map((f) => `${f.where} ${f.message}`)).toEqual(['a/s2 focus names no diagram node: Ranker']);
});

test('a focus may name a Mermaid node by its label', () => {
  const lead = '<rr-mermaid>flowchart LR\n  A[Fetcher] --&gt; B[Ranker]</rr-mermaid>';
  const steps = [{ id: 's1', text: '<p>a</p>', ref: 'rr:code/x.go#L1', focus: ['Fetcher', 'Ranker', 'Cache'] }];
  const fs = lintTour({ version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', lead, steps }] }, [], () => undefined).filter((f) => f.check === 'unknown-focus');
  expect(fs.map((f) => f.message)).toEqual(['focus names no diagram node: Cache']);
});

test('slide-lint reads Mermaid labels as the page does: entities decoded, whitespace collapsed', () => {
  const lead = '<rr-mermaid>flowchart LR\n  A[say #quot;Hi#quot;] --&gt; B[x &amp;amp; y]\n  B --&gt; C[Two  spaces]</rr-mermaid>';
  const steps = [{ id: 's1', text: '<p>a</p>', ref: 'rr:code/x.go#L1', focus: ['say "Hi"', 'x & y', 'Two spaces', 'Two  spaces'] }];
  const fs = lintTour({ version: 1, title: 'T', chapters: [{ id: 'a', title: 'A', lead, steps }] }, [], () => undefined).filter((f) => f.check === 'unknown-focus');
  expect(fs).toEqual([]);
});

test('judge: a step without its own ref does not repeat the pane findings of the step before', () => {
  const audit: StepAudit = { left: { visible: 600, content: 600, lead: 0 }, chunks: [{ ref: 'rr:code/a.go#L1-50', code: true, lines: 50, visible: 30, hidden: 20 }], wide: [], stripped: { lead: [], text: [] }, settled: true };
  const fs = judge([
    { viewport: 'v', chapter: 'c', step: 's1', audit, errors: [] },
    { viewport: 'v', chapter: 'c', step: 's2', audit, errors: [], ownRef: false },
  ]);
  expect(fs.map((f) => f.where)).toEqual(['c/s1']);
});
