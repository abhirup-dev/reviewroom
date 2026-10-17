// Files, Contents (TOC + pins) and Threads panels.
import { h, icon, relTime, threadBadge, threadCounts } from '../core/dom';
import { cssPathWithin, parseRef, refIcon } from '../core/refs';
import { anchorRef } from '../shared/refs';
import { plainExcerpt } from '../core/markdown';
import { PR_DESCRIPTION } from '../shared/feedback';
import { openCentered } from '../shell/focus';
import type { ChangedFile, CiCommit, CiState, Thread } from '../core/types';
import { definePanel, type PanelInstance } from '../shell/layout';
import { popMenu, menuItem, menuLabel } from '../shell/chrome';
import { fileType, isTestFile, reviewOrder, type ReviewApp } from '../shell/app';

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
    const select = h('select', { class: 'rr-select', 'aria-label': 'Diff range', title: 'Review all changes or one commit' });
    ranges.forEach((r) => select.append(h('option', { value: r.key, selected: r.key === app.range?.key }, r.label)));
    select.addEventListener('change', () => app.setRange(ranges.find((r) => r.key === select.value)!));
    const search = h('input', { class: 'rr-input', type: 'search', placeholder: 'Filter files', value: this.q, 'aria-label': 'Filter files' });
    search.addEventListener('input', () => {
      this.q = search.value;
      this.renderList();
    });
    const seg = h(
      'div',
      { class: 'rr-seg rr-seg--small', role: 'group', 'aria-label': 'Group files' },
      ...(['tree', 'type', 'flat'] as const).map((g) => h('button', { title: { tree: 'Group by folder', type: 'Group by file type (tests separate)', flat: 'Plain list of paths' }[g], class: p.fileGroup === g ? 'is-on' : '', 'aria-pressed': String(p.fileGroup === g), onclick: () => app.setPref('fileGroup', g) }, g === 'tree' ? 'Tree' : g === 'type' ? 'Type' : 'Flat')),
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
    const threads = app.threads().filter((t) => t.status === 'open' && t.anchor.kind === 'code' && t.anchor.path === f.path);
    const viewed = app.state.viewed[f.path] !== undefined;
    return h(
      'button',
      {
        class: 'rr-file-row' + (viewed ? ' is-viewed' : '') + (f.path === app.activeFile ? ' is-active' : ''),
        role: 'treeitem',
        'data-path': f.path,
        style: `--depth:${depth}`,
        title: f.path + ' (double-click to open it big)',
        onclick: () => app.bus.emit('reveal-code', { path: f.path, side: f.status === 'deleted' ? 'base' : 'head' }),
        ondblclick: () => openCentered(app, { type: 'file', path: f.path, rev: 'head' }),
      },
      h('span', { class: `rr-status rr-status--${f.status}`, title: { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' }[f.status] }, STATUS[f.status]),
      h('span', { class: 'rr-file-row__name' }, label),
      ...threadCounts(threads, 'in this file'),
      h('span', { class: 'rr-delta rr-delta--small', title: `${f.additions} added, ${f.deletions} removed` }, f.additions ? h('span', { class: 'rr-add' }, '+' + f.additions) : null, f.deletions ? h('span', { class: 'rr-del' }, '\u2212' + f.deletions) : null),
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
      });
    sections.forEach((s) => {
      if (s.parentElement?.closest('section[id]')) return; // nested handled below
      const title = app.docTitle(s.id) ?? s.id;
      const round = s.getAttribute('data-round');
      const n = threadsIn(s);
      items.push(
        h(
          'button',
          { class: 'rr-toc-item' + (s.id === this.active ? ' is-active' : ''), 'data-id': s.id, title: `Jump to “${title}” (double-click to open it big)`, 'data-keys': 'n,p', onclick: () => app.bus.emit('reveal-doc', { id: s.id }), ondblclick: () => openCentered(app, { type: 'doc', id: s.id }) },
          h('span', { class: 'rr-toc-item__title' }, title),
          round && round !== '1' ? h('span', { class: 'rr-round-badge', title: `Added or changed in round ${round}` }, 'R' + round) : null,
          ...threadCounts(n, 'in this section'),
        ),
      );
      s.querySelectorAll(':scope section[id], :scope h3[id]').forEach((sub) => {
        items.push(h('button', { class: 'rr-toc-item rr-toc-item--sub', 'data-id': sub.id, onclick: () => app.bus.emit('reveal-doc', { id: sub.id }), ondblclick: () => openCentered(app, { type: 'doc', id: sub.id }) }, h('span', { class: 'rr-toc-item__title' }, app.docTitle(sub.id) ?? sub.id)));
      });
    });
    if (!items.length) items.push(h('div', { class: 'rr-empty' }, 'This review has no sections.'));
    // the PR description's own headings (its ids are stripped, so they are addressed by path)
    const heads = [...app.descDoc.querySelectorAll('h1, h2, h3, h4')].map((el) => {
      const at = { id: PR_DESCRIPTION, path: cssPathWithin(app.descDoc, el) };
      const title = el.textContent?.trim() || 'Heading';
      return h(
        'button',
        { class: 'rr-toc-item' + (/^H[34]$/.test(el.tagName) ? ' rr-toc-item--sub' : ''), title: `Jump to “${title}” in the PR description (double-click to open it big)`, onclick: () => app.bus.emit('reveal-doc', at), ondblclick: () => openCentered(app, { type: 'doc', ...at }) },
        h('span', { class: 'rr-toc-item__title' }, title),
      );
    });
    const pins = app.state.pins;
    this.body.replaceChildren(
      ...([
      heads.length ? h('div', { class: 'rr-group-label' }, 'Description') : null,
      ...heads,
      heads.length || pins.length ? h('div', { class: 'rr-group-label' }, 'Review') : null,
      ...items,
      pins.length ? h('div', { class: 'rr-group-label' }, 'Pinned', h('span', null, String(pins.length))) : null,
      ...pins.map((ref) => {
        const r = parseRef(ref);
        return h(
          'div',
          { class: 'rr-toc-item rr-toc-item--pin' },
          h('button', { class: 'rr-toc-item__title rr-link-btn', title: 'Open (double-click to open it big)', onclick: () => app.open(ref), ondblclick: () => openCentered(app, ref) }, h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : ''), app.label(ref)),
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
type Source = 'agent' | 'github';
const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
/** Who started a thread: a GitHub login (with avatar), or you / the agent for reviewroom's own threads. */
function starter(t: Thread) {
  const m = t.messages[0];
  if (m?.gh) return { key: 'gh:' + m.gh.login, label: '@' + m.gh.login, avatar: m.gh.avatar, order: 2 };
  return m?.author === 'agent' ? { key: 'agent', label: 'Agent', avatar: undefined, order: 1 } : { key: 'you', label: 'You', avatar: undefined, order: 0 };
}
class ThreadsPanel implements PanelInstance {
  element: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private convo: HTMLElement;
  private foot: HTMLElement;
  private filter: 'open' | 'resolved' | 'all' | 'mine-pending' = 'open';
  /** Agent or GitHub threads; null = what the review mode implies (Agent: agent threads, Team: GitHub's). */
  private sources: Set<Source> | null = null;
  /** Thread starters to show (see starter()); empty = everyone. */
  private authors = new Set<string>();
  private mode = '';
  private filterBtn: HTMLElement;
  private offs: (() => void)[] = [];
  constructor(private app: ReviewApp) {
    this.head = h('div', { class: 'rr-side-head' });
    // kept across renders: the filter menu stays anchored to it while toggles re-render the panel
    this.filterBtn = h('button', { class: 'rr-tool', 'aria-label': 'Filter threads', title: 'Filter threads by source and by who started them', 'aria-haspopup': 'menu', onclick: () => this.filterMenu() }, icon('filter', 14));
    this.body = h('div', { class: 'rr-scroll rr-thread-list' });
    // the PR conversation isn't a thread on anything: it opens from a small button in the footer, not the list
    this.convo = h('button', { class: 'rr-convo-btn', title: 'PR conversation', 'aria-label': 'PR conversation', onclick: () => app.bus.emit('open-thread', { id: 'gh_conversation' }) });
    this.foot = h('div', { class: 'rr-side-foot' });
    this.element = h('div', { class: 'rr-side' }, this.head, this.body, this.foot);
    this.offs.push(app.bus.on('state', () => this.render()), app.bus.on('prefs', () => this.render()));
    this.render();
  }

  private item(t: Thread) {
    const app = this.app;
    const ref = anchorRef(t.anchor);
    const last = t.messages[t.messages.length - 1];
    const r = ref ? parseRef(ref) : null;
    return h(
      'button',
      { class: 'rr-thread-item' + (t.status === 'resolved' ? ' is-resolved' : ''), title: 'Open thread', onclick: () => {
          // a walkthrough step's thread: the player at that step, the thread over it
          if (t.anchor.kind === 'tour') app.bus.emit('walkthrough-open', { chapter: t.anchor.chapter, step: t.anchor.step });
          app.bus.emit('open-thread', { id: t.id });
        } },
      h(
        'div',
        { class: 'rr-thread-item__anchor' },
        threadBadge(t, app.unreadAgent(t)),
        h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'),
        h('span', null, t.title ?? app.anchorLabel(t.anchor)),
        t.gh ? h('span', { class: 'rr-round-badge', title: 'Started on GitHub by ' + t.messages[0]?.gh?.login }, '@' + t.messages[0]?.gh?.login) : h('span', { class: 'rr-round-badge', title: `Started in round ${t.createdRound}` }, 'R' + t.createdRound),
      ),
      h('div', { class: 'rr-thread-item__text' }, plainExcerpt(t.messages[0]?.body ?? '', 120)),
      h(
        'div',
        { class: 'rr-thread-item__meta' },
        h('span', null, `${t.messages.length} message${t.messages.length > 1 ? 's' : ''}`),
        last?.author === 'agent' ? h('span', { class: 'rr-agent-tag' }, 'agent replied') : null,
        t.messages.some((m) => m.gh?.pending) ? h('span', { class: 'rr-pill rr-pill--draft', title: 'In your GitHub review, not posted until you submit it' }, 'draft') : null,
        t.gh?.outdated ? h('span', { class: 'rr-pill', title: 'The code this was written on has changed since' }, 'outdated') : null,
        t.status === 'resolved' ? h('span', { class: 'rr-pill rr-pill--ok' }, 'resolved') : null,
      ),
    );
  }

  private render() {
    const app = this.app;
    // switching Agent/Team/All starts over from that mode's default
    const mode = this.view();
    if (mode !== this.mode) {
      this.mode = mode;
      this.sources = null;
      this.authors.clear();
    }
    const every = app.threads().filter((t) => !t.gh?.conversation);
    const all = every.filter((t) => this.shown(t));
    const convo = app.threads().find((t) => t.gh?.conversation);
    this.convo.hidden = !convo;
    if (convo) this.convo.replaceChildren(threadBadge(convo));
    const pending = app.pendingFeedback().length;
    const count = (f: typeof this.filter) => all.filter((t) => this.match(t, f)).length;
    const narrowed = this.authors.size > 0 || (this.sources !== null && !sameSet(this.sources, this.defaultSources()));
    this.filterBtn.classList.toggle('is-on', narrowed);
    this.filterBtn.title = `Filter threads by source and by who started them · showing ${this.describe()}`;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'rr-side-head__row' },
        h(
          'div',
          { class: 'rr-seg rr-seg--small rr-seg--fill' },
          ...(['open', 'resolved', 'all'] as const).map((f) => h('button', { title: { open: 'Threads still being discussed', resolved: 'Threads marked resolved', all: 'Every thread from every round' }[f], class: this.filter === f ? 'is-on' : '', onclick: () => ((this.filter = f), this.render()) }, `${f[0].toUpperCase() + f.slice(1)} ${count(f)}`)),
        ),
        this.filterBtn,
      ),
      // a comment about the whole PR: for the agent, or the PR conversation on GitHub; the review mode greys out the side it leaves out
      h(
        'div',
        { class: 'rr-side-head__row rr-side-head__row--center' },
        ...app.commentTargets({ kind: 'general' }).map((b) =>
          h('button', { class: 'rr-btn rr-btn--small rr-btn--send' + (b.to === 'agent' ? ' rr-btn--agent' : ''), title: b.off ?? b.title, 'aria-disabled': b.off ? 'true' : null, onclick: () => b.off || app.compose({ kind: 'general' }, undefined, b.to) }, icon('send', 12), b.label),
        ),
      ),
    );
    const list = all.filter((t) => this.match(t, this.filter));
    const groups: [string, Thread[]][] = [
      ['PR description', list.filter((t) => t.anchor.kind === 'doc' && t.anchor.target === PR_DESCRIPTION)],
      ['Narrative', list.filter((t) => !t.gh && t.anchor.kind === 'doc' && t.anchor.target !== PR_DESCRIPTION)],
      ['Code', list.filter((t) => !t.gh && (t.anchor.kind === 'code' || t.anchor.kind === 'symbol'))],
      ['Guided walkthrough', list.filter((t) => t.anchor.kind === 'tour')],
      ['General', list.filter((t) => !t.gh && t.anchor.kind === 'general')],
      ['GitHub', list.filter((t) => t.gh)],
    ];
    const out: HTMLElement[] = [];
    for (const [label, ts] of groups) {
      if (!ts.length) continue;
      out.push(h('div', { class: 'rr-group-label' }, label, h('span', null, String(ts.length))));
      ts.forEach((t) => out.push(this.item(t)));
    }
    if (!out.length)
      out.push(
        all.length ? h('div', { class: 'rr-empty' }, 'Nothing here.')
        : every.length ? h('div', { class: 'rr-empty' }, `No ${this.describe()}. `, h('button', { class: 'rr-link-btn', onclick: () => ((this.sources = new Set(['agent', 'github'])), this.authors.clear(), this.render()) }, 'Show all threads'))
        : h('div', { class: 'rr-empty' }, 'No threads yet'),
      );
    this.body.replaceChildren(...out);
    this.foot.replaceChildren(
      h(
        'div',
        { class: 'rr-round-foot' },
        h('span', null, `Round ${app.state.round}`),
        h('span', { class: 'rr-muted' }, pending ? `${pending} thread${pending > 1 ? 's' : ''} with new comments` : 'nothing to send yet'),
      ),
      this.convo,
    );
  }

  /** The review mode, as far as the list goes: without GitHub there is only one kind of thread. */
  private view() {
    return this.app.github?.ok ? this.app.prefs.reviewMode : 'all';
  }
  private defaultSources(): Set<Source> {
    const v = this.view();
    return new Set<Source>(v === 'all' ? ['agent', 'github'] : v === 'team' ? ['github'] : ['agent']);
  }
  private shown(t: Thread) {
    const src = this.sources ?? this.defaultSources();
    return src.has(t.gh ? 'github' : 'agent') && (!this.authors.size || this.authors.has(starter(t).key));
  }
  private describe() {
    const src = this.sources ?? this.defaultSources();
    const what = src.size === 2 ? 'threads' : src.has('agent') ? 'agent threads' : 'GitHub threads';
    return this.authors.size ? `${what} started by ${[...this.authors].map((k) => k.replace(/^gh:/, '@')).join(', ')}` : what;
  }

  private filterMenu() {
    const src = this.sources ?? this.defaultSources();
    // only people whose threads the sources let through (Team review: no Agent), plus anyone already picked
    const threads = this.app.threads().filter((t) => !t.gh?.conversation && (src.has(t.gh ? 'github' : 'agent') || this.authors.has(starter(t).key)));
    const starters = new Map<string, ReturnType<typeof starter>>();
    threads.forEach((t) => starters.set(starter(t).key, starter(t)));
    // several toggles in a row: each re-renders the list and reopens the menu where it was
    const toggle = (fn: () => void) => () => (fn(), this.render(), this.filterMenu());
    const toggleSource = (s: Source) =>
      toggle(() => {
        const next = new Set(src);
        if (next.has(s) && next.size > 1) next.delete(s);
        else next.add(s);
        this.sources = next;
      });
    const authorRow = (a: ReturnType<typeof starter>) =>
      menuItem(h('span', { class: 'rr-filter-author' }, a.avatar ? h('img', { src: a.avatar + (a.avatar.includes('?') ? '&' : '?') + 's=32', alt: '' }) : null, a.label), toggle(() => (this.authors.has(a.key) ? this.authors.delete(a.key) : this.authors.add(a.key))), {
        checked: this.authors.has(a.key),
        hint: String(threads.filter((t) => starter(t).key === a.key).length),
      });
    popMenu(this.filterBtn, (close) => [
      menuLabel('Show'),
      menuItem('Agent threads', toggleSource('agent'), { checked: src.has('agent') }),
      menuItem('GitHub threads', toggleSource('github'), { checked: src.has('github') }),
      menuLabel('Started by'),
      menuItem('Everyone', toggle(() => this.authors.clear()), { checked: !this.authors.size }),
      ...[...starters.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)).map(authorRow),
      this.sources || this.authors.size ? menuItem('Back to the default for this mode', () => (close(), (this.sources = null), this.authors.clear(), this.render()), { icon: 'round' }) : null,
    ]);
  }

  private match(t: Thread, f: typeof this.filter) {
    return f === 'all' || (f === 'open' ? t.status === 'open' : f === 'resolved' ? t.status === 'resolved' : true);
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

// ======================================================================= CI
const CI_WORD: Record<CiState, string> = { success: 'passed', failure: 'failed', pending: 'running', none: 'no checks' };
const ciDot = (s: CiState) => h('span', { class: 'rr-ci-dot is-' + s, 'aria-label': CI_WORD[s] });

/** The latest commit's CI; when it failed or is still running, also the last commit that passed. */
class CiPanel implements PanelInstance {
  element: HTMLElement;
  private off: () => void;
  constructor(private app: ReviewApp) {
    this.element = h('div', { class: 'rr-side' }, h('div', { class: 'rr-scroll rr-ci' }));
    this.off = app.bus.on('state', () => this.render());
    this.render();
  }

  private commit(c: CiCommit, label: string) {
    // only what needs attention is listed; passing checks collapse into a count
    const shown = c.checks.filter((x) => x.state !== 'success');
    const passed = c.checks.length - shown.length;
    return h(
      'div',
      { class: 'rr-ci-commit' },
      h('div', { class: 'rr-ci-commit__head' }, ciDot(c.state), h('span', { class: 'rr-ci-commit__label' }, label), h('span', { class: 'rr-muted' }, CI_WORD[c.state]), h('a', { class: 'rr-ci-commit__sha', href: c.url, target: '_blank', rel: 'noopener', title: 'Open this commit on GitHub' }, c.short), h('span', { class: 'rr-muted' }, relTime(c.at))),
      h('div', { class: 'rr-ci-commit__title', title: c.title }, c.title),
      ...shown.map((x) => h(x.url ? 'a' : 'span', { class: 'rr-ci-check', ...(x.url ? { href: x.url, target: '_blank', rel: 'noopener', title: 'Open this run' } : {}) }, ciDot(x.state), h('span', null, x.name))),
      passed ? h('div', { class: 'rr-ci-check rr-muted', title: c.checks.filter((x) => x.state === 'success').map((x) => x.name).join('\n') }, icon('check', 11), `${passed} passed`) : null,
    );
  }

  private render() {
    const g = this.app.github;
    const ci = g?.ci ?? [];
    const head = ci[0];
    const green = head && head.state !== 'success' ? ci.find((c) => c.state === 'success') : undefined;
    this.element.firstElementChild!.replaceChildren(
      ...(!head
        ? [h('div', { class: 'rr-empty' }, !g ? 'Loading…' : g.ok ? 'No commits on this PR' : 'CI shows for GitHub pull requests')]
        : [this.commit(head, 'Latest'), ...(head.state === 'success' ? [] : [green ? this.commit(green, 'Last passed') : h('div', { class: 'rr-empty' }, 'No commit on this PR has passed yet')])]),
    );
  }
  dispose() {
    this.off();
  }
}

definePanel({ id: 'files', title: 'Files', icon: 'files', create: (app) => new FilesPanel(app) });
definePanel({ id: 'toc', title: 'Contents', icon: 'toc', create: (app) => new TocPanel(app) });
definePanel({ id: 'threads', title: 'Threads', icon: 'thread', create: (app) => new ThreadsPanel(app) });
definePanel({ id: 'ci', title: 'CI', icon: 'ci', create: (app) => new CiPanel(app) });
