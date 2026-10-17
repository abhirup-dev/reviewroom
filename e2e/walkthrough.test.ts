// walkthrough.json on the agent's side: tour threads carry their slide.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture.ts';

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

  test('a tour anchor without a step breaks the schema', async () => {
    const st = state();
    st.threads[0].anchor = { kind: 'tour', chapter: 'latency' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await cli(['status', '--threads', ...d]);
    expect(r.stderr).toMatch(/does not match schema.*step/);
  });
});
