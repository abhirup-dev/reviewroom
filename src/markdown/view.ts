import DOMPurify from 'dompurify';
import { h, icon } from '../core/dom';
import { formatRef } from '../core/refs';
import type { ReviewApp } from '../shell/app';
import { threadCard } from '../panels/code';
import { compute } from './client';
import type { Block, BlockSide, DocumentDiff, InlineDiff, Span } from './model';

interface Options { before: string | null; after: string | null; side?: 'base' | 'head'; start?: number; end?: number; compact?: boolean; single?: boolean; contents?: string }
const caches = new WeakMap<ReviewApp, Map<string, Promise<DocumentDiff>>>();

function load(app: ReviewApp, path: string, options: Options): Promise<DocumentDiff> {
  if (options.contents !== undefined) return compute({ kind: 'document', before: null, after: options.contents }).then((result) => {
    if (Array.isArray(result)) throw new Error('Invalid Markdown result');
    return result;
  });
  let cache = caches.get(app);
  if (!cache) caches.set(app, (cache = new Map()));
  const key = JSON.stringify([path, options.before, options.after]);
  const hit = cache.get(key);
  if (hit) return hit;
  const previous = app.files.find((f) => f.path === path)?.prevPath ?? path;
  const promise = Promise.all([
    options.before === null ? null : app.read(previous, options.before),
    options.after === null ? null : app.read(path, options.after),
  ]).then(async ([before, after]) => {
    if ((options.before !== null && before === null) || (options.after !== null && after === null)) throw new Error('File contents are unavailable. Open Source to inspect this file.');
    const model = await compute({ kind: 'document', before, after });
    if (Array.isArray(model)) throw new Error('Invalid Markdown result');
    return model;
  }).catch((error: unknown) => { cache.delete(key); throw error; });
  cache.set(key, promise);
  const oldest = cache.keys().next().value;
  if (cache.size > 16 && oldest !== undefined) cache.delete(oldest);
  return promise;
}

export function markdownView(app: ReviewApp, path: string, options: Options) {
  const element = h('div', { class: 'rr-markdown-view', 'aria-label': `Rendered ${path.split('/').pop()}`, 'aria-busy': 'true' }, h('div', { class: 'rr-empty', role: 'status' }, 'Rendering Markdown…'));
  const rows: { block: Block; element: HTMLElement; threads: HTMLElement; side: 'base' | 'head'; source: BlockSide }[] = [];
  const folds: HTMLDetailsElement[] = [];
  let fullDocument = !!options.single;
  let disposed = false;
  let current: { start?: number; end?: number; side?: 'base' | 'head' } = options;
  const reveal = (start?: number, end?: number, side: 'base' | 'head' = 'head') => {
    current = { start, end, side };
    let target: HTMLElement | undefined;
    for (const row of rows) {
      const source = side === 'base' ? row.block.before : row.block.after;
      const selected = start !== undefined && source !== undefined && source.start <= (end ?? start) && source.end >= start;
      row.element.classList.toggle('is-selected', selected);
      if (selected) row.element.closest('details')?.setAttribute('open', '');
      if (selected && !target) target = row.element;
    }
    if (target && !options.compact) target.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => {
    const threads = app.prefs.inlineThreads ? app.threads().filter((t) => t.anchor.kind === 'code' && t.anchor.path === path && !t.gh?.outdated && !t.gh?.file) : [];
    for (const row of rows) row.threads.replaceChildren(...threads.filter((t) => {
      if (t.anchor.kind !== 'code') return false;
      const source = t.anchor.rev === 'base' ? row.block.before : row.block.after;
      // A modified block is shown once per side; equal blocks share one row.
      return source && (row.block.status === 'equal' || row.side === t.anchor.rev) && t.anchor.end >= source.start && t.anchor.end <= source.end;
    }).map((t) => threadCard(app, t)));
    element.dataset.style = app.prefs.diffStyle;
    element.dataset.focus = app.prefs.focus;
    for (const fold of folds) if (fold.querySelector('.rr-inline-thread,.is-selected')) fold.open = true;
  };
  const offs = [app.bus.on('state', refresh), app.bus.on('prefs', refresh)];
  const ready = load(app, path, options).then(async (model) => {
    if (disposed) return;
    if (model.limited) {
      element.replaceChildren(h('div', { class: 'rr-empty', role: 'status' }, 'This document is too large for rendered comparison. Open Source to inspect it.'));
      return;
    }
    element.replaceChildren();
    const refinements: { before: HTMLElement; after: HTMLElement }[] = [];
    for (const original of model.blocks) {
      const block = options.single ? { ...original, status: 'equal' as const } : original;
      const source = options.side === 'base' ? block.before : block.after ?? block.before;
      if (options.compact && options.start && (!source || source.end < options.start || source.start > (options.end ?? options.start))) continue;
      if (options.compact && !options.start && rows.length >= 12) break;
      const pair = h('section', { class: `rr-md-pair rr-md-pair--${block.status}`, 'data-change': block.status });
      const render = (content: BlockSide, side: 'base' | 'head') => {
        const label = block.status === 'equal' ? '' : side === 'base' ? 'Before' : 'After';
        const prose = h('div', { class: 'rr-md-prose rr-prose', html: DOMPurify.sanitize(content.html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] }) });
        prose.querySelectorAll('input').forEach((input) => { if (input.type === 'checkbox') input.disabled = true; else input.remove(); });
        prose.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; if (!/^(https?:|data:image\/)/i.test(img.getAttribute('src') ?? '')) img.replaceWith(h('span', { class: 'rr-muted' }, img.alt || 'Image')); });
        prose.querySelectorAll('pre > code.language-mermaid').forEach((code) => {
          const diagram = h('rr-mermaid', null, code.textContent ?? '');
          code.parentElement!.replaceWith(diagram);
        });
        prose.querySelectorAll('a').forEach((a) => {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          const href = a.getAttribute('href') ?? '';
          if (href && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) {
            const url = new URL(href, `https://reviewroom.invalid/${path}`);
            a.onclick = (e) => { e.preventDefault(); void app.open(formatRef({ type: 'file', path: decodeURIComponent(url.pathname.slice(1)), rev: side })); };
          }
        });
        const threads = h('div', { class: 'rr-md-threads' });
        const cell = h('div', { class: 'rr-md-block', 'data-side': side, 'data-start': content.start, 'data-end': content.end },
          h('div', { class: 'rr-md-block__tools' }, label ? h('span', { class: 'rr-md-label' }, label) : null,
            options.compact || (options.before !== null && options.before !== app.range.base) || (options.after !== null && options.after !== app.range.head) ? null : h('button', { class: 'rr-icon-btn', title: 'Start a thread on this block', 'aria-label': 'Comment on block', onclick: () => app.compose({ kind: 'code', path, rev: side, start: content.start, end: content.end }) }, icon('thread', 14))), prose, threads);
        rows.push({ block, element: cell, threads, side, source: content });
        pair.append(cell);
        return prose;
      };
      if (block.status === 'equal') render((options.side === 'base' ? block.before : block.after) ?? block.before ?? block.after!, options.side ?? 'head');
      else {
        const old = block.before && render(block.before, 'base');
        const next = block.after && render(block.after, 'head');
        if (old && next && !old.querySelector('rr-mermaid') && !next.querySelector('rr-mermaid')) refinements.push({ before: old, after: next });
      }
      element.append(pair);
    }
    if (!rows.length) element.append(h('div', { class: 'rr-empty' }, 'No Markdown content in this range.'));
    if (!options.single) {
      let group: HTMLElement[] = [];
      const flush = () => {
        if (!group.length) return;
        const fold = h('details', { class: 'rr-md-context' }, h('summary', null, `${group.length} unchanged block${group.length === 1 ? '' : 's'}`));
        group[0].before(fold);
        fold.append(...group);
        folds.push(fold);
        group = [];
      };
      for (const pair of element.querySelectorAll<HTMLElement>(':scope > [data-change]')) {
        if (pair.dataset.change === 'equal') group.push(pair);
        else flush();
      }
      flush();
      if (!options.compact) {
        const scopeLabel = h('span', { class: 'rr-muted' }, 'Changed blocks');
        const toggle = h('button', { class: 'rr-tool', title: 'Show unchanged Markdown blocks', 'aria-pressed': 'false', onclick: () => {
          fullDocument = !fullDocument;
          scopeLabel.textContent = fullDocument ? 'Full document' : 'Changed blocks';
          toggle.textContent = fullDocument ? 'Changes only' : 'Full document';
          toggle.setAttribute('aria-pressed', String(fullDocument));
          folds.forEach((fold) => { fold.open = fullDocument || !!fold.querySelector('.rr-inline-thread,.is-selected'); });
        } }, 'Full document');
        element.prepend(h('div', { class: 'rr-md-scope' }, scopeLabel, toggle));
      }
    }
    refresh();
    reveal(current.start, current.end, current.side);
    if (refinements.length) {
      const result = await compute({ kind: 'inline', pairs: refinements.map((p) => ({ before: p.before.textContent ?? '', after: p.after.textContent ?? '' })) });
      if (!disposed && Array.isArray(result)) result.forEach((diff: InlineDiff, i) => {
        emphasize(refinements[i].before, diff.before, 'del');
        emphasize(refinements[i].after, diff.after, 'ins');
      });
    }
  }).catch((error: unknown) => {
    if (!disposed) element.replaceChildren(h('div', { class: 'rr-empty', role: 'status' }, error instanceof Error ? error.message : 'Markdown could not be rendered. Open Source to inspect it.'));
  }).finally(() => element.setAttribute('aria-busy', 'false'));
  return { element, ready, reveal, dispose: () => { disposed = true; offs.forEach((off) => off()); } };
}

/** Annotate rendered text nodes; never insert markers into Markdown source. */
function emphasize(root: HTMLElement, spans: Span[], tag: 'ins' | 'del') {
  if (!spans.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of nodes) {
    const text = node.data;
    const hits = spans.filter((s) => s.start < offset + text.length && s.end > offset);
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const hit of hits) {
      const start = Math.max(0, hit.start - offset);
      const end = Math.min(text.length, hit.end - offset);
      fragment.append(text.slice(cursor, start), h(tag, null, text.slice(start, end)));
      cursor = end;
    }
    if (hits.length) { fragment.append(text.slice(cursor)); node.replaceWith(fragment); }
    offset += text.length;
  }
}
