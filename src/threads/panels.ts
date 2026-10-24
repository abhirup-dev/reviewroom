// Agent and team threads panel.
import { avatarUrl, h, icon, plural, seg, threadBadge } from '../kernel/dom';
import { parseRef, refIcon } from '../kernel/refs/browser';
import { anchorRef } from '../kernel/refs/refs.shared';
import { PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import { plainExcerpt } from '../kernel/markdown';
import type { Thread } from '../kernel/state/model.shared';
import { definePanel, type PanelInstance } from '../kernel/dock';
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
        threadBadge(t, app.services.threads.unreadAgent(t)),
        h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'),
        h('span', null, t.title ?? app.anchorLabel(t.anchor)),
        t.gh ? h('span', { class: 'rr-round-badge', title: 'Started on GitHub by ' + t.messages[0]?.gh?.login }, '@' + t.messages[0]?.gh?.login) : h('span', { class: 'rr-round-badge', title: `Started in round ${t.createdRound}` }, 'R' + t.createdRound),
      ),
      h('div', { class: 'rr-thread-item__text' }, plainExcerpt(t.messages[0]?.body ?? '', 120)),
      h(
        'div',
        { class: 'rr-thread-item__meta' },
        h('span', null, plural(t.messages.length, 'message')),
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
    const every = app.services.threads.threads().filter((t) => !t.gh?.conversation);
    const all = every.filter((t) => this.shown(t));
    const convo = app.services.threads.threads().find((t) => t.gh?.conversation);
    this.convo.hidden = !convo;
    if (convo) this.convo.replaceChildren(threadBadge(convo));
    const pending = app.services.threads.pendingFeedback().length;
    const count = (f: typeof this.filter) => all.filter((t) => this.match(t, f)).length;
    const narrowed = this.authors.size > 0 || (this.sources !== null && !sameSet(this.sources, this.defaultSources()));
    this.filterBtn.classList.toggle('is-on', narrowed);
    this.filterBtn.title = `Filter threads by source and by who started them · showing ${this.describe()}`;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'rr-side-head__row' },
        seg(
          (['open', 'resolved', 'all'] as const).map((f) => ({ label: `${f[0].toUpperCase() + f.slice(1)} ${count(f)}`, title: { open: 'Threads still being discussed', resolved: 'Threads marked resolved', all: 'Every thread from every round' }[f], on: this.filter === f, onclick: () => ((this.filter = f), this.render()) })),
          { class: 'rr-seg rr-seg--small rr-seg--fill', 'aria-label': 'Which threads' },
        ),
        this.filterBtn,
      ),
      // a comment about the whole PR: for the agent, or the PR conversation on GitHub; the review mode greys out the side it leaves out
      h(
        'div',
        { class: 'rr-side-head__row rr-side-head__row--center' },
        ...app.services.threads.commentTargets({ kind: 'general' }).map((b) =>
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
        h('span', { class: 'rr-muted' }, pending ? `${plural(pending, 'thread')} with new comments` : 'nothing to send yet'),
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
    const threads = this.app.services.threads.threads().filter((t) => !t.gh?.conversation && (src.has(t.gh ? 'github' : 'agent') || this.authors.has(starter(t).key)));
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

definePanel({ id: 'threads', title: 'Threads', icon: 'thread', create: (app) => new ThreadsPanel(app) });
