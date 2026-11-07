// The client's computed styles on the demo, as a before/after check for refactors that must not change how anything
// looks (Refactor 3.0, rr-486). Uses the built CLI (dist/), so build first.
//   bun scripts/snapshot.ts <out.json>          capture: phone (?phone, 390x844) and desktop (1280x800), light and dark
//   bun scripts/snapshot.ts --diff <a> <b>      what differs, grouped by property; exits 1 if anything does
import { $ } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPage, type Viewport } from '../cli/lib/render.ts';

type Dump = Record<string, Record<string, string>>;
type Snapshot = Record<string, Dump>;

const root = path.resolve(import.meta.dir, '..');
const PROPS = ['display', 'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing', 'color', 'background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap', 'width', 'height', 'border-top-left-radius', 'border-top-color', 'border-top-width'];
// every element on screen (and a little below), keyed by its tag and class path
const DUMP = `(() => {
  const props = ${JSON.stringify(PROPS)}, res = {};
  const key = (el) => { const p = []; for (let e = el; e && e !== document.documentElement; e = e.parentElement) p.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].sort().join('.') : '') + ':' + (e.parentElement ? [...e.parentElement.children].indexOf(e) : 0)); return p.join('>'); };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight * 2 || cs.visibility === 'hidden') continue;
    res[key(el)] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
  }
  return JSON.stringify(res);
})()`;
// no motion, no caret: the same frame every run
const STILL = `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.append(s); return true; })()`;
const STATES: [string, string][] = [
  ['start', ''],
  ['code', `rr.addPanel('code')`],
  ['threads', `rr.addPanel('threads')`],
  ['files', `rr.addPanel('files')`],
  ['guided', `rr.walkthrough()`],
];
const FORMS: [string, string, Viewport][] = [
  ['phone', '?phone', { width: 390, height: 844 }],
  ['desktop', '', { width: 1280, height: 800 }],
];

async function capture(out: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-snapshot-'));
  const repo = path.join(tmp, 'repo'), dir = path.join(tmp, 'review');
  const env = { ...process.env, REVIEWROOM_HOME: path.join(tmp, 'home') };
  const cli = (args: string[]) => $`${process.execPath} ${path.join(root, 'dist/cli/reviewroom.js')} ${args}`.env(env).quiet();
  await $`bash ${path.join(root, 'examples/make-demo-repo.sh')} ${repo}`.quiet();
  fs.cpSync(path.join(root, 'examples/habit-events'), dir, { recursive: true });
  const url = (await cli(['pr', 'feat/habit-events', '--repo', repo, '--dir', dir, '--detach', '--no-open', '--port', '0'])).stdout.toString().trim();
  const snap: Snapshot = {};
  const runs = FORMS.flatMap(([form, query, vp]) => ['light', 'dark'].flatMap((theme) => STATES.map(([state, js]) => ({ name: `${form}/${theme}/${state}`, url: url + query, vp, theme, js }))));
  try {
    for (const run of runs) snap[run.name] = await shot(run);
  } finally {
    await cli(['stop', '--repo', repo, '--dir', dir]).nothrow();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(out, JSON.stringify(snap));
  console.log(`${out}: ${Object.entries(snap).map(([k, d]) => `${k} ${Object.keys(d).length}`).join(', ')}`);
}

/** One state's dump: a fresh page in that form and theme, after `js` has run. */
async function shot({ name, url, vp, theme, js }: { name: string; url: string; vp: Viewport; theme: string; js: string }): Promise<Dump> {
  const page = await openPage(url, vp);
  try {
    await page.evaluate(STILL);
    await page.evaluate(`(document.documentElement.dataset.rrTheme = '${theme}', true)`); // what app.ts applies for the theme pref
    if (js) await page.evaluate(`(${js}, true)`);
    await Bun.sleep(1500); // panels mount, diagrams render
    const dump = JSON.parse(await page.evaluate<string>(DUMP)) as Dump;
    const errors = page.errors();
    if (errors.length) throw new Error(`${name}: page errors:\n  ${errors.join('\n  ')}`);
    return dump;
  } finally {
    await page.close();
  }
}

/** Differences between two snapshots, one line per state and change, most frequent first. */
export function diff(a: Snapshot, b: Snapshot): string[] {
  const lines: string[] = [];
  for (const state of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[state] ?? {}, y = b[state] ?? {};
    const counts = new Map<string, number>();
    const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const el of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const tag = el.split('>').at(-1)!.replace(/:\d+$/, '');
      if (!x[el] || !y[el]) add(`${x[el] ? 'gone' : 'new'}: ${tag}`);
      else PROPS.filter((p) => x[el][p] !== y[el][p]).forEach((p) => add(`${p}: ${x[el][p]} -> ${y[el][p]} (${tag})`));
    }
    for (const [k, n] of [...counts].sort((p, q) => q[1] - p[1])) lines.push(`${state}  ${n}x  ${k}`);
  }
  return lines;
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--diff' && rest.length === 2) {
    const [a, b] = rest.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as Snapshot);
    const lines = diff(a, b);
    console.log(lines.length ? lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n... ${lines.length - 200} more` : '') : 'no differences');
    process.exit(lines.length ? 1 : 0);
  } else if (first && !first.startsWith('-') && !rest.length) await capture(first);
  else {
    console.error('usage: bun scripts/snapshot.ts <out.json> | --diff <a.json> <b.json>');
    process.exit(2);
  }
}
