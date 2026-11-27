import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPage } from '../cli/lib/render.ts';
import { until } from '../src/testing/wait.ts';
import { slideCases, writeSlideCase } from '../testing/slides/cases.ts';
import { browser } from '../testing/slides/fixture.ts';
import { read, setup } from './fixture.ts';

const { cli, dir, d, tmp, state, serve, spawn } = setup();

test.skipIf(!browser)('the export plays from disk with bundled code and no network requests or private review text', async () => {
  const tour = structuredClone(slideCases.demo.tour);
  tour.chapters[0].steps[0].text += '<p><a href="rr:tour/bucket/s2">Plan</a></p><img src="https://example.com/hidden.png">';
  const privateReport = 'Private report marker';
  const privateComment = 'Private slide comment';
  writeSlideCase(dir, { tour, html: slideCases.demo.html.replace('</rr-review>', `<p>${privateReport}</p></rr-review>`) });
  expect((await cli(['comment', ...d, 'rr:tour/why/s1', privateComment])).code).toBe(0);

  const before = state();
  const output = path.join(tmp, 'Custom walkthrough name.html');
  expect(await cli(['export', ...d, '--out', output])).toEqual({ code: 0, stdout: output + '\n', stderr: '' });
  expect(state()).toEqual(before);
  const html = read(output);
  expect(html).not.toContain(privateComment);
  expect(html).not.toContain(privateReport);

  const requests: string[] = [];
  const url = pathToFileURL(output).href;
  const stage = '.rr-export-stage';
  let engine = '';
  await withPage(url, { width: 1280, height: 800 }, async (page) => {
    engine = page.engine;
    const click = async (selector: string) =>
      expect(await page.evaluate(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        if (!target) return false;
        target.click();
        return true;
      })()`), selector).toBe(true);
    const hash = () => page.evaluate('location.hash');
    const next = () => click('.rr-export-footer button[title="Next page"]');
    expect(await hash()).toBe('#cover');
    await next();
    expect(await hash()).toBe('#why');
    expect(await page.evaluate(`document.querySelector('${stage}').dataset.page`)).toBe('divider');
    await next();
    expect(await hash()).toBe('#why/s1');
    const layer = '.rr-tour__layer:not(.is-leaving)';
    await until(() => page.evaluate(`!!document.querySelector('${layer} diffs-container')?.shadowRoot?.querySelector('[data-line] span[style]')`));
    expect(await page.evaluate(`document.querySelector('${layer} .rr-file__path').textContent`)).toContain('handler.go');

    await click('.rr-tour__step a[href="rr:tour/bucket/s2"]');
    expect(await hash()).toBe('#bucket/s2');
    await click('button[aria-label="Skip chapter intro"]');
    await next();
    expect(await hash()).toBe('#enforce/s1');
    await click('.rr-export-tick[data-chapter="risks"][data-step="s2"]');
    await next();
    expect(await hash()).toBe('#end');
    expect(await page.evaluate(`document.querySelector('${stage}').dataset.page`)).toBe('end');
    expect(page.errors()).toEqual([]);
  }, 1, { readySelector: `${stage}[data-page]`, animations: false, onRequest: (url) => requests.push(url) });
  if (engine !== 'chrome') return; // only Chrome reports requests (WebKit runs the walk-through above)
  expect(requests).toContain(url);
  expect(requests.filter((url) => !/^(?:file:|data:|about:|blob:file:)/.test(url))).toEqual([]);
});

test('the route and CLI export identical attachments, with CLI opt-in for stale links', async () => {
  const tour = structuredClone(slideCases.demo.tour);
  tour.chapters[0].steps[0].ref = 'rr:file/gone.go@head';
  writeSlideCase(dir, { ...slideCases.demo, tour });

  const filename = 'repo-feat-upload-rate-limit-limit-file-uploads-per-account.html';
  const output = path.join(fs.realpathSync(tmp), filename);
  const args = ['export', ...d];
  const filesBefore = fs.readdirSync(tmp).sort();
  const stale = spawn(args, tmp);
  expect(await new Response(stale.stdout).text()).toContain('export anyway with --allow-stale');
  expect(await stale.exited).toBe(1);
  expect(fs.readdirSync(tmp).sort()).toEqual(filesBefore);

  const command = spawn([...args, '--allow-stale'], tmp);
  expect(await new Response(command.stdout).text()).toBe(output + '\n');
  expect(await command.exited).toBe(0);

  const response = await fetch((await serve()) + 'api/export');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toStartWith('text/html');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const withoutTimestamp = (html: string) => html.replace(/"exportedAt":"[^"]+"/, '"exportedAt":"timestamp"');
  expect(withoutTimestamp(await response.text())).toBe(withoutTimestamp(read(output)));
});
