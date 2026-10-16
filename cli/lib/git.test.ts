import { expect, test } from 'bun:test';
import { parseDiff } from './git.ts';

test('parseDiff: counts from --numstat, status from --name-status (real git -z output)', () => {
  // a.go edited, `a<TAB>b.go` added, img.png binary, a rename to a name with a tab, gone.go renamed to new.go at 71%
  const numstat = '1\t0\ta\tb.go\u00003\t0\ta.go\u0000-\t-\timg.png\u00000\t0\t\u0000old name.go\u0000new\tname.go\u00000\t2\t\u0000gone.go\u0000new.go\u0000';
  const nameStatus = 'A\u0000a\tb.go\u0000M\u0000a.go\u0000M\u0000img.png\u0000R100\u0000old name.go\u0000new\tname.go\u0000R071\u0000gone.go\u0000new.go\u0000';
  expect(parseDiff(numstat, nameStatus)).toEqual([
    { path: 'a\tb.go', prevPath: undefined, additions: 1, deletions: 0, binary: false, status: 'added' },
    { path: 'a.go', prevPath: undefined, additions: 3, deletions: 0, binary: false, status: 'modified' },
    { path: 'img.png', prevPath: undefined, additions: 0, deletions: 0, binary: true, status: 'modified' },
    { path: 'new\tname.go', prevPath: 'old name.go', additions: 0, deletions: 0, binary: false, status: 'renamed' },
    { path: 'new.go', prevPath: 'gone.go', additions: 0, deletions: 2, binary: false, status: 'renamed' },
  ]);
  expect(parseDiff('', '')).toEqual([]);
});
