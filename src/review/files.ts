// Changed files panel.
import { h, icon, plural, seg, threadCounts } from '../kernel/dom';
import { openCentered } from './focus';
import type { ChangedFile } from '../kernel/state/model.shared';
import { definePanel, type PanelInstance } from '../kernel/dock';
import type { ReviewApp } from '../app';
import { codeThreadsOn, defaultSide, fileType, isTestFile, reviewOrder } from './files.shared';

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
    const select = h('select', { class: 'rr-select', 'aria-label': 'Diff range', title: 'Review all changes or one commit' });
    ranges.forEach((r) => select.append(h('option', { value: r.key, selected: r.key === app.range?.key }, r.label)));
    select.addEventListener('change', () => app.setRange(ranges.find((r) => r.key === select.value)!));
    const search = h('input', { class: 'rr-input', type: 'search', placeholder: 'Filter files', value: this.q, 'aria-label': 'Filter files' });
    search.addEventListener('input', () => {
      this.q = search.value;
      this.renderList();
    });
    const grouping = seg(
      (['tree', 'type', 'flat'] as const).map((g) => ({ label: { tree: 'Tree', type: 'Type', flat: 'Flat' }[g], title: { tree: 'Group by folder', type: 'Group by file type (tests separate)', flat: 'Plain list of paths' }[g], on: p.fileGroup === g, onclick: () => app.setPref('fileGroup', g) })),
      { class: 'rr-seg rr-seg--small', 'aria-label': 'Group files' },
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
      h('div', { class: 'rr-progress', title: `${viewed} of ${app.files.length} files viewed` }, h('div', { class: 'rr-progress__bar', style: `width:${app.files.length ? (viewed / app.files.length) * 100 : 0}%` }), h('span', null, `${viewed}/${app.files.length} viewed`)),
      ...(ranges.length > 1 ? [select] : []),
      h('div', { class: 'rr-side-row' }, search, grouping),
      chips,
    );
    this.renderList();
  }

  private row(f: ChangedFile, label: string, depth: number) {
    const app = this.app;
    const threads = codeThreadsOn(app.threads(), f.path).filter((t) => t.status === 'open');
    const viewed = app.state.viewed[f.path] !== undefined;
    return h(
      'button',
      {
        class: 'rr-file-row' + (viewed ? ' is-viewed' : '') + (f.status === 'added' || f.status === 'deleted' ? ' is-' + f.status : '') + (f.path === app.activeFile ? ' is-active' : ''),
        role: 'treeitem',
        'data-path': f.path,
        style: `--depth:${depth}`,
        title: f.path + (viewed ? ' · viewed' : '') + ' (double-click to open it big)',
        onclick: () => app.bus.emit('reveal-code', { path: f.path, side: defaultSide(f) }),
        ondblclick: () => openCentered(app, { type: 'file', path: f.path, rev: 'head' }),
      },
      h('span', { class: 'rr-file-row__threads' }, ...threadCounts(threads, 'in this file')),
      h('span', { class: 'rr-file-row__name' }, label),
      h('span', { class: 'rr-delta rr-delta--small', title: `${f.additions} added, ${f.deletions} removed` }, f.additions ? h('span', { class: 'rr-add' }, '+' + f.additions) : null, f.deletions ? h('span', { class: 'rr-del' }, '\u2212' + f.deletions) : null),
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
      for (const [t, fs] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
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
      const onlyTests = (n: Node): boolean => n.files.every((f) => isTestFile(f.path)) && [...n.dirs.values()].every(onlyTests);
      const walk = (n: Node, depth: number, prefix: string) => {
        // folders holding only tests come after the rest, like test files within a folder
        for (const d of [...n.dirs.values()].sort((a, b) => Number(onlyTests(a)) - Number(onlyTests(b)) || a.name.localeCompare(b.name))) {
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
                title: closed ? 'Expand folder' : 'Collapse folder',
                onclick: () => {
                  if (closed) this.collapsedDirs.delete(key);
                  else this.collapsedDirs.add(key);
                  this.renderList();
                },
              },
              icon('chevronDown', 12),
              h('span', null, name),
            ),
          );
          if (!closed) walk(node, depth + 1, key + '/');
        }
        n.files.sort(reviewOrder).forEach((f) => out.push(this.row(f, f.path.split('/').pop()!, depth)));
      };
      walk(root, 0, '');
    }
    if (!out.length) out.push(h('div', { class: 'rr-empty' }, q ? 'No files match.' : 'No files.'));
    if (hidden) out.push(h('button', { class: 'rr-link-btn rr-hidden-note', onclick: () => (app.setPref('hiddenTypes', []), app.setPref('hideTests', false)) }, `${plural(hidden, 'file')} hidden by filters · show all`));
    this.list.classList.toggle('is-tree', app.prefs.fileGroup === 'tree');
    this.list.replaceChildren(...out);
  }

  private markActive() {
    this.list.querySelectorAll('.rr-file-row').forEach((r) => r.classList.toggle('is-active', (r as HTMLElement).dataset.path === this.app.activeFile));
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

definePanel({ id: 'files', title: 'Files', icon: 'files', create: (app) => new FilesPanel(app) });
