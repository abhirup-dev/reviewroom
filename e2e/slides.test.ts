// walkthrough.json on the agent's side: tour threads carry their slide.
import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';

describe('slides', () => {
  const { dir, d, cli, state, repo } = setup();
  const demo = path.join(import.meta.dir, '..', 'examples', 'habit-events', 'walkthrough.json');
  const walkthrough = read(import.meta.dir, '..', 'examples', 'habit-events', 'review.html');
  // Keep the paired walkthrough: slides may link to its sections with rr:doc refs.
  beforeEach(() => {
    fs.copyFileSync(demo, path.join(dir, 'walkthrough.json'));
    fs.writeFileSync(path.join(dir, 'review.html'), walkthrough);
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('state.json'))) fs.rmSync(path.join(dir, f));
  });

  test('a comment on a step is a tour thread; status --threads shows the slide', async () => {
    const c = await cli(['comment', 'rr:tour/latency/s2', 'why 30 ms?', ...d]);
    expect(c.code).toBe(0);
    expect(state().threads[0].anchor).toEqual({ kind: 'tour', chapter: 'latency', step: 's2' });
    const s = await cli(['status', '--threads', ...d]);
    expect(s.stdout).toMatch(/guided walkthrough "Builder.Build: the threads meet" slide 2\/5: "The fetcher arrives through/);
  });

  test('check covers walkthrough.json: the demo is ok, a broken step ref names its step, a schema error stops it', async () => {
    const file = path.join(dir, 'walkthrough.json');
    const ok = await cli(['check', ...d]);
    expect([ok.code, ok.stdout]).toEqual([0, expect.stringContaining('links ok (review.html and walkthrough.json)')]);
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    w.chapters[1].steps[0].ref = 'rr:code/pkg/gone.go#L1-2';
    fs.writeFileSync(file, JSON.stringify(w, null, 2));
    const broken = await cli(['check', ...d]);
    expect([broken.code, broken.stdout]).toEqual([1, expect.stringMatching(/broken\s+rr:code\/pkg\/gone.go#L1-2.*\[guided walkthrough fetcher\/s1\]/)]);
    fs.writeFileSync(file, JSON.stringify({ ...w, version: 2 }));
    const bad = await cli(['check', ...d]);
    expect([bad.code, bad.stderr]).toEqual([1, expect.stringContaining('version')]);
  });

  test('publish-slides --dry-run prints the PR block; without a PR it cannot post', async () => {
    const dry = await cli(['publish-slides', '--dry-run', ...d]);
    expect([dry.code, dry.stdout]).toEqual([0, expect.stringContaining('<!-- reviewroom-walkthrough -->\n```reviewroom-walkthrough\n{')]);
    const real = await cli(['publish-slides', ...d]);
    expect([real.code, real.stderr]).toEqual([1, expect.stringContaining('not about a GitHub PR')]);
  });

  test('a tour anchor without a step breaks the schema', async () => {
    await cli(['comment', 'rr:tour/latency/s2', 'why 30 ms?', ...d]);
    const st = state();
    st.threads[0].anchor = { kind: 'tour', chapter: 'latency' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await cli(['status', '--threads', ...d]);
    expect(r.stderr).toMatch(/does not match schema.*step/);
  });

  const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
  if (!browser) console.log('skipping slide-lint/shot: no browser (Chrome or Chromium) to render in');
  const listing = () => fs.readdirSync(dir).sort().map((f) => `${f} ${fs.statSync(path.join(dir, f)).mtimeMs}`);
  test.skipIf(!browser)('slide-lint measures every step on screen; shot writes one step\'s PNG; neither touches the review', async () => {
    // a script of the agent's that throws, and a diagram Pele can't parse: the reviewer would hit both, so lint reports them
    fs.writeFileSync(path.join(dir, 'review.html'), walkthrough.replace('</rr-review>', '<script>throw new Error("author boom")</script><rr-mermaid id="bad">flowchart TD\n  A --&gt;\n  ((( x</rr-mermaid></rr-review>'));
    // Exercise overflow deliberately, independently of how well the demo fits.
    const file = path.join(dir, 'walkthrough.json');
    const tour = JSON.parse(read(file));
    tour.chapters.find((chapter: { id: string }) => chapter.id === 'latency').steps[2].text += `<p>${'Oversized narration. '.repeat(300)}</p>`;
    fs.writeFileSync(file, JSON.stringify(tour));
    const before = listing();
    const lint = await cli(['slide-lint', '--viewport', '1280x720', '--json', ...d]);
    if (!lint.stdout) throw new Error(lint.stderr);
    const out = JSON.parse(lint.stdout);
    expect(out).toMatchObject({ viewports: ['1280x720'], links: [] });
    // The oversized step needs scrolling, and the report names it and explains the fix.
    expect(out.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'latency/s3', fix: expect.stringContaining('Shorten or split the slide') }));
    expect(out.findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('author boom') }));
    expect(out.findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('rr-mermaid#bad: the diagram could not be rendered') }));
    expect(lint.code).toBe(1);
    const png = path.join(dir, '..', 'shots', 'latency-s2-1280x800-light.png');
    const shot = await cli(['shot', 'latency/s2', '--out', path.dirname(png), ...d]);
    expect([shot.code, shot.stdout.split('\n')[0]]).toEqual([0, png]);
    expect([...fs.readFileSync(png).subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(listing()).toEqual(before);
  }, 60_000);

  // the desktop player's chapter heading is as tall as the code's toolbar and file band (slides.css), so a slide's text
  // starts level with the code, with a chapter intro above it (why) or without (fetcher), whatever the tokens become
  test.skipIf(!browser)('the narration starts level with the code, with or without a chapter intro', async () => {
    const { withServer, withPage } = await import('../cli/lib/render.ts');
    const gap = (url: string) =>
      withPage(url, { width: 1440, height: 900 }, (p) =>
        p.evaluate<number>(`new Promise((ok) => {
          const at = () => {
            const band = document.querySelector('.rr-tour__right .rr-file__head');
            const first = [...document.querySelector('.rr-tour__left')?.children ?? []].find((e) => e.getBoundingClientRect().height > 0);
            if (!band || !first) return setTimeout(at, 50);
            ok(Math.round(first.getBoundingClientRect().top - band.getBoundingClientRect().bottom));
          };
          at();
        })`),
      );
    const gaps = await withServer(repo, dir, async (url) => [await gap(url + '?walkthrough=why/s1'), await gap(url + '?walkthrough=fetcher/s1')]);
    expect(gaps).toEqual([0, 0]);
  }, 60_000);
});
