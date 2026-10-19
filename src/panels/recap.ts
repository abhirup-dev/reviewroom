// Threads from last round: the agent threads still open when a new round starts, the ones the reviewer wrote in
// last round first. It docks as a tab beside the narrative and floats over the dock once per round.
import { h, icon, threadBadge } from '../core/dom';
import type { Thread } from '../core/types';
import type { ReviewApp } from '../shell/app';
import { definePanel, ensurePanel, floatInPlace, type PanelInstance } from '../shell/layout';
import { anchorChip, messageList } from '../overlays/thread';
import { recapThreads } from '../shared/ops';

/** A new round the agent has answered: float the panel over the dock, once per round in this tab. */
export function recapOnNewRound(app: ReviewApp) {
  const key = `reviewroom:recap:${app.meta.id}`;
  const { active, stale, rest } = recapThreads(app.state);
  if (app.state.round < 2 || sessionStorage.getItem(key) === String(app.state.round) || !(active.length + stale.length + rest.length) || !app.state.threads.some((t) => app.unreadAgent(t))) return;
  sessionStorage.setItem(key, String(app.state.round));
  ensurePanel(app, 'recap');
  app.dock.getPanel('narrative')?.api.setActive(); // the docked spot keeps showing the narrative
  floatInPlace(app, 'recap');
}

class RecapPanel implements PanelInstance {
  element: HTMLElement;
  private body = h('div', { class: 'rr-scroll rr-recap' });
  private off: () => void;
  /** What the cards were last built from: any state change that leaves it alone skips the rebuild. */
  private built = '';
  constructor(private app: ReviewApp) {
    this.element = h('div', { class: 'rr-side' }, this.body);
    // hidden behind another tab it waits: onShow catches up
    this.off = app.bus.on('state', () => this.element.checkVisibility() && this.render());
    this.render();
  }

  onShow() {
    this.render();
  }

  private card(t: Thread) {
    const app = this.app;
    const prev = app.state.round - 1;
    // last round's exchange on; an older thread shows its last message
    const from = t.messages.findIndex((m) => m.round >= prev);
    const shown = from < 0 ? t.messages.slice(-1) : t.messages.slice(from);
    const earlier = t.messages.length - shown.length;
    const open = () => app.bus.emit('open-thread', { id: t.id });
    return h(
      'section',
      { class: 'rr-recap-card' },
      h(
        'header',
        { class: 'rr-recap-card__head' },
        threadBadge(t, app.unreadAgent(t)),
        anchorChip(app, t.anchor, t.title),
        h('span', { class: 'rr-round-badge', title: `Started in round ${t.createdRound}` }, 'R' + t.createdRound),
        h('span', { class: 'rr-toolbar__spacer' }),
        h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', title: 'Open the whole thread to reply', onclick: open }, icon('thread', 12), 'Reply'),
        h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', title: 'Mark resolved: it leaves this list', onclick: () => app.setStatus(t.id, 'resolved') }, icon('check', 12), 'Resolve'),
      ),
      earlier ? h('button', { class: 'rr-link-btn rr-recap-card__earlier', title: 'Open the whole thread', onclick: open }, `${earlier} earlier message${earlier > 1 ? 's' : ''}`) : null,
      messageList(app, shown),
    );
  }

  private render() {
    const { active, stale, rest } = recapThreads(this.app.state);
    const { round } = this.app.state;
    const key = JSON.stringify([round, [active, stale, rest].map((ts) => ts.map((t) => [t.id, t.title, t.messages.map((m) => [m.id, m.body])]))]);
    if (key === this.built) return;
    this.built = key;
    const section = (label: string, title: string, ts: Thread[]) =>
      ts.length ? [h('div', { class: 'rr-group-label', title }, label, h('span', null, String(ts.length))), ...ts.map((t) => this.card(t))] : [];
    const out = [
      ...section('Active', `Open threads you wrote in during round ${round - 1}`, active),
      ...section('Stale', `Open since round ${round - 2} or earlier, and left alone last round`, stale),
      ...section('Still unresolved', 'Open threads you left alone last round: resolve the ones that are done', rest),
    ];
    this.body.replaceChildren(...(out.length ? out : [h('div', { class: 'rr-empty' }, 'Every agent thread is resolved.')]));
  }

  dispose() {
    this.off();
  }
}

definePanel({ id: 'recap', title: 'Threads from last round', icon: 'thread', create: (app) => new RecapPanel(app) });
