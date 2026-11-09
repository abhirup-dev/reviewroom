// Each batch has isolated slide DOM state; workers share one read-only server.
import { fail } from './args.ts';
import { openPage, vpName, type Viewport } from './render.ts';
import type { Finding, Measured } from './slide-lint.ts';

export type AuditSlide = { chapter: string; step: string; ownRef: boolean };
type Item = AuditSlide & { index: number };
type Batch = { viewport: Viewport; slides: Item[] };
type Options = { viewports: Viewport[]; slides: AuditSlide[]; jobs: number; native?: boolean };

export function auditJobs(value?: string): number {
  if (value === undefined) return 1;
  if (!/^[1-8]$/.test(value)) fail('--jobs: an integer from 1 to 8');
  return Number(value);
}

/** Keep neighbouring slides together for caching; split the largest batch when there are spare workers. */
function auditBatches({ viewports, slides, jobs }: Options): Batch[] {
  const batches = viewports.map((viewport, v) => ({ viewport, slides: slides.map((s, i) => ({ ...s, index: v * slides.length + i })) }));
  while (batches.length < jobs) {
    const largest = batches.reduce((a, b) => a.slides.length >= b.slides.length ? a : b);
    if (largest.slides.length < 2) break;
    const at = batches.indexOf(largest), middle = Math.ceil(largest.slides.length / 2);
    batches.splice(at, 1, { ...largest, slides: largest.slides.slice(0, middle) }, { ...largest, slides: largest.slides.slice(middle) });
  }
  return batches;
}

export async function auditSlides(url: string, options: Options, createPage = openPage) {
  const batches = auditBatches(options), jobs = Math.min(options.jobs, batches.length);
  const measurements: Measured[] = [];
  const starts: { engine: string; errors: string[] }[] = [];
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const index = next++, batch = batches[index];
      try {
        const page = await createPage(url, batch.viewport, 1, { animations: false, rasterHeight: options.native ? undefined : 480 });
        try {
          starts[index] = { engine: page.engine, errors: page.errors() };
          for (const { index: at, ...slide } of batch.slides) measurements[at] = { viewport: vpName(batch.viewport), ...slide, audit: await page.audit(slide.chapter, slide.step), errors: page.errors() };
        } finally { await page.close(); }
      } catch (e) { failed = true; throw e; }
    }
  };
  // A rejection must not close the shared server while other workers are still using it.
  const settled = await Promise.allSettled(Array.from({ length: jobs }, worker));
  const rejected = settled.find((r) => r.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  const boot = startupFindings(batches, starts);
  return { measurements, boot, jobs, engine: [...new Set(starts.map((s) => s.engine))].join(', ') };
}

function startupFindings(batches: Batch[], starts: { errors: string[] }[]): Finding[] {
  const seen = new Set<string>();
  return starts.flatMap((start, i) => start.errors.flatMap((e) => {
    const message = `while the page started (${vpName(batches[i].viewport)}): ${e.slice(0, 200)}`;
    if (seen.has(message)) return [];
    seen.add(message);
    return [{ check: 'page-error', level: 'warn' as const, message, fix: 'A script in review.html or the walkthrough prose failed; the reviewer sees the same.' }];
  }));
}
