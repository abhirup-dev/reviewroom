// Partial lint must keep real playback context while reporting exactly what was checked.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read } from '../../e2e/fixture.ts';
import { browser, setupSlides } from './fixture.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';

const { dir, d, cli, file } = setupSlides();
const lint = (args: string[]) => cli(['slide-lint', '--json', ...args, ...d]);

test('a partial check still validates the entire schema, including unselected chapters', async () => {
  const w = JSON.parse(read(file));
  w.chapters[0].steps[1].id = w.chapters[0].steps[0].id;
  fs.writeFileSync(file, JSON.stringify(w));
  const r = await lint(['--slide', 'enforce/s2']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('duplicate step id');
});

test.skipIf(!browser)('partial checks ignore unrelated links, focus and overflow; a full check still catches them', async () => {
  const w = JSON.parse(read(file));
  w.chapters[1].steps[0] = { id: 's1', ref: 'rr:code/pkg/gone.go#L1', text: `<p>${'Unrelated overflow. '.repeat(300)}</p><rr-mermaid>flowchart TD\n A -->\n ((( bad</rr-mermaid>`, focus: ['Missing node'] };
  fs.writeFileSync(file, JSON.stringify(w));
  fs.appendFileSync(path.join(dir, 'review.html'), '<a href="rr:sym/UnrelatedMissingSymbol">Unrelated</a>');
  fs.writeFileSync(path.join(dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), artifact: 'walkthrough', event: 'requested' }) + '\n');
  const before = fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs, read(dir, f)]);
  const single = await lint(['--slide', 'enforce/s2']);
  expect(single.code).toBe(0);
  expect(JSON.parse(single.stdout)).toMatchObject({ selection: { kind: 'slide', chapter: 'enforce', step: 's2' }, coverage: { partial: true, totalSlides: 8, measured: ['enforce/s2'] }, links: [], findings: [] });
  const chapter = await lint(['--chapter', 'enforce']);
  expect(chapter.code).toBe(0);
  expect(JSON.parse(chapter.stdout)).toMatchObject({ selection: { kind: 'chapter', chapter: 'enforce' }, coverage: { partial: true, totalSlides: 8, measured: ['enforce/s1', 'enforce/s2'] }, findings: [] });
  const full = await lint([]);
  expect(full.code).toBe(1);
  const out = JSON.parse(full.stdout);
  expect(out.coverage.partial).toBe(false);
  expect(out.coverage.measured).toHaveLength(8);
  expect(out.links).toContainEqual(expect.objectContaining({ ref: 'rr:code/pkg/gone.go#L1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'bucket/s1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'unknown-focus', where: 'bucket/s1' }));
  expect(fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs, read(dir, f)])).toEqual(before);
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
  fs.writeFileSync(file, JSON.stringify(w));
  const broken = JSON.parse((await lint(['--slide', 'after/inherited'])).stdout);
  expect(broken.links).toContainEqual(expect.objectContaining({ ref: 'rr:code/pkg/gone.go#L1', where: ['after/inherited'] }));
}, 30_000);

test.skipIf(!browser)('selected slides include their chapter lead', async () => {
  const w = JSON.parse(read(file));
  w.chapters[2].lead = `<p>${'An oversized shared lead. '.repeat(300)}</p><a href="rr:doc/missing">Missing</a>`;
  fs.writeFileSync(file, JSON.stringify(w));
  const r = JSON.parse((await lint(['--slide', 'enforce/s2'])).stdout);
  expect(r.links).toContainEqual(expect.objectContaining({ ref: 'rr:doc/missing', where: ['enforce'] }));
  expect(r.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'enforce/s2' }));

}, 30_000);
