// Review previews depend on review data, never on panels or optional feature implementations.
import { FileDiff, File as PierreFile, parseDiffFromFile } from '@pierre/diffs';
import { avatarUrl, h } from '../kernel/dom';
import { parseRef, type Ref } from '../kernel/refs/browser';
import { plainExcerpt } from '../kernel/markdown';
import type { ReviewApp } from '../app';

/** Shared Pierre styling for both code panels and inline previews. */
export const PIERRE_CSS = `:host{--rr-diff-mix-light:40%;--rr-diff-mix-dark:10%;--diffs-light-bg:var(--rr-panel)!important;--diffs-dark-bg:var(--rr-panel)!important;--diffs-font-family:var(--rr-mono)!important;--diffs-light-addition-color:var(--rr-add);--diffs-dark-addition-color:var(--rr-add);--diffs-light-deletion-color:var(--rr-del);--diffs-dark-deletion-color:var(--rr-del);--diffs-bg-addition-override:light-dark(color-mix(in lab,var(--diffs-bg) 88%,var(--diffs-addition-base)),color-mix(in lab,var(--diffs-bg) 88%,var(--diffs-addition-base)));--diffs-bg-deletion-override:light-dark(color-mix(in lab,var(--diffs-bg) 88%,var(--diffs-deletion-base)),color-mix(in lab,var(--diffs-bg) 88%,var(--diffs-deletion-base)));}[data-line],[data-no-newline]{--mix-light:var(--rr-diff-mix-light);--mix-dark:var(--rr-diff-mix-dark)}`;

export type PreviewOptions = { compact?: boolean };
export type PreviewExtensions = {
  tour?: (app: ReviewApp, ref: Extract<Ref, { type: 'tour' }>, opts: PreviewOptions) => HTMLElement | Promise<HTMLElement>;
};
const extensions: PreviewExtensions = {};

/** Boot supplies optional feature rendering before mounting review elements. */
export function registerPreviewExtensions(next: PreviewExtensions) {
  Object.assign(extensions, next);
}

// ------------------------------------------------------------------ snippets
/** @pierre/diffs options for code in the review: our colours on `surface`, light/dark following the page. */
export function codeOptions(surface = '--rr-panel') {
  return {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: 'system' as const,
    disableFileHeader: true,
    overflow: 'scroll' as const,
    // inherit the page's color-scheme (tokens.css) so pierre's light-dark() colours follow the review theme; --rr-wrap: hover card's wrap toggle
    unsafeCSS: PIERRE_CSS.replace(/var\(--rr-panel\)/g, `var(${surface})`) + ':host{color-scheme:inherit}[data-line]{white-space:var(--rr-wrap,pre);word-break:break-word}',
  };
}
// pierre holds every instance in a static resize map until cleanUp(): release the previews that have left the page
const live = new Map<HTMLElement, [{ cleanUp(): void }, number]>();
const track = (box: HTMLElement, inst: { cleanUp(): void }) => {
  for (const [b, [i, t]] of live) {
    if (b.isConnected || Date.now() - t < 5000) continue;
    i.cleanUp();
    live.delete(b);
  }
  live.set(box, [inst, Date.now()]);
};
export const range = (start: number, end: number) => ({ startingLine: start - 1, totalLines: end - start + 1, bufferBefore: 0, bufferAfter: 0 });

async function snippet(app: ReviewApp, r: Extract<Ref, { type: 'code' | 'file' }>, context = 2, opts: { endAt?: number } = {}): Promise<HTMLElement> {
  const rev = app.revOf(r.rev);
  const text = await app.read(r.path, rev);
  if (text === null) return h('div', { class: 'rr-empty' }, `${r.path.split('/').pop()} isn't in this version`);
  const box = h('div', { class: 'rr-snippet' });
  // a changed file without lines: its hunks
  const diff = !r.start && r.type === 'code' && r.rev === 'head' ? await changedDiff(app, r.path, text) : null;
  if (diff?.hunks.length) {
    const fd = new FileDiff({ ...codeOptions(), diffStyle: 'unified', hunkSeparators: 'simple' });
    fd.render({ fileDiff: diff, containerWrapper: box });
    track(box, fd);
    return box;
  }
  const lines = text.split('\n').length;
  const file = new PierreFile(codeOptions());
  const [s, e] = r.start ? [Math.max(1, r.start - context), Math.min(lines, (opts.endAt ?? r.end ?? r.start) + context)] : [1, Math.min(lines, 25)];
  file.render({ file: { name: r.path, contents: text }, containerWrapper: box, renderRange: range(s, e) });
  track(box, file);
  if (r.start) file.setSelectedLines({ start: r.start, end: r.end ?? r.start }, { notify: false });
  return box;
}

/** The diff of a changed file against the base. */
async function changedDiff(app: ReviewApp, path: string, head: string) {
  const f = app.files.find((x) => x.path === path);
  if (!f || (f.status !== 'modified' && f.status !== 'renamed')) return null;
  const base = await app.read(f.prevPath ?? path, app.revFor('base'));
  if (base === null) return null;
  return parseDiffFromFile({ name: f.prevPath ?? path, contents: base }, { name: path, contents: head });
}

// shortcut: bracket/indent heuristic, not a parser (braces in strings can end it early); swap for a provider symbol range if that lands.
/** Last line of the declaration starting at `start`: to its closing bracket, or through its indented body. */
function declEnd(lines: string[], start: number, max = 40): number {
  const last = Math.min(lines.length, start + max - 1);
  const indent = (s: string) => s.length - s.trimStart().length;
  let depth = 0;
  let opened = false;
  for (let i = start; i <= last; i++) {
    for (const c of lines[i - 1]) {
      if (c === '{' || c === '(' || c === '[') {
        depth++;
        opened = true;
      } else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (i === start && depth <= 0) break; // one-liner or indent-scoped (Python, YAML): fall through
    if (opened && depth <= 0) return i;
  }
  let end = start;
  for (let i = start + 1; i <= last; i++) {
    if (!lines[i - 1].trim()) continue;
    if (indent(lines[i - 1]) <= indent(lines[start - 1])) break;
    end = i;
  }
  return end;
}

export async function renderPreview(app: ReviewApp, ref: string, opts: PreviewOptions = {}): Promise<HTMLElement> {
  const r = parseRef(ref);
  if (!r) return h('div', { class: 'rr-empty' }, 'This link is broken');
  switch (r.type) {
    case 'doc': {
      const el = app.docElement(r.id, r.path);
      if (!el) return h('div', { class: 'rr-empty' }, 'This part of the review no longer exists');
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      clone.removeAttribute('id');
      clone.querySelectorAll('script').forEach((n) => n.remove());
      // widgets that render into shadow DOM don't survive cloneNode: re-run them from source
      clone.querySelectorAll('rr-code, rr-embed, rr-mermaid').forEach((n) => {
        const el = n as HTMLElement;
        if (el.dataset.src === undefined) return;
        delete el.dataset.ready;
        el.replaceChildren(el.dataset.src);
      });
      if (clone.matches('rr-code, rr-embed, rr-mermaid') && clone.dataset.src !== undefined) {
        delete clone.dataset.ready;
        clone.replaceChildren(clone.dataset.src);
      }
      return h('div', { class: 'rr-embed__doc rr-prose' }, clone);
    }
    case 'code':
    case 'file':
      return snippet(app, r, opts.compact ? 1 : 2);
    case 'sym': {
      const hits = await app.searchSymbol(r.name);
      const d = hits.find((x) => x.kind === 'definition') ?? hits[0];
      if (!d) return h('div', { class: 'rr-empty' }, `No definition of ${r.name}`);
      const text = await app.read(d.path, d.rev);
      const endAt = text === null ? d.line : declEnd(text.split('\n'), d.line);
      return h('div', null, h('div', { class: 'rr-embed__sub' }, `${d.path}:${d.line}`), await snippet(app, { type: 'file', path: d.path, rev: d.rev, start: d.line, end: d.line }, 1, { endAt }));
    }
    case 'thread': {
      const t = app.thread(r.id);
      if (!t) return h('div', { class: 'rr-empty' }, 'Thread not found');
      return h(
        'div',
        { class: 'rr-embed__thread' },
        // GitHub comments are a colleague's (or yours): their login and avatar, not "you"
        ...t.messages.slice(-2).map((m) =>
          h(
            'div',
            { class: 'rr-embed__msg' },
            m.gh?.avatar ? h('img', { class: 'rr-embed__avatar', src: avatarUrl(m.gh.avatar, 32), alt: '', loading: 'lazy' }) : null,
            h('strong', null, m.gh ? m.gh.login : m.author === 'agent' ? 'agent' : 'you'),
            ' ',
            plainExcerpt(m.body, 160),
          ),
        ),
      );
    }
    case 'round':
      return h('div', null, `Round ${r.n}`);
    case 'tour':
      return extensions.tour?.(app, r, opts) ?? h('div', { class: 'rr-empty' }, 'Guided walkthrough previews are unavailable');
  }
}
