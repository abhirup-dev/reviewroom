// One tooltip system for the whole app (and the agent's own HTML).
//
// Any element with `title` or `data-tip` gets a styled tooltip; `data-keys="mod+k"` adds a
// shortcut hint. Native `title` is migrated to `data-tip` on first hover so the browser's own
// slow, unstyled tooltip never doubles up. Works inside shadow DOM and for keyboard focus.
import { h } from '../core/dom';
import { keyLabel } from '../core/commands';
import type { ReviewApp } from '../shell/app';

export function tip(el: HTMLElement, text: string, keys?: string) {
  el.dataset.tip = text;
  if (keys) el.dataset.keys = keys;
  if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text);
  return el;
}

export function mountTooltips(app: ReviewApp) {
  const box = h('div', { class: 'rr-tooltip', role: 'tooltip', hidden: true });
  document.body.append(box);
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warmUntil = 0;

  const find = (e: Event): HTMLElement | null => {
    for (const n of e.composedPath()) {
      if (!(n instanceof HTMLElement) && !(n instanceof SVGElement)) continue;
      const el = n as HTMLElement;
      if (el === document.body || el.classList?.contains('rr-tooltip')) return null;
      if (el.hasAttribute?.('title') || el.dataset?.tip) {
        if (el.hasAttribute('title')) {
          const t = el.getAttribute('title')!;
          el.removeAttribute('title');
          if (t && !el.dataset.tip) el.dataset.tip = t;
          if (t && !el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', t);
        }
        return el.dataset.tip ? el : null;
      }
    }
    return null;
  };

  const show = (el: HTMLElement) => {
    const text = el.dataset.tip!;
    const keys = el.dataset.keys;
    box.replaceChildren(h('span', null, text), ...(keys ? keys.split(',').map((k) => h('kbd', null, keyLabel(k.trim()))) : []));
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const above = r.top - b.height - 8 > 4;
    const left = Math.min(window.innerWidth - b.width - 6, Math.max(6, r.left + r.width / 2 - b.width / 2));
    box.style.left = left + 'px';
    box.style.top = (above ? r.top - b.height - 8 : r.bottom + 8) + 'px';
    box.dataset.side = above ? 'top' : 'bottom';
  };
  const hide = () => {
    clearTimeout(timer);
    if (!box.hidden) warmUntil = Date.now() + 400;
    box.hidden = true;
    target = null;
  };

  const enter = (e: Event) => {
    const el = find(e);
    if (el === target) return;
    clearTimeout(timer);
    if (!el) return hide();
    target = el;
    // the first tooltip waits; moving between controls right after shows instantly
    timer = setTimeout(() => target === el && el.isConnected && show(el), Date.now() < warmUntil || !box.hidden ? 60 : 480);
  };
  document.addEventListener('pointerover', enter, true);
  document.addEventListener('focusin', (e) => (e.target as HTMLElement).matches?.(':focus-visible') && enter(e), true);
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (target && to && target.contains(to)) return;
    if (!to) hide();
  }, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide(), true);
  app.escapers.push(() => (box.hidden ? false : (hide(), true)));
}
