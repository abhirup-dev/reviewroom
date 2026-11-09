// Partial lint must keep real playback context while reporting exactly what was checked.
import { beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { read, setup } from './fixture.ts';
import type { Walkthrough } from '../src/slides/model.shared.ts';

const { dir, d, cli } = setup();
const demo = path.join(import.meta.dir, '../examples/habit-events');
const file = path.join(dir, 'walkthrough.json');
beforeEach(() => {
  fs.copyFileSync(path.join(demo, 'walkthrough.json'), file);
  fs.copyFileSync(path.join(demo, 'review.html'), path.join(dir, 'review.html'));
});
const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
const lint = (args: string[]) => cli(['slide-lint', '--json', ...args, ...d]);

test('selectors reject conflicts and unknown ids before starting a browser', async () => {
  for (const [args, message] of [
    [['--chapter', 'missing'], 'chapters: why, fetcher, proto, latency, together'],
    [['--slide', 'latency/nope'], 'slides: why/s1'],
    [['--slide', 's1'], 'unknown slide'],
    [['--chapter', 'latency', '--slide', 'latency/s2'], 'mutually exclusive'],
  ] as const) {
    const r = await lint([...args]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
  }
});

test('a partial check still validates the entire schema, including unselected chapters', async () => {
  const w = JSON.parse(read(file));
  w.chapters[0].steps[1].id = w.chapters[0].steps[0].id;
  fs.writeFileSync(file, JSON.stringify(w));
  const r = await lint(['--slide', 'latency/s2']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('duplicate step id');
});

test.skipIf(!browser)('partial checks ignore unrelated links, focus and overflow; a full check still catches them', async () => {
  const w = JSON.parse(read(file));
  w.chapters[1].steps[0] = { id: 's1', ref: 'rr:code/pkg/gone.go#L1', text: `<p>${'Unrelated overflow. '.repeat(300)}</p>`, focus: ['Missing node'] };
  fs.writeFileSync(file, JSON.stringify(w));
  fs.appendFileSync(path.join(dir, 'review.html'), '<a href="rr:sym/UnrelatedMissingSymbol">Unrelated</a>');
  const before = fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs, read(dir, f)]);
  const single = await lint(['--slide', 'latency/s2']);
  expect(single.code).toBe(0);
  expect(JSON.parse(single.stdout)).toMatchObject({ selection: { kind: 'slide', chapter: 'latency', step: 's2' }, coverage: { partial: true, totalSlides: 15, measured: ['latency/s2'] }, links: [], findings: [] });
  const chapter = await lint(['--chapter', 'latency']);
  expect(chapter.code).toBe(0);
  expect(JSON.parse(chapter.stdout)).toMatchObject({ selection: { kind: 'chapter', chapter: 'latency' }, coverage: { partial: true, totalSlides: 15, measured: ['latency/s1', 'latency/s2', 'latency/s3', 'latency/s4', 'latency/s5'] }, findings: [] });
  const full = await lint([]);
  expect(full.code).toBe(1);
  const out = JSON.parse(full.stdout);
  expect(out.coverage.partial).toBe(false);
  expect(out.coverage.measured).toHaveLength(15);
  expect(out.links).toContainEqual(expect.objectContaining({ ref: 'rr:code/pkg/gone.go#L1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'fetcher/s1' }));
  expect(out.findings).toContainEqual(expect.objectContaining({ check: 'unknown-focus', where: 'fetcher/s1' }));
  expect(fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs, read(dir, f)])).toEqual(before);
}, 30_000);

test.skipIf(!browser)('a selected slide keeps cross-chapter inherited code and reports its hidden lines', async () => {
  const w: Walkthrough = { version: 1, title: 'Inherited code', chapters: [
    { id: 'before', title: 'Before', steps: [{ id: 'seed', text: '<a href="rr:sym/UnrelatedMissingSymbol">Other prose</a>', ref: 'rr:code/pkg/features/habit/fetcher.go#L1-48' }] },
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

test.skipIf(!browser)('a selected slide does not preload and report errors from unrelated guided prose', async () => {
  const w = JSON.parse(read(file));
  w.chapters[3].steps[2].text += '<rr-mermaid>flowchart TD\n A -->\n ((( bad</rr-mermaid>';
  fs.writeFileSync(file, JSON.stringify(w));
  const r = await lint(['--slide', 'latency/s2']);
  expect([r.code, JSON.parse(r.stdout).findings]).toEqual([0, []]);
}, 30_000);

test.skipIf(!browser)('selected slides include their chapter lead and retain shared page errors', async () => {
  const w = JSON.parse(read(file));
  w.chapters[3].lead = `<p>${'An oversized shared lead. '.repeat(300)}</p><a href="rr:doc/missing">Missing</a>`;
  fs.writeFileSync(file, JSON.stringify(w));
  const r = JSON.parse((await lint(['--slide', 'latency/s2'])).stdout);
  expect(r.links).toContainEqual(expect.objectContaining({ ref: 'rr:doc/missing', where: ['latency'] }));
  expect(r.findings).toContainEqual(expect.objectContaining({ check: 'overflow', where: 'latency/s2' }));
  fs.copyFileSync(path.join(demo, 'walkthrough.json'), file);
  fs.appendFileSync(path.join(dir, 'review.html'), '<script>throw new Error("shared startup failure")</script>');
  const error = await lint(['--slide', 'latency/s2']);
  expect(error.code).toBe(1);
  expect(JSON.parse(error.stdout).findings).toContainEqual(expect.objectContaining({ check: 'page-error', message: expect.stringContaining('shared startup failure') }));
}, 30_000);

test.skipIf(!browser)('human output names partial coverage and existing tour links select the same slide', async () => {
  const human = await cli(['slide-lint', '--slide', 'latency/s2', ...d]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain('1 of 15 slides measured');
  expect(human.stdout).toContain('partial check');
  expect(human.stdout).not.toContain('every slide fits');
  const alias = await lint(['--slide', 'rr:tour/latency/s2']);
  expect(alias.code).toBe(0);
  expect(JSON.parse(alias.stdout).coverage.measured).toEqual(['latency/s2']);
}, 30_000);
