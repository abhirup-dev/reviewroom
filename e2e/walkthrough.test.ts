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

  test('a tour anchor without a step breaks the schema', async () => {
    const st = state();
    st.threads[0].anchor = { kind: 'tour', chapter: 'latency' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await cli(['status', '--threads', ...d]);
    expect(r.stderr).toMatch(/does not match schema.*step/);
  });
});
