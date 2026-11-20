// Each presentation boots: the dock on a computer, the phone shell under ?phone. The guard for Refactor 3.0 (rr-486),
// which moves the phone behind a contract: before/after looks are checked with scripts/snapshot.ts.
import { describe, expect, test } from 'bun:test';
import { openPage } from '../cli/lib/render.ts';
import { until } from '../src/testing/wait.ts';
import { slideCases, writeSlideCase } from '../testing/slides/cases.ts';
import { setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));

const FACTS = `JSON.stringify({
  kind: rr.app.presentation.kind,
  phone: document.documentElement.classList.contains('is-phone') || !!document.querySelector('.is-phone'),
  phoneBar: !!document.querySelector('.rr-phonebar'),
  dock: !!document.querySelector('.dv-dockview'),
  // each presentation is a lazy chunk (src/main.ts): the desktop never fetches the phone's, the phone never the desktop's (dockview)
  phoneChunk: performance.getEntriesByType('resource').some((r) => r.name.includes('/chunks/phone-')),
  deskChunk: performance.getEntriesByType('resource').some((r) => r.name.includes('/chunks/presentation-')),
})`;
// the guided walkthrough's player form, once it has opened: the presentation module's player (src/phone.ts)
const PLAYER = `new Promise((done) => {
  rr.app.commands.run('walkthrough.play');
  const t0 = Date.now();
  const look = () => {
    const player = document.querySelector('.rr-tour__player');
    if (player || Date.now() - t0 > 5000) return done(player ? (player.closest('[data-form]')?.dataset.form ?? 'desktop') : 'none');
    setTimeout(look, 50);
  };
  look();
})`;

const WORKER = `navigator.serviceWorker.getRegistration().then((r) => r ? (r.installing ?? r.waiting ?? r.active)?.scriptURL : 'none')`;

describe('presentations boot', () => {
  const { serve, dir } = setup();
  const tour = structuredClone(slideCases.demo.tour);
  tour.chapters[0].steps[0].text += '<p><a href="rr:code/internal/upload/handler.go@base#L7">Imports</a></p>';
  writeSlideCase(dir, { ...slideCases.demo, tour });

  test.skipIf(!browser)('a computer gets the dock and its player, ?phone the phone shell and the phone player', async () => {
    const url = await serve();
    for (const [query, vp, want, player] of [
      ['', { width: 1280, height: 800 }, { kind: 'dock', phone: false, phoneBar: false, dock: true, phoneChunk: false, deskChunk: true }, 'desktop'],
      ['?phone', { width: 390, height: 844 }, { kind: 'phone', phone: true, phoneBar: true, dock: false, phoneChunk: true, deskChunk: false }, 'phone'],
    ] as const) {
      const page = await openPage(url + query, vp, 1, { animations: false });
      try {
        expect(JSON.parse(await page.evaluate<string>(FACTS))).toEqual(want);
        expect(await page.evaluate<string>(PLAYER)).toBe(player);
        // the worker sits beside the entry, whichever chunk the update code ended up in
        expect(await page.evaluate<string>(WORKER)).toBe(new URL('sw.js', url).href);
        const selected = () => page.evaluate<string[]>(`Array.from(
          document.querySelector('.rr-tour__layer:not(.is-leaving) diffs-container')?.shadowRoot?.querySelectorAll('[data-selected-line]') ?? [],
          (line) => line.getAttribute('data-line')
        )`);
        const original = await until(async () => {
          const lines = await selected();
          return lines.length ? lines : undefined;
        });
        expect(original).not.toContain('7');
        await page.evaluate(`document.querySelector('.rr-tour__text a[href$="#L7"]').click()`);
        await until(async () => (await selected()).includes('7'));
        const reset = player === 'phone' ? '.rr-tour__files .rr-tour__reset' : '.rr-tour__top > .rr-tour__reset';
        await page.evaluate(`document.querySelector('${reset}').click()`);
        await until(async () => JSON.stringify(await selected()) === JSON.stringify(original));
        expect(await page.evaluate('new URLSearchParams(location.search).get("walkthrough")')).toBe('why/s1');
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
