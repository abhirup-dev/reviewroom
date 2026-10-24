// Threads from last round: the agent threads still open when a new round starts, laid out as a canvas. Each section
// is a lane (Active, Still unresolved, Stale) with its count; across a lane, threads run latest interaction first,
// each card showing what it is about above its messages. It docks as a tab beside the narrative and floats over the
// dock, headerless like a feed, once per round.
import { h, icon, threadBadge } from '../kernel/dom';
import type { Thread } from '../kernel/state/model.shared';
import { recapThreads } from '../kernel/state/ops.shared';
import { anchorRef } from '../kernel/refs/refs.shared';
import type { ReviewApp } from '../app';
import { definePanel, floatInPlace, putBack, type PanelInstance } from '../kernel/dock';
import { renderPreview } from '../review/previews';
import { anchorChip, messageList } from './view';

/** A new round the agent has answered: float the panel over the dock, once per round in this tab. */
export function recapOnNewRound(app: ReviewApp) {
  const key = `reviewroom:recap:${app.meta.id}`;
  const { active, rest, stale } = recapThreads(app.state);
  if (app.state.round < 2 || sessionStorage.getItem(key) === String(app.state.round) || !(active.length + rest.length + stale.length) || !app.state.threads.some((t) => app.services.threads.unreadAgent(t))) return;
  sessionStorage.setItem(key, String(app.state.round));
  app.layout.ensurePanel('recap');
  app.dock.getPanel('narrative')?.api.setActive(); // the docked spot keeps showing the narrative
  floatInPlace(app, 'recap');
  // a feed, not a tiled window: no tab bar (the panel's own head says what it is and docks it)
  const group = app.dock.getPanel('recap')?.group;
  if (group?.api.location.type !== 'floating') return;
  group.model.header.hidden = true;
  group.element.closest('.dv-resize-container')?.classList.add('rr-feed-window');
}

class RecapPanel implements PanelInstance {
  element: HTMLElement;
  private canvas = h('div', { class: 'rr-scroll rr-recap' });
  private off: () => void;
  /** Cards by thread, with what they were built from: an unchanged thread keeps its card (and its loaded preview). */
  private cards = new Map<string, { sig: string; el: HTMLElement }>();
  constructor(private app: ReviewApp) {
    this.element = h('div', { class: 'rr-side' }, this.canvas);
    // hidden behind another tab it waits: onShow catches up
    this.off = app.bus.on('state', () => this.element.checkVisibility() && this.render());
    this.render();
  }

  onShow() {
    this.render();
  }

  private card(t: Thread) {
    const sig = JSON.stringify([this.app.state.round, t.title, t.messages.map((m) => [m.id, m.body])]);
    const had = this.cards.get(t.id);
    if (had?.sig === sig) return had.el;
    const app = this.app;
    const prev = app.state.round - 1;
    // last round's exchange on; an older thread shows its last message
    const from = t.messages.findIndex((m) => m.round >= prev);
    const shown = from < 0 ? t.messages.slice(-1) : t.messages.slice(from);
    const earlier = t.messages.length - shown.length;
    const open = () => app.bus.emit('open-thread', { id: t.id });
    const ref = anchorRef(t.anchor);
    const preview = ref ? h('div', { class: 'rr-recap-card__preview rr-scroll', title: 'What this thread is about' }) : null;
    if (preview && ref) void renderPreview(app, ref, { compact: true }).then((el) => preview.replaceChildren(el));
    const quote = t.anchor.kind === 'doc' && t.anchor.quote ? h('blockquote', { class: 'rr-quote' }, t.anchor.quote.exact) : null;
    const el = h(
      'section',
      { class: 'rr-recap-card' },
      h(
        'header',
        { class: 'rr-recap-card__head' },
        threadBadge(t, app.services.threads.unreadAgent(t)),
        anchorChip(app, t.anchor, t.title),
        h('span', { class: 'rr-round-badge', title: `Started in round ${t.createdRound}` }, 'R' + t.createdRound),
        h('span', { class: 'rr-toolbar__spacer' }),
        h('button', { class: 'rr-icon-btn', title: 'Open the whole thread to reply', 'aria-label': 'Reply', onclick: open }, icon('thread', 14)),
        h('button', { class: 'rr-icon-btn', title: 'Mark resolved: it leaves this list', 'aria-label': 'Resolve', onclick: () => app.services.threads.setStatus(t.id, 'resolved') }, icon('check', 14)),
      ),
      preview,
      quote,
      earlier ? h('button', { class: 'rr-link-btn rr-recap-card__earlier', title: 'Open the whole thread', onclick: open }, `${earlier} earlier message${earlier > 1 ? 's' : ''}`) : null,
      messageList(app, shown),
    );
    this.cards.set(t.id, { sig, el });
    return el;
  }

  private render() {
    const { active, rest, stale } = recapThreads(this.app.state);
    const { round } = this.app.state;
    const lane = (label: string, title: string, ts: Thread[]) =>
      h(
        'div',
        { class: 'rr-recap-lane' },
        h('div', { class: 'rr-recap-lane__head', title }, label, h('span', { class: 'rr-recap-lane__count' + (ts.length ? '' : ' is-zero') }, String(ts.length))),
        h('div', { class: 'rr-recap-lane__cards' }, ...(ts.length ? ts.map((t) => this.card(t)) : [h('div', { class: 'rr-recap-lane__none' }, 'Nothing here')])),
      );
    const live = new Set([...active, ...rest, ...stale].map((t) => t.id));
    for (const id of this.cards.keys()) if (!live.has(id)) this.cards.delete(id);
    // scroll stays put: the lanes are swapped in whole, their cards reused
    this.canvas.replaceChildren(
      h(
        'div',
        { class: 'rr-recap__head' },
        h('span', { class: 'rr-recap__title' }, 'Threads from last round'),
        h('span', { class: 'rr-muted' }, `Round ${round}`),
        h('span', { class: 'rr-toolbar__spacer' }),
        h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', title: 'Dock it as a tab beside the review', 'data-keys': 'Escape', onclick: () => putBack(this.app, 'recap') }, 'Dock'),
      ),
      lane('Active', `Open threads you wrote in during round ${round - 1}`, active),
      lane('Still unresolved', 'Open threads you left alone last round: resolve the ones that are done', rest),
      lane('Stale', `Open since round ${round - 2} or earlier, and left alone last round`, stale),
    );
  }

  dispose() {
    this.off();
  }
}

definePanel({ id: 'recap', title: 'Threads from last round', icon: 'thread', create: (app) => new RecapPanel(app) });
