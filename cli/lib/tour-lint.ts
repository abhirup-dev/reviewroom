// Whether a walkthrough works as a walkthrough, beyond the schema and its links: what it leaves out, its pacing, and
// (rendered, `walkthrough lint`) whether each step fits the screen. Findings name the step and say how to fix it.
import type { ChangedFile } from '../../src/kernel/state/model.shared.ts';
import { plain } from '../../src/threads/feedback.shared.ts';
import { parseRef } from '../../src/kernel/refs/refs.shared.ts';
import { stepRefs, type StepAudit, type Walkthrough } from '../../src/walkthrough/model.shared.ts';
import { target } from '../../src/walkthrough/model.shared.ts';
import { extractLinks, uncomment } from './links.ts';
import { tourText } from './walkthrough.ts';

export type Finding = { check: string; level: 'warn' | 'info'; where?: string; message: string; fix: string };

const MAX_STEPS = 6; // per chapter
const MAX_TOTAL = 25;
const MAX_WORDS = 120; // a step's text; past this it rarely fits next to the code (an estimate: `lint` measures)
// highlighted lines that fit per ref at 1280x800, by how many refs the step stacks (an estimate: `lint` measures)
const MAX_LINES = { 1: 25, 2: 10 } as const;
const SMALL = 10; // changed lines below which an unshown file is only mentioned
const TEST = /(^|\/)(tests?|__tests__|testdata)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/;
// lock, checksum, doc and generated files: only mentioned, like tests
const SKIP = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|package\.json|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|build\.gradle(\.kts)?)$|\.(sum|sha256|md|pb\.go)$|_generated\.[^/]+$|\.gen\.[^/]+$|(^|\/)dist\//;

/** The static checks. `estimates`: also the text-length and range-width guesses that rendering measures for real. */
export function lintTour(w: Walkthrough, changed: ChangedFile[], symPath: (name: string) => string | undefined, { estimates = true } = {}): Finding[] {
  const out: Finding[] = [];
  const shown = new Set<string>();
  for (const ref of extractLinks(uncomment(tourText(w)))) { // a link in an HTML comment shows nothing
    const r = parseRef(ref);
    const p = r?.type === 'code' || r?.type === 'file' ? r.path : r?.type === 'sym' ? symPath(r.name) : undefined;
    if (p) shown.add(p);
  }
  const missed = changed.filter((f) => !f.binary && !shown.has(f.path) && !(f.prevPath && shown.has(f.prevPath))).sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  const size = (f: ChangedFile) => `${f.path} (+${f.additions} -${f.deletions})`;
  const minor = (f: ChangedFile) => TEST.test(f.path) || SKIP.test(f.path);
  const code = missed.filter((f) => !minor(f));
  const big = code.filter((f) => f.additions + f.deletions >= SMALL);
  if (big.length) out.push({ check: 'unshown-file', level: 'warn', message: `${big.length} changed file(s) no slide shows: ${big.map(size).join(', ')}`, fix: 'Show each on a slide, or link it in a slide\'s text saying why the reader can skip it.' });
  const rest = [...code.filter((f) => !big.includes(f)), ...missed.filter(minor)];
  if (rest.length) out.push({ check: 'unshown-file', level: 'info', message: `also not shown (small, tests, generated, lock or doc files): ${rest.map(size).join(', ')}`, fix: 'Fine to skip; show tests when they are the evidence for a claim.' });

  const total = w.chapters.reduce((n, c) => n + c.steps.length, 0);
  if (total > MAX_TOTAL) out.push({ check: 'too-long', level: 'warn', message: `${total} slides in all`, fix: `Aim for at most ${MAX_TOTAL}: cut slides that restate the code, leave detail to the walkthrough (review.html).` });
  w.chapters.forEach((c, ci) => {
    if (c.steps.length === 1 && w.chapters.length > 1) out.push({ check: 'chapter-size', level: 'warn', where: c.id, message: 'a chapter of one slide', fix: 'Merge it into a neighbouring chapter, or give it the 2 to 5 slides the concept needs.' });
    if (c.steps.length > MAX_STEPS) out.push({ check: 'chapter-size', level: 'warn', where: c.id, message: `${c.steps.length} slides in one chapter`, fix: 'Split it into two concepts.' });
    c.steps.forEach((s, si) => {
      const where = `${c.id}/${s.id}`;
      if (target({ doc: w, chapter: ci, step: si }).kind === 'empty') out.push({ check: 'empty-pane', level: 'warn', where, message: 'the code pane is empty on this slide', fix: 'Give the slide (or an earlier one) a ref, or the chapter lead an <rr-flow>.' });
      if (s.focus) {
        const labels = [...((c.lead ?? '') + s.text).matchAll(/<rr-node\b[^>]*>([\s\S]*?)<\/rr-node>/g)].map((m) => plain(m[1]));
        const gone = s.focus.filter((l) => !labels.includes(l));
        if (gone.length) out.push({ check: 'unknown-focus', level: 'warn', where, message: `focus names no diagram node: ${gone.join(', ')}`, fix: 'Use an <rr-node> label from the chapter lead or this slide, exactly as written.' });
      }
      if (!estimates) return;
      const words = plain(s.text).split(' ').filter(Boolean).length;
      if (words > MAX_WORDS) out.push({ check: 'long-text', level: 'warn', where, message: `${words} words; likely needs scrolling`, fix: 'Split the slide, or move the detail to the walkthrough (review.html) and link it. `reviewroom walkthrough lint` measures it.' });
      const refs = stepRefs(s);
      if (refs.length > 2) out.push({ check: 'short-chunk', level: 'warn', where, message: `${refs.length} refs stacked`, fix: 'Stack at most 2 refs (about 10 lines each), or split the slide.' });
      else for (const ref of refs) {
        const r = parseRef(ref);
        const n = (r?.type === 'code' || r?.type === 'file') && r.start ? (r.end ?? r.start) - r.start + 1 : 0;
        const max = MAX_LINES[refs.length as 1 | 2];
        if (n > max) out.push({ check: 'wide-range', level: 'warn', where, message: `${ref} highlights ${n} lines`, fix: `About ${max} fit${refs.length > 1 ? ' per stacked ref' : ''}: point at the lines the text is about, or split it over steps.` });
      }
    });
  });
  return out;
}

const MIN_VISIBLE = 8; // code lines a stacked chunk should show at once
const LEAD_SHARE = 0.4; // of the narration's height, past which the lead is named as the cause of an overflow

/** One step measured at one viewport (`walkthrough lint`). */
export type Measured = { viewport: string; chapter: string; step: string; audit: StepAudit; errors: string[]; ownRef?: boolean };

/** The rendered checks: what each step looks like on screen. The same problem at several viewports is one finding. */
export function judge(ms: Measured[]): Finding[] {
  const found = new Map<string, Finding & { at: string[] }>();
  const add = (f: Finding, viewport: string, detail: string) => {
    const key = `${f.where}\0${f.check}\0${f.message}`;
    const had = found.get(key);
    if (had) had.at.push(`${viewport}: ${detail}`);
    else found.set(key, { ...f, at: [`${viewport}: ${detail}`] });
  };
  for (const { viewport, chapter, step, audit: a, errors, ownRef = true } of ms) {
    const where = `${chapter}/${step}`;
    const over = a.left.content - a.left.visible;
    if (over > 2) {
      const lead = a.left.lead / a.left.visible > LEAD_SHARE ? ` The chapter lead takes ${Math.round((a.left.lead / a.left.visible) * 100)}% of it: shorten the lead, or move its diagram onto a slide (where the pane shows it).` : '';
      add({ check: 'overflow', level: 'warn', where, message: 'the narration needs scrolling', fix: `Shorten or split the slide; move detail to the walkthrough (review.html) and link it.${lead}` }, viewport, `${over}px more than the ${a.left.visible}px it has`);
    }
    // a step without a ref shows the previous pane: its chunk findings are that step's
    for (const c of ownRef ? a.chunks : []) {
      const r = parseRef(c.ref);
      if (!c.code && (r?.type === 'code' || r?.type === 'file' || r?.type === 'sym'))
        add({ check: 'no-code', level: 'warn', where, message: `${c.ref} shows a preview card, not code`, fix: 'The symbol or file was not found: link the code with rr:code/<path>#L<a>-<b>.' }, viewport, 'preview');
      if (c.hidden) {
        const fit = c.lines - c.hidden;
        const narrow = (r?.type === 'code' || r?.type === 'file') && r.start ? ` such as ${c.ref.replace(/#.*$/, '')}#L${r.start}-${r.start + fit - 1}` : '';
        add({ check: 'hidden-lines', level: 'warn', where, message: `highlighted lines of ${c.ref} are off screen`, fix: `About ${fit} lines fit: point at fewer${narrow}, or split them over slides (each can show a part). ast-grep outline gives exact declaration ranges.` }, viewport, `${c.hidden} of ${c.lines}, ${fit} fit`);
      }
      else if (c.code && a.chunks.length > 1 && c.visible < MIN_VISIBLE)
        add({ check: 'short-chunk', level: 'warn', where, message: `${a.chunks.length} stacked chunks leave ${c.ref} too little room`, fix: 'Stack at most 2 or 3 chunks, or split the slide.' }, viewport, `${c.visible} lines visible`);
    }
    for (const w of a.wide) add({ check: 'too-wide', level: 'warn', where, message: `content wider than its box (${w})`, fix: 'Narrow it (fewer columns or nodes, shorter lines), or move it to review.html.' }, viewport, 'scrolls sideways');
    if (a.stripped.lead.length) add({ check: 'stripped', level: 'warn', where: chapter, message: `the lead loses ${a.stripped.lead.join(', ')}`, fix: 'Guided walkthrough prose is display-only (it can come from a PR): text, http(s) and rr: links, <rr-ref>, <rr-code>, <rr-flow>, <rr-callout>, <rr-embed>; no scripts, styles, forms, media or <rr-check>.' }, viewport, 'removed');
    if (a.stripped.text.length) add({ check: 'stripped', level: 'warn', where, message: `the text loses ${a.stripped.text.join(', ')}`, fix: 'Guided walkthrough prose is display-only (it can come from a PR): text, http(s) and rr: links, <rr-ref>, <rr-code>, <rr-flow>, <rr-callout>, <rr-embed>; no scripts, styles, forms, media or <rr-check>.' }, viewport, 'removed');
    for (const e of errors) add({ check: 'page-error', level: 'warn', where, message: e.slice(0, 200), fix: 'An error on the page while this slide showed: check its HTML.' }, viewport, 'console');
    if (!a.settled) add({ check: 'unsettled', level: 'info', where, message: 'the page was still changing when measured', fix: 'The numbers for this slide may be off; measure it again.' }, viewport, 'timed out');
  }
  return [...found.values()].map(({ at, ...f }) => ({ ...f, message: `${f.message} (${at.join('; ')})` }));
}

/** Findings for the agent, grouped by where they are (the whole walkthrough first, then in walkthrough order). */
export function findingReport(fs: Finding[], w: Walkthrough) {
  const order = ['', ...w.chapters.flatMap((c) => [c.id, ...c.steps.map((s) => `${c.id}/${s.id}`)])];
  const groups = new Map<string, Finding[]>();
  const rank = (f: Finding) => (order.indexOf(f.where ?? '') + 1 || order.length + 1); // unknown places last
  for (const f of [...fs].sort((a, b) => rank(a) - rank(b))) groups.set(f.where ?? '', [...(groups.get(f.where ?? '') ?? []), f]);
  return [...groups].map(([where, g]) => `${where ? `[${where}]` : '[guided walkthrough]'}\n${g.map((f) => `  ${f.level.padEnd(4)} ${f.check}: ${f.message}\n       fix: ${f.fix}`).join('\n')}`).join('\n');
}
