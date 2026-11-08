// Agent and team threads panel.
import { avatarUrl, h, icon, plural, seg, threadBadge } from '../kernel/dom';
import { refIcon } from '../kernel/refs/browser';
import { anchorRef, parseRef } from '../kernel/refs/refs.shared';
import { PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import { plainExcerpt } from '../kernel/markdown';
import type { Thread } from '../kernel/state/model.shared';
import { definePanel, setPanelTitle, type PanelInstance } from '../kernel/dock';
import { popMenu, menuItem, menuLabel } from '../kernel/menus';
import type { ReviewApp } from '../app';

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
  private filter: 'open' | 'resolved' | 'all' | 'mine-pending';
  /** Agent or GitHub threads; null = what the review mode implies (Agent: agent threads, Team: GitHub's). */
  private sources: Set<Source> | null = null;
  /** Thread starters to show (see starter()); empty = everyone. */
  private authors = new Set<string>();
  private mode = '';
  private filterBtn: HTMLElement;
  private offs: (() => void)[] = [];
  /** `fixed`: one list (a phone's Open and Resolved tabs), without the Open/Resolved/All switch. */
  constructor(private app: ReviewApp, private fixed?: 'open' | 'resolved') {
    this.filter = fixed ?? 'open';
    this.head = h('div', { class: 'rr-side-head' });
    // kept across renders: the filter menu stays anchored to it while toggles re-render the panel
    this.filterBtn = h('button', { class: 'rr-tool', 'aria-label': 'Filter threads', title: 'Filter threads by source and by who started them', 'aria-haspopup': 'menu', onclick: () => this.filterMenu() }, icon('filter', 14));
    this.body = h('div', { class: 'rr-scroll rr-thread-list' });
    // the PR conversation isn't a thread on anything: it opens from a small button by the tools, not the list
    this.convo = h('button', { class: 'rr-convo-btn', title: 'PR conversation', 'aria-label': 'PR conversation', onclick: () => app.bus.emit('open-thread', { id: 'gh_conversation' }) });
    this.element = h('div', { class: 'rr-side' }, this.head, this.body);
    this.offs.push(app.bus.on('state', () => this.render()), app.bus.on('prefs', () => this.render()));
    this.render();
  }

  private item(t: Thread) {
    const app = this.app;
    const ref = anchorRef(t.anchor);
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
        h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'),
        h('span', null, t.title ?? app.anchorLabel(t.anchor)),
        t.gh ? h('span', { class: 'rr-round-badge', title: 'Started on GitHub by ' + t.messages[0]?.gh?.login }, '@' + t.messages[0]?.gh?.login) : h('span', { class: 'rr-round-badge', title: `Started in round ${t.createdRound}` }, 'R' + t.createdRound),
        threadBadge(t, app.services.threads.unreadAgent(t)),
      ),
      h('div', { class: 'rr-thread-item__text' }, plainExcerpt(t.messages[0]?.body ?? '', 120)),
      h(
        'div',
        { class: 'rr-thread-item__meta' },
        h('span', null, plural(t.messages.length, 'message')),
        app.services.threads.unreadAgent(t) ? h('span', { class: 'rr-unread-tag', title: 'The agent answered this round' }, 'unread') : null,
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
    const every = app.services.threads.threads().filter((t) => !t.gh?.conversation);
    const all = every.filter((t) => this.shown(t));
    const convo = app.services.threads.threads().find((t) => t.gh?.conversation);
    this.convo.hidden = !convo;
    if (convo) this.convo.replaceChildren(threadBadge(convo));
    const count = (f: typeof this.filter) => all.filter((t) => this.match(t, f)).length;
    const narrowed = this.authors.size > 0 || (this.sources !== null && !sameSet(this.sources, this.defaultSources()));
    this.filterBtn.classList.toggle('is-on', narrowed);
    this.filterBtn.title = `Filter threads by source and by who started them · showing ${this.describe()}`;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'rr-side-head__row' },
        this.fixed
          ? h('span', { class: 'rr-side-head__count' }, `${count(this.filter)} ${this.describe().replace('threads', count(this.filter) === 1 ? 'thread' : 'threads')}`)
          : seg(
          (['open', 'resolved', 'all'] as const).map((f) => ({ label: `${f[0].toUpperCase() + f.slice(1)} ${count(f)}`, title: { open: 'Threads still being discussed', resolved: 'Threads marked resolved', all: 'Every thread from every round' }[f], on: this.filter === f, onclick: () => { this.filter = f; this.render(); } })),
          { class: 'rr-seg rr-seg--small rr-seg--fill', 'aria-label': 'Which threads' },
        ),
        this.newBtn(),
        this.filterBtn,
        this.convo,
      ),
    );
    // the tab says how many are open, as Files says how many are viewed
    if (!this.fixed) setPanelTitle(app, 'threads', `Threads ${count('open')}`);
    const list = all.filter((t) => this.match(t, this.filter));
    // one list, in the order of where they are (the PR description, the walkthrough, the code, the guided walkthrough,
    // the whole PR, then GitHub's); each item's icon says which, so no headings
    const groups = [
      list.filter((t) => t.anchor.kind === 'doc' && t.anchor.target === PR_DESCRIPTION),
      list.filter((t) => !t.gh && t.anchor.kind === 'doc' && t.anchor.target !== PR_DESCRIPTION),
      list.filter((t) => !t.gh && (t.anchor.kind === 'code' || t.anchor.kind === 'symbol')),
      list.filter((t) => t.anchor.kind === 'tour'),
      list.filter((t) => !t.gh && t.anchor.kind === 'general'),
      list.filter((t) => t.gh),
    ];
    const out: HTMLElement[] = groups.flat().filter((t, i, a) => a.indexOf(t) === i).map((t) => this.item(t));
    if (!out.length)
      out.push(
        all.length ? h('div', { class: 'rr-empty' }, 'Nothing here.')
        : every.length ? h('div', { class: 'rr-empty' }, `No ${this.describe()}. `, h('button', { class: 'rr-link-btn', onclick: () => { this.sources = new Set(['agent', 'github']); this.authors.clear(); this.render(); } }, 'Show all threads'))
        : h('div', { class: 'rr-empty' }, 'No threads yet'),
      );
    this.body.replaceChildren(...out);
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

  /** A comment about the whole PR: straight to the composer when only the agent can take it, else a menu of where it
   *  goes (the agent, or the PR conversation on GitHub), the side the review mode leaves out greyed with the reason. */
  private newBtn() {
    const app = this.app, targets = app.services.threads.commentTargets({ kind: 'general' });
    const go = (to: 'agent' | 'github') => app.compose({ kind: 'general' }, undefined, to);
    const btn: HTMLElement = h('button', {
      class: 'rr-tool', 'aria-label': 'Comment on the whole PR', title: targets.length > 1 ? 'Comment on the whole PR: for the agent, or on GitHub' : 'Comment on the whole PR, for the agent',
      'aria-haspopup': targets.length > 1 ? 'menu' : null,
      onclick: () => targets.length > 1
        ? popMenu(btn, () => [menuLabel('Comment on the whole PR'), ...targets.map((b) => {
          const it = menuItem(b.to === 'agent' ? 'For the agent' : 'On the PR', () => go(b.to), { icon: b.to === 'agent' ? 'send' : 'github' });
          it.title = b.off ?? b.title;
          it.disabled = !!b.off;
          return it;
        })])
        : go('agent'),
    }, icon('chat', 14));
    return btn;
  }
  private filterMenu() {
    const src = this.sources ?? this.defaultSources();
    // only people whose threads the sources let through (Team review: no Agent), plus anyone already picked
    const threads = this.app.services.threads.threads().filter((t) => !t.gh?.conversation && (src.has(t.gh ? 'github' : 'agent') || this.authors.has(starter(t).key)));
    const starters = new Map<string, ReturnType<typeof starter>>();
    threads.forEach((t) => starters.set(starter(t).key, starter(t)));
    // several toggles in a row: each re-renders the list and reopens the menu where it was
    const toggle = (fn: () => void) => () => { fn(); this.render(); this.filterMenu(); };
    const toggleSource = (s: Source) =>
      toggle(() => {
        const next = new Set(src);
        if (next.has(s) && next.size > 1) next.delete(s);
        else next.add(s);
        this.sources = next;
      });
    const authorRow = (a: ReturnType<typeof starter>) =>
      menuItem(h('span', { class: 'rr-filter-author' }, a.avatar ? h('img', { src: avatarUrl(a.avatar, 32), alt: '' }) : null, a.label), toggle(() => (this.authors.has(a.key) ? this.authors.delete(a.key) : this.authors.add(a.key))), {
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
      this.sources || this.authors.size ? menuItem('Back to the default for this mode', () => { close(); this.sources = null; this.authors.clear(); this.render(); }, { icon: 'round' }) : null,
    ]);
  }

  private match(t: Thread, f: typeof this.filter) {
    return f === 'all' || (f === 'open' ? t.status === 'open' : f === 'resolved' ? t.status === 'resolved' : true);
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

definePanel({ id: 'threads', title: 'Threads', icon: 'thread', create: (app, params) => new ThreadsPanel(app, params.filter as 'open' | 'resolved' | undefined) });
