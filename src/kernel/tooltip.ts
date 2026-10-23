// One tooltip system for the whole app (and the agent's own HTML).
//
// Any element with `title` or `data-tip` gets a styled tooltip; `data-keys="mod+k"` adds a
// shortcut hint. Native `title` is migrated to `data-tip` on first hover so the browser's own
// slow, unstyled tooltip never doubles up. Works inside shadow DOM and for keyboard focus.
import { h, placeNear } from './dom';
import { keyLabel } from './commands';
import type { ReviewApp } from '../app';

export function tip(el: HTMLElement, text: string, keys?: string) {
  el.dataset.tip = text;
  if (keys) el.dataset.keys = keys;
  if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text);
  return el;
}

/** `app` is optional: the hub page (src/hub/) has tooltips but no ReviewApp. */
export function mountTooltips(app?: Pick<ReviewApp, 'escapers' | 'onDispose'>) {
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof DocumentEventMap>(target: Document, type: K, handler: (event: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };
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
  listen(document, 'pointerover', enter, true);
  listen(document, 'focusin', (e) => (e.target as HTMLElement).matches?.(':focus-visible') && enter(e), true);
  listen(document, 'pointerout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (target && to && target.contains(to)) return;
    if (!to) hide();
  }, true);
  listen(document, 'focusout', hide, true);
  listen(document, 'pointerdown', hide, true);
  listen(document, 'scroll', hide, true);
  listen(document, 'keydown', (e) => e.key === 'Escape' && hide(), true);
  app?.escapers.push(() => (shown() ? (hide(), true) : false));
  const dispose = () => { clearTimeout(timer); cleanups.forEach((fn) => fn()); box.remove(); };
  app?.onDispose(dispose);
  return dispose;
}
