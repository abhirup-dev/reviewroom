// Each presentation boots: the dock on a computer, the phone shell under ?phone. The guard for Refactor 3.0 (rr-486),
// which moves the phone behind a contract: before/after looks are checked with scripts/snapshot.ts.
import { describe, expect, test } from 'bun:test';
import { openPage } from '../cli/lib/render.ts';
import { setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));

const FACTS = `JSON.stringify({
  kind: rr.app.presentation.kind,
  phone: document.documentElement.classList.contains('is-phone') || !!document.querySelector('.is-phone'),
  phoneBar: !!document.querySelector('.rr-phonebar'),
  dock: !!document.querySelector('.dv-dockview'),
})`;

describe('presentations boot', () => {
  const { serve } = setup();

  test.skipIf(!browser)('a computer gets the dock, ?phone the phone shell', async () => {
    const url = await serve();
    for (const [query, vp, want] of [
      ['', { width: 1280, height: 800 }, { kind: 'dock', phone: false, phoneBar: false, dock: true }],
      ['?phone', { width: 390, height: 844 }, { kind: 'phone', phone: true, phoneBar: true, dock: false }],
    ] as const) {
      const page = await openPage(url + query, vp);
      try {
        expect(JSON.parse(await page.evaluate<string>(FACTS))).toEqual(want);
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
