import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from '../cli/lib/render.ts';
import { read, setup } from './fixture.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));

describe('walkthrough gutters in the built client', () => {
  const { dir, serve } = setup();
  const authored = `<section id="overview"><h2>Overview</h2>
    <p id="detail">A paragraph with an existing discussion.</p>
    <p id="free">An unmarked block with <a href="https://example.com">a normal link</a>.</p>
    <button id="author-action">Authored action</button>
    <figure id="pipeline"><svg width="160" height="60"><rect width="160" height="60" /></svg></figure>
  </section>`;
  const template = read(import.meta.dir, '..', 'templates', 'review.html');
  fs.writeFileSync(path.join(dir, 'review.html'), template.replace(/\n  <rr-review>[\s\S]*?<\/rr-review>/, `\n  <rr-review>${authored}</rr-review>`));

  test.skipIf(!browser)('shared gutters preserve anchors, native interactions, and dismissal across widths and themes', async () => {
    const page = await openPage(await serve(), { width: 1280, height: 800 });
    try {
      await page.evaluate(`(async () => {
        rr.layout('narrative-focus');
        rr.app.services.threads.createThread({ kind:'doc', target:'detail', quote:{exact:'existing discussion'} }, 'Existing discussion');
        rr.app.showPanel('code');
        await new Promise(requestAnimationFrame);
        rr.app.showPanel('narrative');
      })()`);
      for (const width of [1280, 1024]) {
        await page.resize(width, 800);
        for (const theme of ['light', 'dark']) {
          const result = await page.evaluate<string>(`(async () => {
            document.documentElement.dataset.rrTheme = ${JSON.stringify(theme)};
            rr.layout('narrative-focus');
            rr.app.surface.float('narrative');
            await new Promise(requestAnimationFrame);
            rr.app.surface.putBack('narrative');
            await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
            const doc = rr.app.doc;
            const wrap = doc.closest('.rr-doc-wrap');
            const heading = doc.querySelector('h2');
            const free = doc.querySelector('#free');
            const handle = wrap.querySelector('.rr-block-handle');
            const outline = wrap.querySelector('.rr-block-outline');
            const scroller = wrap.closest('.rr-narrative-scroll');
            const dr = doc.getBoundingClientRect();
            const hr = heading.getBoundingClientRect();
            const fr = free.getBoundingClientRect();
            const move = (el, x, y) => el.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientX:x, clientY:y, pointerType:'mouse' }));
            const settle = () => new Promise(ok => setTimeout(ok, 0));
            const action = label => [...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.trim() === label);
            const context = el => {
              const r = el.getBoundingClientRect();
              const event = new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left + 10, clientY:r.top + 10 });
              el.dispatchEvent(event);
              return event.defaultPrevented;
            };
            const escape = async () => { document.querySelector('.rr-menu')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, cancelable:true, key:'Escape' })); await new Promise(ok => setTimeout(ok, 0)); };
            const result = {};
            // Floating/docking schedules the panel's 60ms resize cleanup; let it finish before hover intent.
            await new Promise(ok => setTimeout(ok, 100));
            result.passiveQuote = [...CSS.highlights.get('rr-thread')].some(saved => {
              const range = document.createRange();
              range.setStart(saved.startContainer, saved.startOffset);
              range.setEnd(saved.endContainer, saved.endOffset);
              return range.toString() === 'existing discussion';
            });
            move(heading, hr.left + 20, hr.top + 10);
            result.quiet = handle.hidden && outline.hidden;
            await new Promise(ok => setTimeout(ok, 550));
            result.dwell = !handle.hidden && outline.hidden;
            scroller.dispatchEvent(new Event('scroll'));
            move(wrap, dr.left - 10, hr.top + 10);
            result.left = !handle.hidden && handle.getBoundingClientRect().right <= dr.left;
            handle.click();
            result.gutterActions = [...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim());
            result.bracketOnly = getComputedStyle(outline).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(outline).boxShadow === 'none';
            move(wrap, dr.right + 10, fr.top + 10);
            action('Pin to Contents').click();
            result.frozenSectionPin = rr.app.state.pins.includes('rr:doc/overview') && !rr.app.state.pins.includes('rr:doc/free');
            await settle();
            move(wrap, dr.right + 10, hr.top + 10);
            handle.click();
            action('Unpin from Contents').click();
            result.sameAnchorFromRight = !rr.app.state.pins.includes('rr:doc/overview');
            await settle();
            move(wrap, dr.right + 10, fr.top + 10);
            result.right = !handle.hidden;
            handle.click();
            await escape();
            result.escapeFocus = !document.querySelector('.rr-menu') && document.activeElement === scroller;
            move(wrap, dr.right + 10, fr.top + 10);
            handle.click();
            scroller.dispatchEvent(new Event('scroll'));
            await settle();
            result.scrollDismisses = !document.querySelector('.rr-menu') && outline.hidden;
            const chip = wrap.querySelector('.rr-rail-chip');
            const cr = chip.getBoundingClientRect();
            move(wrap, dr.right + 10, cr.top + cr.height / 2);
            result.chipPriority = handle.hidden;
            const link = free.querySelector('a');
            const keyboard = new KeyboardEvent('keydown', { bubbles:true, cancelable:true, key:'ContextMenu' });
            link.dispatchEvent(keyboard);
            result.nativeLink = !context(link) && !keyboard.defaultPrevented;
            const range = document.createRange();
            range.selectNodeContents(free);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            result.nativeSelection = !context(free);
            getSelection().removeAllRanges();
            move(wrap, dr.left - 10, hr.top + 10);
            rr.app.bus.emit('picker', true);
            result.pickerActive = rr.app.root.classList.contains('is-picking') && document.querySelector('[aria-label="Pick element to comment"]').classList.contains('is-on');
            context(doc.querySelector('#pipeline rect'));
            result.pickerReleased = !rr.app.root.classList.contains('is-picking') && !wrap.classList.contains('is-picking') && !document.querySelector('[aria-label="Pick element to comment"]').classList.contains('is-on');
            result.contextActions = [...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim());
            result.singleRail = wrap.querySelectorAll('.rr-rail').length === 1;
            await escape();
            return JSON.stringify(result);
          })()`);
          expect(JSON.parse(result)).toEqual({
            quiet: true, dwell: true, left: true, right: true, chipPriority: true, singleRail: true, bracketOnly: true, passiveQuote: true,
            frozenSectionPin: true, sameAnchorFromRight: true, escapeFocus: true, scrollDismisses: true,
            nativeLink: true, nativeSelection: true, pickerActive: true, pickerReleased: true,
            gutterActions: ['Add comment', 'Copy block reference', 'Pin to Contents'],
            contextActions: ['Add comment', 'Copy block reference'],
          });
        }
      }
      const selectQuote = `(async () => {
        const p = rr.app.doc.querySelector('#free');
        const range = document.createRange();
        range.setStart(p.firstChild, 3);
        range.setEnd(p.firstChild, 17);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const r = range.getBoundingClientRect();
        p.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:r.right, clientY:r.bottom }));
        await new Promise(ok => setTimeout(ok, 0));
        const button = document.querySelector('button[aria-label="Comment on selected text"]');
        return JSON.stringify({ quote:rr.app.selection?.anchor?.quote?.exact,
          visible:!!button?.closest(':popover-open'), sharedMenu:!!button?.matches('.rr-menu__item'),
          duplicateTooltip:!!button?.matches('[title], [data-tip]'),
        });
      })()`;
      const selectionAction = await page.evaluate<string>(selectQuote);
      expect(JSON.parse(selectionAction)).toEqual({ quote: 'unmarked block', visible: true, sharedMenu: true, duplicateTooltip: false });
      expect(await page.evaluate(`(() => {
        rr.app.bus.emit('round-view', 0);
        return rr.app.selection === null && !document.querySelector('.rr-menu:popover-open');
      })()`)).toBe(true);
      await page.evaluate(selectQuote);
      // Open the real composer once, after layout checks, so its autofocus cannot interfere with later cases.
      const anchor = await page.evaluate<string>(`(() => {
        let anchor;
        const off = rr.on('compose-thread', event => { anchor = event.anchor; });
        const button = document.querySelector('button[aria-label="Comment on selected text"]');
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerType:'mouse' }));
        button.click();
        off();
        return JSON.stringify(anchor);
      })()`);
      expect(JSON.parse(anchor)).toEqual({ kind: 'doc', target: 'free', quote: {
        exact: 'unmarked block', prefix: 'An ', suffix: ' with a normal link.',
      } });
      expect(await page.evaluate(`!document.querySelector('.rr-menu:popover-open')`)).toBe(true);
      // Closing the existing thread machine clears selection; its keyboard compose route also dismisses the menu.
      const closeComposer = `new Promise(resolve => {
        const box = document.querySelector('dialog[open]');
        box.addEventListener('close', () => resolve(rr.app.selection === null), { once:true });
        box.close();
      })`;
      expect(await page.evaluate(closeComposer)).toBe(true);
      await page.evaluate(selectQuote);
      expect(await page.evaluate(`(() => {
        rr.commands.run('comment.selection');
        return !document.querySelector('.rr-menu:popover-open');
      })()`)).toBe(true);
      expect(await page.evaluate(closeComposer)).toBe(true);
      const picked = await page.evaluate<string>(`(() => {
        let anchor, clicks = 0;
        const button = rr.app.doc.querySelector('#author-action');
        button.onclick = () => clicks++;
        const off = rr.on('compose-thread', event => { anchor = event.anchor; });
        rr.app.bus.emit('picker', true);
        rr.layout('reading');
        rr.layout('narrative-focus');
        button.click();
        off();
        return JSON.stringify({ anchor, clicks, active:rr.app.root.classList.contains('is-picking') });
      })()`);
      expect(JSON.parse(picked)).toEqual({ anchor: { kind:'doc', target:'author-action' }, clicks:0, active:false });
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
