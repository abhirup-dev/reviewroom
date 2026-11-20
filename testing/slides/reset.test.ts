import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { withPage, withServer } from '../../cli/lib/render.ts';
import { until } from '../../src/testing/wait.ts';
import type { Walkthrough } from '../../src/slides/model.shared';
import { browser, setupSlides } from './fixture.ts';

const { repo, dir, file } = setupSlides();

test.skipIf(!browser)('the workbench walkthrough resets the code on desktop and phone', async () => {
  const tour: Walkthrough = JSON.parse(readFileSync(file, 'utf8'));
  tour.chapters[0].steps[0].text += '<p><a href="rr:code/internal/upload/handler.go@base#L7">Imports</a></p>';
  writeFileSync(file, JSON.stringify(tour));
  const activeLayer = '.rr-tour__layer:not(.is-leaving)';
  const reset = '.rr-tour__reset';
  await withServer(repo, dir, async (url) => {
    for (const phone of [false, true]) {
      const search = phone ? '?phone&walkthrough=why/s1' : '?walkthrough=why/s1';
      const viewport = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      await withPage(url + search, viewport, async (page) => {
        const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        const resetHidden = () => page.evaluate<boolean>(`document.querySelector('${reset}').hidden`);
        const codeHas = (selector: string) => page.evaluate<boolean>(
          `!!document.querySelector('${activeLayer} diffs-container')?.shadowRoot?.querySelector(${JSON.stringify(selector)})`,
        );
        await until(() => codeHas('[data-diff-type] [data-selected-line]'));
        expect(await resetHidden()).toBe(true);
        await click(`${activeLayer} button[title="Whole file after the change"]`);
        await until(() => codeHas('[data-file]'));
        expect(await resetHidden()).toBe(false);
        expect(await page.evaluate(`document.querySelector('${reset}').getBoundingClientRect().width > 0`)).toBe(true);
        await click(reset);
        await until(() => codeHas('[data-diff-type] [data-selected-line]'));
        expect(await resetHidden()).toBe(true);
        const line7 = '[data-line="7"][data-selected-line]';
        expect(await codeHas(line7)).toBe(false);
        await click('.rr-tour__text a[href$="#L7"]');
        await until(() => codeHas(line7));
        expect(await resetHidden()).toBe(false);
        await click(reset);
        await until(async () => await codeHas('[data-selected-line]') && !(await codeHas(line7)));
        expect(await resetHidden()).toBe(true);
        expect(await page.evaluate('new URLSearchParams(location.search).get("walkthrough")')).toBe('why/s1');
        expect(page.errors()).toEqual([]);
      }, 1, { animations: false });
    }
  });
});
