import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
// Partial lint must keep real playback context while reporting exactly what was checked.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read } from '../../e2e/fixture.ts';
import { reviewStore } from '../../cli/lib/review-store.ts';
import { browser, setupSlides } from './fixture.ts';
import { slideCases } from './cases.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';

const { dir, d, cli, file } = setupSlides();
const totalSlides = slideCases.demo.tour.chapters.reduce((n, c) => n + c.steps.length, 0);
const lint = (args: string[]) => cli(['slide-lint', ...d, '--json', ...args]);

test('a partial check still validates the entire schema, including unselected chapters', async () => {
  const w = JSON.parse(read(file));
  w.chapters[0].steps[1].id = w.chapters[0].steps[0].id;
  fs.writeFileSync(file, JSON.stringify(w));
  const r = await lint(['--slide', 'enforce/s2']);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('duplicate step id');
});

test.skipIf(!browser)('partial checks ignore unrelated links, focus and overflow; a full check still catches them', async () => {
  const w = JSON.parse(read(file));
  w.chapters[1].steps[0] = { id: 's1', ref: 'rr:code/pkg/gone.go#L1', text: `<p>${'Unrelated overflow. '.repeat(300)}</p><rr-mermaid>flowchart TD\n A -->\n ((( bad</rr-mermaid>`, focus: ['Missing node'] };
  fs.writeFileSync(file, JSON.stringify(w));
  fs.appendFileSync(path.join(dir, REPORT_FILE), '<a href="rr:sym/UnrelatedMissingSymbol">Unrelated</a>');
  reviewStore(dir).progress.append(JSON.stringify({ at: new Date().toISOString(), artifact: 'walkthrough', event: 'requested', by: 'agent' }) + '\n');
  const listing = () => fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs, read(dir, f)]);
  const before = listing();
  const single = await lint(['--slide', 'enforce/s2']);
  expect(single.code).toBe(0);
  expect(JSON.parse(single.stdout)).toMatchObject({ selection: { kind: 'slide', chapter: 'enforce', step: 's2' }, coverage: { partial: true, totalSlides, measured: ['enforce/s2'] }, links: [], findings: [] });
  const chapter = await lint(['--chapter', 'disk']); // not enforce: its four-file slide warns short-chunk by design
  expect(chapter.code).toBe(0);
  expect(JSON.parse(chapter.stdout)).toMatchObject({ selection: { kind: 'chapter', chapter: 'disk' }, coverage: { partial: true, totalSlides, measured: ['disk/s1', 'disk/s2'] }, findings: [] });
  expect(listing()).toEqual(before); // partial checks touch nothing
  // a script of the agent's that throws, and a diagram Pele can't parse: the reviewer would hit both, so a full lint reports them
  fs.writeFileSync(path.join(dir, REPORT_FILE), read(dir, REPORT_FILE).replace('</rr-review>', '<script>throw new Error("author boom")</script><rr-mermaid id="bad">flowchart TD\n  A --&gt;\n  ((( x</rr-mermaid></rr-review>'));
  const unchanged = listing();
  const full = await lint(['--viewport', '1280x720']);
  expect(full.code).toBe(1);
  const out = JSON.parse(full.stdout);
  expect(out).toMatchObject({ viewports: ['1280x720'], coverage: { partial: false } });
  expect(out.coverage.measured).toHaveLength(totalSlides);
  expect(out.links).toContainEqual(expect.objectContaining({ ref: 'rr:code/pkg/gone.go#L1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'bucket/s1', fix: expect.stringContaining('Shorten or split the slide') }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'unknown-focus', where: 'bucket/s1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('author boom') }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('rr-mermaid#bad: the diagram could not be rendered') }));
  expect(listing()).toEqual(unchanged);
}, 30_000);

test.skipIf(!browser)('a selected slide keeps cross-chapter inherited code and reports its hidden lines', async () => {
  const w: Walkthrough = { version: 1, title: 'Inherited code', chapters: [
    { id: 'before', title: 'Before', steps: [{ id: 'seed', text: '<a href="rr:sym/UnrelatedMissingSymbol">Other prose</a>', ref: 'rr:code/internal/limit/bucket.go#L1-48' }] },
    { id: 'after', title: 'After', steps: [{ id: 'inherited', text: '<p>Inherited code stays visible. <a href="rr:doc/summary">Summary</a></p>' }] },
  ] };
  fs.writeFileSync(file, JSON.stringify(w));
  const r = await lint(['--slide', 'after/inherited']);
  expect(r.code).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.links).toEqual([]);
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'hidden-lines', where: 'after/inherited' }));
  expect(out.findings.some((f: { check: string }) => ['chapter-size', 'unshown-file', 'no-code'].includes(f.check))).toBe(false);
  w.chapters[0].steps[0].ref = 'rr:code/pkg/gone.go#L1';
  // a selected slide also takes its chapter's lead: its links and its size
  w.chapters[1].lead = `<p>${'An oversized shared lead. '.repeat(300)}</p><a href="rr:doc/missing">Missing</a>`;
  fs.writeFileSync(file, JSON.stringify(w));
  const broken = JSON.parse((await lint(['--slide', 'after/inherited'])).stdout);
  expect(broken.links).toContainEqual(expect.objectContaining({ ref: 'rr:code/pkg/gone.go#L1', where: ['after/inherited'] }));
  expect(broken.links).toContainEqual(expect.objectContaining({ ref: 'rr:doc/missing', where: ['after'] }));
  expect(broken.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'after/inherited' }));
}, 30_000);
