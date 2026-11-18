import { WALKTHROUGH_FILE, REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
// One adversarial walkthrough over the demo repo, shared by browser regressions and the benchmark.
// Deliberate defects stay here rather than making the teaching demo a broken review.
import fs from 'node:fs';
import path from 'node:path';
import { Walkthrough } from '../../src/slides/model.shared';

const builder = 'rr:code/internal/upload/handler.go#L18-25';
const fetcher = 'rr:code/internal/limit/bucket.go#L37-44';

export const auditWalkthrough: Walkthrough = {
  version: 1,
  title: 'Slide audit regression cases',
  chapters: [
    {
      id: 'motion', title: 'Readiness, motion and focus',
      lead: '<rr-mermaid>flowchart TD\n A[Fetcher] --> B[Store]\n B --> C[local CDN and ffmpeg, new]</rr-mermaid>',
      steps: [
        { id: 'trace', text: '<p>Two lit nodes animate their connecting edge indefinitely.</p>', ref: builder, focus: ['Fetcher', 'Store'] },
        { id: 'wrapped', text: '<p>The long label exercises the wrapped-label bug (rr-w06).</p>', focus: ['local CDN and ffmpeg, new'] },
        { id: 'preview', text: `<p>Code and diagrams must finish loading before measurement.</p><rr-code ref="${fetcher}"></rr-code><rr-mermaid>classDiagram\n class Fetcher\n class Store\n Fetcher --> Store</rr-mermaid>`, ref: fetcher },
        { id: 'stacked', text: '<p>Two code chunks, with intentionally oversized highlights.</p>', ref: ['rr:code/internal/limit/bucket.go#L1-48', 'rr:code/internal/upload/handler.go#L1-33'] },
        { id: 'stripped', text: '<p onclick="alert(1)">Readable prose.</p><script>throw new Error("must be stripped")</script><rr-flow><rr-node>Removed element</rr-node></rr-flow>', ref: builder },
        { id: 'wide', text: `<pre>${'unbreakable_'.repeat(100)}</pre>`, ref: builder },
      ],
    },
    {
      id: 'budget', title: 'Chapter lead and narration budgets',
      lead: `<p>${'A chapter intro consumes the space shared by every slide. '.repeat(18)}</p>`,
      steps: [
        { id: 'overflow', text: `<p>${'This narration deliberately exceeds the screen budget. '.repeat(90)}</p>`, ref: builder },
        { id: 'shared-lead', text: '<p>The same oversized chapter intro also crowds this short slide.</p>', ref: fetcher },
      ],
    },
    {
      id: 'clean', title: 'Clean slides without a lead',
      steps: [
        { id: 'fits', text: '<p>A short slide fits beside a small code range.</p>', ref: fetcher },
        { id: 'inherited', text: '<p>An omitted ref keeps the preceding code target.</p>' },
        { id: 'stacked', text: '<p>Two small ranges in an unchanged file fit without scrolling.</p>', ref: ['rr:code/internal/upload/account.go#L4-10', 'rr:code/internal/upload/account.go#L14-20'] },
        { id: 'base', text: '<p>The unchanged base revision also lands before measurement.</p>', ref: 'rr:code/internal/upload/account.go@base#L10-16' },
      ],
    },
  ],
};

export const auditReview = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Slide audit fixture</title>
<script type="module" src="_rr/reviewroom.js"></script></head><body><rr-app><rr-review>
<h1>Slide audit fixture</h1><p>Fixtures for rendered and static lint checks.</p>
<rr-flow><rr-node ref="${builder}">Legacy element: check currently misses this (rr-4mt).</rr-node></rr-flow>
<script>throw new Error('audit fixture page error')</script>
</rr-review></rr-app></body></html>`;

const demo = path.join(import.meta.dir, '../../examples/uploads');
export const slideCases = {
  demo: { tour: Walkthrough.parse(JSON.parse(fs.readFileSync(path.join(demo, WALKTHROUGH_FILE), 'utf8'))), html: fs.readFileSync(path.join(demo, REPORT_FILE), 'utf8') },
  audit: { tour: Walkthrough.parse(auditWalkthrough), html: auditReview },
};
export function writeSlideCase(dir: string, fixture: { tour: Walkthrough; html: string }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify(fixture.tour));
  fs.writeFileSync(path.join(dir, REPORT_FILE), fixture.html);
}
