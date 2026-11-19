// Generation and the assistant in a real page: the golden path (Generate, the loading screen live, dismissed mid-turn,
// the panel live, a follow-up answered; and a reload mid-turn), with a scripted assistant (e2e/fake-assistant.ts). The
// machines' and the store's unit tests cover the narrow cases.
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPage, type Page } from '../cli/lib/render.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
const VP = { width: 1280, height: 800 };

// in the page: wait for a condition (a JS expression), or fail with what it was
const until = (page: Page, cond: string, ms = 5000) =>
  page.evaluate<boolean>(`new Promise((done, fail) => { const t0 = Date.now(); const look = () => { try { if (${cond}) return done(true); } catch {} if (Date.now() - t0 > ${ms}) return fail(new Error(${JSON.stringify(cond)})); setTimeout(look, 50); }; look(); })`);
// booted, and past the first visit's service-worker reload
async function open(url: string) {
  const page = await openPage(url, VP);
  await until(page, `window.rr?.app?.generation && navigator.serviceWorker.controller`, 15_000);
  await until(page, `window.rr?.app?.generation`);
  return page;
}

describe('the trust boundary in the page', () => {
  const { serve, dir } = setup();
  fs.copyFileSync(path.join(import.meta.dir, `../examples/uploads/${WALKTHROUGH_FILE}`), path.join(dir, WALKTHROUGH_FILE));
  // a report that claims what only the server may say: Generate and the assistant
  const report = fs.readFileSync(path.join(import.meta.dir, `../examples/uploads/${REPORT_FILE}`), 'utf8')
    .replace('{"title":"Limit file uploads per account"}', '{"title":"Limit file uploads per account","generate":true,"assistant":true}');
  fs.writeFileSync(path.join(dir, REPORT_FILE), report);

  test.skipIf(!browser)('the report\'s #rr-meta turns on neither Generate nor the assistant', async () => {
    const page = await open(await serve());
    try {
      expect(await page.evaluate<string>(`JSON.stringify([rr.app.meta.title, rr.app.meta.generate ?? null, rr.app.meta.assistant ?? null, !!document.querySelector('.rr-gen-btn')])`))
        .toBe(JSON.stringify(['Limit file uploads per account', null, null, false]));
    } finally {
      await page.close();
    }
  }, 60_000);
});

/** A review whose assistant is scripted (e2e/fake-assistant.ts): a generation turn waits on the test's gates `go-1`
 *  (the walkthrough) and `go-2` (the report). The stand-in claude only passes generate's checks. */
function scripted() {
  const gates = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-gates-'));
  afterAll(() => fs.rmSync(gates, { recursive: true, force: true }));
  const claude = path.join(gates, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const { serve } = setup({ env: { CLAUDE_CODE_EXECUTABLE: claude, REVIEWROOM_TEST_ASSISTANT: path.join(import.meta.dir, 'fake-assistant.ts'), REVIEWROOM_TEST_GATES: gates }, assistant: true });
  return { serve, go: (n: 1 | 2) => fs.writeFileSync(path.join(gates, `go-${n}`), '') };
}
const live = `(document.querySelector('.rr-gen__live')?.textContent ?? '')`;
const panel = `(document.querySelector('.rr-assistant__island')?.textContent ?? '')`;
const box = `document.querySelector('.rr-assistant__island textarea')`;
const closePlayer = `document.querySelector('.rr-tour__top [aria-label="Close the walkthrough"], .rr-tour__top [title="Close the walkthrough"]')?.click()`;
/** Lets the walkthrough pass (`go(1)`): it plays, with no reload (the page takes it as data), and one Close leaves it
 *  closed; then the panel. */
async function pastPlayer(page: Page, go: () => void) {
  await page.evaluate(`window.rrBeforeReload = true`);
  go();
  await until(page, `rr.app.generation?.context.progress.walkthrough.state === 'validated' && document.querySelector('.rr-tour')?.dataset.mode === 'playing'`, 15_000);
  expect(await page.evaluate<boolean>(`!!window.rrBeforeReload`)).toBe(true);
  await page.evaluate(closePlayer);
  await until(page, `document.querySelector('.rr-tour').dataset.mode === 'closed' && !location.search.includes('walkthrough')`);
  await until(page, `rr.app && (${panel}.includes('The walkthrough passes.') || (rr.app.commands.run('assistant.open'), false))`);
  expect(await page.evaluate<string>(`document.querySelector('.rr-tour').dataset.mode`)).toBe('closed'); // nothing reopened it
  // the walkthrough passed, the report not yet: its panel says so
  await until(page, `[...document.querySelectorAll('.rr-narrative > .rr-empty')].some((e) => !e.hidden && e.textContent.includes('The report is being written'))`);
}
/** Lets the turn end (`go(2)`), then the same conversation answers a question. The report comes in place, with no
 *  reload: the player closed before stays closed and one send is answered. */
async function followUp(page: Page, go: () => void) {
  await page.evaluate(`window.rrOldReport = rr.app.doc.firstChild`);
  go();
  await until(page, `${panel}.includes('Both pass.') && !document.querySelector('[data-rr-assistant-running]') && !rr.app.doc.contains(window.rrOldReport) && !document.querySelector('.rr-narrative-scroll').hidden`, 20_000);
  expect(await page.evaluate<boolean>(`!!window.rrBeforeReload`)).toBe(true);
  expect(await page.evaluate<boolean>(`document.querySelector('.rr-tour')?.dataset.mode !== 'playing'`)).toBe(true);
  // the header and the tab take the new report's #rr-meta and <title>, as a reload would
  expect(await page.evaluate<string>(`document.querySelector('.rr-header__title').textContent + ' | ' + document.title`)).toBe('Limit file uploads per account | Limit file uploads per account');
  await page.evaluate(`${box}.focus(), document.execCommand('insertText', false, 'what changed?')`);
  await page.evaluate(`[...document.querySelectorAll('.rr-assistant__island button')].find((b) => b.textContent === 'Send' && !b.disabled).click()`);
  await until(page, `${panel}.includes('You asked: what changed?') && ${panel}.includes('Reading the diff.')`, 15_000);
}

describe('the golden path: Generate, the loading screen, the walkthrough plays, a follow-up', () => {
  const { serve, go } = scripted();
  test.skipIf(!browser)('a page reloaded mid-turn follows it again; dismissed it runs on; then a question', async () => {
    const url = await serve();
    let page = await open(url);
    try {
      await page.evaluate(`rr.app.commands.run('generation.generate')`);
      await until(page, `${live}.includes('Reading the diff.')`, 15_000);
      await page.close();
      page = await open(url);
      await until(page, `!document.querySelector('.rr-gen').hidden && ${live}.includes('Reading the diff.')`, 15_000);
      await until(page, `[...document.querySelectorAll('.rr-gen__live button')].some((b) => b.textContent === 'Stop' && !b.disabled)`);
      await page.evaluate(`[...document.querySelectorAll('.rr-gen button')].find((b) => b.textContent === 'Open full').click()`);
      await until(page, `[...document.querySelectorAll('.rr-assistant__island button')].some((b) => b.textContent === 'Stop' && !b.disabled)`);
      await page.evaluate(`rr.app.dock.getPanel('assistant').api.close()`);
      await until(page, `document.querySelector('.rr-gen').hidden`);
      await pastPlayer(page, () => go(1));
      await followUp(page, () => go(2));
      // a draft typed in the panel survives the conversation being taken again (the server's event)
      await page.evaluate(`${box}.focus(), document.execCommand('insertText', false, 'half a thought')`);
      await page.evaluate(`rr.app.bus.emit('assistant-turn', undefined)`);
      await Bun.sleep(300);
      expect(await page.evaluate<string>(`${box}.value`)).toBe('half a thought');
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
