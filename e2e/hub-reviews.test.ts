// The hub starts reviews (cli/hub/reviews.ts): Add a PR by URL, the review listed stopped, Play, Play again, close.
// No GitHub: REVIEWROOM_TEST_CLONE_ROOT clones a local bare repo, and a stand-in `gh` fails. No Claude: Play turns the
// built-in assistant on for the review and asks it to generate, but CLAUDE_CODE_EXECUTABLE names a missing file, so
// api/generate refuses in its preflight, before any turn starts.
import { afterAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '../src/hub/model.shared.ts';
import { setup } from './fixture.ts';

const root = path.resolve(import.meta.dir, '..');

describe('the hub starts reviews', async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'rr-e2e-hubrev-'));
  const clones = path.join(scratch, 'clones');
  const bare = path.join(clones, 'acme', 'demo.git');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await $`bash ${path.join(root, 'examples', 'make-demo-repo.sh')} ${path.join(scratch, 'src')}`.quiet();
  await $`git clone -q --bare ${path.join(scratch, 'src')} ${bare}`.quiet();
  await $`git -C ${bare} update-ref refs/pull/7/head refs/heads/feat/upload-rate-limit`.quiet();
  const { cli, tmp } = setup({
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

  test('adding it again picks up new commits', async () => {
    const work = path.join(scratch, 'work');
    await $`git clone -q ${bare} ${work}`.quiet();
    await $`git -C ${work} checkout -q feat/upload-rate-limit && git -C ${work} -c user.email=t@t -c user.name=t commit -q --allow-empty -m more`.quiet();
    const sha = (await $`git -C ${work} rev-parse HEAD`.text()).trim();
    await $`git -C ${work} push -q origin HEAD:refs/pull/7/head`.quiet();
    expect((await post('api/reviews', 'add-review', { url: PR })).status).toBe(201);
    expect((await $`git -C ${path.join(tmp, 'home', 'repos', 'acme', 'demo')} rev-parse refs/reviewroom/pr-7`.text()).trim()).toBe(sha);
    expect(await ours()).toHaveLength(1);
  }, 60_000);

  let pid = 0;
  test('Play starts it with the built-in assistant and asks it to generate; Play again reuses the same server', async () => {
    const first = await (await post(`api/reviews/${id}/play`, 'play-review')).json();
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
});
