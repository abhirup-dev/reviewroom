// Raster size must not alter layout; a prose shot is the same left pane with right-hand work omitted.
import { beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pngSize, withPage, withServer, type Page } from '../cli/lib/render.ts';
import { read, setup } from './fixture.ts';

const { dir, repo, tmp, d, cli } = setup();
const demo = path.join(import.meta.dir, '../examples/habit-events');
const file = path.join(dir, 'walkthrough.json');
const out = path.join(tmp, 'shot-modes');
beforeEach(() => {
  fs.copyFileSync(path.join(demo, 'walkthrough.json'), file);
  fs.copyFileSync(path.join(demo, 'review.html'), path.join(dir, 'review.html'));
});
const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
const shot = (args: string[]) => cli(['shot', ...args, '--out', out, ...d]);
const image = (stdout: string) => new Blob([fs.readFileSync(stdout.split('\n')[0])]);
const pane = (page: Page) => page.evaluate<{ x: number; y: number; width: number; height: number; viewport: [number, number] }>(`(() => {
  const r = document.querySelector('.rr-tour__left').getBoundingClientRect();
  return { x:r.x, y:r.y, width:r.width, height:r.height, viewport:[innerWidth,innerHeight] };
})()`);

async function pixelDifference(page: Page, a: Blob, b: Blob) {
  const sources = await Promise.all([a, b].map(async (blob) => `data:image/png;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`));
  return page.evaluate<number>(`(async () => {
    const images = await Promise.all(${JSON.stringify(sources)}.map((src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; })));
    if (images[0].width !== images[1].width || images[0].height !== images[1].height) return -1;
    const data = images.map((i) => { const c = document.createElement('canvas'); c.width=i.width; c.height=i.height; const ctx=c.getContext('2d'); ctx.drawImage(i,0,0); return ctx.getImageData(0,0,c.width,c.height).data; });
    let changed=0; for(let i=0;i<data[0].length;i++) if(data[0][i]!==data[1][i]) changed++;
    return changed;
  })()`);
}

test('prose-only requires a guided slide rather than silently changing a normal review shot', async () => {
  const r = await shot(['summary', '--prose-only']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('--prose-only requires a guided slide');
});

test.skipIf(!browser)('shot defaults to a 480-high raster and native opts out without changing the CSS viewport', async () => {
  const capped = await shot(['latency/s2', '--viewport', '1440x900']);
  const native = await shot(['latency/s2', '--viewport', '1440x900', '--native']);
  expect([capped.code, native.code]).toEqual([0, 0]);
  expect(await pngSize(image(capped.stdout))).toEqual({ width: 768, height: 480 });
  expect(await pngSize(image(native.stdout))).toEqual({ width: 1440, height: 900 });
  expect(capped.stdout).toContain('1440x900 CSS viewport');
  expect(native.stdout).toContain('-native.png');
  const prose = await shot(['latency/s2', '--viewport', '1440x900', '--prose-only']);
  expect(prose.code).toBe(0);
  const size = await pngSize(image(prose.stdout));
  expect(size.width).toBeLessThan(768);
  expect(size.height).toBeLessThan(480);
  expect(prose.stdout).toContain('code pane not audited');
}, 30_000);

test.skipIf(!browser)('prose-only preserves the full-slide pane bounds and pixels while skipping code reads and panels', async () => {
  await withServer(repo, dir, async (url) => {
    for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) for (const rasterHeight of [undefined, 480]) for (const theme of ['light', 'dark'] as const) {
      await withPage(url, vp, async (page) => {
        const full = await page.audit('latency', 's1', theme);
        const before = await pane(page);
        const crop = await page.screenshot('.rr-tour__left');
        await page.evaluate(`(() => {
          window.__shotReads=0;
          const code=rr.app.services.code, original=code.read;
          code.read=(...args)=>{window.__shotReads++;return original(...args)};
          return true;
        })()`);
        const prose = await page.audit('latency', 's1', theme, { proseOnly: true });
        expect(await pane(page)).toEqual(before);
        expect(prose.left).toEqual(full.left);
        expect(prose.chunks).toEqual([]);
        expect(await page.evaluate(`({reads:window.__shotReads,panels:document.querySelectorAll('.rr-tour__pane .rr-code-panel').length})`)).toEqual({ reads: 0, panels: 0 });
        const only = await page.screenshot('.rr-tour__left');
        expect(await pngSize(only)).toEqual(await pngSize(crop));
        expect(await pixelDifference(page, crop, only)).toBe(0);
        expect((await pane(page)).viewport).toEqual([vp.width, vp.height]);
      }, 1, { animations: false, rasterHeight });
    }
  });
}, 60_000);

test.skipIf(!browser)('a fresh prose-only capture lights diagram nodes and inherited targets without resolving code', async () => {
  const w = JSON.parse(read(file));
  w.chapters[3].steps[0].ref = 'rr:sym/DefinitelyMissingPaneSymbol';
  w.chapters[3].steps[1].ref = undefined;
  w.chapters[3].steps[1].focus = ['Tardis.Fetch', 'habit.RecentEvents'];
  fs.writeFileSync(file, JSON.stringify(w));
  await withServer(repo, dir, (url) => withPage(url, { width: 1440, height: 900 }, async (page) => {
    await page.evaluate(`(() => {
      rr.app.services.code.read=()=>{throw new Error('unexpected code read')};
      rr.app.searchSymbol=()=>{throw new Error('unexpected symbol resolution')};
      return true;
    })()`);
    const audit = await page.audit('latency', 's2', 'light', { proseOnly: true });
    expect(audit.settled).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('.rr-tour__lead .pele-node.is-focus').length`)).toBe(2);
    expect(await page.evaluate(`document.querySelector('.rr-tour__body').classList.contains('is-solo')`)).toBe(false);
    expect(page.errors()).toEqual([]);
  }, 1, { animations: false, rasterHeight: 480 }));
}, 30_000);

test.skipIf(!browser)('prose-only still waits for code that is embedded in the narration', async () => {
  fs.writeFileSync(file, JSON.stringify({ version: 1, title: 'Embedded code', chapters: [{ id: 'c', title: 'C', steps: [{ id: 's', ref: 'rr:sym/SkipThisPane', text: '<rr-code ref="rr:code/pkg/features/habit/fetcher.go#L1-48"></rr-code>' }] }] }));
  await withServer(repo, dir, (url) => withPage(url, { width: 1280, height: 800 }, async (page) => {
    await page.evaluate(`(() => {
      const code=rr.app.services.code, original=code.read;
      code.read=async(...args)=>{await new Promise(r=>setTimeout(r,300));return original(...args)};
      rr.app.searchSymbol=()=>{throw new Error('unexpected pane resolution')};
      return true;
    })()`);
    expect((await page.audit('c', 's', 'light', { proseOnly: true })).settled).toBe(true);
    expect(await page.evaluate(`!!document.querySelector('.rr-tour__left rr-code .rr-code__body')`)).toBe(true);
    expect(page.errors()).toEqual([]);
  }, 1, { animations: false, rasterHeight: 480 }));
}, 30_000);

test.skipIf(!browser)('slide-lint defaults to capped pixels and native preserves its layout findings', async () => {
  const capped = await cli(['slide-lint', '--slide', 'latency/s2', '--json', ...d]);
  const native = await cli(['slide-lint', '--slide', 'latency/s2', '--native', '--json', ...d]);
  expect([capped.code, native.code]).toEqual([0, 0]);
  const a = JSON.parse(capped.stdout), b = JSON.parse(native.stdout);
  expect(a.rasterHeight).toBe(480);
  expect(b.rasterHeight).toBe(null);
  expect(a.viewports).toEqual(['1280x800', '1440x900']);
  expect(a.findings).toEqual(b.findings);
}, 30_000);

test.skipIf(!browser)('normal review screenshots also cap each part while native keeps its layout size', async () => {
  const capped = await shot(['request-path']);
  const native = await shot(['request-path', '--native']);
  expect([capped.code, native.code]).toEqual([0, 0]);
  const files = (stdout: string) => stdout.split('\n').flatMap((line) => { const match = /^(.*\.png)  \(/.exec(line); return match ? [match[1]] : []; });
  const small = await Promise.all(files(capped.stdout).map((f) => pngSize(new Blob([fs.readFileSync(f)]))));
  const large = await Promise.all(files(native.stdout).map((f) => pngSize(new Blob([fs.readFileSync(f)]))));
  expect(small.length).toBeGreaterThan(0);
  expect(small.every((s) => s.height <= 480)).toBe(true);
  expect(large.some((s) => s.height > 480)).toBe(true);
}, 30_000);
