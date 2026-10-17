// walkthrough.json on the agent's side: tour threads carry their slide.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';

describe('walkthrough', () => {
  const { dir, d, cli, state } = setup();
  const demo = path.join(import.meta.dir, '..', 'examples', 'habit-events', 'walkthrough.json');

  test('a comment on a step is a tour thread; status --threads shows the slide', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(demo, path.join(dir, 'walkthrough.json'));
    const c = await cli(['comment', 'rr:tour/latency/s2', 'why 30 ms?', ...d]);
    expect(c.code).toBe(0);
    expect(state().threads[0].anchor).toEqual({ kind: 'tour', chapter: 'latency', step: 's2' });
    const s = await cli(['status', '--threads', ...d]);
    expect(s.stdout).toMatch(/walkthrough "Request path & failure mode" step 2\/4: "The fetcher caps itself/);
  });

  test('check covers walkthrough.json: the demo is ok, a broken step ref names its step, a schema error stops it', async () => {
    const file = path.join(dir, 'walkthrough.json');
    fs.writeFileSync(path.join(dir, 'review.html'), '<rr-review><p>x</p></rr-review>');
    const ok = await cli(['check', ...d]);
    expect([ok.code, ok.stdout]).toEqual([0, expect.stringContaining('links ok (review.html and walkthrough.json)')]);
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    w.chapters[1].steps[0].ref = 'rr:code/pkg/gone.go#L1-2';
    fs.writeFileSync(file, JSON.stringify(w, null, 2));
    const broken = await cli(['check', ...d]);
    expect([broken.code, broken.stdout]).toEqual([1, expect.stringMatching(/broken\s+rr:code\/pkg\/gone.go#L1-2.*\[walkthrough latency\/s1\]/)]);
    fs.writeFileSync(file, JSON.stringify({ ...w, version: 2 }));
    const bad = await cli(['check', ...d]);
    expect([bad.code, bad.stderr]).toEqual([1, expect.stringContaining('version')]);
    fs.copyFileSync(demo, file);
  });

  test('walkthrough publish --dry-run prints the PR block; without a PR it cannot post', async () => {
    const dry = await cli(['walkthrough', 'publish', '--dry-run', ...d]);
    expect([dry.code, dry.stdout]).toEqual([0, expect.stringContaining('<!-- reviewroom-walkthrough -->\n```reviewroom-walkthrough\n{')]);
    const real = await cli(['walkthrough', 'publish', ...d]);
    expect([real.code, real.stderr]).toEqual([1, expect.stringContaining('not about a GitHub PR')]);
  });

  test('a tour anchor without a step breaks the schema', async () => {
    const st = state();
    st.threads[0].anchor = { kind: 'tour', chapter: 'latency' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await cli(['status', '--threads', ...d]);
    expect(r.stderr).toMatch(/does not match schema.*step/);
  });

  // needs a browser (Chrome, or WebKit on macOS); without one it says so and the test only checks that
  test('walkthrough lint measures every step on screen; shot writes one step\'s PNG', async () => {
    fs.copyFileSync(demo, path.join(dir, 'walkthrough.json'));
    // a script of the author's that throws: the reviewer would hit it, so lint reports it
    fs.writeFileSync(path.join(dir, 'review.html'), read(import.meta.dir, '..', 'templates', 'review.html').replace('</rr-review>', '<script>throw new Error("author boom")</script></rr-review>'));
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('state.json'))) fs.rmSync(path.join(dir, f)); // the test above broke it on purpose
    const lint = await cli(['walkthrough', 'lint', '--viewport', '1280x720', '--json', ...d]);
    if (/no browser to render in/.test(lint.stderr)) {
      expect(lint.code).toBe(1);
      return;
    }
    if (!lint.stdout) throw new Error(lint.stderr);
    const out = JSON.parse(lint.stdout);
    expect(out).toMatchObject({ viewports: ['1280x720'], links: [] });
    // the demo's longest step needs scrolling on a short screen, and the report says where and how to fix it
    expect(out.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'latency/s3', fix: expect.stringContaining('Shorten or split the step') }));
    expect(out.findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('author boom') }));
    expect(lint.code).toBe(1);
    const png = path.join(dir, '..', 'shot.png');
    const shot = await cli(['walkthrough', 'shot', 'latency/s2', '--out', png, ...d]);
    expect([shot.code, shot.stdout.split('\n')[0]]).toEqual([0, png]);
    expect([...fs.readFileSync(png).subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  }, 60_000);
});
