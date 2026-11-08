// The phone's header: a status bar and a menu drawer instead of the desktop header (header.ts). Phone code: only
// src/phone.ts wires it.
import { append, backdropCloses, h, icon } from './dom';
import type { ReviewApp } from '../app';
import { updateReady } from './pwa';
import { repaintOn, shellStatus } from './header';

/** A drawer entry: closes the drawer, then runs `run`, a command's id (shown while its `when` holds; see commands.ts)
 *  or, for what no command does, a function. */
type DrawerItem = (label: string, ic: Parameters<typeof icon>[0], run: string | (() => void), opts?: { title?: string; hint?: string }) => HTMLElement | null;
/** Live feature controls in the phone's status bar and menu drawer. */
export interface PhoneBarContributions {
  /** Under the title, after the repo: "Round 2", "Team review". */
  sub: () => string;
  /** A tap on the title (the rounds menu); null: the title only shows. */
  titleMenu: () => ((anchor: HTMLElement) => void) | null;
  status: () => HTMLElement[];
  /** Before send: play the guided review. */
  actions: () => (HTMLElement | null)[];
  send: () => HTMLElement;
  /** The drawer's facts line, after the repo. */
  facts: () => string[];
  /** Drawer entries: after Search, and between its first two separators. */
  drawer: (item: DrawerItem) => { top: (HTMLElement | null)[]; review: (HTMLElement | null)[] };
  subscribe?: (paint: () => void) => void;
}

/** The phone's status bar: menu, the review's title over "repo · Round N" (tap: rounds), search, play, send. */
export function buildPhoneBar(app: ReviewApp, features: PhoneBarContributions): HTMLElement {
  const m = app.meta;
  const bar = h('header', { class: 'rr-header rr-phonebar' });
  const paint = () => {
    const picking = app.root.classList.contains('is-picking');
    const menuBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Menu', title: 'Menu: all reviews, theme, install, pick an element to comment on', onclick: () => openDrawer(app, features) }, icon('menu', 24));
    const menu = features.titleMenu();
    const sub = [m.repo?.split('/').pop(), features.sub()].filter(Boolean).join(' · ');
    const titles = h(
      'button',
      { class: 'rr-phonebar__titles', 'aria-haspopup': menu ? 'menu' : null, title: menu ? 'Review rounds: view the narrative as it was at the end of an earlier round' : m.title },
      h('span', { class: 'rr-phonebar__title' }, m.title),
      h('span', { class: 'rr-phonebar__sub' }, h('span', null, sub), ...features.status(), ...shellStatus()),
    );
    titles.onclick = () => menu?.(titles);
    bar.replaceChildren();
    append(bar, [
      menuBtn,
      titles,
      // no Esc key on a phone: while picking, Cancel stands in for search
      picking
        ? h('button', { class: 'rr-hbtn is-on', title: 'Stop picking', onclick: () => app.bus.emit('picker', false) }, icon('target', 16), h('span', null, 'Cancel'))
        : h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Search', title: 'Search files, sections, symbols, threads and actions', onclick: () => app.openPalette('') }, icon('search', 24)),
      ...features.actions(),
      features.send(),
    ]);
  };
  repaintOn(app, paint, features.subscribe);
  return bar;
}

/** The phone's menu: a drawer from the left with the review's facts and what the desktop header has that a phone
 *  still needs (no layouts: a phone has none). A modal dialog, so Esc, a tap outside and Back close it. */
function openDrawer(app: ReviewApp, features: PhoneBarContributions) {
  const m = app.meta;
  const close = () => box.close();
  const item: DrawerItem = (label, ic, run, opts = {}) => {
    const c = typeof run === 'string' ? app.commands.get(run) : null;
    if (c === undefined || (c?.when && !c.when())) return null;
    return h('button', { class: 'rr-drawer__item', title: opts.title, onclick: () => { close(); if (typeof run === 'string') app.commands.run(run); else run(); } }, icon(ic, 24), h('span', null, label), opts.hint ? h('small', null, opts.hint) : null);
  };
  const sep = () => h('div', { class: 'rr-drawer__sep', role: 'separator' });
  const more = features.drawer(item);
  // a segmented button: light, auto (the system's), dark
  const theme = h(
    'div',
    { class: 'rr-seg rr-drawer__theme', role: 'group', 'aria-label': 'Theme' },
    ...(['light', 'system', 'dark'] as const).map((t) =>
      h(
        'button',
        { class: app.prefs.theme === t ? 'is-on' : '', title: { light: 'Light', system: 'Auto: follow the system', dark: 'Dark' }[t], 'aria-label': { light: 'Light', system: 'Auto', dark: 'Dark' }[t], 'aria-pressed': String(app.prefs.theme === t), onclick: (e: Event) => {
          app.setPref('theme', t);
          (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => { b.className = b === e.currentTarget ? 'is-on' : ''; b.setAttribute('aria-pressed', String(b === e.currentTarget)); });
        } },
        t === 'system' ? 'Auto' : icon(t === 'light' ? 'sun' : 'moon', 16),
      ),
    ),
  );
  const update = updateReady();
  const box = h(
    'dialog',
    { class: 'rr-drawer', 'aria-label': 'Menu', tabindex: '-1', onmousedown: backdropCloses, onclose: () => box.remove() },
    h(
      'header',
      { class: 'rr-drawer__head' },
      h('div', { class: 'rr-drawer__title' }, m.title),
      h('div', { class: 'rr-drawer__facts' }, [m.repo, m.number ? `PR #${m.number}` : null, ...features.facts()].filter(Boolean).join(' · ')),
    ),
    h(
      'nav',
      { class: 'rr-drawer__list' },
      item('All reviews', 'home', 'hub', { title: 'Every review running on this machine' }),
      item('Search', 'search', 'palette'),
      ...more.top,
      sep(),
      ...more.review,
      sep(),
      h('div', { class: 'rr-drawer__row' }, icon('theme', 24), h('span', null, 'Theme'), theme),
      item('Install app', 'install', 'app.install', { title: 'An icon on the home screen, in a window of its own' }),
      update
        ? item(`reviewroom ${__RR_BUILD__.slice(0, 7)}`, 'info', update, { hint: 'Update ready: reload', title: 'Reload into the new version of reviewroom' })
        : h('div', { class: 'rr-drawer__row rr-drawer__version' }, icon('info', 24), h('span', null, `reviewroom ${__RR_BUILD__.slice(0, 7)}`), h('small', null, 'Up to date')),
    ),
  );
  document.body.append(box);
  box.showModal();
  box.focus(); // the drawer, not its first item: no ring or tooltip on open
}
