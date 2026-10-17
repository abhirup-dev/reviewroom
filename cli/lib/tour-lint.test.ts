import { expect, test } from 'bun:test';
import type { ChangedFile } from '../../src/core/types.ts';
import type { Walkthrough } from '../../src/shared/walkthrough.ts';
import { findingReport, lintTour } from './tour-lint.ts';

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
  expect(big).toMatchObject({ level: 'warn', message: '1 changed file(s) no step shows: pkg/b.go (+30 -0)' });
  expect(rest).toMatchObject({ level: 'info', message: 'also not shown (small or tests): pkg/c.go (+3 -0), pkg/a_test.go (+50 -0)' });
});

test('pacing, empty pane, and the estimates rendering replaces', () => {
  const at = (o = {}) => checks(o).filter((f) => f.check !== 'unshown-file').map((f) => `${f.where} ${f.check}`);
  expect(at()).toEqual(['one/s1 empty-pane', 'one/s2 long-text', 'one/s2 wide-range', 'two chapter-size']);
  expect(at({ estimates: false })).toEqual(['one/s1 empty-pane', 'two chapter-size']);
});

test('the report groups by place, the whole walkthrough first, then in walkthrough order', () => {
  const r = findingReport(checks({ estimates: false }), w);
  expect(r.split('\n').filter((l) => l.startsWith('['))).toEqual(['[walkthrough]', '[one/s1]', '[two]']);
  expect(r).toContain('fix: Give the step (or an earlier one) a ref');
});
