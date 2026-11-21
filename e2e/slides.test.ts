import { WALKTHROUGH_FILE, REPORT_FILE } from '../src/kernel/state/files.shared.ts';
// walkthrough.json on the agent's side: tour threads carry their slide.
import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';

describe('slides', () => {
  const { dir, d, cli, state } = setup();
  const demo = path.join(import.meta.dir, '..', 'examples', 'uploads', WALKTHROUGH_FILE);
  const walkthrough = read(import.meta.dir, '..', 'examples', 'uploads', REPORT_FILE);
  // Keep the paired walkthrough: slides may link to its sections with rr:doc refs.
  beforeEach(() => {
    fs.copyFileSync(demo, path.join(dir, WALKTHROUGH_FILE));
    fs.writeFileSync(path.join(dir, REPORT_FILE), walkthrough);
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('state.json'))) fs.rmSync(path.join(dir, f));
  });

  test('a comment on a step is a tour thread; status --threads shows the slide', async () => {
    const c = await cli(['comment', ...d, 'rr:tour/enforce/s2', 'why retry immediately?']);
    expect(c.code).toBe(0);
    expect(state().threads[0].anchor).toEqual({ kind: 'tour', chapter: 'enforce', step: 's2' });
    const s = await cli(['status', ...d, '--threads']);
    expect(s.stdout).toMatch(/guided walkthrough "The handler joins the contract" slide 2\/4: "The client retries/);
  });

  test(`check covers ${WALKTHROUGH_FILE}: the demo is ok, a broken step ref names its step, a schema error stops it`, async () => {
    const file = path.join(dir, WALKTHROUGH_FILE);
    const ok = await cli(['check', ...d]);
    expect([ok.code, ok.stdout]).toEqual([0, expect.stringContaining(`links ok (${REPORT_FILE} and ${WALKTHROUGH_FILE})`)]);
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    w.chapters[1].steps[0].ref = 'rr:code/pkg/gone.go#L1-2';
    fs.writeFileSync(file, JSON.stringify(w, null, 2));
    const broken = await cli(['check', ...d]);
    expect([broken.code, broken.stdout]).toEqual([1, expect.stringMatching(/broken\s+rr:code\/pkg\/gone.go#L1-2.*\[guided walkthrough bucket\/s1\]/)]);
    fs.writeFileSync(file, JSON.stringify({ ...w, version: 2 }));
    const bad = await cli(['check', ...d]);
    expect([bad.code, bad.stdout]).toEqual([1, expect.stringContaining('version')]);
  });

  test('publish-slides --dry-run prints the PR block; without a PR it cannot post', async () => {
    const dry = await cli(['publish-slides', ...d, '--dry-run']);
    expect([dry.code, dry.stdout]).toEqual([0, expect.stringContaining('<!-- reviewroom-walkthrough -->\n```reviewroom-walkthrough\n{')]);
    const real = await cli(['publish-slides', ...d]);
    expect([real.code, real.stdout]).toEqual([1, expect.stringContaining('not about a GitHub PR')]);
  });

  test('a tour anchor without a step breaks the schema', async () => {
    await cli(['comment', ...d, 'rr:tour/enforce/s2', 'why retry immediately?']);
    const st = state();
    st.threads[0].anchor = { kind: 'tour', chapter: 'enforce' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await cli(['status', ...d, '--threads']);
    expect(r.stdout).toMatch(/does not match schema.*step/);
  });
});
