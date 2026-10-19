import { Virtualizer, VirtualizedFileDiff, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffOptions } from '@pierre/diffs';
import { h } from '../core/dom';
import { oldToNewLine } from '../core/hunks';

type MarkdownView = ReturnType<typeof import('../markdown/view').markdownView>;
export interface MixedItem {
  path: string;
  diff: FileDiffMetadata;
  markdown: boolean;
  collapsed: boolean;
  annotations: DiffLineAnnotation<{ threadId: string }>[];
}
interface Callbacks {
  options(path: string): FileDiffOptions<{ threadId: string }, undefined>;
  header(path: string): HTMLElement | undefined;
  markdown(path: string): Promise<MarkdownView>;
}
interface RecordEntry {
  item: MixedItem;
  element: HTMLElement;
  body?: HTMLElement;
  source?: VirtualizedFileDiff<{ threadId: string }>;
  view?: MarkdownView;
  loading?: Promise<void>;
  disposed: boolean;
}

/** A shared scroll viewport: Pierre virtualizes source lines; Markdown is loaded near the viewport. */
export class MixedDiffList {
  private virtualizer = new Virtualizer();
  private records = new Map<string, RecordEntry>();
  private observer: IntersectionObserver;
  constructor(private root: HTMLElement, private callbacks: Callbacks) {
    this.virtualizer.setup(root);
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const record = this.records.get((entry.target as HTMLElement).dataset.file ?? '');
        if (entry.isIntersecting && record) void this.loadMarkdown(record);
      }
    }, { root, rootMargin: '600px' });
  }

  setItems(items: MixedItem[]) {
    const paths = new Set(items.map((item) => item.path));
    for (const [path, record] of this.records) if (!paths.has(path)) { this.remove(record); this.records.delete(path); }
    let previous: HTMLElement | undefined;
    for (const item of items) {
      let record = this.records.get(item.path);
      if (record && (record.item.markdown !== item.markdown || record.item.diff !== item.diff)) {
        this.remove(record);
        this.records.delete(item.path);
        record = undefined;
      }
      if (!record) {
        record = { item, element: h('section', { class: 'rr-mixed-file', 'data-file': item.path }), disposed: false };
        this.records.set(item.path, record);
        if (item.markdown) {
          record.body = h('div', { class: 'rr-mixed-body' }, h('div', { class: 'rr-empty', role: 'status' }, 'Markdown preview'));
          record.element.append(this.callbacks.header(item.path) ?? h('div'), record.body);
          this.observer.observe(record.element);
        } else record.source = new VirtualizedFileDiff(this.callbacks.options(item.path), this.virtualizer, { diffHeaderHeight: 38 });
      }
      record.item = item;
      const next = previous ? previous.nextElementSibling : this.root.firstElementChild;
      if (next !== record.element) this.root.insertBefore(record.element, next);
      previous = record.element;
      if (record.body) {
        record.element.firstElementChild?.replaceWith(this.callbacks.header(item.path) ?? h('div'));
        record.body.hidden = item.collapsed;
        const bounds = record.element.getBoundingClientRect();
        const viewport = this.root.getBoundingClientRect();
        if (!item.collapsed && bounds.top < viewport.bottom + 600 && bounds.bottom > viewport.top - 600) void this.loadMarkdown(record);
      } else if (record.source) {
        record.source.setOptions({ ...this.callbacks.options(item.path), collapsed: item.collapsed });
        record.source.render({ fileDiff: item.diff, containerWrapper: record.element, lineAnnotations: item.annotations });
      }
    }
    this.virtualizer.markDOMDirty();
  }

  private loadMarkdown(record: RecordEntry): Promise<void> {
    if (!record.body || record.item.collapsed || record.disposed || record.view) return Promise.resolve();
    if (record.loading) return record.loading;
    return (record.loading = this.callbacks.markdown(record.item.path).then(async (view) => {
      if (record.disposed) { view.dispose(); return; }
      record.view = view;
      record.body!.replaceChildren(view.element);
      await view.ready;
      this.virtualizer.markDOMDirty();
    }).catch(() => {
      if (!record.disposed) record.body!.replaceChildren(h('div', { class: 'rr-empty' }, 'Markdown is unavailable. Switch this file to Source.'));
    }));
  }

  async reveal(path: string, start?: number, end?: number, side: 'base' | 'head' = 'head', signal?: AbortSignal) {
    const record = this.records.get(path);
    if (!record || signal?.aborted) return;
    this.virtualizer.scrollTo({ top: this.top(path) });
    if (record.item.markdown) {
      await this.loadMarkdown(record);
      if (!signal?.aborted && !record.disposed) {
        this.virtualizer.scrollTo({ top: this.top(path) });
        record.view?.reveal(start, end, side);
      }
      return;
    }
    const source = record.source;
    if (!source || !start) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (record.item.diff.isPartial) await source.prepareForEditing();
    if (signal?.aborted || record.disposed) return;
    const line = side === 'head' ? start : oldToNewLine(record.item.diff.hunks, start);
    if (line) source.revealLine(line);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (signal?.aborted || record.disposed) return;
    const selectionSide = side === 'base' ? 'deletions' : 'additions';
    source.setSelectedLines({ start, end: end ?? start, side: selectionSide }, { notify: false });
    const position = source.getLinePosition(start, selectionSide);
    if (position) this.root.scrollTop = this.top(path) + position.top - 70;
  }

  top(path: string) {
    const element = this.records.get(path)?.element;
    return element ? element.getBoundingClientRect().top - this.root.getBoundingClientRect().top + this.root.scrollTop : 0;
  }

  changeStops() {
    return [...this.records.values()].flatMap((record) => {
      if (record.item.collapsed) return [];
      if (record.view) return [...record.element.querySelectorAll<HTMLElement>('[data-change]:not([data-change="equal"])')].map((element) => element.getBoundingClientRect().top - this.root.getBoundingClientRect().top + this.root.scrollTop);
      return record.item.diff.hunks.flatMap((hunk) => hunk.hunkContent.flatMap((c) => {
        if (c.type !== 'change') return [];
        const position = record.source?.getLinePosition(c.additions ? c.additionLineIndex + 1 : c.deletionLineIndex + 1, c.additions ? 'additions' : 'deletions');
        return position ? [this.top(record.item.path) + position.top] : [];
      }));
    }).sort((a, b) => a - b);
  }

  clearSelection() {
    for (const record of this.records.values()) record.source?.setSelectedLines(null, { notify: false });
  }

  private remove(record: RecordEntry) {
    record.disposed = true;
    this.observer.unobserve(record.element);
    record.source?.cleanUp();
    record.view?.dispose();
    record.element.remove();
  }
  dispose() {
    this.observer.disconnect();
    for (const record of this.records.values()) this.remove(record);
    this.records.clear();
    this.virtualizer.cleanUp();
  }
}
