import { expect, test } from 'bun:test';
import { parseDiff } from './git.ts';

test('parseDiff: counts from --numstat, status from --name-status, renames and binaries', () => {
  const z = (...f: string[]) => f.join('\0') + '\0';
  const numstat = z('3\t1\ta.go', '0\t0\t', 'old name.go', 'new\tname.go', '-\t-\timg.png', '5\t0\tnew.go', '0\t7\tgone.go');
  const nameStatus = z('M', 'a.go', 'R087', 'old name.go', 'new\tname.go', 'M', 'img.png', 'A', 'new.go', 'D', 'gone.go');
  expect(parseDiff(numstat, nameStatus)).toEqual([
    { path: 'a.go', prevPath: undefined, additions: 3, deletions: 1, binary: false, status: 'modified' },
    { path: 'new\tname.go', prevPath: 'old name.go', additions: 0, deletions: 0, binary: false, status: 'renamed' },
    { path: 'img.png', prevPath: undefined, additions: 0, deletions: 0, binary: true, status: 'modified' },
    { path: 'new.go', prevPath: undefined, additions: 5, deletions: 0, binary: false, status: 'added' },
    { path: 'gone.go', prevPath: undefined, additions: 0, deletions: 7, binary: false, status: 'deleted' },
  ]);
  expect(parseDiff('', '')).toEqual([]);
});
