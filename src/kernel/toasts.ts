import { h } from './dom';
import type { ReviewApp } from '../app';

// ================================================================ toasts
export function mountToasts(app: ReviewApp) {
  const host = h('div', { class: 'rr-toasts', 'aria-live': 'polite', popover: 'manual' });
  document.body.append(host);
  app.onDispose(() => host.remove());
  app.bus.on('toast', ({ text, kind }) => {
    const t = h('div', { class: 'rr-toast' + (kind === 'error' ? ' rr-toast--error' : '') }, text);
    host.append(t);
    // shown again so it stacks over any modal dialog opened since
    host.hidePopover();
    host.showPopover();
    setTimeout(() => t.classList.add('is-out'), 2600);
    setTimeout(() => t.remove(), 3000);
  });
}
