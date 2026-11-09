// Repeatable worktree-local baseline; build first. Run before and after each lint optimization:
// bun scripts/benchmark-slides.ts .demo/slides-before.json [--runs 3]
// bun scripts/benchmark-slides.ts --diff .demo/slides-before.json .demo/slides-after.json
// The demo is representative; the single adversarial fixture exercises known audit failures.
import { $ } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck } from '../cli/commands/check.ts';
import { openPage, vpName, withServer } from '../cli/lib/render.ts';
import { judge, type Measured } from '../cli/lib/slide-lint.ts';
import { auditReview, auditWalkthrough } from '../src/testing/slide-audit.ts';
import type { Walkthrough } from '../src/slides/model.shared.ts';

const root = path.resolve(import.meta.dir, '..');
const entry = path.join(root, 'dist/cli/reviewroom.js');
const viewports = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
type Sample = { checkMs: number; renderMs: number; bootMs: number; auditMs: number; cliMs: number; cliCode: number; engine: string; measurements: Measured[]; findings: unknown };
type CliRun = { ms: number; code: number; result: unknown };
type ScopedRuns = Record<string, Record<string, { args: string[]; runs: CliRun[] }>>;
type Result = { version: 1; revision: string; sourceHash: string; build: unknown; bun: string; platform: string; cpu: string; fixtureHash: string; viewports: string[]; cases: Record<string, Sample[]>; scoped?: ScopedRuns };
const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const elapsed = (t: number) => Math.round(performance.now() - t);
const median = (ns: number[]) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)];

async function runCli(repo: string, dir: string, home: string, args: string[] = []): Promise<CliRun> {
  const started = performance.now();
  const cli = await $`${process.execPath} ${entry} slide-lint --repo ${repo} --dir ${dir} --json ${args}`.env({ ...process.env, REVIEWROOM_HOME: home }).quiet().nothrow();
  const ms = elapsed(started);
  if (cli.exitCode !== 0 && cli.exitCode !== 1) throw new Error(cli.stderr.toString());
  return { ms, code: cli.exitCode, result: JSON.parse(cli.stdout.toString()) };
}

async function sample(repo: string, dir: string, tour: Walkthrough, home: string): Promise<Sample> {
  let t = performance.now();
  const checked = await runCheck(repo, dir, { store: false, estimates: false });
  const checkMs = elapsed(t);
  if ('issues' in checked) throw new Error(checked.issues.join('\n'));
  const measurements: Measured[] = [];
  let bootMs = 0, auditMs = 0, engine = '';
  t = performance.now();
  await withServer(repo, dir, async (url) => {
    for (const vp of viewports) {
      let started = performance.now();
      const page = await openPage(url, vp, 1, { animations: false, rasterHeight: 480 });
      bootMs += elapsed(started);
      engine = page.engine;
      try {
        // Boot errors are recorded separately from the first slide, as the CLI does.
        measurements.push({ viewport: vpName(vp), chapter: '', step: '', audit: { left: { visible: 0, content: 0, lead: 0 }, chunks: [], wide: [], stripped: { lead: [], text: [] }, settled: true }, errors: page.errors() });
        for (const ch of tour.chapters) for (const st of ch.steps) {
          started = performance.now();
          const audit = await page.audit(ch.id, st.id, 'light');
          auditMs += elapsed(started);
          measurements.push({ viewport: vpName(vp), chapter: ch.id, step: st.id, audit, errors: page.errors(), ownRef: st.ref !== undefined });
        }
      } finally { await page.close(); }
    }
  });
  const renderMs = elapsed(t);
  const cli = await runCli(repo, dir, home);
  console.log(`${path.basename(dir)}: check ${checkMs}ms, boot ${bootMs}ms, audit ${auditMs}ms; CLI ${cli.ms}ms (exit ${cli.code}, ${judge(measurements).length} rendered findings)`);
  return { checkMs, renderMs, bootMs, auditMs, cliMs: cli.ms, cliCode: cli.code, engine, measurements, findings: cli.result };
}

async function capture(out: string, runs: number) {
  fs.mkdirSync(path.join(root, '.demo'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, '.demo', 'slide-audit-'));
  const repo = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const demo = path.join(root, 'examples/habit-events');
  const tours: Record<string, Walkthrough> = { demo: JSON.parse(fs.readFileSync(path.join(demo, 'walkthrough.json'), 'utf8')), audit: auditWalkthrough };
  const reviews = { demo: fs.readFileSync(path.join(demo, 'review.html'), 'utf8'), audit: auditReview };
  const cases: Result['cases'] = {};
  const scoped: ScopedRuns = {};
  const revision = (await $`git -C ${root} rev-parse HEAD`.quiet()).stdout.toString().trim();
  const diff = (await $`git -C ${root} diff -- src cli`.quiet()).stdout.toString();
  try {
    await $`bash ${path.join(root, 'examples/make-demo-repo.sh')} ${repo}`.quiet();
    for (const [name, tour] of Object.entries(tours)) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ base: 'main', head: 'feat/habit-events' }));
      fs.writeFileSync(path.join(dir, 'review.html'), reviews[name as keyof typeof reviews]);
      fs.writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify(tour));
      cases[name] = [];
      for (let i = 0; i < runs; i++) cases[name].push(await sample(repo, dir, tour, home));
      // Same dataset and viewport defaults: full, its largest chapter, and one slide from that chapter.
      const chapter = tour.chapters.reduce((a, b) => a.steps.length >= b.steps.length ? a : b);
      const slide = chapter.steps[Math.min(1, chapter.steps.length - 1)];
      scoped[name] = {};
      for (const [kind, args] of [['chapter', ['--chapter', chapter.id]], ['slide', ['--slide', `${chapter.id}/${slide.id}`]]] as const) {
        const measurements: CliRun[] = [];
        for (let i = 0; i < runs; i++) measurements.push(await runCli(repo, dir, home, [...args]));
        scoped[name][kind] = { args: [...args], runs: measurements };
        console.log(`${name} ${args.join(' ')}: CLI median ${median(measurements.map((m) => m.ms))}ms`);
      }
    }
    const result: Result = { version: 1, revision, sourceHash: hash(revision + diff), build: JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8')), bun: Bun.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0].model, fixtureHash: hash(JSON.stringify({ tours, reviews })), viewports: viewports.map(vpName), cases, scoped };
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(`Saved ${out}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Coverage metadata was added with scoped lint; retain comparisons against earlier full-run baselines.
function outcome(raw: unknown) {
  const r = raw as Record<string, unknown>;
  return JSON.stringify({ engine: r.engine, viewports: r.viewports, links: r.links, findings: r.findings });
}

function compare(before: Result, after: Result) {
  if (before.fixtureHash !== after.fixtureHash || JSON.stringify(before.viewports) !== JSON.stringify(after.viewports)) throw new Error('Fixture or viewports changed: capture a new baseline.');
  let different = false;
  for (const [name, samples] of Object.entries(before.cases)) {
    const next = after.cases[name];
    if (!next?.length) throw new Error(`Missing case: ${name}`);
    for (const key of ['checkMs', 'bootMs', 'auditMs', 'cliMs'] as const) {
      const a = median(samples.map((s) => s[key])), b = median(next.map((s) => s[key]));
      console.log(`${name} ${key}: ${a} -> ${b}ms (${((b / a - 1) * 100).toFixed(1)}%)`);
    }
    const expected = samples[0];
    for (const s of [...samples, ...next]) {
      if (JSON.stringify(s.measurements) !== JSON.stringify(expected.measurements) || outcome(s.findings) !== outcome(expected.findings) || s.cliCode !== expected.cliCode) different = true;
    }
  }
  console.log(different ? 'Audit results or CLI findings differ; inspect the saved JSON.' : 'All audit results, CLI findings and exit codes are identical across every run.');
  if (different) process.exitCode = 1;
}

const [first, second, third] = process.argv.slice(2);
if (first === '--diff' && second && third) compare(JSON.parse(fs.readFileSync(second, 'utf8')), JSON.parse(fs.readFileSync(third, 'utf8')));
else if (first && !first.startsWith('-') && (!second || second === '--runs')) {
  const runs = third === undefined ? 3 : Number(third);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  await capture(first, runs);
} else throw new Error('usage: bun scripts/benchmark-slides.ts <out.json> [--runs 3] | --diff <before.json> <after.json>');
