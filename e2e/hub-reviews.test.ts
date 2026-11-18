// The hub starts reviews (cli/hub/reviews.ts): Add a PR by URL, the review listed stopped, Play, Play again, close.
// No GitHub: REVIEWROOM_TEST_CLONE_ROOT clones a local bare repo, and a stand-in `gh` fails. No Claude: Play turns the
// built-in assistant on for the review and asks it to generate, but CLAUDE_CODE_EXECUTABLE names a missing file, so
// api/generate refuses in its preflight, before any turn starts.
import { afterAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '../src/hub/model.shared.ts';
import { recordArtifact, requestGeneration } from '../cli/lib/progress.ts';
import { WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { setup } from './fixture.ts';
import { until } from '../src/testing/wait.ts';
import { reviewId } from '../cli/lib/registry.ts';

const root = path.resolve(import.meta.dir, '..');

describe('the hub starts reviews', async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'rr-e2e-hubrev-'));
  const clones = path.join(scratch, 'clones');
  const bare = path.join(clones, 'acme', 'demo.git');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  // a stand-in `gh`: every PR comes from a fork branch called patch-1; anything else fails
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
[ "$1 $2" = "pr view" ] || exit 1
echo '{"number":'$3',"title":"PR '$3'","headRefName":"patch-1","baseRefName":"main","url":"https://github.com/acme/demo/pull/'$3'","author":{"login":"x"}}'
`, { mode: 0o755 });
  await $`bash ${path.join(root, 'examples', 'make-demo-repo.sh')} ${path.join(scratch, 'src')}`.quiet();
  await $`git clone -q --bare ${path.join(scratch, 'src')} ${bare}`.quiet();
  await $`git -C ${bare} update-ref refs/pull/7/head refs/heads/feat/upload-rate-limit`.quiet();
  await $`git -C ${bare} update-ref refs/pull/8/head refs/heads/feat/upload-rate-limit~1`.quiet();
  await $`git -C ${bare} update-ref refs/pull/9/head refs/heads/feat/upload-rate-limit`.quiet();
  const { cli, tmp, repo } = setup({
    REVIEWROOM_TEST_CLONE_ROOT: clones,
    CLAUDE_CODE_EXECUTABLE: path.join(scratch, 'no-claude'),
    PATH: `${bin}:${process.env.PATH}`,
  });
  afterAll(async () => {
    await cli(['hub', '--stop']);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const hub = (await cli(['hub', '--detach', '--no-open', '--port', '0'])).stdout.trim();
  const PR = 'https://github.com/acme/demo/pull/7';
  const post = (p: string, action: string, body?: object) => fetch(hub + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-reviewroom-action': action }, body: body && JSON.stringify(body) });
  const ours = async () => ((await (await fetch(hub + 'api/sessions')).json()).sessions as SessionInfo[]).filter((s) => s.target === '#7');
  let id = '';

  const config = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  test('Add a PR: cloned under repos/<owner>/<repo>, listed stopped and not generated, the assistant not chosen', async () => {
    expect((await post('api/reviews', 'add-review', { url: 'https://example.com/x' })).status).toBe(422);
    expect((await post('api/reviews', 'add-review', { url: 'https://github.com/acme/nothing/pull/1' })).status).toBe(422);
    expect((await fetch(hub + 'api/reviews', { method: 'POST', body: JSON.stringify({ url: PR }) })).status).toBe(403); // no action header
    const r = await post('api/reviews', 'add-review', { url: PR });
    expect(r.status).toBe(201);
    id = (await r.json()).id;
    expect(fs.existsSync(path.join(tmp, 'home', 'repos', 'acme', 'demo', '.git'))).toBe(true);
    const [s] = await ours();
    expect(s).toMatchObject({ id: `review:${id}`, stopped: true, generation: 'idle', pid: null, url: null, repository: 'demo', prUrl: PR });
    expect(config(s.reviewPath!).assistant).toBeUndefined();
  }, 60_000);

  test('adding it again picks up new commits; documents made for the old head no longer count, but stay on disk', async () => {
    // both documents written and validated for the PR's head as it is now
    const [s] = await ours();
    const dir = s.reviewPath!;
    const clone = path.join(tmp, 'home', 'repos', 'acme', 'demo');
    const old = (await $`git -C ${clone} rev-parse refs/reviewroom/pr-7`.text()).trim();
    fs.copyFileSync(path.join(root, 'examples', 'uploads', WALKTHROUGH_FILE), path.join(dir, WALKTHROUGH_FILE));
    requestGeneration(dir, 'agent', old);
    for (const a of ['walkthrough', 'report'] as const) recordArtifact(dir, a, 'validated', { head: old });
    await until(async () => (await ours())[0].generation === 'ready', { timeout: 10_000, every: 200 }); // the hub's next poll
    // the same head again: still ready
    expect((await post('api/reviews', 'add-review', { url: PR })).status).toBe(201);
    expect((await ours())[0].generation).toBe('ready');
    const work = path.join(scratch, 'work');
    await $`git clone -q ${bare} ${work}`.quiet();
    await $`git -C ${work} checkout -q feat/upload-rate-limit && git -C ${work} -c user.email=t@t -c user.name=t commit -q --allow-empty -m more`.quiet();
    const sha = (await $`git -C ${work} rev-parse HEAD`.text()).trim();
    await $`git -C ${work} push -q origin HEAD:refs/pull/7/head`.quiet();
    expect((await post('api/reviews', 'add-review', { url: PR })).status).toBe(201);
    expect((await $`git -C ${path.join(tmp, 'home', 'repos', 'acme', 'demo')} rev-parse refs/reviewroom/pr-7`.text()).trim()).toBe(sha);
    expect(await ours()).toHaveLength(1);
    expect((await ours())[0].generation).toBe('idle'); // the next Play regenerates them
    expect(fs.existsSync(path.join(dir, WALKTHROUGH_FILE))).toBe(true);
  }, 60_000);

  test('two PRs from branches of the same name are two reviews, each in its pr-<n> folder', async () => {
    expect((await post('api/reviews', 'add-review', { url: 'https://github.com/acme/demo/pull/8' })).status).toBe(201);
    const all = ((await (await fetch(hub + 'api/sessions')).json()).sessions as SessionInfo[]).filter((s) => s.target === '#7' || s.target === '#8');
    expect(all.map((s) => path.basename(s.reviewPath!)).sort()).toEqual(['pr-7', 'pr-8']);
  }, 60_000);

  test('a review of the PR made before pr-<n> folders (in its head branch\'s folder) is reused, not split in two', async () => {
    const [s] = await ours();
    const legacy = path.join(path.dirname(s.reviewPath!), 'patch-1');
    fs.mkdirSync(legacy);
    const clone = path.join(tmp, 'home', 'repos', 'acme', 'demo');
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ number: 9, url: 'https://github.com/acme/demo/pull/9', repoPath: clone, base: 'origin/main', head: 'refs/reviewroom/pr-9' }));
    fs.writeFileSync(path.join(legacy, 'keep.txt'), 'threads and rounds');
    const r = await post('api/reviews', 'add-review', { url: 'https://github.com/acme/demo/pull/9' });
    expect(r.status).toBe(201);
    expect((await r.json()).id).toBe(reviewId(legacy));
    expect([fs.existsSync(path.join(path.dirname(legacy), 'pr-9')), fs.existsSync(path.join(legacy, 'keep.txt'))]).toEqual([false, true]);
    expect(((await (await fetch(hub + 'api/sessions')).json()).sessions as SessionInfo[]).filter((x) => x.target === '#9')).toHaveLength(1);
  }, 60_000);

  test('two first Adds of one new repository at once: one clones, the other waits and fetches; both set it up', async () => {
    await $`git clone -q --bare ${path.join(scratch, 'src')} ${path.join(clones, 'acme', 'other.git')}`.quiet();
    await $`git -C ${path.join(clones, 'acme', 'other.git')} update-ref refs/pull/1/head refs/heads/feat/upload-rate-limit`.quiet();
    const rs = await Promise.all([0, 1].map(() => post('api/reviews', 'add-review', { url: 'https://github.com/acme/other/pull/1' })));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(bodies[0].id).toBe(bodies[1].id);
    expect(fs.readdirSync(path.join(tmp, 'home', 'repos', 'acme')).sort()).toEqual(['demo', 'other']); // no staging left in repos/
  }, 60_000);

  let pid = 0;
  test('Play starts it with the built-in assistant and asks it to generate; Play again reuses the same server', async () => {
    // two Plays at once: one starts the server and asks it to generate, the other finds that server and just opens it
    const both = await Promise.all([0, 1].map(async () => (await post(`api/reviews/${id}/play`, 'play-review')).json()));
    const first = both.find((r) => r.started);
    const other = both.find((r) => r !== first);
    expect([other?.ok, other?.started, other?.pid, other?.generate]).toEqual([true, false, first?.pid, null]);
    // the refusal is api/generate's own (its preflight found no Claude): it was called, and the review still runs
    expect(first).toMatchObject({ ok: true, started: true, generate: { ok: false, code: 'assistant_unavailable' } });
    expect(first.generate.error).toContain('Claude executable not found');
    pid = first.pid;
    expect(await (await fetch(first.url + 'api/meta')).json()).toMatchObject({ assistant: true, generate: true });
    expect(await ours()).toEqual([expect.objectContaining({ id: `reviewroom:${pid}`, generation: 'idle' })]);
    const again = await (await post(`api/reviews/${id}/play`, 'play-review')).json();
    expect([again.started, again.pid, again.url, again.generate]).toEqual([false, pid, first.url, null]);
    expect(config((await ours())[0].reviewPath!).assistant).toBe(true);
  }, 60_000);

  test('closing it lists it stopped again', async () => {
    expect((await post(`api/sessions/${encodeURIComponent(`reviewroom:${pid}`)}/close`, 'close-session')).status).toBe(202);
    expect(await ours()).toEqual([expect.objectContaining({ id: `review:${id}`, stopped: true })]);
  }, 60_000);

  test('a running review in a custom --dir shows its generation state too', async () => {
    const custom = path.join(tmp, 'elsewhere');
    const d = ['--repo', repo, '--dir', custom];
    try {
      expect((await cli(['pr', 'feat/upload-rate-limit', '--detach', '--no-open', '--port', '0', '--no-agent', ...d])).code).toBe(0);
      const s = await until(async () => ((await (await fetch(hub + 'api/sessions')).json()).sessions as SessionInfo[]).find((x) => x.reviewPath === custom && !x.stopped), { timeout: 10_000, every: 200 });
      expect(s.generation).toBe('idle');
    } finally {
      await cli(['stop', ...d]);
    }
  }, 60_000);
});
