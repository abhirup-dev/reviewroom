// Shell header: identity, search, layout, theme, and injected feature controls.
import { h, icon } from './dom';
import { keyLabel, modLabel } from './commands';
import { closePanel, hasPanel, panelDefs } from './dock';
import { applyLayout, canUndoLayout, deleteLayout, ensurePanel, layouts, resetLayout, saveLayout, setDefaultLayout, undoLayout } from './layouts/layout';
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
    save.onclick = act(() => saveLayout(app, name.value.trim(), asDefault));
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
    const mine = () => Object.keys(app.layouts);
    layoutBtn.onclick = () => {
      const def = app.defaultLayout ? layouts(app)[app.defaultLayout] : undefined;
      popMenu(layoutBtn, (close) => [
        canUndoLayout(app) ? menuItem('Undo layout change', () => (close(), undoLayout(app)), { icon: 'undo', hint: 'back to how it was' }) : null,
        menuItem('Reset layout', () => (close(), resetLayout(app)), { icon: 'round', hint: def ? `back to “${def.title}”` : 'every panel back in place' }),
        menuItem('Save layout as default…', () => (close(), saveLayoutDialog(app, true)), { icon: 'pin', hint: 'new reviews open like this' }),
        def ? menuItem('Forget default layout', () => (close(), void setDefaultLayout(app, null)), { icon: 'close', hint: `“${def.title}” stays saved` }) : null,
        menuItem('Save layout as…', () => (close(), saveLayoutDialog(app)), { hint: 'pick it here in any review' }),
        mine().length ? menuItem('Delete a saved layout…', () => (close(), popMenu(layoutBtn, (done) => mine().map((id) => menuItem(app.layouts[id].title, () => (done(), void deleteLayout(app, id)), { icon: 'close' }))))) : null,
        menuLabel('Layouts'),
        ...Object.entries(layouts(app)).map(([id, l], i) => menuItem(l.title, () => (close(), applyLayout(app, id)), { checked: id === app.defaultLayout, hint: [id === app.defaultLayout ? 'default' : '', i < 9 ? keyLabel(`alt+${i + 1}`) : ''].filter(Boolean).join(' · ') || undefined })),
        menuLabel('Panels'),
        ...panelDefs()
          .filter((d) => !d.onDemand)
          .map((d) => menuItem(d.title, () => (close(), hasPanel(app, d.id) ? closePanel(app, d.id) : ensurePanel(app, d.id)), { checked: hasPanel(app, d.id) })),
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
        h('span', { class: 'rr-pill rr-pill--draft rr-round-status rr-round-status--offline', title: 'The reviewroom server stopped. Changes stay in this tab and are saved when it is back' }, 'Disconnected'),
        h('span', { class: 'rr-pill rr-pill--draft rr-unsaved', title: 'The reviewroom server has not stored your latest changes. Reviewroom keeps retrying; keep this tab open' }, 'Not saved yet'),
        app.backend.kind === 'server' ? h('a', { class: 'rr-hbtn', href: '/api/hub', target: '_blank', title: 'Every review running on this machine: reviewroom, Crit and Plannotator' }, 'All reviews') : null,
        h('button', { class: 'rr-search-btn', onclick: () => app.openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        ...features.beforeLayout(),
        layoutBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system') }, icon(themeIcon, 16)),
        ...features.afterTheme(),
      ),
    );
  };
  app.bus.on('state', paint);
  app.bus.on('prefs', paint);
  app.bus.on('theme', paint);
  app.bus.on('files', paint);
  features.subscribe?.(paint);
  paint();
  return bar;
}

const short = (s: string) => (/^[0-9a-f]{12,}$/.test(s) ? s.slice(0, 7) : s);
