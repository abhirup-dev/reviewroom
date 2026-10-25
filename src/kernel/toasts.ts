import { h } from './dom';
import type { ReviewApp } from '../app';

/** How long a toast shows; one with a button stays long enough to reach it. */
const SHOW_MS = 2600, ACTION_MS = 10000;

// ================================================================ toasts
export function mountToasts(app: ReviewApp) {
  const host = h('div', { class: 'rr-toasts', 'aria-live': 'polite', popover: 'manual' });
  document.body.append(host);
  app.onDispose(() => host.remove());
  app.bus.on('toast', ({ text, kind, action }) => {
    const t = h('div', { class: 'rr-toast' + (kind === 'error' ? ' rr-toast--error' : '') }, text);
    if (action) t.append(h('button', { class: 'rr-toast__action', onclick: () => (t.remove(), action.run()) }, action.label));
    host.append(t);
    // shown again so it stacks over any modal dialog opened since
    host.hidePopover();
    host.showPopover();
    // one with a button stays long enough to reach it
    const ms = action ? ACTION_MS : SHOW_MS;
    setTimeout(() => t.classList.add('is-out'), ms);
    setTimeout(() => t.remove(), ms + 400);
  });
}
