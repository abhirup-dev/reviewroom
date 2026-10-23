// Popover menus shared by shell and feature views.
import { h, icon, placeNear } from './dom';

// ---------------------------------------------------------------- tiny menu
export function popMenu(anchor: HTMLElement, build: (close: () => void) => (HTMLElement | null)[]) {
  document.querySelectorAll<HTMLElement>('.rr-menu').forEach((m) => m.hidePopover());
  // a popover: click-away and Esc close it; it's removed once closed
  const menu = h('div', { class: 'rr-menu', role: 'menu', popover: 'auto', onkeydown: arrows, ontoggle: (e: ToggleEvent) => {
    anchor.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState === 'closed') menu.remove();
  } });
  const close = () => menu.hidePopover();
  menu.append(...(build(close).filter(Boolean) as HTMLElement[]));
  (anchor.closest('dialog') ?? document.body).append(menu); // outside an open modal dialog it would be inert
  menu.showPopover();
  void placeNear(anchor, menu, 'bottom-end', 6, 8);
  (menu.querySelector('button') as HTMLElement | null)?.focus();
  return close;
}
/** Up/Down/Home/End between a menu's items. */
function arrows(e: KeyboardEvent) {
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 } as Record<string, number>)[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items.at(to % items.length)?.focus();
}
export const menuItem = (label: string | Node, fn: () => void, opts: { hint?: string; checked?: boolean; icon?: Parameters<typeof icon>[0] } = {}) =>
  h('button', { class: 'rr-menu__item', role: 'menuitem', onclick: fn }, h('span', { class: 'rr-menu__check' }, opts.checked ? icon('check', 12) : opts.icon ? icon(opts.icon, 14) : ''), h('span', { class: 'rr-menu__label' }, label), opts.hint ? h('span', { class: 'rr-menu__hint' }, opts.hint) : null);
export const menuLabel = (t: string) => h('div', { class: 'rr-menu__label-row' }, t);

