// Code panel: the whole diff as one virtualized @pierre/diffs CodeView (a file per item),
// or one full file at base/head/any sha. Supports several instances ("code", "code:2"...).
import { CodeView, parseDiffFromFile, parsePatchFiles, type CodeViewItem, type CodeViewOptions, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs';
import { copyText, h, icon, threadBadge, threadCounts } from '../kernel/dom';
import { formatRef } from '../kernel/refs/browser';
import { plainExcerpt } from '../kernel/markdown';
import { oldToNewLine } from './hunks';
import type { ChangedFile, Thread } from '../kernel/state/model.shared';
import { addPanelAt, definePanel, setPanelTitle, type PanelInstance, type Placement } from '../kernel/dock';
import { openCentered } from './focus';
import { popMenu, menuItem, menuLabel } from '../kernel/menus';
import type { ReviewApp } from '../app';
import type { CodeTarget } from './navigation.shared';
import { createActor, fromPromise, type Actor } from 'xstate';
import { revealMachine, type Prepared } from './reveal.machine';

type Meta = { threadId: string };
type Side = 'additions' | 'deletions';
/** What CodeView hands every callback as its last argument (file or diff item). */
type Ctx = { item: { id: string } };

/** Blend @pierre/diffs into the panel colours (custom properties cross the shadow boundary). */
// diff colours come from our --rr-add/--rr-del tokens (so review themes reach the code); dark tints are kept low
// Pierre tints a changed line's body by mixing that tint into the background again (--mix-*), which washes it out; the mixes keep more of it
import { PIERRE_CSS } from './previews';
import { codeThreadsOn, defaultSide } from './files.shared';
/** Lines a jump landed on glow a few times while the panel sets --rr-pulse (the reveal machine's glow). */
const PULSE_CSS = `@keyframes rr-pulse{50%{background-color:color-mix(in srgb,var(--rr-accent) 26%,transparent)}}[data-selected-line]{animation:var(--rr-pulse,none) 1s ease-in-out 3}@media (prefers-reduced-motion:reduce){[data-selected-line]{animation-iteration-count:1}}`;
/** .rr-file__head is 38px tall (border included); CodeView lays items out from this number. */
const HEADER_HEIGHT = 38;
/** Stands in for a file whose contents can't be shown (binary, unreadable): the header alone. */
const NO_DIFF = (name: string): FileDiffMetadata => ({ name, type: 'change', hunks: [], splitLineCount: 0, unifiedLineCount: 0, isPartial: false, deletionLines: [], additionLines: [] });

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
    threadBadge(t, app.unreadAgent(t)),
    h('span', { class: 'rr-inline-thread__text' }, plainExcerpt(first?.body ?? '', 110)),
    last && last !== first ? h('span', { class: 'rr-inline-thread__last' }, (last.author === 'github' ? last.gh?.login : last.author) + ': ' + plainExcerpt(last.body, 60)) : null,
    t.status === 'resolved' ? h('span', { class: 'rr-pill rr-pill--ok' }, 'resolved') : null,
  );
  return h('div', { class: 'rr-inline-thread-wrap' }, card);
}

// GitHub threads whose code moved on (outdated) or that are about the whole file have no line here
const onLine = (t: Thread) => !t.gh?.outdated && !t.gh?.file;

const seg = (items: [string, string, boolean, () => void, string?][]) =>
  h('div', { class: 'rr-seg', role: 'group' }, ...items.map(([label, title, on, fn, keys]) => h('button', { class: on ? 'is-on' : '', title, 'data-keys': keys, 'aria-pressed': String(on), onclick: fn }, label)));
const tog = (ic: Parameters<typeof icon>[0], title: string, on: boolean, fn: () => void, text?: string, keys?: string) =>
  h('button', { class: 'rr-tool' + (on ? ' is-on' : ''), title, 'data-keys': keys, 'aria-label': title, 'aria-pressed': String(on), onclick: fn }, icon(ic, 14), text ? h('span', null, text) : null);

/** How diffs are drawn (prefs: every code panel follows them). A code panel's toolbar has them; the walkthrough pane
 *  shows one set for all its files. */
export function displayTools(app: ReviewApp, mode: 'diff' | 'file'): (HTMLElement | null)[] {
  const p = app.prefs;
  return [
    mode === 'diff'
      ? seg([
          ['Split', 'Side-by-side: old on the left, new on the right', p.diffStyle === 'split', () => app.setPref('diffStyle', 'split'), 's'],
          ['Unified', 'One column: removed lines above the lines that replace them', p.diffStyle === 'unified', () => app.setPref('diffStyle', 'unified'), 's'],
        ])
      : null,
    mode === 'diff'
      ? seg([
          ['All', 'Show added and removed lines', p.focus === 'all', () => app.setPref('focus', 'all')],
          ['+', 'Focus on new code: hide removed lines', p.focus === 'additions', () => app.setPref('focus', 'additions'), '+'],
          ['\u2212', 'Focus on old code: hide added lines', p.focus === 'deletions', () => app.setPref('focus', 'deletions'), '-'],
        ])
      : null,
    mode === 'diff' ? tog('filter', 'Ignore whitespace-only changes', p.ignoreWhitespace, () => app.setPref('ignoreWhitespace', !p.ignoreWhitespace), 'ws', 'i') : null,
    tog('wrap', 'Wrap long lines instead of scrolling sideways', p.wrap, () => app.setPref('wrap', !p.wrap), undefined, 'w'),
    mode === 'diff' ? tog('thread', 'Show comment threads inside the diff, under the lines they are on', p.inlineThreads, () => app.setPref('inlineThreads', !p.inlineThreads)) : null,
  ];
}

class CodePanel implements PanelInstance {
  element: HTMLElement;
  private toolbar: HTMLElement;
  private scroller: HTMLElement;
  private empty: HTMLElement;
  private cv: CodeView<Meta>;
  private mode: 'diff' | 'file' = 'diff';
  /** Diff mode: the files shown, in order, with their parsed diff (null: nothing to show) and collapsed state. */
  private files = new Map<string, { file: ChangedFile; diff: FileDiffMetadata | null; collapsed: boolean }>();
  private fileView?: { path: string; side: 'base' | 'head'; rev?: string; text?: string };
  private ready: Promise<void> = Promise.resolve();
  private loadToken = 0;
  private rangeKey = '';
  private version = 0;
  private lastPointer = { x: 0, y: 0 };
  private offs: (() => void)[] = [];
  private isPrimary: boolean;
  /** Single-file panel (opened via "open in new panel"): shows only this path as diff, before or after. */
  private pin?: string;
  private optionsKey?: string;
  private optionsInit = false;
  /** The walkthrough's code pane: revealed lines stay highlighted, and it never moves the workbench's active file. */
  private embedded: boolean;
  /** Embedded: the walkthrough's name for this chunk, first in the toolbar (its own path label is left out). */
  private head?: HTMLElement;
  /** Reveals (src/review/reveal.machine.ts): a new one cancels the last one's wait, unfold and glow. */
  private revealer: Actor<typeof revealMachine>;

  constructor(private app: ReviewApp, private panelId: string, params: Record<string, unknown>) {
    this.isPrimary = panelId === 'code';
    this.pin = (params.pin as string) || undefined;
    this.embedded = !!params.embedded;
    this.head = params.head as HTMLElement | undefined;
    this.toolbar = h('div', { class: 'rr-toolbar' });
    this.empty = h('div', { class: 'rr-empty', hidden: true });
    this.scroller = h('div', { class: 'rr-scroll rr-code-scroll', tabindex: '0', 'data-rr-scope': 'code' });
    this.element = h('div', { class: 'rr-code-panel' }, this.toolbar, this.empty, this.scroller);
    this.scroller.addEventListener('pointerup', (e) => (this.lastPointer = { x: e.clientX, y: e.clientY }), true);
    this.cv = new CodeView<Meta>(this.options());
    this.cv.setup(this.scroller);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    this.revealer = createActor(
      revealMachine.provide({
        actors: { prepare: fromPromise(({ input, signal }) => this.prepare(input, signal)), unfold: fromPromise(({ input, signal }) => this.unfoldAround(input, signal, frame)) },
        actions: {
          land: ({ context }) => this.land(context.target!),
          // restart the pulse: it runs while --rr-pulse names it
          glow: () => {
            this.scroller.style.removeProperty('--rr-pulse');
            requestAnimationFrame(() => this.revealer.getSnapshot().matches('glowing') && this.scroller.style.setProperty('--rr-pulse', 'rr-pulse'));
          },
          unglow: () => this.scroller.style.removeProperty('--rr-pulse'),
          clear: () => !this.embedded && this.cv.clearSelectedLines({ notify: false }),
          landed: () => this.app.bus.emit('code-landed', { panel: this.panelId }),
        },
      }),
    ).start();
    // read the position once CodeView's frame has settled it (mid-jump it rebases its paged scroll)
    this.scroller.addEventListener('scroll', () => requestAnimationFrame(() => this.trackActive()), { passive: true });

    this.offs.push(
      app.bus.on('files', () => this.rebuild()),
      app.bus.on('prefs', () => this.refreshOptions(true)),
      app.bus.on('theme', () => this.cv.setOptions(this.options())),
      app.bus.on('state', () => this.refreshItems()),
      app.bus.on('reveal-code', (t) => {
        if ((t.panel ?? 'code') === this.panelId) this.reveal(t);
      }),
      app.bus.on('selection', (sel) => {
        // Esc / clearing the selection also clears the highlighted line range; the walkthrough's highlight is its own
        if (!sel && !this.embedded) this.cv.clearSelectedLines({ notify: false });
      }),
    );
    this.element.addEventListener('rr-code-cmd', (e) => {
      const c = (e as CustomEvent).detail;
      if (c === 'next') this.jumpChange(1);
      else if (c === 'prev') this.jumpChange(-1);
      else if (c === 'nextFile') this.jumpFile(1);
      else if (c === 'prevFile') this.jumpFile(-1);
    });
    void this.rebuild();
    if (this.pin && (params.view === 'base' || params.view === 'head')) queueMicrotask(() => this.openFile(this.pin!, params.view as 'base' | 'head'));
    else if (params.path) queueMicrotask(() => this.reveal({ ...(params as unknown as CodeTarget), panel: this.panelId }));
  }

  // ------------------------------------------------------------ toolbar
  private renderToolbar() {
    const left: (HTMLElement | null)[] = [this.embedded ? (this.head ?? null) : null];
    if (this.pin) {
      const f = this.app.files.find((x) => x.path === this.pin);
      const view = this.mode === 'diff' ? 'diff' : this.fileView?.side;
      left.push(
        this.embedded ? null : h('span', { class: 'rr-toolbar__path', title: this.pin }, this.pin.split('/').pop()),
        h(
          'div',
          { class: 'rr-seg', role: 'group', 'aria-label': 'View' },
          h('button', { class: view === 'diff' ? 'is-on' : '', disabled: !f, title: 'Diff of this file', onclick: () => this.setMode('diff') }, 'Diff'),
          h('button', { class: view === 'base' ? 'is-on' : '', disabled: f?.status === 'added', title: 'Whole file before the change', onclick: () => this.openFile(this.pin!, 'base') }, 'Before'),
          h('button', { class: view === 'head' ? 'is-on' : '', disabled: f?.status === 'deleted', title: 'Whole file after the change', onclick: () => this.openFile(this.pin!, 'head') }, 'After'),
        ),
      );
      setPanelTitle(this.app, this.panelId, `${this.pin.split('/').pop()} · ${view === 'diff' ? 'diff' : view === 'base' ? 'before' : 'after'}`);
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
        h('span', { class: 'rr-delta', title: `${adds} lines added, ${dels} removed` }, h('span', { class: 'rr-add' }, '+' + adds), h('span', { class: 'rr-del' }, '\u2212' + dels)),
        this.app.range && this.app.range.key !== 'all' ? h('span', { class: 'rr-pill rr-pill--accent', title: 'Showing one commit: ' + this.app.range.label + '. Pick “All changes” in Files to see the whole PR.' }, this.app.range.label.split(' · ')[0]) : null,
      );
    }
    this.toolbar.replaceChildren(
      h('div', { class: 'rr-toolbar__group' }, ...left),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-toolbar__group' },
        // the walkthrough pane has one set of these for all its files
        ...(this.embedded ? [] : displayTools(this.app, this.mode)),
        this.mode === 'diff' && !this.embedded
          ? h('div', { class: 'rr-seg' }, h('button', { title: 'Previous change', 'data-keys': 'k', 'aria-label': 'Previous change', onclick: () => this.jumpChange(-1) }, icon('arrowUp', 14)), h('button', { title: 'Next change (moves to the next file at the end)', 'data-keys': 'j', 'aria-label': 'Next change', onclick: () => this.jumpChange(1) }, icon('arrowDown', 14)))
          : null,
      ),
    );
  }

  private setMode(m: 'diff' | 'file') {
    this.mode = m;
    if (m === 'diff') {
      this.fileView = undefined;
      this.cv.setOptions(this.options());
      void this.rebuild();
    }
  }

  private showEmpty(text = '') {
    this.empty.textContent = text;
    this.empty.hidden = !text;
  }

  // ------------------------------------------------------------ diff
  private rebuild(): Promise<void> {
    if (this.mode !== 'diff') return Promise.resolve(this.renderToolbar());
    const token = ++this.loadToken;
    const files = this.pin ? this.app.files.filter((f) => f.path === this.pin) : this.app.visibleFiles();
    const r = this.app.range;
    const ws = this.app.prefs.ignoreWhitespace ? { ignoreWhitespace: true } : undefined;
    this.renderToolbar();
    this.showEmpty(files.length ? '' : this.app.files.length ? 'All files are hidden by the current filters.' : 'No changes in this range.');
    // a new range: drop the old one's lines rather than leave them clickable while the new one loads
    const key = `${r.base}..${r.head}`;
    if (key !== this.rangeKey) {
      this.rangeKey = key;
      this.files = new Map();
      this.cv.setItems([]);
    }
    // CodeView lays out every item from its diff: from the range's patch where the provider has one (loadDiffFiles reads
    // a file when its context is expanded), else from both sides read up front
    return (this.ready = (async () => {
      const patch = await this.app.provider.patch?.(r, !!ws).catch(() => null);
      const parsed = new Map((patch ? parsePatchFiles(patch, `${key}${ws ? ':ws' : ''}`) : []).flatMap((p) => p.files).map((d) => [d.name, d]));
      const diffs = await Promise.all(
        files.map(async (f) => {
          if (f.binary) return null;
          const fromPatch = parsed.get(f.path);
          if (fromPatch) return fromPatch;
          const [oldText, newText] = await Promise.all([
            f.status === 'added' ? null : this.app.read(f.prevPath ?? f.path, r.base),
            f.status === 'deleted' ? null : this.app.read(f.path, r.head),
          ]);
          if (oldText === null && newText === null) return null;
          return parseDiffFromFile(
            oldText === null ? null : { name: f.prevPath ?? f.path, contents: oldText, cacheKey: `${r.base}:${f.prevPath ?? f.path}` },
            newText === null ? null : { name: f.path, contents: newText, cacheKey: `${r.head}:${f.path}` },
            ws,
          );
        }),
      );
      if (token !== this.loadToken) return;
      this.files = new Map(files.map((f, i) => [f.path, { file: f, diff: diffs[i], collapsed: this.app.state.viewed[f.path] !== undefined }]));
      this.refreshItems();
    })());
  }

  /** Hand CodeView the current items; a new version makes it re-render each (threads, header, collapse). */
  private refreshItems() {
    const items: CodeViewItem<Meta>[] = [];
    const fv = this.fileView;
    if (this.mode === 'file') {
      if (fv?.text !== undefined) items.push({ id: fv.path, type: 'file', file: { name: fv.path, contents: fv.text }, annotations: this.fileAnnotations(fv.path, fv.side), version: ++this.version });
    } else {
      for (const [path, f] of this.files) items.push({ id: path, type: 'diff', fileDiff: f.diff ?? NO_DIFF(path), annotations: this.annotations(path), collapsed: f.collapsed, version: ++this.version });
    }
    this.cv.setItems(items);
  }

  private fileHeader(path: string) {
    const app = this.app;
    const entry = this.files.get(path);
    if (!entry) return undefined;
    const f = entry.file;
    const threads = codeThreadsOn(app.threads(), f.path).filter((t) => t.status === 'open');
    const viewed = app.state.viewed[f.path] !== undefined;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.slice(dir.length);
    const cb = h('input', { type: 'checkbox', checked: viewed, 'aria-label': 'Mark file as viewed' });
    cb.addEventListener('change', () => {
      this.toggleCollapse(f.path, cb.checked);
      app.setViewed(f.path, cb.checked);
    });
    return h(
      'header',
      {
        class: 'rr-file__head' + (entry.collapsed ? ' is-collapsed' : ''),
        // double-click the bar (not its buttons) to open this file big
        ondblclick: (e: MouseEvent) => !(e.target as Element).closest('button, input, a') && !this.pin && openCentered(app, { type: 'file', path: f.path, rev: 'head' }),
      },
      h('button', { class: 'rr-icon-btn rr-file__chev', 'aria-label': 'Collapse file', title: 'Collapse or expand this file', onclick: () => this.toggleCollapse(f.path) }, icon('chevronDown', 14)),
      h('span', { class: `rr-status rr-status--${f.status}`, title: { added: 'Added in this PR', modified: 'Modified', deleted: 'Deleted in this PR', renamed: 'Renamed' }[f.status] }, STATUS[f.status]),
      h(
        'button',
        { class: 'rr-file__path', title: 'Open the whole file (after the change)', onclick: () => this.openFile(f.path, defaultSide(f)) },
        f.prevPath && f.prevPath !== f.path ? h('span', { class: 'rr-muted' }, f.prevPath + ' → ') : null,
        h('span', { class: 'rr-muted' }, dir),
        h('strong', null, name),
      ),
      h('span', { class: 'rr-delta', title: `${f.additions} lines added, ${f.deletions} removed` }, f.additions ? h('span', { class: 'rr-add' }, '+' + f.additions) : null, f.deletions ? h('span', { class: 'rr-del' }, '\u2212' + f.deletions) : null),
      entry.diff ? null : h('span', { class: 'rr-pill' }, f.binary ? 'Binary file' : 'Could not load file contents'),
      ...threadCounts(threads, 'in this file'),
      h('span', { class: 'rr-toolbar__spacer' }),
      h('button', { class: 'rr-icon-btn', title: 'Copy a link to this file (paste it into any comment)', 'aria-label': 'Copy link to file', onclick: () => (void copyText(formatRef({ type: 'code', path: f.path, rev: 'head' })), app.toast(`Link to ${f.path.split('/').pop()} copied — paste it into any comment`)) }, icon('link', 14)),
      this.pin ? null : popoutButton(app, f, this.panelId),
      h('label', { class: 'rr-viewed', title: 'Mark as viewed: collapses the file and counts toward your progress', 'data-keys': 'v' }, cb, 'Viewed'),
    );
  }

  private toggleCollapse(path: string, force?: boolean) {
    const f = this.files.get(path);
    if (!f) return;
    f.collapsed = force ?? !f.collapsed;
    this.refreshItems();
  }

  private options(): CodeViewOptions<Meta, undefined> {
    const p = this.app.prefs;
    const fv = this.fileView;
    const focusCSS =
      this.mode === 'file' ? '' : p.focus === 'additions'
        ? `[data-line-type="change-deletion"]{display:none!important}`
        : p.focus === 'deletions'
          ? `[data-line-type="change-addition"]{display:none!important}`
          : '';
    // a whole file has no sides of its own: its lines are the base or head side of the diff
    const side = (r: SelectedLineRange): SelectedLineRange => (fv ? { ...r, side: fv.side === 'base' ? 'deletions' : 'additions' } : r);
    return {
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: this.app.resolvedTheme(),
      diffStyle: p.diffStyle,
      overflow: p.wrap ? 'wrap' : 'scroll',
      lineDiffType: p.lineDiff,
      hunkSeparators: 'line-info',
      expansionLineCount: 20,
      stickyHeaders: true,
      disableFileHeader: this.mode === 'file',
      itemMetrics: { diffHeaderHeight: HEADER_HEIGHT },
      lineHoverHighlight: 'number',
      enableLineSelection: true,
      enableGutterUtility: !fv?.rev,
      unsafeCSS: PIERRE_CSS + PULSE_CSS + focusCSS,
      renderCustomHeader: (_: unknown, ctx: Ctx) => this.fileHeader(ctx.item.id),
      renderAnnotation: (a: { metadata: Meta }) => {
        const t = this.app.thread(a.metadata.threadId);
        return t ? threadCard(this.app, t) : undefined;
      },
      onLineSelected: (r: SelectedLineRange | null, ctx: Ctx) => r && !fv?.rev && this.onSelect(ctx.item.id, side(r)),
      onGutterUtilityClick: (r: SelectedLineRange, ctx: Ctx) => !fv?.rev && this.onGutter(ctx.item.id, side(r)),
      loadDiffFiles: async (d: FileDiffMetadata) => {
        const { base, head } = this.app.range;
        const old = this.files.get(d.name)?.file.prevPath ?? d.name; // our file list knows renames GitHub's hunks don't say
        const [o, n] = await Promise.all([this.app.read(old, base), this.app.read(d.name, head)]);
        return { oldFile: { name: old, contents: o ?? '', cacheKey: `${base}:${old}` }, newFile: { name: d.name, contents: n ?? '', cacheKey: `${head}:${d.name}` } };
      },
    };
  }

  private annotations(path: string): DiffLineAnnotation<Meta>[] {
    if (!this.app.prefs.inlineThreads) return [];
    return codeThreadsOn(this.app.threads(), path)
      .filter(onLine)
      .map((t) => {
        const a = t.anchor;
        const across = a.rev === 'base' ? this.pairedNewLine(path, a.end) : undefined;
        return across ? { side: 'additions', lineNumber: across, metadata: { threadId: t.id } } : ({ side: a.rev === 'base' ? 'deletions' : 'additions', lineNumber: a.end, metadata: { threadId: t.id } });
      });
  }

  /** Split view: the new line drawn across from an old line, so threads on either side share one row's card instead of two half-width ones. */
  private pairedNewLine(path: string, oldLine: number): number | undefined {
    const d = this.files.get(path)?.diff;
    if (!d || this.app.prefs.diffStyle !== 'split') return;
    for (const hunk of d.hunks)
      for (const c of hunk.hunkContent) {
        const i = oldLine - 1 - c.deletionLineIndex;
        if (c.type === 'change' && i >= 0 && i < c.deletions) return i < c.additions ? c.additionLineIndex + i + 1 : undefined;
      }
  }

  private refreshOptions(structural: boolean) {
    this.renderToolbar();
    const p = this.app.prefs;
    const key = `${p.ignoreWhitespace}|${p.lineDiff}|${p.hideTests}|${p.hiddenTypes.join()}`;
    this.cv.setOptions(this.options());
    if (structural && key !== this.optionsKey) {
      this.optionsKey = key;
      if (this.optionsInit) return void this.rebuild();
      this.optionsInit = true;
    }
    this.refreshItems();
  }

  // ------------------------------------------------------------ full file view
  private fileAnnotations(path: string, side: 'base' | 'head') {
    return codeThreadsOn(this.app.threads(), path)
      .filter((t) => t.anchor.rev === side && onLine(t))
      .map((t) => ({ lineNumber: t.anchor.end, metadata: { threadId: t.id } }));
  }

  /** The whole file at a side or sha; true once it is on screen (false: gone, or another view replaced it). */
  async openFile(path: string, side: 'base' | 'head', rev?: string) {
    this.mode = 'file';
    this.loadToken++;
    const fv = (this.fileView = { path, side, rev } as NonNullable<CodePanel['fileView']>);
    this.renderToolbar();
    this.showEmpty();
    this.cv.setOptions(this.options());
    this.cv.setItems([]);
    const text = await this.app.read(path, rev ?? this.app.revFor(side));
    if (this.fileView !== fv) return false;
    if (text === null) return (this.showEmpty(`${path} does not exist at ${rev ?? side}.`), false);
    fv.text = text;
    this.refreshItems();
    return true;
  }

  // ------------------------------------------------------------ navigation
  reveal(target: CodeTarget) {
    this.revealer.send({ type: 'reveal', target });
  }

  /** revealMachine's `prepare`: the panel ready for `t` (its file shown and mounted); 'lines' when there are lines to
   *  highlight. `signal`: a newer reveal took over, leave the view alone. */
  private async prepare(t: CodeTarget, signal: AbortSignal): Promise<Prepared> {
    this.app.showPanel(this.panelId);
    if (t.view === 'file' || t.rev || !this.app.files.some((f) => f.path === t.path)) return (await this.openFile(t.path, t.side, t.rev)) && t.start && !signal.aborted ? 'lines' : 'nothing';
    if (this.mode !== 'diff') this.setMode('diff');
    if (!this.pin && !this.app.visibleFiles().some((f) => f.path === t.path)) {
      // hidden by a filter: lift the filter so the link works
      if (this.app.prefs.hideTests) this.app.setPref('hideTests', false);
      if (this.app.prefs.hiddenTypes.length) this.app.setPref('hiddenTypes', []);
    }
    // wait for the newest rebuild (lifting a filter or leaving the file view starts one)
    for (let r = this.ready; ; r = this.ready) if ((await r, r === this.ready)) break;
    const f = this.files.get(t.path);
    if (signal.aborted || !f) return 'nothing';
    if (f.collapsed) this.toggleCollapse(t.path, false);
    if (!this.embedded) {
      this.app.activeFile = t.path;
      this.app.bus.emit('active-file', t.path);
    }
    if (t.start) return 'lines';
    this.cv.scrollTo({ type: 'item', id: t.path, align: 'start' });
    return 'nothing';
  }

  /** revealMachine's `unfold`: lines the PR didn't touch sit in folded context; once the file is mounted, unfold around
   *  them. True: it did, and CodeView has applied it (land again). */
  private async unfoldAround(t: CodeTarget, signal: AbortSignal, frame: () => Promise<unknown>) {
    const f = this.files.get(t.path);
    if (this.mode !== 'diff' || !f?.diff) return false;
    await frame();
    if (signal.aborted) return false; // before loading a partial diff for a reveal that is over
    const item = () => this.cv.getRenderedItems().find((x) => x.id === t.path);
    let it = item();
    // a file from the patch knows only its hunks: load it, then look again (revealLine refuses partial diffs)
    if (it?.type === 'diff' && f.diff.isPartial) {
      await it.instance.prepareForEditing().catch(() => {});
      await frame();
      it = item();
    }
    if (signal.aborted || it?.type !== 'diff' || !f.diff) return false;
    const side: Side = t.side === 'base' ? 'deletions' : 'additions';
    if (!unfold(it.instance, f.diff, side, t.start!, t.end ?? t.start!)) return false;
    // CodeView applies the unfold on its next frame
    await frame();
    await frame();
    return !signal.aborted;
  }

  /** Highlight the target's lines and scroll them to 30% from the top. */
  private land(t: CodeTarget) {
    const side: Side = t.side === 'base' ? 'deletions' : 'additions';
    const lines = { start: t.start!, end: t.end ?? t.start! };
    const range = this.mode === 'file' ? lines : { ...lines, side, endSide: side };
    this.cv.setSelectedLines({ id: t.path, range }, { notify: false });
    this.cv.scrollTo({ type: 'range', id: t.path, range, align: 'start', offset: this.scroller.clientHeight * 0.3 });
  }

  /** The first line of every run of changed lines in the files on screen, top to bottom. */
  private changeStops() {
    return this.cv.getRenderedItems().flatMap((it) => {
      if (it.type !== 'diff' || it.item.collapsed) return [];
      const top = this.cv.getTopForItem(it.id) ?? 0;
      return it.item.fileDiff.hunks.flatMap((hunk) =>
        hunk.hunkContent.flatMap((c) => {
          if (c.type !== 'change') return [];
          const [lineNumber, side]: [number, Side] = c.additions ? [c.additionLineIndex + 1, 'additions'] : [c.deletionLineIndex + 1, 'deletions'];
          const pos = it.instance.getLinePosition(lineNumber, side);
          return pos ? [{ id: it.id, lineNumber, side, top: top + pos.top }] : [];
        }),
      );
    });
  }

  jumpChange(dir: 1 | -1) {
    const offset = this.scroller.clientHeight * 0.3;
    // where scrollTo puts a line: below the sticky file header, `offset` down
    const cur = this.cv.getScrollTop() + HEADER_HEIGHT + offset;
    const stops = this.changeStops();
    const next = dir > 0 ? stops.find((s) => s.top > cur + 2) : stops.filter((s) => s.top < cur - 6).pop();
    if (next) this.cv.scrollTo({ type: 'line', id: next.id, lineNumber: next.lineNumber, side: next.side, align: 'start', offset, behavior: 'smooth' });
    // past the files on screen (CodeView only mounts those near the viewport)
    else this.jumpFile(dir);
  }

  /** Index of the file at the top of the view (tops only grow down the list). */
  private fileAt(slack: number) {
    const top = this.cv.getScrollTop() + slack;
    return [...this.files.keys()].findLastIndex((id) => (this.cv.getTopForItem(id) ?? 0) <= top);
  }

  jumpFile(dir: 1 | -1) {
    const ids = [...this.files.keys()];
    const next = ids[Math.max(0, Math.min(ids.length - 1, this.fileAt(8) + dir))];
    if (next) this.reveal({ path: next, side: 'head' });
  }

  private trackActive() {
    if (this.mode !== 'diff' || !this.isPrimary) return;
    const path = [...this.files.keys()][Math.max(0, this.fileAt(40))];
    if (path && this.app.activeFile !== path) {
      this.app.activeFile = path;
      this.app.bus.emit('active-file', path);
    }
  }

  // ------------------------------------------------------------ selection -> comments
  private onSelect(path: string, r: SelectedLineRange) {
    const [start, end] = r.start <= r.end ? [r.start, r.end] : [r.end, r.start];
    // the user's own selection: a pending jump must not glow or clear it
    this.revealer.send({ type: 'select' });
    const side = r.side === 'deletions' ? 'base' : 'head';
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
    this.revealer.stop();
    this.offs.forEach((f) => f());
    this.cv.cleanUp();
  }
}

/** Unfold the context around lines the PR didn't touch so a link to them shows something; true if anything opened. */
function unfold(inst: { revealLine(line: number): boolean }, diff: FileDiffMetadata, side: Side, start: number, end: number) {
  let opened = false;
  for (const l of new Set([start, end])) {
    // revealLine speaks new-file numbers
    const n = side === 'additions' ? l : oldToNewLine(diff.hunks, l);
    if (n && inst.revealLine(n)) opened = true;
  }
  return opened;
}

let counter = 1;
export type PopoutView = 'diff' | 'base' | 'head';

/** Open one file in its own code panel: as a diff (optionally at some lines), or the whole file before/after the change. */
export function openInNewPanel(app: ReviewApp, path: string, view: PopoutView = 'diff', placement: Placement = 'right', near?: string, at?: CodeTarget) {
  const id = `code:${++counter}`;
  const name = path.split('/').pop()!;
  addPanelAt(app, { id, component: 'code', title: `${name} · ${view === 'diff' ? 'diff' : view === 'base' ? 'before' : 'after'}`, params: { ...at, pin: path, view } }, placement, near);
  return id;
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
