import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPage } from '../cli/lib/render.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { until } from '../src/testing/wait.ts';
import { read, setup } from './fixture.ts';

const { cli, dir, d, tmp, state } = setup();
const demo = path.join(import.meta.dir, '..', 'examples', 'uploads');
const copyReport = () => fs.copyFileSync(path.join(demo, REPORT_FILE), path.join(dir, REPORT_FILE));
const playing = '.rr-tour[data-mode="playing"]';
const filePath = `${playing} .rr-tour__layer:not(.is-leaving) .rr-file__path`;
const withoutRequests = (urls: string[]) => urls.every((url) => /^(?:file:|data:|about:)/.test(url));

test('the exported demo plays from disk with bundled code and zero network requests', async () => {
  copyReport();
  const tour = JSON.parse(read(demo, WALKTHROUGH_FILE));
  tour.chapters[0].steps[0].text += '<p><a href="https://example.com">External</a> · <a href="rr:tour/bucket/s2">Plan</a></p><img src="https://example.com/hidden.png"><rr-code lang="toml">key = 1</rr-code>';
  tour.chapters[1].steps[1].ref = ['rr:code/config/limits.json#L1-5', 'rr:code/internal/limit/limiter.go'];
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify(tour));
  expect((await cli(['comment', ...d, 'rr:tour/why/s1', 'Private slide comment'])).code).toBe(0);
  expect((await cli(['comment', ...d, 'rr:code/internal/upload/handler.go@base#L12', 'Private code comment'])).code).toBe(0);
  const before = state();
  const output = path.join(tmp, 'demo.html');
  const r = await cli(['export', ...d, '--out', output]);
  expect(r).toEqual({ code: 0, stdout: output + '\n', stderr: '' });
  expect(state()).toEqual(before);
  expect(fs.statSync(output).size).toBeLessThan(5_200_000);
  expect(read(tmp, 'demo.html')).not.toContain('Private slide comment');

  const requests: string[] = [];
  let sawChrome = false;
  const onRequest = (url: string) => requests.push(url);
  const url = pathToFileURL(output).href;
  const opts = { readySelector: playing, onRequest, animations: false };
  await withPage(url, { width: 1280, height: 800 }, async (page) => {
    const evalAt = (selector: string, property: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.${property}`);
    const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const press = (key: string) => page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, bubbles: true}))`);
    const code = `${playing} .rr-tour__layer:not(.is-leaving) diffs-container`;
    const active = '.rr-tour__tick.is-on';
    await until(() => evalAt(filePath, 'textContent'));
    expect(await evalAt(filePath, 'textContent')).toContain('handler.go');
    expect(await evalAt(active, 'dataset.step')).toBe('s1');
    if (page.engine === 'chrome') {
      sawChrome = true;
      expect(await page.evaluate('document.documentElement.dataset.rrTheme')).toBe('light');
    }
    await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(code)})?.shadowRoot?.querySelector('[data-line] span[style]')`));
    expect(await page.evaluate(`[...document.querySelectorAll('rr-code diffs-container')].some((el) => el.shadowRoot?.textContent.includes('key = 1'))`)).toBe(true);
    expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(code)}).shadowRoot.querySelector('[data-gutter-utility], [data-line-annotation]')`)).toBe(false);
    expect(await page.evaluate(`document.querySelectorAll('.rr-tour__comment, .rr-tour__badge, [title^="Show comment threads"], .rr-viewed, rr-review, [title="Close the walkthrough"]').length`)).toBe(0);
    expect(await page.evaluate(`[...document.querySelectorAll('a[href], img[src]')].every((el) => (el.getAttribute('href') ?? '').startsWith('rr:'))`)).toBe(true);

    const renderedCode = (kind: string) =>
      page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(code)})?.shadowRoot?.querySelector(${JSON.stringify(kind)})`);
    await until(() => renderedCode('[data-selected-line]'));
    await click('.rr-tour__right button[title="Whole file before the change"]');
    await until(() => renderedCode('[data-file]'));
    await click('.rr-tour__right button[title="Whole file after the change"]');
    await until(() => renderedCode('[data-file]'));
    await click('.rr-tour__right button[title="Diff of this file"]');
    await press('ArrowRight');
    await until(async () => (await evalAt(filePath, 'textContent'))?.includes('account.go'));
    expect(await evalAt(active, 'dataset.step')).toBe('s2');
    await until(() => evalAt('.rr-tour__lead .pele-node.is-focus .pele-label', 'textContent'));
    expect(await evalAt('.rr-tour__lead .pele-node.is-focus .pele-label', 'textContent')).toBe('Account');
    await page.evaluate("document.querySelector('.rr-tour__lead a[href*=handler]').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))");
    await until(async () => (await evalAt(filePath, 'textContent'))?.includes('handler.go'));
    expect(await page.evaluate('location.hash')).toBe('#why/s2');
    await press('Escape');
    expect(await evalAt(playing, 'dataset.mode')).toBe('playing');
    await press('ArrowLeft');
    await until(async () => (await evalAt(active, 'dataset.step')) === 's1');
    await click('.rr-tour__step a[href="rr:tour/bucket/s2"]');
    await until(async () => (await evalAt(filePath, 'textContent'))?.includes('limits.json'));
    expect(await evalAt(active, 'dataset.chapter')).toBe('bucket');
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(filePath)}).length`)).toBe(2);
    expect(await page.evaluate("performance.getEntriesByType('resource').filter((e) => /^https?:/.test(e.name)).length")).toBe(0);
    expect(page.errors()).toEqual([]);
  }, 1, { ...opts, colorScheme: 'light' });

  await withPage(url + '#risks/s2', { width: 670, height: 820 }, async (page) => {
    expect(await page.evaluate('document.querySelector(".rr-tour__tick.is-on").dataset.step')).toBe('s2');
    expect(await page.evaluate('document.querySelector(".rr-tour__tick.is-on").dataset.chapter')).toBe('risks');
    expect(await page.evaluate('!!document.querySelector(".rr-tour__next[hidden]")')).toBe(true);
    expect(await page.evaluate('document.querySelector(".rr-tour__left").getBoundingClientRect().bottom <= document.querySelector(".rr-tour__right").getBoundingClientRect().top')).toBe(true);
    if (page.engine === 'chrome') expect(await page.evaluate('document.documentElement.dataset.rrTheme')).toBe('dark');
    expect(page.errors()).toEqual([]);
  }, 1, { ...opts, colorScheme: 'dark' });
  if (sawChrome) expect(requests).toContain(url);
  expect(withoutRequests(requests)).toBe(true);
});

test('export refuses stale links unless explicitly allowed', async () => {
  copyReport();
  const tour = JSON.parse(read(demo, WALKTHROUGH_FILE));
  tour.chapters[0].steps[0].ref = 'rr:file/gone.go@head';
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify(tour));
  const output = path.join(tmp, 'stale.html');
  const args = ['export', '--out', output, ...d];
  const stale = await cli(args);
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain('export anyway with --allow-stale');
  expect(fs.existsSync(output)).toBe(false);
  expect((await cli([...args, '--allow-stale'])).code).toBe(0);
  expect(fs.existsSync(output)).toBe(true);
});
