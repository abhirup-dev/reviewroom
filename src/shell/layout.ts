// Docking layout. Every region is a dockview panel: drag tabs to split, float,
// maximise or pop out; the layout is saved per review and presets rebuild it.
import { createDockview, type DockviewApi, type IContentRenderer, type DockviewGroupPanel, type IHeaderActionsRenderer, type CreateComponentOptions } from 'dockview-core';
import { h, icon } from '../core/dom';
import { loadRaw, saveLocal } from '../core/store';
import type { ReviewApp } from './app';
import { withoutPanels } from '../core/dockjson';

export interface PanelDef {
  id: string;
  title: string;
  icon?: Parameters<typeof icon>[0];
  /** Parameterised panels (e.g. one per thread) are opened on demand, never by presets or the panel menu. */
  onDemand?: boolean;
  /** Build the panel body. Called once per mounted panel instance. */
  create(app: ReviewApp, params: Record<string, unknown>, panelId: string): PanelInstance;
}
export interface PanelInstance {
  element: HTMLElement;
  onShow?(): void;
  dispose?(): void;
}

const registry = new Map<string, PanelDef>();
/** Register a panel type. Agents can add their own (a metrics chart, a query runner…) from review.html. */
export function definePanel(def: PanelDef) {
  registry.set(def.id, def);
}
export const panelDefs = () => [...registry.values()];

export type PresetName = 'reading' | 'wide-code' | 'code-focus' | 'narrative-focus';
/** Back to the review's starting layout: the reviewer's saved default, else its layout="" attribute, else Reading. */
export function resetLayout(app: ReviewApp) {
  if (!applyDefault(app)) applyPreset(app, (app.root.getAttribute('layout') as PresetName) || 'reading');
}

// panels opened for one thing (a thread, one file) aren't part of a default
const onDemandPanel = (id: string) => id.includes(':');

function applyDefault(app: ReviewApp): boolean {
  if (!app.defaultLayout) return false;
  try {
    app.dock.fromJSON(app.defaultLayout as any);
    // the PR's own panels only mean something on a PR
    if (!app.meta.number) ['ci', 'description'].forEach((id) => app.dock.getPanel(id)?.api.close());
    return app.dock.panels.length > 0;
  } catch (e) {
    console.warn('[reviewroom] saved default layout no longer loads, using preset', e);
    app.dock.clear();
    return false;
  }
}

/** Remember the current arrangement for every review on this machine (or forget it: null). */
export async function saveDefaultLayout(app: ReviewApp, forget = false) {
  const layout = forget ? null : withoutPanels(app.dock.toJSON() as any, onDemandPanel);
  if (!(await app.backend.saveDefaultLayout?.(layout))) return app.toast('Could not save the default layout', 'error');
  app.defaultLayout = layout;
  app.toast(forget ? 'Default layout forgotten: new reviews start from the preset' : 'Saved: reviews without a layout of their own open like this');
}

export const presets: { id: PresetName; title: string; hint: string }[] = [
  { id: 'reading', title: 'Reading', hint: 'Narrative centre, code on the right' },
  { id: 'wide-code', title: 'Wide code', hint: 'Code below the narrative, full width' },
  { id: 'code-focus', title: 'Code focus', hint: 'Code centre, narrative as a side column' },
  { id: 'narrative-focus', title: 'Narrative focus', hint: 'Just the narrative; code opens on demand' },
];

const layoutKey = (app: ReviewApp) => `reviewroom:layout:${app.meta.id}`;

// ---------------------------------------------------------------- undo
// Settled layouts (after the save debounce), newest last. Switching tabs isn't a layout change, and
// neither is the window resizing: that only moves the baseline.
type Snap = { raw: string; key: string; w: number; h: number };
const undoStack: Snap[] = [];
let last: Snap | undefined;
const snapshot = (api: DockviewApi): Snap => {
  const j = api.toJSON();
  return { raw: JSON.stringify(j), key: JSON.stringify(j, (k, v) => (k === 'activeGroup' || k === 'activeView' ? undefined : v)), w: j.grid.width, h: j.grid.height };
};
function track(api: DockviewApi) {
  const s = snapshot(api);
  if (last && s.key !== last.key && s.w === last.w && s.h === last.h) {
    undoStack.push(last);
    if (undoStack.length > 30) undoStack.shift();
  }
  last = s;
}
export const canUndoLayout = () => undoStack.length > 0;
/** Back to the layout before the last change (presets and resets included). */
export function undoLayout(app: ReviewApp) {
  const prev = undoStack.pop();
  if (!prev) return;
  app.dock.fromJSON(JSON.parse(prev.raw));
  last = snapshot(app.dock); // the change this fires is the undo itself, not a new step
}

export function mountDock(app: ReviewApp, host: HTMLElement): DockviewApi {
  const api = createDockview(host, {
    theme: { name: 'reviewroom', className: 'dockview-theme-rr', gap: 0, dndOverlayMounting: 'absolute', dndPanelOverlay: 'group', dndTabIndicator: 'line' },
    singleTabMode: 'default',
    createComponent: (opts: CreateComponentOptions): IContentRenderer => {
      const kind = opts.name;
      const def = registry.get(kind);
      const el = h('div', { class: 'rr-panel-host', 'data-rr-kind': kind });
      let inst: PanelInstance | undefined;
      return {
        element: el,
        init(params) {
          if (!def) {
            el.append(h('div', { class: 'rr-empty' }, `Unknown panel “${kind}”`));
            return;
          }
          inst = def.create(app, (params.params ?? {}) as Record<string, unknown>, opts.id);
          el.append(inst.element);
          params.api.onDidVisibilityChange((e) => e.isVisible && inst?.onShow?.());
        },
        dispose() {
          inst?.dispose?.();
        },
      };
    },
    createRightHeaderActionComponent: (group: DockviewGroupPanel): IHeaderActionsRenderer => {
      const el = h('div', { class: 'rr-group-actions' });
      const btn = (name: Parameters<typeof icon>[0], label: string, fn: (b: HTMLElement) => void) => {
        const b = h('button', { class: 'rr-icon-btn', 'aria-label': label, title: label });
        b.append(icon(name, 14));
        b.onclick = () => fn(b);
        return b;
      };
      const paint = () => {
        const floating = group.api.location.type === 'floating';
        const kids: HTMLElement[] = [
          floating ? btn('dock', 'Dock this window', (b) => dockMenu(app, group, b)) : btn('popout', 'Float as a window', () => floatGroup(app, group)),
        ];
        if (!floating) kids.push(btn('maximize', group.api.isMaximized() ? 'Restore' : 'Maximise', () => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize())));
        el.replaceChildren(...kids);
      };
      let subs: { dispose(): void }[] = [];
      return {
        element: el,
        init() {
          paint();
          subs = [group.api.onDidLocationChange(paint), api.onDidMaximizedGroupChange(paint)];
        },
        dispose() {
          subs.forEach((d) => d.dispose());
        },
      };
    },
    // floating windows can never be dragged out of reach; a visible titlebar is the move handle
    floatingGroupBounds: 'boundedWithinViewport',
    floatingGroupDragHandle: 'titlebar',
    getTabContextMenuItems: () => ['float', 'maximize', 'separator', 'close', 'closeOthers'],
  });

  app.dock = api;
  // dockview's own tab buttons get tooltips too
  const labelTabs = () =>
    requestAnimationFrame(() =>
      host.querySelectorAll('.dv-default-tab-action:not([data-tip])').forEach((el) => ((el as HTMLElement).dataset.tip = 'Close panel (reopen it from the layout menu)')),
    );
  api.onDidAddPanel(labelTabs);
  api.onDidLayoutFromJSON?.(labelTabs);
  const saved = loadRaw(layoutKey(app));
  let restored = false;
  if (saved) {
    try {
      api.fromJSON(JSON.parse(saved));
      restored = api.panels.length > 0;
    } catch (e) {
      console.warn('[reviewroom] stale layout, using preset', e);
      api.clear();
    }
  }
  if (!restored && !applyDefault(app)) applyPreset(app, (app.root.getAttribute('layout') as PresetName) || 'reading');

  let t: ReturnType<typeof setTimeout> | undefined;
  last = snapshot(api);
  api.onDidLayoutChange(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      saveLocal(layoutKey(app), api.toJSON());
      track(api);
    }, 250);
  });
  return api;
}

function add(api: DockviewApi, id: string, ref?: { panel?: string; group?: string; dir: 'left' | 'right' | 'above' | 'below' | 'within' }, params?: Record<string, unknown>) {
  const def = registry.get(id.split(':')[0]);
  if (!def || api.getPanel(id)) return api.getPanel(id);
  return api.addPanel({
    id,
    component: def.id,
    title: def.title,
    params,
    position: ref ? (ref.panel ? { referencePanel: ref.panel, direction: ref.dir } : undefined) : undefined,
  } as any);
}

export function applyPreset(app: ReviewApp, name: PresetName) {
  const api = app.dock;
  api.clear();
  const extra = panelDefs().filter((d) => !d.onDemand && !['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description'].includes(d.id));
  const W = api.width || window.innerWidth;
  const size = (id: string, s: { width?: number; height?: number }) => api.getPanel(id)?.group.api.setSize(s);
  switch (name) {
    case 'reading':
      add(api, 'narrative');
      add(api, 'toc', { panel: 'narrative', dir: 'left' });
      add(api, 'files', { panel: 'toc', dir: 'below' });
      add(api, 'threads', { panel: 'files', dir: 'within' });
      add(api, 'code', { panel: 'narrative', dir: 'right' });
      size('toc', { width: 264 });
      size('code', { width: Math.round((W - 264) * 0.5) });
      api.getPanel('files')?.api.setActive();
      break;
    case 'wide-code':
      add(api, 'narrative');
      add(api, 'toc', { panel: 'narrative', dir: 'left' });
      add(api, 'files', { panel: 'toc', dir: 'below' });
      add(api, 'threads', { panel: 'files', dir: 'within' });
      add(api, 'code', { panel: 'narrative', dir: 'below' });
      size('toc', { width: 264 });
      size('code', { height: Math.round((api.height || window.innerHeight) * 0.52) });
      api.getPanel('files')?.api.setActive();
      break;
    case 'code-focus':
      add(api, 'code');
      add(api, 'files', { panel: 'code', dir: 'left' });
      add(api, 'toc', { panel: 'files', dir: 'within' });
      add(api, 'narrative', { panel: 'code', dir: 'right' });
      add(api, 'threads', { panel: 'narrative', dir: 'below' });
      size('files', { width: 264 });
      size('narrative', { width: Math.round(W * 0.3) });
      api.getPanel('files')?.api.setActive();
      break;
    case 'narrative-focus':
      add(api, 'narrative');
      add(api, 'toc', { panel: 'narrative', dir: 'left' });
      add(api, 'threads', { panel: 'toc', dir: 'within' });
      add(api, 'files', { panel: 'toc', dir: 'within' });
      add(api, 'code', { panel: 'narrative', dir: 'within' });
      size('toc', { width: 264 });
      api.getPanel('toc')?.api.setActive();
      api.getPanel('narrative')?.api.setActive();
      break;
  }
  // a preset is the whole layout: the PR's panels join it now, or when GitHub answers
  for (const id of ['ci', 'description'])
    try {
      localStorage.removeItem(`${layoutKey(app)}:${id}`);
    } catch {}
  offerGitHubPanels(app);
  for (const d of extra) add(api, d.id, { panel: 'narrative', dir: 'within' });
  api.getPanel('narrative')?.api.setActive();
}

/** The CI tab, behind Threads (keeping whichever tab was in front). */
function addCiTab(app: ReviewApp) {
  const front = app.dock.getPanel('threads')?.group.activePanel;
  add(app.dock, 'ci', { panel: app.dock.getPanel('threads') ? 'threads' : 'narrative', dir: 'within' });
  front?.api.setActive();
}

/** The PR description, above the agent's review (taking the top 40%). */
function addDescription(app: ReviewApp) {
  if (!app.dock.getPanel('narrative')) return;
  add(app.dock, 'description', { panel: 'narrative', dir: 'above' });
  app.dock.getPanel('description')?.group.api.setSize({ height: Math.round((app.dock.height || window.innerHeight) * 0.4) });
}

/** GitHub panels arrive with the first GitHub snapshot, once per review: closed after that, they stay closed (layout menu reopens them). */
export function offerGitHubPanels(app: ReviewApp) {
  const g = app.github;
  const offer = (id: string, has: unknown, place: (app: ReviewApp) => void) => {
    const key = `${layoutKey(app)}:${id}`;
    if (!has || app.dock.getPanel(id) || loadRaw(key)) return;
    saveLocal(key, 1);
    place(app);
    last = snapshot(app.dock); // the PR's panels arriving is part of the starting layout, not something to undo
  };
  offer('ci', g?.ci?.length, addCiTab);
  offer('description', g?.description, addDescription);
}

/** Ensure a panel exists (re-adding it next to a sensible neighbour if the user closed it) and focus it. */
export function ensurePanel(app: ReviewApp, id: string, params?: Record<string, unknown>) {
  const api = app.dock;
  let p = api.getPanel(id);
  // the PR's own panels go back where the presets put them
  if (!p && id === 'description' && api.getPanel('narrative')) addDescription(app), (p = api.getPanel(id));
  if (!p && id === 'ci' && api.getPanel('threads')) addCiTab(app), (p = api.getPanel(id));
  if (!p) {
    const kind = id.split(':')[0];
    const near = kind === 'code' ? (api.getPanel('narrative') ? { panel: 'narrative', dir: 'right' as const } : undefined) : api.getPanel('toc') ? { panel: 'toc', dir: 'within' as const } : api.getPanel('narrative') ? { panel: 'narrative', dir: 'left' as const } : undefined;
    const def = registry.get(kind)!;
    p = api.addPanel({ id, component: kind, title: def.title + (id.includes(':') ? ' ' + id.split(':')[1] : ''), params, position: near ? { referencePanel: near.panel, direction: near.dir } : undefined } as any);
  }
  if (!p.api.isVisible) p.api.setActive();
  return p;
}


// ------------------------------------------------------------------ floating / docking helpers
/** Where a floating window opens: right half of the dock, inside the viewport. */
export function floatBox(app: ReviewApp, w = 0.5, hgt = 0.62) {
  const W = app.dock.width || window.innerWidth;
  const H = app.dock.height || window.innerHeight;
  const width = Math.round(Math.min(980, Math.max(420, W * w)));
  const height = Math.round(Math.min(H - 60, Math.max(320, H * hgt)));
  return { position: { top: Math.max(24, Math.round((H - height) / 3)), left: Math.max(24, W - width - 40) }, width, height };
}

/** A large window centred on the dock. */
export function centerBox(app: ReviewApp) {
  const W = app.dock.width || window.innerWidth;
  const H = app.dock.height || window.innerHeight;
  const width = Math.round(W * 0.8);
  const height = Math.round(H * 0.86);
  return { position: { top: Math.round((H - height) / 2), left: Math.round((W - width) / 2) }, width, height };
}

export function floatGroup(app: ReviewApp, group: DockviewGroupPanel) {
  const p = group.activePanel;
  if (p) app.dock.addFloatingGroup(group.panels.length > 1 ? p : group, floatBox(app));
}

function dockMenu(app: ReviewApp, group: DockviewGroupPanel, anchor: HTMLElement) {
  const targets = app.dock.groups.filter((g) => g.api.location.type === 'grid' && g !== group);
  const named = (g: DockviewGroupPanel) => g.panels.map((p) => p.title).join(' · ');
  const go = (target: DockviewGroupPanel | undefined, position: 'left' | 'right' | 'top' | 'bottom' | 'center') => {
    if (!target) return;
    group.api.moveTo({ group: target, position });
  };
  const main = targets.find((g) => g.panels.some((p) => p.id === 'code')) ?? targets.find((g) => g.panels.some((p) => p.id === 'narrative')) ?? targets[0];
  import('./chrome').then(({ popMenu, menuItem, menuLabel }) =>
    popMenu(anchor, (close) => [
      menuLabel(`Dock next to ${main ? named(main) : 'the layout'}`),
      menuItem('Right', () => (close(), go(main, 'right')), { icon: 'split' }),
      menuItem('Below', () => (close(), go(main, 'bottom')), { icon: 'unified' }),
      menuItem('Left', () => (close(), go(main, 'left'))),
      menuItem('Above', () => (close(), go(main, 'top'))),
      menuItem('As a tab', () => (close(), go(main, 'center'))),
      targets.length > 1 ? menuLabel('Or as a tab in') : null,
      ...(targets.length > 1 ? targets.filter((g) => g !== main).map((g) => menuItem(named(g), () => (close(), go(g, 'center')))) : []),
    ]),
  );
}
