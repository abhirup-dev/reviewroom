import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReview, shellArg } from './config.ts';
import { localReviewFolder, reviewFolder } from './review-id.ts';
import { reviewStore } from './review-store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-config-'));
const previous = process.env.REVIEWROOM_HOME;
process.env.REVIEWROOM_HOME = path.join(tmp, 'home');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
for (const args of [['init', '-b', 'main'], ['remote', 'add', 'origin', 'https://github.com/acme/api.git']]) execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
const pull = reviewFolder({ owner: 'acme', repo: 'api', number: 31 });
const local = localReviewFolder('acme/api', 'feature');
for (const [dir, cfg] of [[pull, { id: 'acme/api#31' }], [local, { target: 'feature' }]] as const) {
  reviewStore(dir).config.write({ ...cfg, repoPath: repo });
}
afterAll(() => {
  if (previous === undefined) delete process.env.REVIEWROOM_HOME;
  else process.env.REVIEWROOM_HOME = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test.each(([
  ['canonical ID anywhere', null, 'acme/api#31', 'status', pull, undefined],
  ['URL anywhere', null, 'https://github.com/acme/api/pull/31', 'check', pull, undefined],
  ['branch in repo', repo, 'feature', 'reply', local, undefined],
  ['absolute path anywhere', null, local, 'shot', local, undefined],
  ['relative path anywhere', null, './' + path.relative(process.cwd(), local), 'start', local, undefined],
  ['number on pr', repo, '31', 'pr', pull, undefined],
  ['missing target', repo, undefined, 'status', undefined, 'missing review'],
  ['number on shot', repo, '3', 'shot', undefined, 'bare numbers'],
  ['short ID', repo, '#31', 'status', undefined, 'full PR review ID'],
  ['short ID on pr', repo, '#31', 'pr', undefined, 'full PR review ID'],
  ['branch outside repo', null, 'feature', 'status', undefined, 'require a git repository'],
  ['missing path', null, path.join(tmp, 'absent'), 'pr', undefined, 'no review'],
  ['missing review ID', null, 'acme/api#32', 'status', undefined, 'no review'],
  ['malformed ID wins over branch', repo, 'acme/api#oops', 'status', undefined, 'invalid PR review ID'],
] as const).map(([name, selected, target, command, expected, error]) => ({ name, selected, target, command, expected, error })))('$name', ({ selected, target, command, expected, error }) => {
  const resolve = () => resolveReview(selected, {}, target, command);
  if (error) expect(resolve).toThrow(error);
  else expect(resolve().dir).toBe(expected!);
});

test('removed directory flag and shell-safe targets', () => {
  expect(() => resolveReview(repo, { dir: local }, 'feature', 'status')).toThrow('--dir was removed');
  expect(shellArg('acme/api#31')).toBe("'acme/api#31'");
  expect(shellArg('#31')).toBe("'#31'");
  expect(shellArg("a'b#c")).toBe("'a'\\''b#c'");
});
