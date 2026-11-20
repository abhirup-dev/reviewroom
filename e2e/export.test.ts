import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPage } from '../cli/lib/render.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { until } from '../src/testing/wait.ts';
import { config, read, setup } from './fixture.ts';

const { cli, dir, d, home, tmp, state } = setup();
const demo = path.join(import.meta.dir, '..', 'examples', 'uploads');
const copyReport = () => fs.copyFileSync(path.join(demo, REPORT_FILE), path.join(dir, REPORT_FILE));
const stage = '.rr-export-stage';
const playing = '.rr-tour[data-mode="playing"]';
const filePath = `${playing} .rr-tour__layer:not(.is-leaving) .rr-file__path`;
const withoutRequests = (urls: string[]) => urls.every((url) => /^(?:file:|data:|about:)/.test(url));

test('the exported demo plays from disk with bundled code and zero network requests', async () => {
  copyReport();
  const tour = JSON.parse(read(demo, WALKTHROUGH_FILE));
  tour.chapters[0].steps[0].text += '<p><a href="https://example.com">External</a> · <a href="rr:tour/bucket/s2">Plan</a></p><img src="https://example.com/hidden.png"><rr-code lang="toml">key = 1</rr-code>';
  tour.chapters[1].steps[1].ref = ['rr:code/config/limits.json#L1-5', 'rr:code/internal/limit/limiter.go', 'rr:code/config/limits.json@base#L1'];
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
  const opts = { readySelector: `${stage}[data-page]`, onRequest, animations: false };
  await withPage(url, { width: 1280, height: 800 }, async (page) => {
    const evalAt = <T = string>(selector: string, property: string) => page.evaluate<T>(`document.querySelector(${JSON.stringify(selector)})?.${property}`);
    const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const press = (key: string) => page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, bubbles: true}))`);
    const code = `${playing} .rr-tour__layer:not(.is-leaving) diffs-container`;
    const active = '.rr-export-tick[aria-current]';
    const hash = () => page.evaluate('location.hash');
    expect(await hash()).toBe('#cover');
    expect(await evalAt('#rr-export-title', 'textContent')).toBe(tour.title);
    expect(await evalAt('.rr-export-position', 'textContent')).toBe('Cover');
    expect(await evalAt<boolean>('.rr-export-prev', 'disabled')).toBe(true);
    expect(await page.evaluate(`[...document.querySelectorAll('.rr-export-tools button:not([hidden]), .rr-export-footer > button')].every((button) =>
      button.getBoundingClientRect().right < document.querySelector('.rr-export-card').getBoundingClientRect().right
    )`)).toBe(true);
    await press('?');
    expect(await evalAt<boolean>('.rr-export-help', 'open')).toBe(true);
    await press('ArrowRight');
    expect(await hash()).toBe('#cover');
    await click('.rr-export-help button');
    expect(await evalAt<boolean>('.rr-export-help', 'open')).toBe(false);
    await press('ArrowRight');
    expect(await hash()).toBe('#why');
    expect(await evalAt('#rr-export-title', 'textContent')).toBe(tour.chapters[0].title);
    expect(await page.evaluate(`document.querySelectorAll('${active}').length`)).toBe(0);
    await press('ArrowLeft');
    expect(await hash()).toBe('#cover');
    await click('.rr-export-chapters button');
    expect(await hash()).toBe('#why');
    await click('.rr-export-footer button[title="Next page"]');
    expect(await hash()).toBe('#why/s1');
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
    await press('ArrowRight');
    expect(await hash()).toBe('#bucket');
    await press('ArrowLeft');
    expect(await hash()).toBe('#why/s2');
    await press('ArrowLeft');
    await until(async () => (await evalAt(active, 'dataset.step')) === 's1');
    await click('.rr-tour__step a[href="rr:tour/bucket/s2"]');
    await until(async () => (await evalAt(filePath, 'textContent'))?.includes('limits.json'));
    expect(await evalAt(active, 'dataset.chapter')).toBe('bucket');
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(filePath)}).length`)).toBe(3);
    const chips = await page.evaluate<string[]>("Array.from(document.querySelectorAll('.rr-tour__refs button'), (chip) => chip.textContent)");
    expect(chips).toEqual(['limits.json:1–5', 'limiter.go', 'limits.json:1 (before)', 'All 3']);
    expect(await page.evaluate("performance.getEntriesByType('resource').filter((e) => /^https?:/.test(e.name)).length")).toBe(0);
    expect(page.errors()).toEqual([]);
  }, 1, { ...opts, colorScheme: 'light' });

  await withPage(url + '#risks/s2', { width: 390, height: 844 }, async (page) => {
    expect(await page.evaluate('document.querySelector(".rr-export-tick[aria-current]").dataset.step')).toBe('s2');
    expect(await page.evaluate('document.querySelector(".rr-export-tick[aria-current]").dataset.chapter')).toBe('risks');
    expect(await page.evaluate('document.querySelector(".rr-tour__left").getBoundingClientRect().bottom <= document.querySelector(".rr-tour__right").getBoundingClientRect().top')).toBe(true);
    if (page.engine === 'chrome') expect(await page.evaluate('document.documentElement.dataset.rrTheme')).toBe('dark');
    expect(await page.evaluate('document.querySelector(".rr-export-prev").getBoundingClientRect().height')).toBeGreaterThanOrEqual(48);
    await page.evaluate(`document.querySelector('.rr-export-footer button[title="Next page"]').click()`);
    expect(await page.evaluate('location.hash')).toBe('#end');
    expect(await page.evaluate('document.querySelector(".rr-export-cue").textContent')).toMatch(/^Exported from reviewroom · [a-f0-9]{7} · /);
    await page.evaluate('document.querySelector(".rr-export-story button").click()');
    expect(await page.evaluate('location.hash')).toBe('#cover');
    await page.evaluate('location.hash = "#bucket"');
    await until(() => page.evaluate('document.querySelector(".rr-export-stage").dataset.page === "divider"'));
    expect(await page.evaluate('document.querySelector("#rr-export-title").textContent')).toBe(tour.chapters[1].title);
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

test('export includes the saved PR identity without contacting GitHub', async () => {
  const review = path.join(home, 'reviews', 'acme_uploads', 'pulls', '7');
  fs.mkdirSync(review, { recursive: true });
  fs.writeFileSync(path.join(review, 'config.json'), JSON.stringify({ ...config(dir), id: 'acme/uploads#7' }));
  for (const artifact of [REPORT_FILE, WALKTHROUGH_FILE]) fs.copyFileSync(path.join(demo, artifact), path.join(review, artifact));
  const output = path.join(tmp, 'pull.html');
  expect(await cli(['export', 'acme/uploads#7', '--out', output])).toEqual({ code: 0, stdout: output + '\n', stderr: '' });
  const bundle = /<script type="application\/json" id="rr-bundle">(.*?)<\/script>/s.exec(read(tmp, 'pull.html'))?.[1];
  expect(JSON.parse(bundle!).source).toMatchObject({ repo: 'acme/uploads', pr: 7 });
});
