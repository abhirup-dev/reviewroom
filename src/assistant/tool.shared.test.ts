import { expect, test } from 'bun:test';
import { toolTarget, toolVerb } from './tool.shared';

test('a tool call reads as a verb and a short target', () => {
  expect(toolVerb('Bash')).toBe('Ran');
  expect(toolVerb('fileChange')).toBe('Wrote');
  expect(toolVerb('Mystery')).toBe('Mystery');
  expect(toolTarget({ command: 'cd /a/b && R=/tmp/x; reviewroom check $R --fix' })).toBe('reviewroom check $R --fix');
  expect(toolTarget({ command: 'git diff --stat' })).toBe('git diff --stat');
  expect(toolTarget({ command: 'cd /a/b' })).toBe('cd /a/b'); // nothing after the preamble: kept whole
  expect(toolTarget({ file_path: '/Users/me/repo/cli/lib/upload.ts' })).toBe('cli/lib/upload.ts');
  expect(toolTarget({ skill: 'reviewroom' })).toBe('reviewroom');
  expect(toolTarget(undefined)).toBe('');
});
