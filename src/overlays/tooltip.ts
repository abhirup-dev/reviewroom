// One tooltip system for the whole app (and the agent's own HTML).
//
// Any element with `title` or `data-tip` gets a styled tooltip; `data-keys="mod+k"` adds a
// shortcut hint. Native `title` is migrated to `data-tip` on first hover so the browser's own
// slow, unstyled tooltip never doubles up. Works inside shadow DOM and for keyboard focus.
import { h, placeNear, onLongPress } from '../core/dom';
import { keyLabel } from '../core/commands';
import type { ReviewApp } from '../shell/app';

export function tip(el: HTMLElement, text: string, keys?: string) {
  el.dataset.tip = text;
  if (keys) el.dataset.keys = keys;
  if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text);
  return el;
}

/** `app` is optional: the hub page (src/hub/) has tooltips but no ReviewApp. */
export function mountTooltips(app?: Pick<ReviewApp, 'escapers'>) {
  const box = h('div', { class: 'rr-tooltip', role: 'tooltip', popover: 'manual' }); // a popover: over modal dialogs too
  const shown = () => box.matches(':popover-open');
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
    box.showPopover();
    void placeNear(el, box, 'top', 8, 6);
  };
  const hide = () => {
    clearTimeout(timer);
    if (shown()) warmUntil = Date.now() + 400;
    box.hidePopover();
    target = null;
  };

  const enter = (e: Event) => {
    const el = find(e);
    if (el === target) return;
    clearTimeout(timer);
    if (!el) return hide();
    target = el;
    // the first tooltip waits; moving between controls right after shows instantly
    timer = setTimeout(() => target === el && el.isConnected && show(el), Date.now() < warmUntil || shown() ? 60 : 480);
  };
  document.addEventListener('pointerover', (e) => e.pointerType !== 'touch' && enter(e), true);
  // touch: a long press shows the tip, until the next touch; preview links have their own long press (misc.ts)
  onLongPress((path) => {
    if (path.some((n) => n instanceof Element && n.matches('rr-ref, a[href^="rr:"], rr-node[ref]'))) return false;
    const el = find({ composedPath: () => path } as Event);
    if (!el) return false;
    target = el;
    show(el);
    return true;
  });
  document.addEventListener('focusin', (e) => (e.target as HTMLElement).matches?.(':focus-visible') && enter(e), true);
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (target && to && target.contains(to)) return;
    if (!to && e.pointerType !== 'touch') hide();
  }, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide(), true);
  app?.escapers.push(() => (shown() ? (hide(), true) : false));
}
