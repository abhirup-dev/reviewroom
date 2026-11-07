// Each presentation boots: the dock on a computer, the phone shell under ?phone. The guard for Refactor 3.0 (rr-486),
// which moves the phone behind a contract: before/after looks are checked with scripts/snapshot.ts.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from '../cli/lib/render.ts';
import { setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));

const FACTS = `JSON.stringify({
  kind: rr.app.presentation.kind,
  phone: document.documentElement.classList.contains('is-phone') || !!document.querySelector('.is-phone'),
  phoneBar: !!document.querySelector('.rr-phonebar'),
  dock: !!document.querySelector('.dv-dockview'),
})`;
// the guided walkthrough's player form, once it has opened: main.ts hands the phone's in by presentation.phonePlayer
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

describe('presentations boot', () => {
  const { serve, dir } = setup();
  fs.copyFileSync(path.join(import.meta.dir, '../examples/habit-events/walkthrough.json'), path.join(dir, 'walkthrough.json'));

  test.skipIf(!browser)('a computer gets the dock and its player, ?phone the phone shell and the phone player', async () => {
    const url = await serve();
    for (const [query, vp, want, player] of [
      ['', { width: 1280, height: 800 }, { kind: 'dock', phone: false, phoneBar: false, dock: true }, 'desktop'],
      ['?phone', { width: 390, height: 844 }, { kind: 'phone', phone: true, phoneBar: true, dock: false }, 'phone'],
    ] as const) {
      const page = await openPage(url + query, vp);
      try {
        expect(JSON.parse(await page.evaluate<string>(FACTS))).toEqual(want);
        expect(await page.evaluate<string>(PLAYER)).toBe(player);
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
