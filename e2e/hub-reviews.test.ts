// The hub starts reviews (cli/hub/reviews.ts): Add a PR by URL, the review listed stopped, Play, Play again, close.
// No GitHub: REVIEWROOM_TEST_CLONE_ROOT clones a local bare repo, and a stand-in `gh` fails. No Claude: Play turns the
// built-in assistant on for the review and asks it to generate, but CLAUDE_CODE_EXECUTABLE names a missing file, so
// api/generate refuses in its preflight, before any turn starts.
import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import fs from 'node:fs';
import path from 'node:path';
import { recordArtifact, requestGeneration } from '../cli/lib/progress.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { until } from '../src/testing/wait.ts';
import { config, setup } from './fixture.ts';

const root = path.resolve(import.meta.dir, '..');

describe('the hub starts reviews', async () => {
  const { cli, tmp, hub: client, mockPullRepository } = setup();
  const scratch = tmp;
  const { bare } = await mockPullRepository();
  const hub = await client.start();
  const PR = 'https://github.com/acme/demo/pull/7';
  const post = client.post;
  const ours = async () => (await client.sessions()).filter((s) => s.reviewId === 'acme/demo#7');

  test('the golden path: Add (listed stopped, not generated, the assistant not chosen), Play (generate asked, the server reused), close, Remove', async () => {
    expect((await post('api/reviews', 'add-review', { url: 'https://example.com/x' })).status).toBe(422);
    expect((await post('api/reviews', 'add-review', { url: 'https://github.com/acme/nothing/pull/1' })).status).toBe(422);
    expect((await fetch(hub + 'api/reviews', { method: 'POST', body: JSON.stringify({ url: PR }) })).status).toBe(403); // no action header
    const r = await post('api/reviews', 'add-review', { url: PR });
    expect(r.status).toBe(201);
    const id = (await r.json()).routeId;
    expect(fs.existsSync(path.join(tmp, 'home', 'repos', 'acme', 'demo', '.git'))).toBe(true);
    const [s] = await ours();
    expect(s).toMatchObject({ id: `review:${id}`, stopped: true, generation: 'idle', hasWork: false, pid: null, url: null, repository: 'demo', reviewId: 'acme/demo#7' });
    expect(config(s.reviewPath!).assistant).toBeUndefined();
    // two Plays at once: one starts the server and asks it to generate, the other finds that server and just opens it
    const both = await Promise.all([0, 1].map(async () => (await post(`api/reviews/${id}/play`, 'play-review')).json()));
    const first = both.find((r) => r.started);
    const other = both.find((r) => r !== first);
    expect([other?.ok, other?.started, other?.pid, other?.generate]).toEqual([true, false, first?.pid, null]);
    // the refusal is api/generate's own (its preflight found no Claude): it was called, and the review still runs
    expect(first).toMatchObject({ ok: true, started: true, generate: { ok: false, code: 'assistant_unavailable' } });
    expect(first.generate.error).toContain('Claude executable not found');
    const pid = first.pid;
    expect(await (await fetch(first.url + 'api/meta')).json()).toMatchObject({ assistant: true, generate: true });
    expect(await ours()).toEqual([expect.objectContaining({ id: `reviewroom:${pid}`, generation: 'idle' })]);
    const again = await (await post(`api/reviews/${id}/play`, 'play-review')).json();
    expect([again.started, again.pid, again.url, again.generate]).toEqual([false, pid, first.url, null]);
    expect(config((await ours())[0].reviewPath!).assistant).toBe(true);
    expect((await post(`api/reviews/${id}/remove`, 'remove-review')).status).toBe(409); // running: Close it first
    fs.copyFileSync(path.join(root, 'examples', 'uploads', WALKTHROUGH_FILE), path.join(s.reviewPath!, WALKTHROUGH_FILE)); // work Remove would lose
    expect((await post(`api/sessions/${encodeURIComponent(`reviewroom:${pid}`)}/close`, 'close-session')).status).toBe(202);
    const [closed] = await ours();
    expect(closed).toMatchObject({ id: `review:${id}`, stopped: true, hasWork: true }); // the page asks first
    expect((await fetch(hub + `api/reviews/${id}/remove`, { method: 'POST' })).status).toBe(403); // no action header
    expect((await post(`api/reviews/${id}/remove`, 'remove-review', { confirmed: true })).status).toBe(200);
    expect([fs.existsSync(closed.reviewPath!), fs.existsSync(path.join(tmp, 'home', 'repos', 'acme', 'demo', '.git'))]).toEqual([false, true]);
    expect(await ours()).toEqual([]);
    expect((await post(`api/reviews/${id}/remove`, 'remove-review')).status).toBe(404);
  }, 60_000);

  test('removing a stopped review with only an edited report requires confirmation', async () => {
    const r = await post('api/reviews', 'add-review', { url: 'https://github.com/acme/demo/pull/10' });
    expect(r.status).toBe(201);
    const { routeId } = await r.json();
    const review = async () => (await client.sessions()).find((s) => s.routeId === routeId);
    const added = await review();
    expect(added).toMatchObject({ stopped: true, hasWork: false });
    const report = path.join(added!.reviewPath!, REPORT_FILE);
    const edited = `${fs.readFileSync(report, 'utf8')}<p>Review notes</p>\n`;
    fs.writeFileSync(report, edited);
    await until(async () => (await review())?.hasWork, { every: 100 });
    const remove = () => `api/reviews/${routeId}/remove`;
    expect((await post(remove(), 'remove-review')).status).toBe(409);
    expect(fs.readFileSync(report, 'utf8')).toBe(edited);
    expect((await post(remove(), 'remove-review', { confirmed: true })).status).toBe(200);
  });

  test('a re-add at a new head never replaces a walkthrough edited since the PR import, even with a stale request', async () => {
    const clone = path.join(tmp, 'home', 'repos', 'acme', 'demo');
    const url = 'https://github.com/acme/demo/pull/11';
    const prRun = () => cli(['pr', url, '--no-agent', '--no-serve', '--no-open', '--repo', clone]);
    await $`git -C ${bare} update-ref refs/pull/11/head refs/heads/feat/upload-rate-limit`.quiet();
    const dir = (await prRun()).stdout.trim();
    const A = (await $`git -C ${clone} rev-parse ${config(dir).head}`.text()).trim();
    // the PR's walkthrough imported at A, generation requested at A, then the walkthrough edited here
    fs.copyFileSync(path.join(root, 'examples', 'uploads', WALKTHROUGH_FILE), path.join(dir, WALKTHROUGH_FILE));
    recordArtifact(dir, 'walkthrough', 'validated', { source: 'pr', head: A });
    requestGeneration(dir, 'agent', A);
    const edited = fs.readFileSync(path.join(dir, WALKTHROUGH_FILE), 'utf8').replace('{', '{"edited":true,');
    fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), edited);
    // the PR moves to B; the re-add resets the stale request but must not even try to import over the edit
    const work = path.join(scratch, 'work-11');
    await $`git clone -q ${bare} ${work}`.quiet();
    await $`git -C ${work} checkout -q feat/upload-rate-limit && git -C ${work} -c user.email=t@t -c user.name=t commit -q --allow-empty -m b && git -C ${work} push -q origin HEAD:refs/pull/11/head`.quiet();
    const r = await prRun();
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('could not look for a walkthrough on the PR'); // a fetch would replace it
    expect(fs.readFileSync(path.join(dir, WALKTHROUGH_FILE), 'utf8')).toBe(edited);
  }, 60_000);

  test('two PRs from branches of the same name are two reviews: the Review ID names the folder', async () => {
    for (const n of [7, 8]) expect((await post('api/reviews', 'add-review', { url: `https://github.com/acme/demo/pull/${n}` })).status).toBe(201);
    const all = (await client.sessions()).filter((s) => s.reviewId === 'acme/demo#7' || s.reviewId === 'acme/demo#8');
    expect(all.map((s) => s.reviewPath!.split(path.sep).slice(-3).join('/')).sort()).toEqual(['acme_demo/pulls/7', 'acme_demo/pulls/8']);
  }, 60_000);
});
