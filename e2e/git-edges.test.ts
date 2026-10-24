import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile } from '../src/kernel/state/model.shared.ts';
import { setup } from './fixture.ts';

describe('git edges through the served provider', () => {
  const { repo, tmp, git, serve } = setup();
  let url = '';
  const request = (endpoint: string, params: Record<string, string>) => fetch(url + 'api/' + endpoint + '?' + new URLSearchParams(params));
  beforeAll(async () => {
    fs.writeFileSync(path.join(repo, 'rename source.txt'), 'a stable file for rename detection\n');
    await git('add', 'rename source.txt');
    await git('commit', '-qm', 'Add rename fixture');
    await git('mv', 'rename source.txt', 'renamed # target.txt');
    fs.writeFileSync(path.join(repo, 'untracked # text.txt'), 'new content\n');
    fs.writeFileSync(path.join(repo, 'untracked.bin'), Buffer.from([1, 0, 2, 3]));
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside repository secret');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(repo, 'outside-link'));
    fs.symlinkSync('untracked # text.txt', path.join(repo, 'inside-link'));
    url = await serve();
  });

  test('worktree files include untracked text, binary metadata, and staged renames', async () => {
    const response = await request('files', { base: 'HEAD', head: 'worktree' });
    expect(response.status).toBe(200);
    const files: ChangedFile[] = await response.json();
    expect(files).toContainEqual(expect.objectContaining({ path: 'untracked # text.txt', status: 'added', binary: false }));
    expect(files).toContainEqual(expect.objectContaining({ path: 'untracked.bin', status: 'added', binary: true }));
    expect(files).toContainEqual(expect.objectContaining({ path: 'renamed # target.txt', prevPath: 'rename source.txt', status: 'renamed' }));
    const patch = await request('patch', { base: 'HEAD', head: 'worktree' });
    expect(patch.status).toBe(200);
    expect(await patch.text()).toContain('rename to renamed # target.txt');
    const old = await request('read', { path: 'rename source.txt', rev: 'HEAD' });
    const current = await request('read', { path: 'renamed # target.txt', rev: 'worktree' });
    expect(old.status).toBe(200);
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(await old.text());
  });

  test('worktree reads allow internal symlinks but refuse traversal, external symlinks, and directories', async () => {
    const internal = await request('read', { path: 'inside-link', rev: 'worktree' });
    expect(internal.status).toBe(200);
    expect(await internal.text()).toContain('new content');
    for (const file of ['../outside.txt', path.join(tmp, 'outside.txt'), 'outside-link', '.git', 'missing.txt']) {
      const response = await request('read', { path: file, rev: 'worktree' });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('outside repository secret');
    }
  });

  test('all revision-bearing endpoints reject options and revision expressions outside the contract', async () => {
    for (const rev of ['--output=escape', 'HEAD:rename source.txt', 'HEAD\n--help']) {
      const requests: [string, Record<string, string>][] = [
        ['files', { base: rev, head: 'HEAD' }],
        ['files', { base: 'HEAD', head: rev }],
        ['patch', { base: rev, head: 'HEAD' }],
        ['read', { path: 'rename source.txt', rev }],
        ['tree', { rev }],
        ['search', { q: 'stable', rev }],
      ];
      for (const [endpoint, params] of requests) {
        const response = await request(endpoint, params);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('invalid revision');
      }
    }
  });
});
