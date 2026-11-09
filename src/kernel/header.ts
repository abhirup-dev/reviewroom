// Shell header: identity, search, layout, theme, and injected feature controls. On a phone, a status bar and a menu
// drawer instead (header.phone.ts).
import { avatarUrl, copyText, diffstat, h, icon, plural } from './dom';
import { keyLabel, modLabel } from './commands';
import { closePanel, hasPanel, panelDefs } from './dock';
import type { ReviewApp } from '../app';
import { noteDialog } from './dialog';
import { popMenu, menuItem, menuLabel } from './menus';

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
        app.layout.canUndo() ? menuItem('Undo layout change', () => { close(); app.layout.undo(); }, { icon: 'undo', hint: 'back to how it was' }) : null,
        menuItem('Reset layout', () => { close(); app.layout.reset(); }, { icon: 'round', hint: def ? `back to “${def.title}”` : 'every panel back in place' }),
        menuItem('Save layout as default…', () => { close(); saveLayoutDialog(app, true); }, { icon: 'pin', hint: 'new reviews open like this' }),
        def ? menuItem('Forget default layout', () => { close(); void app.layout.setDefault(null); }, { icon: 'close', hint: `“${def.title}” stays saved` }) : null,
        menuItem('Save layout as…', () => { close(); saveLayoutDialog(app); }, { hint: 'pick it here in any review' }),
        mine().length ? menuItem('Delete a saved layout…', () => { close(); popMenu(layoutBtn, (done) => mine().map((id) => menuItem(app.layout.saved[id].title, () => { done(); void app.layout.delete(id); }, { icon: 'close' }))); }) : null,
        menuLabel('Layouts'),
        ...Object.entries(app.layout.all()).map(([id, l], i) => menuItem(l.title, () => { close(); app.layout.apply(id); }, { checked: id === app.layout.defaultId, hint: [id === app.layout.defaultId ? 'default' : '', i < 9 ? keyLabel(`alt+${i + 1}`) : ''].filter(Boolean).join(' · ') || undefined })),
        menuLabel('Panels'),
        ...panelDefs()
          .filter((d) => !d.onDemand)
          .map((d) => menuItem(d.title, () => { close(); if (hasPanel(app, d.id)) closePanel(app, d.id); else app.layout.ensurePanel(d.id); }, { checked: hasPanel(app, d.id) })),
      ]);
    };
    const infoBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', title: 'About this change: repository, author, branches, worktree', 'aria-label': 'About this change', 'aria-haspopup': 'menu', onclick: () => aboutChange(app, infoBtn) }, icon('info', 16));
    const adds = app.files.reduce((n, f) => n + f.additions, 0), dels = app.files.reduce((n, f) => n + f.deletions, 0);
    bar.replaceChildren(
      h(
        'div',
        { class: 'rr-header__id' },
        h('div', { class: 'rr-mark', 'aria-hidden': 'true' }, 'rr'),
        // the title opens the change's details too (a bigger target than the icon beside it)
        h('button', { class: 'rr-header__title', title: m.title, 'aria-haspopup': 'menu', onclick: () => aboutChange(app, infoBtn) }, m.number ? h('span', { class: 'rr-muted' }, `#${m.number} `) : null, m.title),
        infoBtn,
        h('span', { class: 'rr-delta', title: `${plural(app.files.length, 'file')}: ${adds} lines added, ${dels} removed` }, diffstat(adds, dels)),
      ),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-header__actions' },
        ...features.status(),
        ...shellStatus(),
        h('button', { class: 'rr-search-btn', onclick: () => app.openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        ...features.beforeLayout(),
        layoutBtn,
        // install stays in the palette (Install app) and on the hub
        app.backend.kind === 'server' ? h('a', { class: 'rr-hbtn rr-hbtn--icon', href: hubHref(), target: '_blank', title: 'All reviews: every review running on this machine (reviewroom, Crit and Plannotator)', 'aria-label': 'All reviews' }, icon('globe', 16)) : null,
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system') }, icon(themeIcon, 16)),
        ...features.afterTheme(),
      ),
    );
  };
  repaintOn(app, paint, features.subscribe);
  return bar;
}

/** About this change, from the title or its ⓘ: what the header used to spell out (repository, author, branches) and the
 *  worktree, each a row that copies its value; a PR also opens on GitHub. The menu's own popover, nothing new. */
function aboutChange(app: ReviewApp, anchor: HTMLElement) {
  const m = app.meta;
  const gh = app.github?.description; // the PR's author, with their avatar
  popMenu(anchor, (close) => {
    // a field row that copies its value (whole in its tooltip)
    const copy = (value: string, what: string, label: string | Node = value, mono = false) =>
      menuItem(label, () => { close(); void copyText(value); app.toast(`${what} copied`); }, { field: what, icon: 'copy', mono, title: `Copy ${what.toLowerCase()}: ${value}` });
    const author = gh?.login ?? m.author;
    return [
      menuLabel(m.number ? `Pull request #${m.number}` : 'Change'),
      m.url ? menuItem('Open on GitHub', () => { close(); window.open(m.url, '_blank', 'noopener'); }, { icon: 'github', hint: 'the pull request' }) : null,
      // owner/name from the GitHub remote; without one, the checkout's folder name, said as such
      m.repo ? copy(m.repo, 'Repository', m.repo.includes('/') ? m.repo : h('span', null, m.repo, h('span', { class: 'rr-muted' }, ' · local, no GitHub remote'))) : null,
      author ? copy(author, 'Author', h('span', { class: 'rr-who' }, gh?.avatar ? h('img', { class: 'rr-avatar rr-avatar--gh', src: avatarUrl(gh.avatar, 32), alt: '' }) : null, author)) : null,
      menuLabel('Branches'),
      copy(m.headLabel ?? short(m.head), 'Branch', undefined, true),
      copy(m.baseLabel ?? short(m.base), 'Base', undefined, true),
      copy(m.base, 'Merge base', short(m.base), true),
      m.path ? menuLabel('Worktree') : null,
      // a long path loses its start, not the worktree's name at its end
      m.path ? copy(m.path, 'Path', h('bdi', null, m.path), true) : null,
    ];
  });
}

/** Every header repaints on these, and on what its features subscribe it to. */
export function repaintOn(app: ReviewApp, paint: () => void, subscribe?: (paint: () => void) => void) {
  for (const e of ['state', 'prefs', 'theme', 'files'] as const) app.bus.on(e, paint);
  subscribe?.(paint);
  paint();
}

/** The hub's page: its root when the hub serves this review at /r/<id>/, else this server's hub page. */
export const hubHref = () => (location.pathname.startsWith('/r/') ? '/' : '/api/hub');

/** Where the connection or saving is at; the root's classes show one. */
export const shellStatus = () => [
  h('span', { class: 'rr-pill rr-pill--draft rr-round-status rr-round-status--offline', title: 'The reviewroom server stopped. Changes stay in this tab and are saved when it is back' }, 'Disconnected'),
  h('span', { class: 'rr-pill rr-pill--draft rr-unsaved', title: 'The reviewroom server has not stored your latest changes. Reviewroom keeps retrying; keep this tab open' }, 'Not saved yet'),
];

const short = (s: string) => (/^[0-9a-f]{12,}$/.test(s) ? s.slice(0, 7) : s);
