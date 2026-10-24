// Generic panel registration, dockview rendering, and floating/docking mechanics.
import { createDockview, type DockviewApi, type IContentRenderer, type DockviewGroupPanel, type IDockviewPanel, type IHeaderActionsRenderer, type CreateComponentOptions } from 'dockview';
import { h, icon } from './dom';
import { menuItem, menuLabel, popMenu } from './menus';
import type { ReviewApp } from '../app';

/** A floating window rather than a docked group. */
export const isFloating = (g: DockviewGroupPanel) => g.api.location.type === 'floating';
/** The stand-in tab that holds a floated panel's place in the dock (see floatInPlace). */
const slotOf = (dock: DockviewApi, id: string) => dock.getPanel('slot:' + id);

export interface PanelDef {
  id: string;
  title: string;
  icon?: Parameters<typeof icon>[0];
  /** Parameterised panels are opened on demand, never by layouts or the panel menu. */
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
/** Register a panel type. Agents can add their own (a metrics chart, a query runner...) from review.html. */
/** Register a panel kind; the returned function restores what was registered under its id before. */
export function definePanel(def: PanelDef) {
  const before = registry.get(def.id);
  registry.set(def.id, def);
  return () => void (before ? registry.set(def.id, before) : registry.delete(def.id));
}
export const panelDefs = () => [...registry.values()];
export const panelDef = (id: string) => registry.get(id);

/** Create the dock surface; saved-layout selection and persistence belong to layout.ts. */
export function createDock(app: ReviewApp, host: HTMLElement): DockviewApi {
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
          inst = def.create(app, (params.params ?? {}), opts.id);
          el.append(inst.element);
          // dockview takes a hidden tab out of the page, which loses its scroll: put it back when the tab shows again
          const scrolled = new Map<Element, [number, number]>();
          el.addEventListener('scroll', (e) => scrolled.set(e.target as Element, [(e.target as Element).scrollTop, (e.target as Element).scrollLeft]), { capture: true, passive: true });
          params.api.onDidVisibilityChange((e) => {
            if (!e.isVisible) return;
            for (const [s, [top, left]] of scrolled) if (s.isConnected) s.scrollTo({ top, left, behavior: 'instant' });
            else scrolled.delete(s);
            inst?.onShow?.();
          });
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
        const floating = isFloating(group);
        const kids: HTMLElement[] = [
          floating
            ? hasSlot(api, group)
              ? btn('dock', 'Put it back where it was (Esc)', () => putBack(app, group.activePanel!.id))
              : btn('dock', 'Dock this window', (b) => dockMenu(api, group, b))
            : btn('popout', 'Float as a window (double-click the tab)', () => group.activePanel && floatInPlace(app, group.activePanel.id)),
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
    // our own menu (styled, and its Float keeps the layout): dockview shows nothing for an empty list
    getTabContextMenuItems: ({ panel, event }) => (tabMenu(app, api, panel, event), []),
  });

  app.dock = api;
  app.surface = new DockSurface(app, api);
  // double-click a tab: float it in place, or put a floated one back
  const doubleClick = (e: MouseEvent) => {
    const tab = (e.target as Element).closest('.dv-tab');
    const p = tab && api.panels.find((x) => tab.contains(x.view.tab.element));
    if (!p || (e.target as Element).closest('.dv-default-tab-action')) return;
    if (!isFloating(p.group)) floatInPlace(app, p.id);
    else if (slotOf(api, p.id)) putBack(app, p.id);
  };
  host.addEventListener('dblclick', doubleClick);
  app.onDispose(() => host.removeEventListener('dblclick', doubleClick));
  // dockview's own tab buttons get tooltips too
  const labelTabs = () =>
    requestAnimationFrame(() =>
      host.querySelectorAll('.dv-default-tab-action:not([data-tip])').forEach((el) => ((el as HTMLElement).dataset.tip = 'Close panel (reopen it from the layout menu)')),
    );
  const subscriptions = [api.onDidAddPanel(labelTabs), api.onDidLayoutFromJSON(labelTabs)];
  app.onDispose(() => subscriptions.forEach((sub) => sub.dispose()));
  return api;
}

export function addDockPanel(api: DockviewApi, id: string, ref?: { panel?: string; group?: string; dir: 'left' | 'right' | 'above' | 'below' | 'within' }, params?: Record<string, unknown>) {
  const def = registry.get(id.split(':')[0]);
  if (!def || api.getPanel(id)) return api.getPanel(id);
  return api.addPanel({
    id,
    component: def.id,
    title: def.title,
    params,
    position: ref ? (ref.panel ? { referencePanel: ref.panel, direction: ref.dir } : undefined) : undefined,
  });
}

type Match = (id: string, params: Record<string, unknown> | undefined) => boolean;
export type DockPlacement = 'right' | 'below' | 'float' | 'center';
/** Where panels open: the dock (DockSurface), or the phone shell (phone.ts: one panel at a time, nothing floats). */
export interface PanelSurface {
  has(id: string): boolean;
  /** Open (if needed) and bring to the front; false if there's no such panel. */
  show(id: string, params?: Record<string, unknown>): boolean;
  close(id: string): void;
  setTitle(id: string, title: string): void;
  find(match: Match): string | undefined;
  /** Bring an open panel to the front; false if it isn't open. */
  toFront(id: string): boolean;
  /** Add a panel beside `near` (else the code panel, else the active one), below it, or as a window. */
  add(panel: { id: string; component: string; title: string; params: Record<string, unknown> }, placement: DockPlacement, near?: string): void;
  /** Float a panel in place (see floatInPlace). */
  float(id: string): void;
  putBack(id: string): void;
  /** Esc runs `back` once, if the panel is still floating then. */
  onEscape(id: string, back: () => void): void;
  /** The panel in front. */
  front(): string | undefined;
}

// The rest of the app asks for panels through these, never dockview itself: the phone shell replaces them.
export const hasPanel = (app: ReviewApp, id: string) => !!app.surface?.has(id);
export const closePanel = (app: ReviewApp, id: string) => app.surface?.close(id);
export const setPanelTitle = (app: ReviewApp, id: string, title: string) => app.surface?.setTitle(id, title);
/** The first open panel `match` accepts. */
export const findPanel = (app: ReviewApp, match: Match) => app.surface?.find(match);
/** Open a panel (if needed: where the layout puts it) and bring it to the front; false if there's no such panel. */
export const ensurePanel = (app: ReviewApp, id: string, params?: Record<string, unknown>) => !!app.surface?.show(id, params);
/** The panel in front: the phone's page or sheet, the dock's active panel. */
export const frontPanel = (app: ReviewApp) => app.surface?.front();
/** Bring an open panel to the front; false if it isn't open. */
export const showPanel = (app: ReviewApp, id: string) => !!app.surface?.toFront(id);
/** Add a panel beside `near` (else the code panel, else the active one), below it, or as a window. */
export const addPanelAt = (app: ReviewApp, panel: Parameters<PanelSurface['add']>[0], placement: DockPlacement, near?: string) => app.surface?.add(panel, placement, near);
/** Esc runs `back` once, if the panel is still floating then. */
export const onEscape = (app: ReviewApp, id: string, back: () => void) => app.surface?.onEscape(id, back);
/** Float a docked panel to the centre. A stand-in keeps its docked spot so nothing else moves;
 *  Esc, "Put it back" or closing the window returns it to exactly that spot. Every way of floating
 *  a panel (header button, tab double-click or menu, double-clicking a section, file or pin) comes here. */
export const floatInPlace = (app: ReviewApp, id: string) => app.surface?.float(id);
export const putBack = (app: ReviewApp, id: string) => app.surface?.putBack(id);

/** The dock as a PanelSurface: dockview's panels, groups and floating windows. */
class DockSurface implements PanelSurface {
  constructor(
    private app: ReviewApp,
    private api: DockviewApi,
  ) {}

  has = (id: string) => !!this.api.getPanel(id);
  /** The dock opens a panel where the layout puts it (Layouts.ensurePanel). */
  show = (id: string, params?: Record<string, unknown>) => !!this.app.layout.ensurePanel(id, params);
  close = (id: string) => this.api.getPanel(id)?.api.close();
  setTitle = (id: string, title: string) => this.api.getPanel(id)?.api.setTitle(title);
  find = (match: Match) => this.api.panels.find((p) => match(p.id, p.params))?.id;
  front = () => this.api.activePanel?.id;

  toFront(id: string) {
    const p = this.api.getPanel(id);
    if (!p) return false;
    // dockview re-appends an already shown panel on setActive, which resets its scroll (and CodeView's idea of it);
    // a panel behind another group's maximize still needs setActive, which brings it out
    const covered = this.api.hasMaximizedGroup() && !p.group.api.isMaximized();
    if (p.api.isVisible && !covered) p.group.api.setActive();
    else p.api.setActive();
    return true;
  }

  add(panel: Parameters<PanelSurface['add']>[0], placement: DockPlacement, near?: string) {
    const api = this.api;
    const ref = (near && api.getPanel(near)) || api.getPanel('code') || api.activePanel;
    if (placement === 'float' || placement === 'center') api.addPanel({ ...panel, floating: placement === 'center' ? centerBox(api) : floatBox(api) });
    else api.addPanel({ ...panel, position: ref ? { referencePanel: ref.id, direction: placement === 'below' ? 'below' : 'right' } : undefined });
  }

  onEscape(id: string, back: () => void) {
    const app = this.app;
    const f = () => {
      app.escapers.splice(app.escapers.indexOf(f), 1);
      const p = this.api.getPanel(id);
      if (!p || !isFloating(p.group)) return false;
      back();
      return true;
    };
    app.escapers.push(f);
  }

  float(id: string) {
    if (id.startsWith('slot:')) return this.putBack(id.slice(5)); // the stand-in itself: bring the panel home
    const p = this.api.getPanel(id);
    if (!p) return;
    if (isFloating(p.group)) return p.api.setActive();
    const group = p.group;
    this.api.addPanel({ id: 'slot:' + id, component: 'slot', title: p.title ?? id, params: { for: id, component: id.split(':')[0], params: p.params }, position: { referenceGroup: group, index: group.panels.indexOf(p) + 1 }, inactive: group.activePanel !== p });
    this.api.addFloatingGroup(p, centerBox(this.api));
    this.onEscape(id, () => this.putBack(id));
  }

  putBack(id: string) {
    const slot = slotOf(this.api, id);
    if (!slot) return;
    const group = slot.group;
    const index = group.panels.indexOf(slot);
    const keep = group.activePanel !== slot ? group.activePanel : undefined;
    const p = this.api.getPanel(id);
    if (p) p.api.moveTo({ group, position: 'center', index });
    else this.api.addPanel({ id, component: slot.params!.component, params: slot.params!.params, title: slot.title, position: { referenceGroup: group, index } }); // its window was closed
    slot.api.close();
    keep?.api.setActive();
  }
}

// ------------------------------------------------------------------ floating / docking helpers
/** Where a floating window opens: right half of the dock, inside the viewport. */
export function floatBox(api: DockviewApi, w = 0.5, hgt = 0.62) {
  const W = api.width || window.innerWidth;
  const H = api.height || window.innerHeight;
  const width = Math.round(Math.min(980, Math.max(420, W * w)));
  const height = Math.round(Math.min(H - 60, Math.max(320, H * hgt)));
  return { position: { top: Math.max(24, Math.round((H - height) / 3)), left: Math.max(24, W - width - 40) }, width, height };
}

/** A large window centred on the dock. */
export function centerBox(api: DockviewApi) {
  const W = api.width || window.innerWidth;
  const H = api.height || window.innerHeight;
  const width = Math.round(W * 0.8);
  const height = Math.round(H * 0.86);
  return { position: { top: Math.round((H - height) / 2), left: Math.round((W - width) / 2) }, width, height };
}

const hasSlot = (api: DockviewApi, group: DockviewGroupPanel) => !!group.activePanel && !!slotOf(api, group.activePanel.id);

function tabMenu(app: ReviewApp, api: DockviewApi, p: IDockviewPanel, e: MouseEvent) {
  e.preventDefault();
  const tab = ((e.target as Element).closest('.dv-tab') ?? e.target) as HTMLElement;
  const g = p.group;
  const floating = isFloating(g);
  popMenu(tab, (close) => [
    p.id.startsWith('slot:')
      ? menuItem('Put it back', () => (close(), putBack(app, p.id.slice(5))), { icon: 'dock', hint: 'Esc' })
      : floating
      ? slotOf(api, p.id) ? menuItem('Put it back', () => (close(), putBack(app, p.id)), { icon: 'dock', hint: 'Esc' }) : null
      : menuItem('Float as a window', () => (close(), floatInPlace(app, p.id)), { icon: 'popout', hint: 'double-click' }),
    floating ? null : menuItem(g.api.isMaximized() ? 'Restore' : 'Maximise', () => (close(), g.api.isMaximized() ? g.api.exitMaximized() : (p.api.setActive(), g.api.maximize())), { icon: 'maximize' }),
    menuItem('Close', () => (close(), p.api.close()), { icon: 'close' }),
    g.panels.length > 1 ? menuItem('Close others', () => (close(), g.panels.filter((x) => x !== p).forEach((x) => x.api.close()))) : null,
  ]);
}

function dockMenu(api: DockviewApi, group: DockviewGroupPanel, anchor: HTMLElement) {
  const targets = api.groups.filter((g) => g.api.location.type === 'grid' && g !== group);
  const named = (g: DockviewGroupPanel) => g.panels.map((p) => p.title).join(' · ');
  const go = (target: DockviewGroupPanel | undefined, position: 'left' | 'right' | 'top' | 'bottom' | 'center') => {
    if (!target) return;
    group.api.moveTo({ group: target, position });
  };
  const main = targets.find((g) => g.panels.some((p) => p.id === 'code')) ?? targets.find((g) => g.panels.some((p) => p.id === 'narrative')) ?? targets[0];
  popMenu(anchor, (close) => [
    menuLabel(`Dock next to ${main ? named(main) : 'the layout'}`),
    menuItem('Right', () => (close(), go(main, 'right')), { icon: 'split' }),
    menuItem('Below', () => (close(), go(main, 'bottom')), { icon: 'unified' }),
    menuItem('Left', () => (close(), go(main, 'left'))),
    menuItem('Above', () => (close(), go(main, 'top'))),
    menuItem('As a tab', () => (close(), go(main, 'center'))),
    targets.length > 1 ? menuLabel('Or as a tab in') : null,
    ...(targets.length > 1 ? targets.filter((g) => g !== main).map((g) => menuItem(named(g), () => (close(), go(g, 'center')))) : []),
  ]);
}

definePanel({
  id: 'slot',
  title: 'Open in a window',
  onDemand: true,
  create: (app, params, panelId) => {
    const id = params.for as string;
    const dock = app.dock!; // only the dock makes stand-ins
    const name = dock.getPanel(panelId)?.title ?? 'This panel';
    const el = h(
      'div',
      { class: 'rr-slot' },
      h('p', null, `${name} is open in a window.`),
      h('button', { class: 'rr-btn', title: 'Back into this spot', 'data-keys': 'Escape', onclick: () => putBack(app, id) }, 'Put it back'),
    );
    const sub = dock.onDidLayoutChange(() =>
      queueMicrotask(() => {
        const slot = dock.getPanel(panelId);
        const p = dock.getPanel(id);
        if (!slot) return;
        if (!p) putBack(app, id);
        // docked somewhere else by hand: this spot has no job left
        else if (!isFloating(p.group) && p.group !== slot.group) slot.api.close();
      }),
    );
    return { element: el, dispose: () => sub.dispose() };
  },
});
