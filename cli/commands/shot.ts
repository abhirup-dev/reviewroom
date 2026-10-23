// shot: the review (review.html as the Review panel shows it) as PNGs, for an agent to look at without a browser
// (`shot <chapter>/<step>`: one guided-walkthrough slide instead, in slides.ts).
// One picture when it is short; else one per section (the Contents' sections), a tall section cut between its blocks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit } from '../lib/config.ts';
import { withPage, withServer } from '../lib/render.ts';
import { shotSlide } from './slides.ts';

type ShotOpts = Global & { theme?: string; out?: string; mobile?: boolean; viewport?: string };
type Part = { name: string; top: number; height: number };
type Plan = { error?: string; width?: number; parts?: Part[]; wide?: string[] };

const LAPTOP = { width: 1280, height: 800 }; // the Review panel is as wide as in the default layout on this screen
const PHONE = 390; // CSS px: a common phone's width (iPhone 12 to 15)
const MAX = 1400; // CSS px per picture: under the ~1568 px edge vision models take without downscaling

// The Review panel alone, at the width it has in the layout (or a phone's), its whole height laid out at the top of the browser (a part is shown by moving it up,
// not by scrolling: a scroller is never shorter than the window); then where to cut. Sections as in the
// Contents (top-level section[id] / [data-rr-section][id]); a section starts where the last ended, so the
// title and lead go with the first. A part over MAX is cut at its last child's top that fits, else at MAX.
const PLAN = (only: string | undefined, max: number, phone?: number) => `(async () => {
  const s = document.querySelector('.rr-narrative-scroll:not(.rr-description)');
  if (!s) return { error: 'the layout has no Review panel' };
  const width = ${phone ?? 's.clientWidth'};
  s.style.cssText += ';position:fixed;top:0;left:0;width:' + width + 'px;height:auto;overflow:visible;z-index:2147483647;background:var(--rr-surface-doc)';
  await document.fonts.ready;
  // diagrams and late scripts grow the page: wait until its height holds for 300 ms (at most 5 s)
  for (let h = -1, t0 = Date.now(); h !== s.offsetHeight && Date.now() - t0 < 5000; ) { h = s.offsetHeight; await new Promise((r) => setTimeout(r, 300)); }
  const total = s.offsetHeight, base = s.getBoundingClientRect().top;
  const top = (el) => Math.round(el.getBoundingClientRect().top - base);
  const secs = [...s.querySelectorAll('section[id], [data-rr-section][id]')].filter((x) => !x.parentElement?.closest('section[id]'));
  const ranges = (total <= ${max} && !${JSON.stringify(only ?? null)}) || !secs.length
    ? [{ name: 'review', el: s.querySelector('rr-review') ?? s, from: 0, to: total }]
    : secs.map((el, i) => ({ name: el.id, el, from: i ? top(el) : 0, to: i + 1 < secs.length ? top(secs[i + 1]) : total }));
  const want = ${JSON.stringify(only ?? null)};
  if (want && !ranges.some((r) => r.name === want)) return { error: 'no section "' + want + '"; sections: ' + ranges.map((r) => r.name).join(', ') };
  const parts = [];
  for (const r of ranges.filter((r) => !want || r.name === want)) {
    const cuts = [...r.el.querySelectorAll(':scope > *, :scope > * > *')].map(top).filter((y) => y > r.from && y < r.to).sort((a, b) => a - b);
    const n0 = parts.length;
    for (let at = r.from; at < r.to; ) {
      const end = r.to - at <= ${max} ? r.to : cuts.filter((y) => y > at && y - at <= ${max}).at(-1) ?? at + ${max};
      parts.push({ name: r.name, top: at, height: end - at });
      at = end;
    }
    if (parts.length - n0 > 1) parts.slice(n0).forEach((p, i) => (p.name += '-' + (i + 1)));
  }
  // what sticks out past the panel's edge (cut off, or the page scrolls sideways): outermost only, not what a
  // scroller or clipping box holds
  const clipped = (el) => { for (let a = el.parentElement; a && a !== s; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
  const wide = [];
  for (const el of s.querySelectorAll('rr-review *')) {
    const by = Math.round(el.getBoundingClientRect().right - width);
    if (by <= 1 || clipped(el) || wide.some((w) => w.el.contains(el))) continue;
    wide.push({ el, by });
  }
  const label = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : '');
  return { width, parts, wide: wide.map(({ el, by }) => (el.closest('section[id]')?.id ?? 'review') + ': <' + label(el) + '> ' + by + ' px past the edge') };
})()`;

export async function cmdShot(repo: string | null, o: ShotOpts, [only]: string[]) {
  if (o.theme && o.theme !== 'light' && o.theme !== 'dark') fail('--theme: light or dark', 2);
  if (only?.includes('/')) return shotSlide(repo, o, only); // section ids have no '/'
  const dir = dirForEdit(repo, o.dir);
  if (!fs.existsSync(path.join(dir, 'review.html'))) fail(`no review.html in ${dir}`);
  const theme = o.theme ?? 'light';
  const tmp = path.join(os.tmpdir(), 'reviewroom-shots', `${path.basename(dir)}-${theme}${o.mobile ? '-mobile' : ''}`);
  const out = path.resolve(o.out ?? tmp);
  if (!o.out) fs.rmSync(tmp, { recursive: true, force: true }); // last run's pictures would read as this one's
  fs.mkdirSync(out, { recursive: true });
  await withServer(repo, dir, (url) =>
    withPage(url, LAPTOP, async (page) => {
      await page.evaluate(`(rr.app.prefs = { ...rr.app.prefs, theme: '${theme}' }, rr.app.applyTheme())`); // this page only: not saved
      const plan = await page.evaluate<Plan>(PLAN(only, MAX, o.mobile ? PHONE : undefined));
      if (plan.error) fail(plan.error);
      for (const [i, p] of plan.parts!.entries()) {
        await page.resize(plan.width!, p.height);
        await page.evaluate(`new Promise((ok) => { document.querySelector('.rr-narrative-scroll:not(.rr-description)').style.top = '${-p.top}px'; requestAnimationFrame(() => requestAnimationFrame(ok)); })`);
        const file = path.join(out, `${String(i + 1).padStart(2, '0')}-${p.name}.png`);
        await Bun.write(file, await page.screenshot());
        console.log(`${file}  (${plan.width}x${p.height})`);
      }
      if (plan.wide!.length) console.log(`\nwider than the panel (cut off, or the page scrolls sideways):\n  ${plan.wide!.join('\n  ')}`);
      const errors = page.errors();
      if (errors.length) console.log(`\npage errors (the reviewer sees the same):\n  ${errors.join('\n  ')}`);
    }),
  );
}
