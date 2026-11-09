import { expect, test } from 'bun:test';
import { auditJobs, auditSlides } from '../../cli/lib/slide-render.ts';
import type { Page } from '../../cli/lib/render.ts';
import type { StepAudit } from '../../src/slides/model.shared.ts';

const viewports = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
const slides = Array.from({ length: 5 }, (_, i) => ({ chapter: 'c', step: `s${i}`, ownRef: true }));
const audit: StepAudit = { left: { visible: 100, content: 100, lead: 0 }, chunks: [], wide: [], stripped: { lead: [], text: [] }, settled: true };
const pause = () => new Promise((r) => setTimeout(r, 5));

test('jobs are explicit, bounded integers', () => {
  expect(auditJobs()).toBe(1);
  expect(auditJobs('8')).toBe(8);
  for (const value of ['0', '-1', '9', '2.5', 'many', '1e0', '']) expect(() => auditJobs(value)).toThrow('--jobs');
});

function pages(failAt?: string) {
  let active = 0, peak = 0, opened = 0, closed = 0;
  const factory = async (): Promise<Page> => {
    active++; opened++; peak = Math.max(active, peak);
    let busy = false;
    return {
      engine: 'chrome', errors: () => ['shared startup failure'],
      audit: async (_chapter, step) => {
        if (busy) throw new Error('two audits shared a page');
        busy = true;
        await pause();
        busy = false;
        if (step === failAt) throw new Error('audit failed');
        return audit;
      },
      close: async () => { await pause(); active--; closed++; },
      resize: async () => {}, evaluate: async () => undefined as never, screenshot: async () => new Blob(),
    };
  };
  return { factory, counts: () => ({ active, peak, opened, closed }) };
}

test('workers overlap isolated pages, keep result order, deduplicate startup errors, and close pages', async () => {
  const p = pages();
  const result = await auditSlides('url', { viewports, slides, jobs: 4 }, p.factory);
  expect(p.counts()).toEqual({ active: 0, peak: 4, opened: 4, closed: 4 });
  expect(result.measurements.map((m) => `${m.viewport}/${m.step}`)).toEqual(viewports.flatMap((v) => slides.map((s) => `${v.width}x${v.height}/${s.step}`)));
  expect(result.boot).toHaveLength(2);
  expect(result.jobs).toBe(4);
});

test('a worker failure waits for all in-flight pages to close before rejecting', async () => {
  const p = pages('s0');
  const error: unknown = await auditSlides('url', { viewports, slides, jobs: 4 }, p.factory).catch((e: unknown) => e);
  expect(error).toMatchObject({ message: 'audit failed' });
  expect(p.counts().active).toBe(0);
  expect(p.counts().closed).toBe(p.counts().opened);
});
