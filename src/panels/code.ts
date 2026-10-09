// Code panel: the whole diff as a stack of files (lazy-rendered with @pierre/diffs),
// or one full file at base/head/any sha. Supports several instances ("code", "code:2"…).
import { FileDiff, File as PierreFile, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from '@pierre/diffs';
import { h, icon } from '../core/dom';
import { formatRef } from '../core/refs';
import { plainExcerpt } from '../core/markdown';
import type { ChangedFile, Thread } from '../core/types';
import { definePanel, floatBox, type PanelInstance } from '../shell/layout';
import { popMenu, menuItem, menuLabel } from '../shell/chrome';
import type { CodeTarget, ReviewApp } from '../shell/app';

type Meta = { threadId: string };

/** Blend @pierre/diffs into the panel colours (custom properties cross the shadow boundary). */
export const PIERRE_CSS = `:host{--diffs-light-bg:var(--rr-panel)!important;--diffs-dark-bg:var(--rr-panel)!important;--diffs-font-family:var(--rr-mono)!important;}`;

interface Block {
  file: ChangedFile;
  el: HTMLElement;
  body: HTMLElement;
  inst?: FileDiff<Meta>;
  rendering?: Promise<void>;
  collapsed: boolean;
}

const STATUS: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

export function threadCard(app: ReviewApp, t: Thread): HTMLElement {
  const last = t.messages[t.messages.length - 1];
  const first = t.messages[0];
  const card = h(
    'button',
    {
      class: 'rr-inline-thread' + (t.status === 'resolved' ? ' is-resolved' : '') + (app.unreadAgent(t) ? ' has-agent' : ''),
      'data-thread': t.id,
      title: `Open thread · ${t.messages.length} message${t.messages.length > 1 ? 's' : ''}${t.status === 'resolved' ? ' · resolved' : ''}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        app.bus.emit('open-thread', { id: t.id });
      },
    },
    h('span', { class: 'rr-inline-thread__count' }, String(t.messages.length)),
    h('span', { class: 'rr-inline-thread__text' }, plainExcerpt(first?.body ?? '', 110)),
    last && last !== first ? h('span', { class: 'rr-inline-thread__last' }, (last.author === 'agent' ? 'agent: ' : 'you: ') + plainExcerpt(last.body, 60)) : null,
    t.status === 'resolved' ? h('span', { class: 'rr-pill rr-pill--ok' }, 'resolved') : null,
  );
  return h('div', { class: 'rr-inline-thread-wrap' }, card);
}

class CodePanel implements PanelInstance {
  element: HTMLElement;
  private toolbar: HTMLElement;
  private scroller: HTMLElement;
  private stack: HTMLElement;
  private blocks = new Map<string, Block>();
  private io: IntersectionObserver;
  private mode: 'diff' | 'file' = 'diff';
  private fileView?: { path: string; side: 'base' | 'head'; rev?: string; inst?: PierreFile<Meta> };
  private lastPointer = { x: 0, y: 0 };
  private offs: (() => void)[] = [];
  private isPrimary: boolean;
  /** Single-file panel (opened via “open in new panel”): shows only this path as diff, before or after. */
  private pin?: string;

  constructor(private app: ReviewApp, private panelId: string, params: Record<string, unknown>) {
    this.isPrimary = panelId === 'code';
    this.pin = (params.pin as string) || undefined;
    this.toolbar = h('div', { class: 'rr-toolbar' });
    this.stack = h('div', { class: 'rr-diff-stack' });
    this.scroller = h('div', { class: 'rr-scroll rr-code-scroll', tabindex: '0', 'data-rr-scope': 'code' }, this.stack);
    this.element = h('div', { class: 'rr-code-panel' }, this.toolbar, this.scroller);
    this.scroller.addEventListener('pointerup', (e) => (this.lastPointer = { x: e.clientX, y: e.clientY }), true);
    this.io = new IntersectionObserver((entries) => entries.forEach((en) => en.isIntersecting && this.renderBlock((en.target as HTMLElement).dataset.path!)), { root: this.scroller, rootMargin: '900px 0px' });
    this.scroller.addEventListener('scroll', () => this.trackActive(), { passive: true });

    this.offs.push(
      app.bus.on('files', () => this.rebuild()),
      app.bus.on('prefs', () => this.refreshOptions(true)),
      app.bus.on('theme', (t) => {
        this.blocks.forEach((b) => b.inst?.setThemeType(t));
        this.fileView?.inst?.setThemeType(t);
      }),
      app.bus.on('state', () => this.refreshAnnotations()),
      app.bus.on('reveal-code', (t) => {
        if ((t.panel ?? 'code') === this.panelId) this.reveal(t);
      }),
      app.bus.on('selection', (sel) => {
        // Esc / clearing the selection also clears the highlighted line range
        if (sel) return;
        this.blocks.forEach((b) => b.inst?.setSelectedLines(null));
        this.fileView?.inst?.setSelectedLines(null);
      }),
    );
    this.element.addEventListener('rr-code-cmd', (e) => {
      const c = (e as CustomEvent).detail;
      if (c === 'next') this.jumpChange(1);
      else if (c === 'prev') this.jumpChange(-1);
      else if (c === 'nextFile') this.jumpFile(1);
      else if (c === 'prevFile') this.jumpFile(-1);
    });
    this.rebuild();
    if (this.pin && (params.view === 'base' || params.view === 'head')) queueMicrotask(() => this.openFile(this.pin!, params.view as 'base' | 'head'));
    else if (params.path && !this.pin) queueMicrotask(() => this.reveal(params as unknown as CodeTarget));
  }

  // ------------------------------------------------------------ toolbar
  private renderToolbar() {
    const p = this.app.prefs;
    const seg = (items: [string, string, boolean, () => void, string?][]) =>
      h('div', { class: 'rr-seg', role: 'group' }, ...items.map(([label, title, on, fn, keys]) => h('button', { class: on ? 'is-on' : '', title, 'data-keys': keys, 'aria-pressed': String(on), onclick: fn }, label)));
    const tog = (ic: Parameters<typeof icon>[0], title: string, on: boolean, fn: () => void, text?: string, keys?: string) =>
      h('button', { class: 'rr-tool' + (on ? ' is-on' : ''), title, 'data-keys': keys, 'aria-label': title, 'aria-pressed': String(on), onclick: fn }, icon(ic, 14), text ? h('span', null, text) : null);
    const left: (HTMLElement | null)[] = [];
    if (this.pin) {
      const f = this.app.files.find((x) => x.path === this.pin);
      const view = this.mode === 'diff' ? 'diff' : this.fileView?.side;
      left.push(
        h('span', { class: 'rr-toolbar__path', title: this.pin }, this.pin.split('/').pop()!),
        h(
          'div',
          { class: 'rr-seg', role: 'group', 'aria-label': 'View' },
          h('button', { class: view === 'diff' ? 'is-on' : '', disabled: !f, title: 'Diff of this file', onclick: () => this.setMode('diff') }, 'Diff'),
          h('button', { class: view === 'base' ? 'is-on' : '', disabled: f?.status === 'added', title: 'Whole file before the change', onclick: () => this.openFile(this.pin!, 'base') }, 'Before'),
          h('button', { class: view === 'head' ? 'is-on' : '', disabled: f?.status === 'deleted', title: 'Whole file after the change', onclick: () => this.openFile(this.pin!, 'head') }, 'After'),
        ),
      );
      this.app.dock?.getPanel(this.panelId)?.api.setTitle(`${this.pin.split('/').pop()} · ${view === 'diff' ? 'diff' : view === 'base' ? 'before' : 'after'}`);
    } else if (this.mode === 'file' && this.fileView) {
      const fv = this.fileView;
      left.push(
        h('button', { class: 'rr-tool rr-tool--back', title: 'Back to the diff', onclick: () => this.setMode('diff') }, icon('chevron', 14), h('span', null, 'Diff')),
        h('span', { class: 'rr-toolbar__path', title: fv.path }, fv.path),
        seg([
          ['base', 'Show the file before the change', !fv.rev && fv.side === 'base', () => this.openFile(fv.path, 'base')],
          ['head', 'Show the file after the change', !fv.rev && fv.side === 'head', () => this.openFile(fv.path, 'head')],
        ]),
        fv.rev ? h('span', { class: 'rr-pill' }, '@' + fv.rev.slice(0, 7)) : null,
      );
    } else {
      const vis = this.app.visibleFiles();
      const adds = vis.reduce((a, f) => a + f.additions, 0);
      const dels = vis.reduce((a, f) => a + f.deletions, 0);
      left.push(
        h('span', { class: 'rr-toolbar__title', title: vis.length === this.app.files.length ? 'Files changed in this range' : `${vis.length} shown, ${this.app.files.length - vis.length} hidden by the Files filters` }, `${vis.length} file${vis.length === 1 ? '' : 's'}`),
        h('span', { class: 'rr-delta', title: `${adds} lines added, ${dels} removed` }, h('span', { class: 'rr-add' }, '+' + adds), h('span', { class: 'rr-del' }, '−' + dels)),
        this.app.range && this.app.range.key !== 'all' ? h('span', { class: 'rr-pill rr-pill--accent', title: 'Showing one commit: ' + this.app.range.label + '. Pick “All changes” in Files to see the whole PR.' }, this.app.range.label.split(' · ')[0]) : null,
      );
    }
    this.toolbar.replaceChildren(
      h('div', { class: 'rr-toolbar__group' }, ...left),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-toolbar__group' },
        this.mode === 'diff'
          ? seg([
              ['Split', 'Side-by-side: old on the left, new on the right', p.diffStyle === 'split', () => this.app.setPref('diffStyle', 'split'), 's'],
              ['Unified', 'One column: removed lines above the lines that replace them', p.diffStyle === 'unified', () => this.app.setPref('diffStyle', 'unified'), 's'],
            ])
          : null,
        this.mode === 'diff'
          ? seg([
              ['All', 'Show added and removed lines', p.focus === 'all', () => this.app.setPref('focus', 'all')],
              ['+', 'Focus on new code: hide removed lines', p.focus === 'additions', () => this.app.setPref('focus', 'additions'), '+'],
              ['−', 'Focus on old code: hide added lines', p.focus === 'deletions', () => this.app.setPref('focus', 'deletions'), '-'],
            ])
          : null,
        this.mode === 'diff' ? tog('filter', 'Ignore whitespace-only changes', p.ignoreWhitespace, () => this.app.setPref('ignoreWhitespace', !p.ignoreWhitespace), 'ws', 'i') : null,
        tog('wrap', 'Wrap long lines instead of scrolling sideways', p.wrap, () => this.app.setPref('wrap', !p.wrap), undefined, 'w'),
        this.mode === 'diff' ? tog('thread', 'Show comment threads inside the diff, under the lines they are on', p.inlineThreads, () => this.app.setPref('inlineThreads', !p.inlineThreads)) : null,
        this.mode === 'diff'
          ? h('div', { class: 'rr-seg' }, h('button', { title: 'Previous change', 'data-keys': 'k', 'aria-label': 'Previous change', onclick: () => this.jumpChange(-1) }, icon('arrowUp', 14)), h('button', { title: 'Next change (moves to the next file at the end)', 'data-keys': 'j', 'aria-label': 'Next change', onclick: () => this.jumpChange(1) }, icon('arrowDown', 14)))
          : null,
      ),
    );
  }

  private setMode(m: 'diff' | 'file') {
    this.mode = m;
    if (m === 'diff') {
      this.fileView?.inst?.cleanUp();
      this.fileView = undefined;
      this.rebuild();
    }
  }

  // ------------------------------------------------------------ diff stack
  private rebuild() {
    if (this.mode !== 'diff') return this.renderToolbar();
    this.blocks.forEach((b) => b.inst?.cleanUp());
    this.blocks.clear();
    this.io.disconnect();
    const files = this.pin ? this.app.files.filter((f) => f.path === this.pin) : this.app.visibleFiles();
    this.stack.replaceChildren();
    if (!files.length) this.stack.append(h('div', { class: 'rr-empty' }, this.app.files.length ? 'All files are hidden by the current filters.' : 'No changes in this range.'));
    for (const f of files) {
      const viewed = this.app.state.viewed[f.path] !== undefined;
      const body = h('div', { class: 'rr-file__body' });
      const el = h('section', { class: 'rr-file', 'data-path': f.path }, this.fileHeader(f), body);
      const est = Math.min(2400, 64 + (f.additions + f.deletions + 8) * 20);
      body.style.minHeight = est + 'px';
      const b: Block = { file: f, el, body, collapsed: viewed };
      if (viewed) el.classList.add('is-collapsed');
      this.blocks.set(f.path, b);
      this.stack.append(el);
      this.io.observe(el);
    }
    this.renderToolbar();
  }

  private fileHeader(f: ChangedFile) {
    const app = this.app;
    const threads = app.state.threads.filter((t) => t.anchor.kind === 'code' && t.anchor.path === f.path && t.status === 'open').length;
    const viewed = app.state.viewed[f.path] !== undefined;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.slice(dir.length);
    const cb = h('input', { type: 'checkbox', checked: viewed, 'aria-label': 'Mark file as viewed' }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      app.setViewed(f.path, cb.checked);
      this.toggleCollapse(f.path, cb.checked);
    });
    return h(
      'header',
      { class: 'rr-file__head' },
      h('button', { class: 'rr-icon-btn rr-file__chev', 'aria-label': 'Collapse file', title: 'Collapse or expand this file', onclick: () => this.toggleCollapse(f.path) }, icon('chevronDown', 14)),
      h('span', { class: `rr-status rr-status--${f.status}`, title: { added: 'Added in this PR', modified: 'Modified', deleted: 'Deleted in this PR', renamed: 'Renamed' }[f.status] }, STATUS[f.status]),
      h(
        'button',
        { class: 'rr-file__path', title: 'Open the whole file (after the change)', onclick: () => this.openFile(f.path, f.status === 'deleted' ? 'base' : 'head') },
        f.prevPath && f.prevPath !== f.path ? h('span', { class: 'rr-muted' }, f.prevPath + ' → ') : null,
        h('span', { class: 'rr-muted' }, dir),
        h('strong', null, name),
      ),
      h('span', { class: 'rr-delta', title: `${f.additions} lines added, ${f.deletions} removed` }, f.additions ? h('span', { class: 'rr-add' }, '+' + f.additions) : null, f.deletions ? h('span', { class: 'rr-del' }, '−' + f.deletions) : null),
      threads ? h('span', { class: 'rr-count-chip', title: `${threads} open comment thread${threads > 1 ? 's' : ''} in this file` }, icon('thread', 12), String(threads)) : null,
      h('span', { class: 'rr-toolbar__spacer' }),
      h('button', { class: 'rr-icon-btn', title: 'Copy a link to this file (paste it into any comment)', 'aria-label': 'Copy link to file', onclick: () => (copy(formatRef({ type: 'code', path: f.path, rev: 'head' })), app.toast(`Link to ${f.path.split('/').pop()} copied — paste it into any comment`)) }, icon('link', 14)),
      this.pin ? null : popoutButton(app, f, this.panelId),
      h('label', { class: 'rr-viewed', title: 'Mark as viewed: collapses the file and counts toward your progress', 'data-keys': 'v' }, cb, 'Viewed'),
    );
  }

  private toggleCollapse(path: string, force?: boolean) {
    const b = this.blocks.get(path);
    if (!b) return;
    b.collapsed = force ?? !b.collapsed;
    b.el.classList.toggle('is-collapsed', b.collapsed);
  }

  private diffOptions(path: string): FileDiffOptions<Meta, undefined> {
    const p = this.app.prefs;
    const focusCSS =
      p.focus === 'additions'
        ? `[data-line-type="change-deletion"]{display:none!important}`
        : p.focus === 'deletions'
          ? `[data-line-type="change-addition"]{display:none!important}`
          : '';
    return {
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: this.app.resolvedTheme(),
      diffStyle: p.diffStyle,
      overflow: p.wrap ? 'wrap' : 'scroll',
      lineDiffType: p.lineDiff,
      hunkSeparators: 'line-info',
      expansionLineCount: 20,
      disableFileHeader: true,
      lineHoverHighlight: 'number',
      enableLineSelection: true,
      enableGutterUtility: true,
      parseDiffOptions: p.ignoreWhitespace ? ({ ignoreWhitespace: true } as any) : undefined,
      unsafeCSS: PIERRE_CSS + focusCSS,
      onLineSelected: (r) => this.onSelect(path, r),
      onGutterUtilityClick: (r) => this.onGutter(path, r),
      renderAnnotation: (a) => {
        const t = this.app.thread(a.metadata!.threadId);
        return t ? threadCard(this.app, t) : undefined;
      },
    };
  }

  private annotations(path: string): DiffLineAnnotation<Meta>[] {
    if (!this.app.prefs.inlineThreads) return [];
    return this.app.state.threads
      .filter((t) => t.anchor.kind === 'code' && t.anchor.path === path)
      .map((t) => {
        const a = t.anchor as Extract<Thread['anchor'], { kind: 'code' }>;
        return { side: a.rev === 'base' ? 'deletions' : 'additions', lineNumber: a.end, metadata: { threadId: t.id } } as DiffLineAnnotation<Meta>;
      });
  }

  private renderBlock(path: string): Promise<void> {
    const b = this.blocks.get(path);
    if (!b) return Promise.resolve();
    if (b.rendering) return b.rendering;
    b.rendering = (async () => {
      const f = b.file;
      const r = this.app.range;
      const [oldText, newText] = await Promise.all([
        f.status === 'added' ? null : this.app.read(f.prevPath ?? f.path, r.base),
        f.status === 'deleted' ? null : this.app.read(f.path, r.head),
      ]);
      if (this.blocks.get(path) !== b) return;
      b.body.style.minHeight = '';
      if (f.binary || (oldText === null && newText === null)) {
        b.body.append(h('div', { class: 'rr-empty' }, f.binary ? 'Binary file' : 'Could not load file contents'));
        return;
      }
      const inst = new FileDiff<Meta>(this.diffOptions(path));
      inst.render({
        oldFile: oldText === null ? null : { name: f.prevPath ?? f.path, contents: oldText, cacheKey: `${r.base}:${f.prevPath ?? f.path}` },
        newFile: newText === null ? null : { name: f.path, contents: newText, cacheKey: `${r.head}:${f.path}` },
        lineAnnotations: this.annotations(path),
        containerWrapper: b.body,
      } as any);
      b.inst = inst;
    })();
    return b.rendering;
  }

  private refreshOptions(structural: boolean) {
    this.renderToolbar();
    const p = this.app.prefs;
    const key = `${p.ignoreWhitespace}|${p.lineDiff}|${p.hideTests}|${p.hiddenTypes.join()}`;
    if (structural && key !== (this as any)._k) {
      (this as any)._k = key;
      if ((this as any)._init) return this.rebuild();
      (this as any)._init = true;
    }
    this.blocks.forEach((b, path) => {
      if (!b.inst) return;
      b.inst.setOptions(this.diffOptions(path));
      b.inst.setLineAnnotations(this.annotations(path));
      b.inst.rerender();
    });
    if (this.fileView?.inst) {
      this.fileView.inst.setOptions({ ...this.fileView.inst.options, overflow: p.wrap ? 'wrap' : 'scroll' });
      this.fileView.inst.rerender();
    }
  }

  private refreshAnnotations() {
    this.blocks.forEach((b, path) => {
      if (!b.inst) return;
      b.inst.setLineAnnotations(this.annotations(path));
      b.inst.rerender();
      const head = this.fileHeader(b.file);
      b.el.querySelector('.rr-file__head')?.replaceWith(head);
    });
    if (this.fileView?.inst) {
      this.fileView.inst.setLineAnnotations(this.fileAnnotations(this.fileView.path, this.fileView.side) as any);
      this.fileView.inst.rerender();
    }
  }

  // ------------------------------------------------------------ full file view
  private fileAnnotations(path: string, side: 'base' | 'head') {
    return this.app.state.threads
      .filter((t) => t.anchor.kind === 'code' && t.anchor.path === path && t.anchor.rev === side)
      .map((t) => ({ lineNumber: (t.anchor as any).end, metadata: { threadId: t.id } }));
  }

  async openFile(path: string, side: 'base' | 'head', rev?: string, start?: number, end?: number) {
    this.mode = 'file';
    this.blocks.forEach((b) => b.inst?.cleanUp());
    this.blocks.clear();
    this.io.disconnect();
    this.fileView?.inst?.cleanUp();
    this.fileView = { path, side, rev };
    this.renderToolbar();
    const body = h('div', { class: 'rr-file rr-file--full' });
    this.stack.replaceChildren(body);
    const text = await this.app.read(path, rev ?? this.app.revFor(side));
    if (text === null) {
      body.append(h('div', { class: 'rr-empty' }, `${path} does not exist at ${rev ?? side}.`));
      return;
    }
    const inst = new PierreFile<Meta>({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: this.app.resolvedTheme(),
      overflow: this.app.prefs.wrap ? 'wrap' : 'scroll',
      lineHoverHighlight: 'number',
      unsafeCSS: PIERRE_CSS,
      enableLineSelection: true,
      enableGutterUtility: !rev,
      onLineSelected: (r) => r && !rev && this.onSelect(path, { ...r, side: side === 'base' ? 'deletions' : 'additions' }),
      onGutterUtilityClick: (r) => !rev && this.onGutter(path, { ...r, side: side === 'base' ? 'deletions' : 'additions' }),
      renderAnnotation: (a) => {
        const t = this.app.thread(a.metadata!.threadId);
        return t ? threadCard(this.app, t) : undefined;
      },
    });
    inst.render({ file: { name: path, contents: text }, lineAnnotations: this.fileAnnotations(path, side) as any, containerWrapper: body });
    this.fileView.inst = inst;
    if (start) {
      inst.setSelectedLines({ start, end: end ?? start });
      requestAnimationFrame(() => this.scrollToRow(body, side === 'base' ? 'deletions' : 'additions', start));
    }
  }

  // ------------------------------------------------------------ navigation
  private async reveal(t: CodeTarget) {
    this.app.showPanel(this.panelId);
    if (t.view === 'file' || t.rev) return this.openFile(t.path, t.side, t.rev, t.start, t.end);
    const inDiff = this.app.files.some((f) => f.path === t.path);
    if (!inDiff) return this.openFile(t.path, t.side, undefined, t.start, t.end);
    if (this.mode !== 'diff') this.setMode('diff');
    let b = this.blocks.get(t.path);
    if (!b) {
      // hidden by a filter: lift the filter so the link works
      if (this.app.prefs.hideTests) this.app.setPref('hideTests', false);
      if (this.app.prefs.hiddenTypes.length) this.app.setPref('hiddenTypes', []);
      this.rebuild();
      b = this.blocks.get(t.path);
      if (!b) return;
    }
    if (b.collapsed) this.toggleCollapse(t.path, false);
    // render this block and everything above it so offsets are stable
    const order = [...this.blocks.keys()];
    await Promise.all(order.slice(0, order.indexOf(t.path) + 1).map((p) => this.renderBlock(p)));
    this.app.activeFile = t.path;
    this.app.bus.emit('active-file', t.path);
    const side = t.side === 'base' ? 'deletions' : 'additions';
    if (t.start) b.inst?.setSelectedLines({ start: t.start, end: t.end ?? t.start, side, endSide: side });
    const block = b;
    // Files above the target (and the target itself) finish highlighting asynchronously and change
    // height after we scroll, so keep the target pinned until the layout settles or the user scrolls.
    this.pinScroll(() => {
      const row = t.start ? this.rowFor(block.body, side, t.start) : null;
      if (row) return { top: this.offsetIn(row) - this.scroller.clientHeight * 0.3, row };
      return { top: block.el.offsetTop - 4, row: null };
    });
  }

  private pinToken = 0;
  private offsetIn(el: HTMLElement) {
    return el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
  }
  private pinScroll(target: () => { top: number; row: HTMLElement | null }) {
    const token = ++this.pinToken;
    const sc = this.scroller;
    let cancelled = false;
    const cancel = () => (cancelled = true);
    const opts = { passive: true } as const;
    sc.addEventListener('wheel', cancel, opts);
    sc.addEventListener('pointerdown', cancel, opts);
    window.addEventListener('keydown', cancel, opts);
    const done = () => {
      sc.removeEventListener('wheel', cancel);
      sc.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', cancel);
    };
    const t0 = performance.now();
    let flashed = false;
    let stableFrames = 0;
    const tick = () => {
      if (cancelled || token !== this.pinToken) return done();
      const { top, row } = target();
      const want = Math.max(0, Math.round(top));
      if (Math.abs(sc.scrollTop - want) > 2) { sc.scrollTop = want; stableFrames = 0; } else stableFrames++;
      if (row && !flashed) {
        flashed = true;
        row.animate?.([{ outline: '2px solid var(--rr-accent, #2b5fd9)' }, { outline: '2px solid transparent' }], { duration: 1400 });
      }
      // settle: the row exists and nothing moved for ~10 frames, or give up after 2.5s
      if ((row && stableFrames > 10) || performance.now() - t0 > 2500) return done();
      requestAnimationFrame(tick);
    };
    tick();
  }

  private rowFor(container: HTMLElement, side: 'additions' | 'deletions', line: number): HTMLElement | null {
    const roots: ParentNode[] = [container];
    container.querySelectorAll('*').forEach((n) => (n as HTMLElement).shadowRoot && roots.push((n as HTMLElement).shadowRoot!));
    for (const root of roots) {
      const col = root.querySelector(`[data-${side}]`) ?? root.querySelector('[data-unified]') ?? root;
      const row = (col as ParentNode).querySelector(`[data-line="${line}"]`) as HTMLElement | null;
      if (row) return row;
    }
    return null;
  }

  private scrollToRow(container: HTMLElement, side: 'additions' | 'deletions', line: number) {
    const row = this.rowFor(container, side, line);
    if (!row) return false;
    const top = this.offsetIn(row);
    this.scroller.scrollTo({ top: Math.max(0, top - this.scroller.clientHeight * 0.3), behavior: 'smooth' });
    row.animate?.([{ outline: '2px solid var(--rr-accent, #2b5fd9)' }, { outline: '2px solid transparent' }], { duration: 1400 });
    return true;
  }

  private changeRows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    this.blocks.forEach((b) => {
      if (!b.inst || b.collapsed) return;
      b.body.querySelectorAll('*').forEach((n) => {
        const sr = (n as HTMLElement).shadowRoot;
        if (!sr) return;
        const col = sr.querySelector('[data-additions]') ?? sr.querySelector('[data-unified]') ?? sr;
        let prevChange = false;
        (col as ParentNode).querySelectorAll('[data-line-type]').forEach((row) => {
          const isChange = (row.getAttribute('data-line-type') || '').startsWith('change');
          if (isChange && !prevChange) out.push(row as HTMLElement);
          prevChange = isChange;
        });
      });
    });
    return out;
  }

  jumpChange(dir: 1 | -1) {
    const rows = this.changeRows();
    const base = this.scroller.getBoundingClientRect().top;
    const pos = rows.map((r) => r.getBoundingClientRect().top - base);
    const cur = this.scroller.clientHeight * 0.3 + 4;
    const idx = dir > 0 ? pos.findIndex((p) => p > cur + 2) : pos.map((p, i) => [p, i] as const).filter(([p]) => p < cur - 6).pop()?.[1] ?? -1;
    if (idx >= 0) this.scroller.scrollBy({ top: pos[idx] - cur + 4, behavior: 'smooth' });
    else if (dir > 0) this.jumpFile(1);
  }

  jumpFile(dir: 1 | -1) {
    const order = [...this.blocks.values()];
    const top = this.scroller.scrollTop + 8;
    const cur = order.findIndex((b) => b.el.offsetTop + b.el.offsetHeight > top);
    const next = order[Math.max(0, Math.min(order.length - 1, cur + dir))];
    if (next) this.reveal({ path: next.file.path, side: 'head' });
  }

  private trackActive() {
    if (this.mode !== 'diff' || !this.isPrimary) return;
    const top = this.scroller.scrollTop + 40;
    for (const b of this.blocks.values()) {
      if (b.el.offsetTop + b.el.offsetHeight > top) {
        if (this.app.activeFile !== b.file.path) {
          this.app.activeFile = b.file.path;
          this.app.bus.emit('active-file', b.file.path);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------ selection → comments
  private onSelect(path: string, r: SelectedLineRange | null) {
    if (!r) return;
    const side = r.side === 'deletions' ? 'base' : 'head';
    const [start, end] = r.start <= r.end ? [r.start, r.end] : [r.end, r.start];
    this.app.selection = { kind: 'code', path, side, start, end, ...this.lastPointer };
    this.app.bus.emit('selection', this.app.selection);
  }
  private onGutter(path: string, r: SelectedLineRange) {
    const side = r.side === 'deletions' ? 'base' : 'head';
    const [start, end] = r.start <= r.end ? [r.start, r.end] : [r.end, r.start];
    this.app.compose({ kind: 'code', path, rev: side, start, end });
  }

  onShow() {
    this.trackActive();
  }
  dispose() {
    this.offs.forEach((f) => f());
    this.io.disconnect();
    this.blocks.forEach((b) => b.inst?.cleanUp());
    this.fileView?.inst?.cleanUp();
  }
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  return text;
}

let counter = 1;
export type PopoutView = 'diff' | 'base' | 'head';
export type Placement = 'right' | 'below' | 'float';

/** Open one file in its own code panel: as a diff, or the whole file before/after the change. */
export function openInNewPanel(app: ReviewApp, path: string, view: PopoutView = 'diff', placement: Placement = 'right', near?: string) {
  const id = `code:${++counter}`;
  const name = path.split('/').pop()!;
  const ref = (near && app.dock.getPanel(near)) || app.dock.getPanel('code') || app.dock.activePanel;
  const base = { id, component: 'code', title: `${name} · ${view === 'diff' ? 'diff' : view === 'base' ? 'before' : 'after'}`, params: { pin: path, view } };
  if (placement === 'float') app.dock.addPanel({ ...base, floating: floatBox(app) } as any);
  else app.dock.addPanel({ ...base, position: ref ? { referencePanel: ref.id, direction: placement === 'below' ? 'below' : 'right' } : undefined } as any);
}

function popoutButton(app: ReviewApp, f: ChangedFile, panelId: string) {
  const b = h('button', { class: 'rr-icon-btn', title: 'Open this file in a new panel', 'aria-label': 'Open this file in a new panel', 'aria-haspopup': 'menu' }, icon('popout', 14));
  b.onclick = () =>
    popMenu(b, (close) => {
      const place = app.prefs.popoutPlacement;
      const placeRow = h(
        'div',
        { class: 'rr-menu__row' },
        h('span', { class: 'rr-muted' }, 'Place'),
        h(
          'div',
          { class: 'rr-seg rr-seg--small' },
          ...(['right', 'below', 'float'] as const).map((p) =>
            h('button', { class: place === p ? 'is-on' : '', 'aria-pressed': String(place === p), onclick: (e: Event) => {
              app.setPref('popoutPlacement', p);
              (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === e.currentTarget));
            } }, p === 'right' ? 'Right' : p === 'below' ? 'Below' : 'Floating'),
          ),
        ),
      );
      const open = (v: PopoutView) => () => {
        close();
        openInNewPanel(app, f.path, v, app.prefs.popoutPlacement, panelId);
      };
      return [
        menuLabel(`Open ${f.path.split('/').pop()} in a new panel`),
        menuItem('Diff', open('diff'), { icon: 'split', hint: 'changes only' }),
        f.status !== 'added' ? menuItem('Before', open('base'), { icon: 'doc', hint: 'whole file @base' }) : null,
        f.status !== 'deleted' ? menuItem('After', open('head'), { icon: 'doc', hint: 'whole file @head' }) : null,
        placeRow,
      ];
    });
  return b;
}

definePanel({ id: 'code', title: 'Code', icon: 'code', create: (app, params, id) => new CodePanel(app, id, params) });
