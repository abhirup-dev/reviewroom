// The dedicated adversarial walkthrough complements the clean teaching demo.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { withPage, withServer } from '../../cli/lib/render.ts';
import { judge, type Measured } from '../../cli/lib/slide-lint.ts';
import { auditWalkthrough } from './cases.ts';
import { browser, setupSlides } from './fixture.ts';

const { repo, dir } = setupSlides(true);

test.skipIf(!browser)('audit keeps readiness and defect detection across viewports and themes', async () => {
  await withServer(repo, dir, async (url) => {
    for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      await withPage(url, vp, async (page) => {
        expect(page.errors()).toContainEqual(expect.stringContaining('audit fixture page error'));
        for (const theme of ['light', 'dark'] as const) {
          const measurements: Measured[] = [];
          for (const ch of auditWalkthrough.chapters) for (const st of ch.steps) {
            const audit = await page.audit(ch.id, st.id, theme);
            expect(audit.settled).toBe(true);
            measurements.push({ viewport: `${vp.width}x${vp.height}`, chapter: ch.id, step: st.id, audit, errors: page.errors(), ownRef: st.ref !== undefined });
          }
          const findings = judge(measurements);
          for (const [check, where] of [['hidden-lines', 'motion/stacked'], ['stripped', 'motion/stripped'], ['too-wide', 'motion/wide'], ['overflow', 'budget/overflow']]) {
            expect(findings).toContainEqual(expect.objectContaining({ check, where }));
          }
          expect(findings.filter((f) => f.where?.startsWith('clean/'))).toEqual([]);
          const preview = measurements.find((m) => m.step === 'preview')!;
          expect(preview.audit.chunks).toContainEqual(expect.objectContaining({ code: true, hidden: 0 }));
          expect(measurements.find((m) => m.step === 'inherited')!.audit.chunks).toEqual(measurements.find((m) => m.step === 'fits')!.audit.chunks);
        }
      }, 1, { animations: false });
    }
  });
}, 90_000);

test.skipIf(!browser)('the headless animations flag suppresses Pele SVG motion and fades, including lazy diagrams, without changing focus', async () => {
  await withServer(repo, dir, async (url) => {
    for (const animations of [true, false]) {
      await withPage(url, { width: 1280, height: 800 }, async (page) => {
        await page.audit('motion', 'trace');
        const edge = await page.evaluate<{ focus: number; motion: number }>(`({
          focus: document.querySelectorAll('.rr-tour__player .pele-edge.is-focus').length,
          motion: document.querySelector('.rr-tour__player').getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length
        })`);
        expect(edge.focus).toBeGreaterThan(0);
        expect(edge.motion > 0).toBe(animations);
        // This diagram type is lazy-loaded by Pele after the initial slide has opened.
        await page.audit('motion', 'preview');
        if (!animations) expect(await page.evaluate(`document.querySelector('.rr-tour__player').getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length`)).toBe(0);
        expect(await page.evaluate(`document.querySelectorAll('.rr-tour__text > .is-leaving').length`)).toBe(0);
      }, 1, { animations });
    }
  });
}, 30_000);

test.skipIf(!browser)('audit waits for slow previews and reports deferred failures', async () => {
  for (const [tag, body] of [['rr-code', '.rr-code__body'], ['rr-embed', '.rr-embed__body .rr-snippet']]) {
    const text = `<${tag} ref="rr:code/pkg/features/habit/fetcher.go#L1-48"></${tag}>`;
    fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify({ version: 1, title: 'Slow prose', chapters: [{ id: 'slow', title: 'Slow', steps: [{ id: 'code', text }, { id: 'failed', text }] }] }));
    await withServer(repo, dir, (url) => withPage(url, { width: 1280, height: 800 }, async (page) => {
      await page.evaluate(`(() => {
        const code = rr.app.services.code, original = code.read;
        code.read = async (...args) => { await new Promise((r) => setTimeout(r, 600)); if(window.__failReads) throw new Error('slow preview read failed'); return original(...args); };
        return true;
      })()`);
      const audit = await page.audit('slow', 'code');
      expect(audit.settled).toBe(true);
      expect(await page.evaluate(`!!document.querySelector('.rr-tour__text ${tag} ${body}')`)).toBe(true);
      expect(await page.evaluate(`(() => {
        const drawn = (root) => !!root.querySelector('[data-line]') || [...root.querySelectorAll('*')].some((e) => e.shadowRoot && drawn(e.shadowRoot));
        return drawn(document.querySelector('.rr-tour__text ${tag}'));
      })()`)).toBe(true);
      await page.evaluate(`(window.__failReads = true)`);
      await page.audit('slow', 'failed');
      expect(page.errors()).toContainEqual(expect.stringContaining('slow preview read failed'));
    }, 1, { animations: false }));
  }
}, 30_000);

test.skipIf(!browser)('a prose preview that never finishes is reported unsettled rather than hanging the audit', async () => {
  fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify({ version: 1, title: 'Stuck prose', chapters: [{ id: 'stuck', title: 'Stuck', steps: [{ id: 'code', text: '<rr-code ref="rr:code/pkg/features/habit/fetcher.go#L1-48"></rr-code>' }] }] }));
  await withServer(repo, dir, (url) => withPage(url, { width: 1280, height: 800 }, async (page) => {
    await page.evaluate(`(() => { rr.app.services.code.read = () => new Promise(() => {}); return true; })()`);
    const audit = await page.audit('stuck', 'code');
    expect(audit.settled).toBe(false);
    expect(judge([{ viewport: '1280x800', chapter: 'stuck', step: 'code', audit, errors: [] }])).toContainEqual(expect.objectContaining({ check: 'unsettled', where: 'stuck/code' }));
  }, 1, { animations: false }));
}, 15_000);
