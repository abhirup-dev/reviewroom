import { REPORT_FILE } from '../src/kernel/state/files.shared.ts';
// CLI surface: resolve without a body, --dir alone, pr without a target.
import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredThread } from '../src/kernel/state/schema.shared.ts';
import { read, setup } from './fixture.ts';

describe('cli', () => {
  const { tmp, repo, dir, d, cli, state } = setup();
  let thread = '';
  beforeAll(async () => (thread = (await cli(['comment', 'general', 'why?', ...d])).stdout.trim()));

  test('reply --resolve without a body resolves the thread', async () => {
    expect((await cli(['reply', thread, '--resolve', ...d])).code).toBe(0);
    expect(state().threads.find((t: StoredThread) => t.id === thread).status).toBe('resolved');
  });
  // the cwd is reviewroom's own repo: the review's repo must come from the dir
  test('--dir alone finds the repo the review dir is in', async () => expect(await cli(['check', '--dir', dir])).toMatchObject({ code: 0, stderr: '' }));
  test('pr without a target scaffolds from --base/--head and serves', async () => {
    const local = path.join(tmp, 'local-review');
    try {
      const r = await cli(['pr', '--base', 'main', '--head', 'feat/upload-rate-limit', '--no-open', '--port', '0', '--repo', repo, '--dir', local]);
      expect(r.code).toBe(0);
      expect((await fetch(r.stdout.trim() + 'api/meta')).ok && fs.existsSync(path.join(local, REPORT_FILE))).toBe(true);
      expect(JSON.parse(read(local, 'config.json'))).toMatchObject({ head: 'feat/upload-rate-limit', profile: 'explainer' });
      expect(read(local, REPORT_FILE)).toContain('<section id="findings">'); // the explainer profile's sections
    } finally {
      await cli(['stop', '--dir', local]);
    }
  });
  test('pr with an unknown report profile fails and names the profiles', async () => {
    const r = await cli(['pr', '--base', 'main', '--head', 'feat/upload-rate-limit', '--profile', 'nope', '--no-open', '--repo', repo, '--dir', path.join(tmp, 'no-profile')]);
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining('no report profile "nope" (profiles: explainer')]);
  });
});

describe('PR targets and running reviews', () => {
  const { tmp, repo, cli, git, addPullRemote } = setup();
  const repoArgs = ['--repo', repo];
  const quiet = ['--no-open', '--port', '0'];

  test('resolves PR IDs and lists live reviews without a hub', async () => {
    const pull = await addPullRemote();
    const mirror = await addPullRemote('other', 'mirror');
    const branch = `${pull.number}/topic`;
    await git('branch', branch, 'feat/upload-rate-limit');
    try {
      expect(await cli(['list', '--json'])).toMatchObject({ code: 0, stdout: '[]\n' });
      const started = await cli(['pr', pull.number, ...repoArgs, ...quiet]);
      expect(started).toMatchObject({ code: 0, stderr: expect.stringContaining(`reviewroom wait ${pull.id}`) });
      const url = started.stdout.trim();
      expect(await fetch(url + 'api/meta').then((r) => r.json())).toMatchObject({ prReviewId: pull.id });
      for (const target of [[pull.id], [pull.number, ...repoArgs], [`#${pull.number}`, ...repoArgs], [pull.url, ...repoArgs], ['--dir', pull.dir]]) {
        const status = await cli(['status', '--json', ...target]);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({ id: pull.id, dir: pull.dir, url });
      }
      expect(await cli(['stop', mirror.url, ...repoArgs])).toMatchObject({ code: 1, stderr: expect.stringContaining('selected repository is demo/project') });
      expect(await cli(['pr', pull.id, '--remote', 'mirror', ...repoArgs, ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining('selected repository is other/project') });
      expect((await cli(['pr', mirror.id, '--remote', 'mirror', ...repoArgs, ...quiet])).code).toBe(0);
      expect((await cli(['pr', branch, ...repoArgs, ...quiet])).code).toBe(0);
      const branchStatus = JSON.parse((await cli(['status', branch, '--json', ...repoArgs])).stdout);
      expect(branchStatus.id).toBeUndefined();
      expect(branchStatus.dir).not.toBe(pull.dir);
      expect(await cli(['pr', branch, '--dir', pull.dir, ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot use a branch target') });

      const listed = await cli(['list', '--json']);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: pull.id, dir: pull.dir, url }),
        expect.objectContaining({ id: mirror.id, dir: mirror.dir }),
        expect.objectContaining({ dir: branchStatus.dir }),
      ]));
      expect((await cli(['list'])).stdout).toContain(`${pull.id}\t${url}`);
      expect(fs.existsSync(path.join(tmp, 'home', 'hub.json'))).toBe(false);

      const file = path.join(pull.dir, 'config.json');
      const config = read(file);
      const mismatched = JSON.stringify({ ...JSON.parse(config), id: mirror.id });
      try {
        fs.writeFileSync(file, mismatched);
        expect(await cli(['pr', pull.id, '--force', ...quiet])).toMatchObject({ code: 1, stderr: expect.stringContaining('review ID mismatch') });
        expect(read(file)).toBe(mismatched);
        expect((await fetch(url + 'api/meta')).status).toBe(409);
      } finally { fs.writeFileSync(file, config); }

      expect((await cli(['stop', pull.id])).code).toBe(0);
      expect(JSON.parse((await cli(['list', '--json'])).stdout)).not.toContainEqual(expect.objectContaining({ id: pull.id }));
    } finally {
      await cli(['stop', pull.id]);
      await cli(['stop', mirror.id]);
      await cli(['stop', branch, ...repoArgs]);
    }
  });
});
