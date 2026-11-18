// Generation's wiring in a real page (src/review/generation.ts): what the machine's unit tests can't see. Progress is
// fed through the page's own bus (the `progress` event ServerState emits), so no assistant runs: the fixture is --no-agent.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPage, type Page } from '../cli/lib/render.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
const VP = { width: 1280, height: 800 };
const hash = 'a'.repeat(64);
const doc = (state: string, request: string, extra: object = {}) => ({ state, by: 'assistant', request, ...extra });
const WRITING = (slides: number) => ({ walkthrough: doc('writing', 'w1', { slides, chapters: 1, hash }), report: doc('requested', 'r1') });
const DONE = { walkthrough: doc('validated', 'w1', { hash }), report: doc('validated', 'r1', { hash }) };

// in the page: wait for a condition (a JS expression), or fail with what it was
const until = (page: Page, cond: string, ms = 5000) =>
  page.evaluate<boolean>(`new Promise((done, fail) => { const t0 = Date.now(); const look = () => { try { if (${cond}) return done(true); } catch {} if (Date.now() - t0 > ${ms}) return fail(new Error(${JSON.stringify(cond)})); setTimeout(look, 50); }; look(); })`);
const feed = (page: Page, progress: object) => page.evaluate(`void rr.app.bus.emit('progress', ${JSON.stringify(progress)})`);
// booted, and past the first visit's service-worker reload
async function open(url: string) {
  const page = await openPage(url, VP);
  await until(page, `window.rr?.app?.generation && navigator.serviceWorker.controller`, 15_000);
  await until(page, `window.rr?.app?.generation`);
  return page;
}

describe('generation in the page', () => {
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

  test.skipIf(!browser)('a progress update keeps the focused control; closing puts focus on a live control, not the body', async () => {
    const page = await open(await serve());
    try {
      await feed(page, WRITING(1));
      await until(page, `!document.querySelector('.rr-gen').hidden`);
      await page.evaluate(`[...document.querySelectorAll('.rr-gen button')].find((b) => b.textContent === 'Continue to the review').focus()`);
      await feed(page, WRITING(2));
      await until(page, `document.querySelector('.rr-gen__status').textContent.startsWith('2 slides')`);
      expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe('Continue to the review');
      await page.evaluate(`document.activeElement.click()`);
      await until(page, `document.querySelector('.rr-gen').hidden`);
      const at = await page.evaluate<string>(`JSON.stringify([document.activeElement === document.body, !!document.activeElement.closest('[inert]'), document.activeElement.isConnected])`);
      expect(at).toBe(JSON.stringify([false, false, true]));
      // the header indicator, updated in place: the same element across updates
      await page.evaluate(`window.__ind = document.querySelector('.rr-gen-ind')`);
      await feed(page, WRITING(3));
      expect(await page.evaluate<boolean>(`document.querySelector('.rr-gen-ind') === window.__ind && !!window.__ind`)).toBe(true);
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test.skipIf(!browser)('"Open the assistant" closes the screen first, so nothing is left inert', async () => {
    const page = await open(await serve());
    try {
      // the server runs no assistant here: a stand-in command (the player's own inert parts aren't the screen's)
      await page.evaluate(`rr.app.commands.register({ id: 'assistant.open', title: 'Open the assistant', group: 'Navigate', run: () => { window.__opened = ![...rr.app.root.children].some((e) => e.inert); } })`);
      await feed(page, { ...WRITING(1), generation: { running: true, awaitingApproval: true } });
      await until(page, `!document.querySelector('.rr-gen').hidden && !document.querySelector('.rr-gen__note').hidden`);
      await page.evaluate(`[...document.querySelectorAll('.rr-gen button')].find((b) => b.textContent === 'Open the assistant').click()`);
      expect(await page.evaluate<string>(`JSON.stringify([window.__opened, document.querySelector('.rr-gen').hidden, [...rr.app.root.children].filter((e) => e.inert).length])`)).toBe(JSON.stringify([true, true, 0]));
    } finally {
      await page.close();
    }
  }, 60_000);

  test.skipIf(!browser)('writing -> done in one snapshot plays once; a second show doesn\'t send the reader back to slide 1', async () => {
    const page = await open(await serve());
    try {
      await page.evaluate(`sessionStorage.clear()`);
      await feed(page, WRITING(1));
      await feed(page, DONE);
      await until(page, `document.querySelector('.rr-tour__player') && new URL(location.href).searchParams.get('walkthrough')?.includes('/')`);
      const first = await page.evaluate<string>(`new URL(location.href).searchParams.get('walkthrough')`);
      await page.evaluate(`document.querySelector('.rr-tour__next').click()`);
      await until(page, `new URL(location.href).searchParams.get('walkthrough') !== ${JSON.stringify(first)}`);
      const second = await page.evaluate<string>(`new URL(location.href).searchParams.get('walkthrough')`);
      // the same validation again, and another show (a deep link, "Show it anyway"): the reader stays where they are
      await feed(page, DONE);
      await page.evaluate(`rr.app.bus.emit('walkthrough-show', undefined)`);
      await new Promise((r) => setTimeout(r, 500));
      expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('walkthrough')`)).toBe(second);
      expect(JSON.parse(await page.evaluate<string>(`sessionStorage.getItem('reviewroom:generation:' + rr.app.meta.id)`))).toMatchObject({ waitedFor: 'w1', played: 'w1' });
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
  test.skipIf(!browser)('a report stopped after the walkthrough validated: no stop screen; the report panel says it, with Retry', async () => {
    const page = await open(await serve());
    try {
      await page.evaluate(`sessionStorage.clear()`);
      await feed(page, WRITING(1));
      await feed(page, { walkthrough: doc('validated', 'w1', { hash }), report: doc('stopped', 'r1', { reason: 'failed' }) });
      await until(page, `document.querySelector('.rr-gen').hidden && document.querySelector('.rr-gen-ind')`);
      const placeholder = `[...document.querySelectorAll('.rr-narrative > .rr-empty')].find((e) => !e.hidden)`;
      expect(await page.evaluate<string>(`${placeholder}?.textContent ?? ''`)).toContain('The report was not finished');
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('the assistant panel', () => {
  // never a real Claude: a stand-in that fails, should anything try to start one (nothing here asks a question)
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-claude-')), 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const { serve } = setup({ CLAUDE_CODE_EXECUTABLE: fake }, { assistant: true });
  const fetched = `performance.getEntriesByType('resource').filter((r) => r.name.endsWith('/api/assistant')).length`;
  const box = `document.querySelector('.rr-assistant__island textarea')`;

  test.skipIf(!browser)('a conversation changed elsewhere waits while the reviewer types, then shows with their draft kept', async () => {
    const page = await open(await serve());
    try {
      await page.evaluate(`rr.app.commands.run('assistant.open')`);
      await until(page, box, 15_000);
      await page.evaluate(`${box}.focus(), document.execCommand('insertText', false, 'my draft')`);
      await until(page, `${box}.value === 'my draft'`);
      const before = await page.evaluate<number>(fetched);
      await page.evaluate(`rr.app.bus.emit('assistant-turn', undefined)`);
      await new Promise((r) => setTimeout(r, 500));
      expect(await page.evaluate<number>(fetched)).toBe(before); // typing: it waits, never dropped
      await page.evaluate(`document.activeElement.blur()`);
      await until(page, `${fetched} > ${before} && ${box}?.value === 'my draft'`);
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
