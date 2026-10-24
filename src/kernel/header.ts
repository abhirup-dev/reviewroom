// Shell header: identity, search, layout, theme, and injected feature controls. On a phone, a status bar and a menu
// drawer instead.
import { append, backdropCloses, h, icon } from './dom';
import { keyLabel, modLabel } from './commands';
import { closePanel, hasPanel, panelDefs } from './dock';
import type { ReviewApp } from '../app';
import { noteDialog } from './dialog';
import { popMenu, menuItem, menuLabel } from './menus';
import { canInstall, install, installButton } from './install';
import { updateReady } from './pwa';

// ---------------------------------------------------------------- save a named layout
/** Name the panels as they are now; as the default, the name starts as “Default” (taken: pick another). */
export function saveLayoutDialog(app: ReviewApp, asDefault = false) {
  const name = h('input', { class: 'rr-composer__input', placeholder: 'Layout name', 'aria-label': 'Layout name', value: asDefault ? 'Default' : '', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && save.click() });
  const save = h('button', { class: 'rr-btn rr-btn--primary', title: 'Save the panels as they are now' }, 'Save');
  const what = asDefault ? 'The panels as they are now, for reviews without a layout of their own to open with.' : 'The panels as they are now, to pick from the layout menu in any review.';
  noteDialog('Save layout', asDefault ? 'Save layout as default' : 'Save layout as', name, (act, close) => {
    save.onclick = act(() => app.layout.save(name.value.trim(), asDefault));
    return [[h('p', { class: 'rr-muted' }, what + ' Names already in use are refused.'), name], [h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), save]];
  });
  name.select();
}

// ---------------------------------------------------------------- header
/** Live feature controls rendered around layout and theme. */
export interface HeaderContributions {
  status: () => (HTMLElement | null)[];
  beforeLayout: () => (HTMLElement | null)[];
  afterTheme: () => (HTMLElement | null)[];
  subscribe?: (paint: () => void) => void;
}

export function buildHeader(app: ReviewApp, features: HeaderContributions): HTMLElement {
  const m = app.meta;
  const bar = h('header', { class: 'rr-header' });
  const paint = () => {
    const themeIcon = app.resolvedTheme() === 'dark' ? 'moon' : 'sun';
    const layoutBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Layout', title: 'Layouts: pick, save or reset one, and choose which panels are open', 'aria-haspopup': 'menu' }, icon('layout', 16));
    const mine = () => Object.keys(app.layout.saved);
    layoutBtn.onclick = () => {
      const def = app.layout.defaultId ? app.layout.all()[app.layout.defaultId] : undefined;
      popMenu(layoutBtn, (close) => [
        app.layout.canUndo() ? menuItem('Undo layout change', () => (close(), app.layout.undo()), { icon: 'undo', hint: 'back to how it was' }) : null,
        menuItem('Reset layout', () => (close(), app.layout.reset()), { icon: 'round', hint: def ? `back to “${def.title}”` : 'every panel back in place' }),
        menuItem('Save layout as default…', () => (close(), saveLayoutDialog(app, true)), { icon: 'pin', hint: 'new reviews open like this' }),
        def ? menuItem('Forget default layout', () => (close(), void app.layout.setDefault(null)), { icon: 'close', hint: `“${def.title}” stays saved` }) : null,
        menuItem('Save layout as…', () => (close(), saveLayoutDialog(app)), { hint: 'pick it here in any review' }),
        mine().length ? menuItem('Delete a saved layout…', () => (close(), popMenu(layoutBtn, (done) => mine().map((id) => menuItem(app.layout.saved[id].title, () => (done(), void app.layout.delete(id)), { icon: 'close' }))))) : null,
        menuLabel('Layouts'),
        ...Object.entries(app.layout.all()).map(([id, l], i) => menuItem(l.title, () => (close(), app.layout.apply(id)), { checked: id === app.layout.defaultId, hint: [id === app.layout.defaultId ? 'default' : '', i < 9 ? keyLabel(`alt+${i + 1}`) : ''].filter(Boolean).join(' · ') || undefined })),
        menuLabel('Panels'),
        ...panelDefs()
          .filter((d) => !d.onDemand)
          .map((d) => menuItem(d.title, () => (close(), hasPanel(app, d.id) ? closePanel(app, d.id) : app.layout.ensurePanel(d.id)), { checked: hasPanel(app, d.id) })),
      ]);
    };
    bar.replaceChildren(
      h(
        'div',
        { class: 'rr-header__id' },
        h('div', { class: 'rr-mark', 'aria-hidden': 'true' }, 'rr'),
        h(
          'div',
          { class: 'rr-header__titles' },
          h('div', { class: 'rr-header__title', title: m.title }, m.number ? h('span', { class: 'rr-muted' }, `#${m.number} `) : null, m.title),
          h(
            'div',
            { class: 'rr-header__meta' },
            m.repo ? h('span', { class: 'rr-pill', title: 'Repository' }, m.repo) : null,
            m.author ? h('span', { class: 'rr-pill', title: 'Author of the change' }, 'by ' + m.author) : null,
            h('span', { class: 'rr-pill rr-pill--mono', title: `Diff of ${m.headLabel ?? m.head} against ${m.baseLabel ?? m.base} (merge base ${short(m.base)})` }, `${m.baseLabel ?? short(m.base)} ← ${m.headLabel ?? short(m.head)}`),
            h('span', { class: 'rr-pill', title: 'Files changed' }, `${app.files.length} files`),
          ),
        ),
      ),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-header__actions' },
        ...features.status(),
        ...shellStatus(),
        app.backend.kind === 'server' ? h('a', { class: 'rr-hbtn', href: hubHref(), target: '_blank', title: 'Every review running on this machine: reviewroom, Crit and Plannotator' }, 'All reviews') : null,
        h('button', { class: 'rr-search-btn', onclick: () => app.openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        ...features.beforeLayout(),
        layoutBtn,
        installButton(),
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system') }, icon(themeIcon, 16)),
        ...features.afterTheme(),
      ),
    );
  };
  repaintOn(app, paint, features.subscribe);
  return bar;
}

/** Every header repaints on these, and on what its features subscribe it to. */
function repaintOn(app: ReviewApp, paint: () => void, subscribe?: (paint: () => void) => void) {
  for (const e of ['state', 'prefs', 'theme', 'files'] as const) app.bus.on(e, paint);
  subscribe?.(paint);
  paint();
}

/** The hub's page: its root when the hub serves this review at /r/<id>/, else this server's hub page. */
export const hubHref = () => (location.pathname.startsWith('/r/') ? '/' : '/api/hub');

/** Where the connection or saving is at; the root's classes show one. */
const shellStatus = () => [
  h('span', { class: 'rr-pill rr-pill--draft rr-round-status rr-round-status--offline', title: 'The reviewroom server stopped. Changes stay in this tab and are saved when it is back' }, 'Disconnected'),
  h('span', { class: 'rr-pill rr-pill--draft rr-unsaved', title: 'The reviewroom server has not stored your latest changes. Reviewroom keeps retrying; keep this tab open' }, 'Not saved yet'),
];

/** A drawer entry: closes the drawer, then runs. */
export type DrawerItem = (label: string, ic: Parameters<typeof icon>[0], run: () => void, opts?: { title?: string; hint?: string }) => HTMLElement;
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
  const item: DrawerItem = (label, ic, run, opts = {}) =>
    h('button', { class: 'rr-drawer__item', title: opts.title, onclick: () => (close(), run()) }, icon(ic, 24), h('span', null, label), opts.hint ? h('small', null, opts.hint) : null);
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
          (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => (b.className = b === e.currentTarget ? 'is-on' : '', b.setAttribute('aria-pressed', String(b === e.currentTarget))));
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
      app.backend.kind === 'server' ? item('All reviews', 'home', () => window.open(hubHref(), '_blank'), { title: 'Every review running on this machine' }) : null,
      item('Search', 'search', () => app.openPalette('')),
      ...more.top,
      sep(),
      ...more.review,
      sep(),
      h('div', { class: 'rr-drawer__row' }, icon('theme', 24), h('span', null, 'Theme'), theme),
      canInstall() ? item('Install app', 'install', () => void install(), { title: 'An icon on the home screen, in a window of its own' }) : null,
      update
        ? item(`reviewroom ${__RR_BUILD__.slice(0, 7)}`, 'info', update, { hint: 'Update ready: reload', title: 'Reload into the new version of reviewroom' })
        : h('div', { class: 'rr-drawer__row rr-drawer__version' }, icon('info', 24), h('span', null, `reviewroom ${__RR_BUILD__.slice(0, 7)}`), h('small', null, 'Up to date')),
    ),
  );
  document.body.append(box);
  box.showModal();
  box.focus(); // the drawer, not its first item: no ring or tooltip on open
}

const short = (s: string) => (/^[0-9a-f]{12,}$/.test(s) ? s.slice(0, 7) : s);
