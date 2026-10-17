// walkthrough publish: ship walkthrough.json with the PR, as a comment `reviewroom pr` picks up.
// walkthrough lint: `check`, then every step measured on screen in a headless browser. walkthrough shot: one step's picture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit, readConfig } from '../lib/config.ts';
import { prTarget, upsertComment } from '../lib/github.ts';
import { report } from '../lib/links.ts';
import { readWalkthrough, walkthroughPath } from '../lib/state.ts';
import { BLOCK_MARK, encodeBlock, type Walkthrough } from '../../src/shared/walkthrough.ts';
import { findingReport, judge, type Finding, type Measured } from '../lib/tour-lint.ts';
import { openPage, parseViewports, vpName, withServer } from '../lib/render.ts';
import { runCheck, schemaReport } from './check.ts';

const COMMENT_LIMIT = 65_536; // GitHub's maximum comment body

/** The comment body: the block plus a line for people reading the PR on GitHub. */
export function publishBody(w: Walkthrough, pr?: number) {
  const body = `${encodeBlock(w)}\n_A guided walkthrough of this PR: \`reviewroom pr ${pr ?? '<number>'}\` plays it in reviewroom._\n`;
  if (body.length > COMMENT_LIMIT) fail(`the walkthrough is ${body.length} characters as a comment; GitHub takes at most ${COMMENT_LIMIT}. Shorten the prose (leads and step text).`);
  return body;
}

type WalkthroughOpts = Global & { dryRun?: boolean; allowStale?: boolean; viewport?: string; theme?: string; out?: string; json?: boolean };

export async function cmdWalkthrough(repo: string | null, o: WalkthroughOpts, [action, at]: string[]) {
  const actions = { publish, lint, shot };
  if (!(action in actions)) fail('usage: reviewroom walkthrough publish|lint|shot (see --help)', 2);
  const dir = dirForEdit(repo, o.dir);
  if (!fs.existsSync(walkthroughPath(dir))) fail(`no walkthrough.json in ${dir}`);
  await actions[action as keyof typeof actions](repo, dir, o, at);
}

async function publish(repo: string | null, dir: string, o: WalkthroughOpts) {
  const c = await runCheck(repo, dir, { store: !o.dryRun, notes: false });
  if ('issues' in c) fail(schemaReport(c.issues));
  if (c.bad.length && !o.allowStale) fail(`${c.bad.length} link(s) need attention (fix them, or publish anyway with --allow-stale):\n${report(c.bad)}`);
  const t = prTarget(readConfig(dir));
  const body = publishBody(c.tour!, t?.number);
  if (o.dryRun) {
    console.log(body);
    return;
  }
  if (!t) fail('this review is not about a GitHub PR (start it with `reviewroom pr <number>`)');
  console.log(await upsertComment(dir, t, BLOCK_MARK, body));
}

async function lint(repo: string | null, dir: string, o: WalkthroughOpts) {
  const c = await runCheck(repo, dir, { store: false, estimates: false });
  if ('issues' in c) fail(schemaReport(c.issues));
  const tour = c.tour!;
  const viewports = parseViewports(o.viewport ?? '1280x800,1440x900');
  const ms: Measured[] = [];
  const boot: Finding[] = [];
  let engine = '';
  await withServer(repo, dir, async (url) => {
    for (const vp of viewports) {
      const page = await openPage(url, vp);
      engine = page.engine;
      try {
        // the page's own start-up (review.html's scripts too): not a step's
        for (const e of page.errors()) boot.push({ check: 'page-error', level: 'warn', message: `while the page started (${vpName(vp)}): ${e.slice(0, 200)}`, fix: 'A script in review.html or the walkthrough prose failed; the reviewer sees the same.' });
        for (const ch of tour.chapters) for (const st of ch.steps) ms.push({ viewport: vpName(vp), chapter: ch.id, step: st.id, audit: await page.audit(ch.id, st.id), errors: page.errors() });
      } finally {
        await page.close();
      }
    }
  });
  const findings: Finding[] = [...c.notes, ...boot, ...judge(ms)];
  const steps = tour.chapters.reduce((n, ch) => n + ch.steps.length, 0);
  if (o.json) console.log(JSON.stringify({ engine, viewports: viewports.map(vpName), links: c.bad, findings }, null, 2));
  else {
    console.log(`${steps} slides measured at ${viewports.map(vpName).join(', ')} (${engine})`);
    if (c.bad.length) console.log(`\n${c.bad.length} link(s) need attention:\n${report(c.bad)}`);
    console.log(findings.length ? `\n${findingReport(findings, tour)}` : '\nno findings: every slide fits.');
    if (findings.some((f) => f.level === 'warn')) console.log('\nSee a slide with `reviewroom walkthrough shot <chapter>/<step>`.');
  }
  if (c.bad.length || findings.some((f) => f.level === 'warn')) process.exitCode = 1;
}

async function shot(repo: string | null, dir: string, o: WalkthroughOpts, at?: string) {
  const [chapter, step] = (at ?? '').split('/');
  const w = readWalkthrough(dir);
  if (!w?.ok) fail(w ? schemaReport(w.issues) : `no walkthrough.json in ${dir}`);
  const ch = w.value.chapters.find((x) => x.id === chapter);
  if (!ch || !ch.steps.some((s) => s.id === step)) fail(`usage: reviewroom walkthrough shot <chapter>/<step>; steps: ${w.value.chapters.flatMap((x) => x.steps.map((s) => `${x.id}/${s.id}`)).join(', ')}`, 2);
  if (o.theme && o.theme !== 'light' && o.theme !== 'dark') fail('--theme: light or dark', 2);
  const theme = (o.theme ?? 'light') as 'light' | 'dark';
  const [vp] = parseViewports(o.viewport ?? '1280x800');
  const out = path.resolve(o.out ?? path.join(os.tmpdir(), 'reviewroom-shots', `${chapter}-${step}-${vpName(vp)}-${theme}.png`));
  await withServer(repo, dir, async (url) => {
    const page = await openPage(url, vp, 2);
    try {
      page.errors();
      const audit = await page.audit(chapter, step, theme);
      await Bun.write(out, await page.screenshot());
      console.log(out);
      const found = judge([{ viewport: vpName(vp), chapter, step, audit, errors: page.errors() }]);
      if (found.length) console.log(findingReport(found, w.value));
    } finally {
      await page.close();
    }
  });
}
