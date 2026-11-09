// slide-lint: `check`, then every slide of the guided walkthrough measured on screen in a headless browser.
// shotSlide: one slide's picture (`reviewroom shot <chapter>/<step>`).
import os from 'node:os';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit } from '../lib/config.ts';
import { report } from '../lib/links.ts';
import { readWalkthrough } from '../lib/state.ts';
import { findingReport, judge, type Finding } from '../lib/slide-lint.ts';
import { parseViewports, pngSize, vpName, withPage, withServer } from '../lib/render.ts';
import { auditJobs, auditSlides } from '../lib/slide-render.ts';
import { runCheck, schemaReport } from './check.ts';

type SlideOpts = Global & { viewport?: string; theme?: string; out?: string; json?: boolean; chapter?: string; slide?: string; native?: boolean; proseOnly?: boolean; jobs?: string };


export async function cmdSlideLint(repo: string | null, o: SlideOpts) {
  const jobs = auditJobs(o.jobs);
  const dir = dirForEdit(repo, o.dir, 'walkthrough.json');
  const c = await runCheck(repo, dir, { store: false, estimates: false, select: { chapter: o.chapter, slide: o.slide } });
  if ('issues' in c) fail(schemaReport(c.issues));
  const tour = c.tour!;
  const selection = c.selection!;
  const partial = selection.scope.kind !== 'all';
  const viewports = parseViewports(o.viewport ?? '1280x800,1440x900');
  const slides = selection.slides.map((at) => {
    const st = tour.chapters.find((ch) => ch.id === at.chapter)!.steps.find((s) => s.id === at.step)!;
    return { ...at, ownRef: partial || st.ref !== undefined };
  });
  const rendered = await withServer(repo, dir, (url) => auditSlides(url, { viewports, slides, jobs, native: o.native }));
  const { engine, boot, measurements: ms } = rendered;
  const findings: Finding[] = [...c.notes, ...boot, ...judge(ms)];
  const coverage = { partial, totalSlides: selection.total, measured: selection.slides.map((s) => `${s.chapter}/${s.step}`) };
  if (o.json) console.log(JSON.stringify({ engine, jobs: rendered.jobs, viewports: viewports.map(vpName), rasterHeight: o.native ? null : 480, selection: selection.scope, coverage, links: c.bad, findings }, null, 2));
  else {
    console.log(`${selection.slides.length}${partial ? ` of ${selection.total}` : ''} slides measured at ${viewports.map(vpName).join(', ')} (${engine}; ${rendered.jobs} worker${rendered.jobs === 1 ? '' : 's'}${partial ? '; partial check' : ''})`);
    if (c.bad.length) console.log(`\n${c.bad.length} link(s) need attention:\n${report(c.bad)}`);
    console.log(findings.length ? `\n${findingReport(findings, tour)}` : partial ? '\nno findings in the selected slides (partial check).' : '\nno findings: every slide fits.');
    if (findings.some((f) => f.level === 'warn')) console.log('\nSee a slide with `reviewroom shot <chapter>/<step>`.');
  }
  if (c.bad.length || findings.some((f) => f.level === 'warn')) process.exitCode = 1;
}

/** `reviewroom shot <chapter>/<step>`: one slide's PNG, and what lint finds on it. */
export async function shotSlide(repo: string | null, o: SlideOpts, at: string) {
  const dir = dirForEdit(repo, o.dir, 'walkthrough.json');
  const [chapter, step] = at.split('/');
  const w = readWalkthrough(dir);
  if (!w?.ok) fail(w ? schemaReport(w.issues) : `no walkthrough.json in ${dir}`);
  const ch = w.value.chapters.find((x) => x.id === chapter);
  if (!ch || !ch.steps.some((s) => s.id === step)) fail(`usage: reviewroom shot <chapter>/<step>; steps: ${w.value.chapters.flatMap((x) => x.steps.map((s) => `${x.id}/${s.id}`)).join(', ')}`, 2);
  const theme = (o.theme ?? 'light') as 'light' | 'dark';
  const [vp] = parseViewports(o.viewport ?? '1280x800');
  const out = path.join(path.resolve(o.out ?? path.join(os.tmpdir(), 'reviewroom-shots')), `${chapter}-${step}-${vpName(vp)}-${theme}${o.proseOnly ? '-prose' : ''}${o.native ? '-native' : ''}.png`);
  await withServer(repo, dir, (url) =>
    withPage(url, vp, async (page) => {
      page.errors();
      const audit = await page.audit(chapter, step, theme, { proseOnly: o.proseOnly });
      const png = await page.screenshot(o.proseOnly ? '.rr-tour__left' : undefined);
      await Bun.write(out, png);
      console.log(out);
      const size = await pngSize(png);
      console.log(`${size.width}x${size.height} pixels; ${vpName(vp)} CSS viewport${o.proseOnly ? '; prose only (code pane not audited)' : ''}`);
      const found = judge([{ viewport: vpName(vp), chapter, step, audit, errors: page.errors(), ownRef: ch.steps.find((s) => s.id === step)!.ref !== undefined }]);
      if (found.length) console.log(findingReport(found, w.value));
    }, 1, { animations: false, rasterHeight: o.native ? undefined : 480 }),
  );
}
