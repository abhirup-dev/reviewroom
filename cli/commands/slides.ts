// slide-lint: `check`, then every slide of the guided walkthrough measured on screen in a headless browser.
// shotSlide: one slide's picture (`reviewroom shot <chapter>/<step>`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit } from '../lib/config.ts';
import { report } from '../lib/links.ts';
import { readWalkthrough, walkthroughPath } from '../lib/state.ts';
import { findingReport, judge, type Finding, type Measured } from '../lib/slide-lint.ts';
import { openPage, parseViewports, vpName, withServer } from '../lib/render.ts';
import { runCheck, schemaReport } from './check.ts';

type SlideOpts = Global & { viewport?: string; theme?: string; out?: string; json?: boolean };

const slidesDir = (repo: string | null, o: SlideOpts) => {
  const dir = dirForEdit(repo, o.dir);
  if (!fs.existsSync(walkthroughPath(dir))) fail(`no walkthrough.json in ${dir}`);
  return dir;
};

export async function cmdSlideLint(repo: string | null, o: SlideOpts) {
  const dir = slidesDir(repo, o);
  const c = await runCheck(repo, dir, { store: false, estimates: false });
  if ('issues' in c) fail(schemaReport(c.issues));
  const tour = c.tour!;
  const viewports = parseViewports(o.viewport ?? '1280x800,1440x900');
  const ms: Measured[] = [];
  const boot: Finding[] = [];
  let engine = '';
  await withServer(repo, dir, async (url) => {
    for (const vp of viewports) {
      const page = await openPage(url, vp);
      engine = page.engine;
      try {
        // the page's own start-up (review.html's scripts too): not a step's
        for (const e of page.errors()) boot.push({ check: 'page-error', level: 'warn', message: `while the page started (${vpName(vp)}): ${e.slice(0, 200)}`, fix: 'A script in review.html or the walkthrough prose failed; the reviewer sees the same.' });
        for (const ch of tour.chapters) for (const st of ch.steps) ms.push({ viewport: vpName(vp), chapter: ch.id, step: st.id, audit: await page.audit(ch.id, st.id), errors: page.errors(), ownRef: st.ref !== undefined });
      } finally {
        await page.close();
      }
    }
  });
  const findings: Finding[] = [...c.notes, ...boot, ...judge(ms)];
  const steps = tour.chapters.reduce((n, ch) => n + ch.steps.length, 0);
  if (o.json) console.log(JSON.stringify({ engine, viewports: viewports.map(vpName), links: c.bad, findings }, null, 2));
  else {
    console.log(`${steps} slides measured at ${viewports.map(vpName).join(', ')} (${engine})`);
    if (c.bad.length) console.log(`\n${c.bad.length} link(s) need attention:\n${report(c.bad)}`);
    console.log(findings.length ? `\n${findingReport(findings, tour)}` : '\nno findings: every slide fits.');
    if (findings.some((f) => f.level === 'warn')) console.log('\nSee a slide with `reviewroom shot <chapter>/<step>`.');
  }
  if (c.bad.length || findings.some((f) => f.level === 'warn')) process.exitCode = 1;
}

/** `reviewroom shot <chapter>/<step>`: one slide's PNG, and what lint finds on it. */
export async function shotSlide(repo: string | null, o: SlideOpts, at: string) {
  const dir = slidesDir(repo, o);
  const [chapter, step] = at.split('/');
  const w = readWalkthrough(dir);
  if (!w?.ok) fail(w ? schemaReport(w.issues) : `no walkthrough.json in ${dir}`);
  const ch = w.value.chapters.find((x) => x.id === chapter);
  if (!ch || !ch.steps.some((s) => s.id === step)) fail(`usage: reviewroom shot <chapter>/<step>; steps: ${w.value.chapters.flatMap((x) => x.steps.map((s) => `${x.id}/${s.id}`)).join(', ')}`, 2);
  const theme = (o.theme ?? 'light') as 'light' | 'dark';
  const [vp] = parseViewports(o.viewport ?? '1280x800');
  const out = path.join(path.resolve(o.out ?? path.join(os.tmpdir(), 'reviewroom-shots')), `${chapter}-${step}-${vpName(vp)}-${theme}.png`);
  await withServer(repo, dir, async (url) => {
    const page = await openPage(url, vp, 2);
    try {
      page.errors();
      const audit = await page.audit(chapter, step, theme);
      await Bun.write(out, await page.screenshot());
      console.log(out);
      const found = judge([{ viewport: vpName(vp), chapter, step, audit, errors: page.errors(), ownRef: ch.steps.find((s) => s.id === step)!.ref !== undefined }]);
      if (found.length) console.log(findingReport(found, w.value));
    } finally {
      await page.close();
    }
  });
}
