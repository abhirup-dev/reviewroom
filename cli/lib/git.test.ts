import { expect, test } from 'bun:test';
import { $ } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, parseDiff, stackLayers } from './git.ts';

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

test('stack layers: each PR from the head of the one below; a rewritten one below is a restack', async () => {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-layers-')), 'r');
  await $`bash ${path.join(import.meta.dir, '..', '..', 'examples', 'make-stack-repo.sh')} ${repo} --squashed`.quiet();
  const prs = [1, 2, 3].map((number) => ({ number, head: `stack-${number}` }));
  const count = (l: { base: string; head: string }) => +git(['rev-list', '--count', `${l.base}..${l.head}`], repo).trim();
  const layers = stackLayers(repo, 'main', prs);
  // stack-1 was squash-merged into main: from main, stack-2 would bring stack-1's two commits back
  expect(+git(['rev-list', '--count', 'main...stack-2', '--right-only'], repo).trim()).toBe(4);
  expect(layers.map(count)).toEqual([2, 2, 1]);
  expect(layers[1].base).toBe(layers[0].head);
  expect(layers.some((l) => l.restack)).toBe(false);
  // stack-1 amended after stack-2 was pushed: stack-2's layer starts where they still agree
  await $`git -C ${repo} checkout -q stack-1 && git -C ${repo} commit -q --amend -m 'store: Delete, reworded'`.quiet();
  const after = stackLayers(repo, 'main', prs);
  expect([after[1].restack, count(after[1])]).toEqual([true, 3]);
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});
