// Files, Contents (TOC + pins) and Threads panels.
import { h, icon } from '../core/dom';
import { parseRef, refIcon } from '../core/refs';
import { plainExcerpt } from '../core/markdown';
import type { ChangedFile, Thread } from '../core/types';
import { definePanel, type PanelInstance } from '../shell/layout';
import { fileType, isTestFile, type ReviewApp } from '../shell/app';

const STATUS: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const TYPE_LABEL: Record<string, string> = { go: 'Go', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', py: 'Python', proto: 'Protobuf', sql: 'SQL', md: 'Markdown', yaml: 'YAML', yml: 'YAML', json: 'JSON', java: 'Java', kt: 'Kotlin', rs: 'Rust', sh: 'Shell', css: 'CSS', html: 'HTML' };

// ======================================================================= Files
class FilesPanel implements PanelInstance {
  element: HTMLElement;
  private list: HTMLElement;
  private head: HTMLElement;
  private q = '';
  private collapsedDirs = new Set<string>();
  private offs: (() => void)[] = [];

  constructor(private app: ReviewApp) {
    this.head = h('div', { class: 'rr-side-head' });
    this.list = h('div', { class: 'rr-scroll rr-files', role: 'tree', 'aria-label': 'Changed files' });
    this.element = h('div', { class: 'rr-side' }, this.head, this.list);
    const r = () => this.render();
    this.offs.push(app.bus.on('files', r), app.bus.on('prefs', r), app.bus.on('state', r), app.bus.on('range', r), app.bus.on('active-file', () => this.markActive()));
    this.render();
  }

  private render() {
    const app = this.app;
    const p = app.prefs;
    const types = [...new Set(app.files.map((f) => fileType(f.path)))].sort();
    const hasTests = app.files.some((f) => isTestFile(f.path));
    const ranges = app.range ? app.ranges() : [];
    const select = h('select', { class: 'rr-select', 'aria-label': 'Diff range', title: 'Review all changes or one commit' }) as HTMLSelectElement;
    ranges.forEach((r) => select.append(h('option', { value: r.key, selected: r.key === app.range?.key }, r.label)));
    select.addEventListener('change', () => app.setRange(ranges.find((r) => r.key === select.value)!));
    const search = h('input', { class: 'rr-input', type: 'search', placeholder: 'Filter files', value: this.q, 'aria-label': 'Filter files' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.q = search.value;
      this.renderList();
    });
    const seg = h(
      'div',
      { class: 'rr-seg rr-seg--small', role: 'group', 'aria-label': 'Group files' },
      ...(['tree', 'type', 'flat'] as const).map((g) => h('button', { class: p.fileGroup === g ? 'is-on' : '', 'aria-pressed': String(p.fileGroup === g), onclick: () => app.setPref('fileGroup', g) }, g === 'tree' ? 'Tree' : g === 'type' ? 'Type' : 'Flat')),
    );
    const chips = h(
      'div',
      { class: 'rr-chips' },
      ...types.map((t) => {
        const off = p.hiddenTypes.includes(t);
        return h('button', { class: 'rr-filter-chip' + (off ? '' : ' is-on'), 'aria-pressed': String(!off), title: off ? `Show .${t}` : `Hide .${t}`, onclick: () => app.setPref('hiddenTypes', off ? p.hiddenTypes.filter((x) => x !== t) : [...p.hiddenTypes, t]) }, '.' + t);
      }),
      hasTests ? h('button', { class: 'rr-filter-chip' + (p.hideTests ? '' : ' is-on'), 'aria-pressed': String(!p.hideTests), title: p.hideTests ? 'Show tests' : 'Hide tests', onclick: () => app.setPref('hideTests', !p.hideTests) }, 'tests') : null,
    );
    const viewed = app.files.filter((f) => app.state.viewed[f.path] !== undefined).length;
    this.head.replaceChildren(
      ...(ranges.length > 1 ? [select] : []),
      h('div', { class: 'rr-side-row' }, search, seg),
      chips,
      h('div', { class: 'rr-progress', title: `${viewed} of ${app.files.length} files viewed` }, h('div', { class: 'rr-progress__bar', style: `width:${app.files.length ? (viewed / app.files.length) * 100 : 0}%` }), h('span', null, `${viewed}/${app.files.length} viewed`)),
    );
    this.renderList();
  }

  private row(f: ChangedFile, label: string, depth: number) {
    const app = this.app;
    const threads = app.state.threads.filter((t) => t.status === 'open' && t.anchor.kind === 'code' && t.anchor.path === f.path).length;
    const viewed = app.state.viewed[f.path] !== undefined;
    return h(
      'button',
      {
        class: 'rr-file-row' + (viewed ? ' is-viewed' : '') + (f.path === app.activeFile ? ' is-active' : ''),
        role: 'treeitem',
        'data-path': f.path,
        style: `--depth:${depth}`,
        title: f.path,
        onclick: () => app.bus.emit('reveal-code', { path: f.path, side: f.status === 'deleted' ? 'base' : 'head' }),
      },
      h('span', { class: `rr-status rr-status--${f.status}` }, STATUS[f.status]),
      h('span', { class: 'rr-file-row__name' }, label),
      threads ? h('span', { class: 'rr-count-chip' }, icon('thread', 11), String(threads)) : null,
      h('span', { class: 'rr-delta rr-delta--small' }, f.additions ? h('span', { class: 'rr-add' }, '+' + f.additions) : null, f.deletions ? h('span', { class: 'rr-del' }, '−' + f.deletions) : null),
      viewed ? h('span', { class: 'rr-viewed-mark', title: 'Viewed' }, icon('check', 12)) : null,
    );
  }

  private renderList() {
    const app = this.app;
    const q = this.q.toLowerCase();
    const files = app.visibleFiles().filter((f) => !q || f.path.toLowerCase().includes(q));
    const out: HTMLElement[] = [];
    const hidden = app.files.length - app.visibleFiles().length;
    if (app.prefs.fileGroup === 'flat') files.forEach((f) => out.push(this.row(f, f.path, 0)));
    else if (app.prefs.fileGroup === 'type') {
      const groups = new Map<string, ChangedFile[]>();
      files.forEach((f) => {
        const t = isTestFile(f.path) ? 'tests' : fileType(f.path);
        groups.set(t, [...(groups.get(t) ?? []), f]);
      });
      for (const [t, fs] of [...groups.entries()].sort()) {
        out.push(h('div', { class: 'rr-group-label' }, t === 'tests' ? 'Tests' : TYPE_LABEL[t] ?? '.' + t, h('span', null, String(fs.length))));
        fs.forEach((f) => out.push(this.row(f, f.path, 0)));
      }
    } else {
      // tree with single-child directory compression
      type Node = { name: string; dirs: Map<string, Node>; files: ChangedFile[] };
      const root: Node = { name: '', dirs: new Map(), files: [] };
      for (const f of files) {
        const parts = f.path.split('/');
        let n = root;
        for (const d of parts.slice(0, -1)) {
          if (!n.dirs.has(d)) n.dirs.set(d, { name: d, dirs: new Map(), files: [] });
          n = n.dirs.get(d)!;
        }
        n.files.push(f);
      }
      const walk = (n: Node, depth: number, prefix: string) => {
        for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          let name = d.name;
          let node = d;
          while (node.files.length === 0 && node.dirs.size === 1) {
            node = [...node.dirs.values()][0];
            name += '/' + node.name;
          }
          const key = prefix + name;
          const closed = this.collapsedDirs.has(key);
          out.push(
            h(
              'button',
              {
                class: 'rr-dir-row' + (closed ? ' is-closed' : ''),
                style: `--depth:${depth}`,
                'aria-expanded': String(!closed),
                onclick: () => {
                  closed ? this.collapsedDirs.delete(key) : this.collapsedDirs.add(key);
                  this.renderList();
                },
              },
              icon('chevronDown', 12),
              h('span', null, name),
            ),
          );
          if (!closed) walk(node, depth + 1, key + '/');
        }
        n.files.sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => out.push(this.row(f, f.path.split('/').pop()!, depth)));
      };
      walk(root, 0, '');
    }
    if (!out.length) out.push(h('div', { class: 'rr-empty' }, q ? 'No files match.' : 'No files.'));
    if (hidden) out.push(h('button', { class: 'rr-link-btn rr-hidden-note', onclick: () => (app.setPref('hiddenTypes', []), app.setPref('hideTests', false)) }, `${hidden} file${hidden > 1 ? 's' : ''} hidden by filters · show all`));
    this.list.replaceChildren(...out);
  }

  private markActive() {
    this.list.querySelectorAll('.rr-file-row').forEach((r) => r.classList.toggle('is-active', (r as HTMLElement).dataset.path === this.app.activeFile));
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

// ======================================================================= Contents
class TocPanel implements PanelInstance {
  element: HTMLElement;
  private body: HTMLElement;
  private offs: (() => void)[] = [];
  private active = '';
  constructor(private app: ReviewApp) {
    this.body = h('div', { class: 'rr-scroll rr-toc' });
    this.element = h('div', { class: 'rr-side' }, this.body);
    const r = () => this.render();
    this.offs.push(
      app.bus.on('state', r),
      app.bus.on('prefs', r),
      app.bus.on('active-section', (id) => {
        this.active = id;
        this.body.querySelectorAll('.rr-toc-item').forEach((el) => el.classList.toggle('is-active', (el as HTMLElement).dataset.id === id));
      }),
    );
    this.render();
  }

  private render() {
    const app = this.app;
    const doc = app.doc;
    if (!doc) return;
    const items: HTMLElement[] = [];
    const sections = doc.querySelectorAll('section[id], [data-rr-section][id]');
    const threadsIn = (el: Element) =>
      app.state.threads.filter((t) => {
        if (t.anchor.kind !== 'doc' || t.status !== 'open') return false;
        const a = t.anchor;
        const target = a.target ? doc.querySelector(`#${CSS.escape(a.target)}`) : null;
        return target ? el === target || el.contains(target) : false;
      }).length;
    sections.forEach((s) => {
      if (s.parentElement?.closest('section[id]')) return; // nested handled below
      const title = app.docTitle(s.id) ?? s.id;
      const round = s.getAttribute('data-round');
      const n = threadsIn(s);
      items.push(
        h(
          'button',
          { class: 'rr-toc-item' + (s.id === this.active ? ' is-active' : ''), 'data-id': s.id, onclick: () => app.bus.emit('reveal-doc', { id: s.id }) },
          h('span', { class: 'rr-toc-item__title' }, title),
          round && round !== '1' ? h('span', { class: 'rr-round-badge', title: `Added or changed in round ${round}` }, 'R' + round) : null,
          n ? h('span', { class: 'rr-count-chip' }, icon('thread', 11), String(n)) : null,
        ),
      );
      s.querySelectorAll(':scope section[id], :scope h3[id]').forEach((sub) => {
        items.push(h('button', { class: 'rr-toc-item rr-toc-item--sub', 'data-id': sub.id, onclick: () => app.bus.emit('reveal-doc', { id: sub.id }) }, h('span', { class: 'rr-toc-item__title' }, app.docTitle(sub.id) ?? sub.id)));
      });
    });
    if (!items.length) items.push(h('div', { class: 'rr-empty' }, 'Add <section id="…"><h2>…</h2> blocks to the review to build contents.'));
    const hasBaseline = !!doc.querySelector('[data-baseline], rr-node[state="baseline"]');
    const pins = app.state.pins;
    this.body.replaceChildren(
      ...([
      h('div', { class: 'rr-group-label' }, 'Contents'),
      ...items,
      hasBaseline
        ? h(
            'label',
            { class: 'rr-switch' },
            h('input', { type: 'checkbox', checked: app.prefs.showBaseline, onchange: (e: Event) => app.setPref('showBaseline', (e.target as HTMLInputElement).checked) }),
            h('span', null, 'Show baseline context'),
          )
        : null,
      pins.length ? h('div', { class: 'rr-group-label' }, 'Pinned', h('span', null, String(pins.length))) : null,
      ...pins.map((ref) => {
        const r = parseRef(ref);
        return h(
          'div',
          { class: 'rr-toc-item rr-toc-item--pin' },
          h('button', { class: 'rr-toc-item__title rr-link-btn', onclick: () => app.open(ref) }, h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : ''), app.label(ref)),
          h('button', { class: 'rr-icon-btn', 'aria-label': 'Unpin', title: 'Unpin', onclick: () => app.togglePin(ref) }, icon('close', 12)),
        );
      }),
      ].filter(Boolean) as HTMLElement[]),
    );
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

// ======================================================================= Threads
class ThreadsPanel implements PanelInstance {
  element: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private filter: 'open' | 'resolved' | 'all' | 'mine-pending' = 'open';
  private offs: (() => void)[] = [];
  constructor(private app: ReviewApp) {
    this.head = h('div', { class: 'rr-side-head' });
    this.body = h('div', { class: 'rr-scroll rr-thread-list' });
    this.element = h('div', { class: 'rr-side' }, this.head, this.body);
    this.offs.push(app.bus.on('state', () => this.render()));
    this.render();
  }

  private item(t: Thread) {
    const app = this.app;
    const ref = app.anchorRef(t.anchor);
    const last = t.messages[t.messages.length - 1];
    const r = ref ? parseRef(ref) : null;
    return h(
      'button',
      { class: 'rr-thread-item' + (t.status === 'resolved' ? ' is-resolved' : ''), onclick: () => app.bus.emit('open-thread', { id: t.id }) },
      h('div', { class: 'rr-thread-item__anchor' }, h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'), h('span', null, app.anchorLabel(t.anchor)), h('span', { class: 'rr-round-badge' }, 'R' + t.createdRound)),
      h('div', { class: 'rr-thread-item__text' }, plainExcerpt(t.messages[0]?.body ?? '', 120)),
      h(
        'div',
        { class: 'rr-thread-item__meta' },
        h('span', null, `${t.messages.length} message${t.messages.length > 1 ? 's' : ''}`),
        last?.author === 'agent' ? h('span', { class: 'rr-agent-tag' }, 'agent replied') : null,
        t.status === 'resolved' ? h('span', { class: 'rr-pill rr-pill--ok' }, 'resolved') : null,
      ),
    );
  }

  private render() {
    const app = this.app;
    const all = app.state.threads;
    const pending = app.pendingFeedback().length;
    const count = (f: typeof this.filter) => all.filter((t) => this.match(t, f)).length;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'rr-seg rr-seg--small rr-seg--fill' },
        ...(['open', 'resolved', 'all'] as const).map((f) => h('button', { class: this.filter === f ? 'is-on' : '', onclick: () => ((this.filter = f), this.render()) }, `${f[0].toUpperCase() + f.slice(1)} ${count(f)}`)),
      ),
      h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', onclick: () => app.compose({ kind: 'general' }) }, icon('plus', 12), 'General comment'),
    );
    const list = all.filter((t) => this.match(t, this.filter));
    const groups: [string, Thread[]][] = [
      ['Narrative', list.filter((t) => t.anchor.kind === 'doc')],
      ['Code', list.filter((t) => t.anchor.kind === 'code' || t.anchor.kind === 'symbol')],
      ['General', list.filter((t) => t.anchor.kind === 'general')],
    ];
    const out: HTMLElement[] = [];
    for (const [label, ts] of groups) {
      if (!ts.length) continue;
      out.push(h('div', { class: 'rr-group-label' }, label, h('span', null, String(ts.length))));
      ts.forEach((t) => out.push(this.item(t)));
    }
    if (!out.length) out.push(h('div', { class: 'rr-empty' }, all.length ? 'Nothing here.' : 'No threads yet. Select text, hover a block, or click a line number to start one.'));
    out.push(
      h(
        'div',
        { class: 'rr-round-foot' },
        h('span', null, `Round ${app.state.round}`),
        h('span', { class: 'rr-muted' }, pending ? `${pending} thread${pending > 1 ? 's' : ''} with new comments` : 'nothing to send yet'),
      ),
    );
    this.body.replaceChildren(...out);
  }

  private match(t: Thread, f: typeof this.filter) {
    return f === 'all' || (f === 'open' ? t.status === 'open' : f === 'resolved' ? t.status === 'resolved' : true);
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

definePanel({ id: 'files', title: 'Files', icon: 'files', create: (app) => new FilesPanel(app) });
definePanel({ id: 'toc', title: 'Contents', icon: 'toc', create: (app) => new TocPanel(app) });
definePanel({ id: 'threads', title: 'Threads', icon: 'thread', create: (app) => new ThreadsPanel(app) });
