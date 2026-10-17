// Docking layout. Every region is a dockview panel: drag tabs to split, float,
// maximise or pop out; the dock is saved per review and layout files rebuild it.
import { createDockview, type DockviewApi, type IContentRenderer, type DockviewGroupPanel, type IDockviewPanel, type IHeaderActionsRenderer, type CreateComponentOptions, type SerializedDockview, type Direction } from 'dockview';
import { h, icon } from '../core/dom';
import type { ReviewApp } from './app';
import { createActor, fromPromise } from 'xstate';
import { layoutSaveMachine } from '../flows/layout';
import { fromDockview, placement, toDockview, type DockJSON, type LastLayout, type Layout } from '../shared/layout';
import reading from '../layouts/reading.json';
import wideCode from '../layouts/wide-code.json';
import codeFocus from '../layouts/code-focus.json';
import narrativeFocus from '../layouts/narrative-focus.json';

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
/** Register a panel type. Agents can add their own (a metrics chart, a query runner...) from review.html. */
export function definePanel(def: PanelDef) {
  registry.set(def.id, def);
}
export const panelDefs = () => [...registry.values()];

// ---------------------------------------------------------------- layout files
/** The layouts reviewroom ships; the reviewer's own files of the same name replace them. */
const builtins = { reading, 'wide-code': wideCode, 'code-focus': codeFocus, 'narrative-focus': narrativeFocus } as Record<string, Layout>;
/** Every layout by name: the built-ins, then the reviewer's files (`default` is their default). */
export const layouts = (app: ReviewApp): Record<string, Layout> => ({ ...builtins, ...app.layouts });
/** The layouts to pick from (the default is what Reset goes back to), in menu and alt+N order. */
export const pickableLayouts = (app: ReviewApp) => Object.entries(layouts(app)).filter(([id]) => id !== 'default');
// the review's starting layout: the reviewer's default, else its layout="" attribute, else Reading
const startId = (app: ReviewApp) => ['default', app.root.getAttribute('layout') ?? '', 'reading'].find((id) => layouts(app)[id])!;

// the layout the dock was last built from: closed panels and the PR's late panels go back where it puts them
let current: Layout | undefined;
let currentId: string | undefined;
// the PR's own panels (description, ci) are offered once per review, when GitHub has them: closed after that, they stay closed
const github = ['ci', 'description'];
let offered = new Set<string>();
const hasGitHub = (app: ReviewApp, id: string) => !!(id === 'ci' ? app.github?.ci?.length : app.github?.description);
// the panels reviewroom itself defines; any other a layout leaves out (an agent's own) joins the narrative's tabs
const ownPanels = ['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description'];

/** Back to the review's starting layout. */
export function resetLayout(app: ReviewApp) {
  applyLayout(app, startId(app));
}

/** Rebuild the dock from layout `id`; false if there is no such layout. */
export function applyLayout(app: ReviewApp, id: string) {
  const l = layouts(app)[id];
  if (!l) return false;
  const api = app.dock;
  const json = toDockview(l.root, api.width || window.innerWidth, api.height || window.innerHeight, (pid) => {
    const def = registry.get(pid);
    // on-demand panels aren't part of a layout; the PR's own panels wait for GitHub (offerGitHubPanels)
    if (!def || def.onDemand || (github.includes(pid) && !hasGitHub(app, pid))) return undefined;
    return { id: pid, contentComponent: pid, title: def.title };
  });
  if (json) api.fromJSON(json as SerializedDockview);
  else api.clear();
  current = l;
  currentId = id;
  offered = new Set(github.filter((g) => api.getPanel(g)));
  for (const d of panelDefs()) if (!d.onDemand && !ownPanels.includes(d.id)) add(api, d.id, { panel: 'narrative', dir: 'within' });
  if (!api.panels.length) add(api, 'narrative'); // a layout of nothing reviewroom has
  api.getPanel('narrative')?.api.setActive();
  return true;
}

/** The dock as a layout file: no on-demand panels, no windows. */
function asLayout(app: ReviewApp, title: string): Layout | null {
  const now = passing(app.dock) && last ? JSON.parse(last.raw) : app.dock.toJSON();
  const root = fromDockview(now as DockJSON, (id) => !id.includes(':'));
  return root && { title, root };
}

/** Save the current arrangement as layout file `id` (or delete that file: no title). */
async function saveLayout(app: ReviewApp, id: string, title?: string) {
  const layout = title === undefined ? null : asLayout(app, title);
  if (title !== undefined && !layout) return app.toast('Nothing to save: no panels are open', 'error'), false;
  if (!(await app.backend.saveLayout(id, layout).catch(() => false))) return app.toast('Could not save the layout', 'error'), false;
  if (layout) app.layouts[id] = layout;
  else delete app.layouts[id];
  return true;
}

/** Remember the current arrangement for every review on this machine (or forget it). */
export async function saveDefaultLayout(app: ReviewApp, forget = false) {
  if (await saveLayout(app, 'default', forget ? undefined : 'My default')) app.toast(forget ? 'Default layout forgotten: new reviews start from the preset' : 'Saved: reviews without a layout of their own open like this');
}

/** Save the current arrangement under a name, to pick from the layout menu in any review. */
export async function saveNamedLayout(app: ReviewApp, title: string) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!id || id === 'default') return app.toast('Name it with some letters or digits (and not “default”)', 'error'), false;
  if (!(await saveLayout(app, id, title))) return false;
  app.commands.register(layoutCommand(app, id));
  app.toast(`Saved layout “${title}”`);
  return true;
}

/** Delete one of the reviewer's layout files (a built-in of the same name comes back). */
export async function deleteLayout(app: ReviewApp, id: string) {
  const title = app.layouts[id]?.title;
  if (await saveLayout(app, id)) app.toast(`Deleted layout “${title}”`);
}

/** The palette command for layout `id` (alt+N for the first nine). */
export function layoutCommand(app: ReviewApp, id: string) {
  const i = pickableLayouts(app).findIndex(([x]) => x === id);
  const l = layouts(app)[id];
  return { id: 'layout.' + id, title: `Layout: ${l.title}`, group: 'Layout', hint: l.hint, keys: i >= 0 && i < 9 ? [`alt+${i + 1}`] : undefined, when: () => !!layouts(app)[id], run: () => applyLayout(app, id) };
}

// a pin or section opened big over the layout (focus.ts) isn't a layout change: not saved, not an undo step
export const passingPanels = new Set<string>();
const passing = (api: DockviewApi) => api.panels.some((p) => p.id.startsWith('slot:') || (passingPanels.has(p.id) && p.group.api.location.type === 'floating'));

// ---------------------------------------------------------------- undo
// Settled layouts (flows/layout.ts reads the dock once it settles), newest last. Switching tabs isn't a layout change, and
// neither is the window resizing: that only moves the baseline.
// `layout`: the layout file the dock was built from, which undo brings back with it.
type Snap = { raw: string; key: string; w: number; h: number; layout?: string };
const undoStack: Snap[] = [];
let last: Snap | undefined;
const snapshot = (api: DockviewApi): Snap => {
  const j = api.toJSON();
  return { raw: JSON.stringify(j), key: JSON.stringify(j, (k, v) => (k === 'activeGroup' || k === 'activeView' ? undefined : v)), w: j.grid.width, h: j.grid.height, layout: currentId };
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
  if (prev.layout && layouts(app)[prev.layout]) current = layouts(app)[(currentId = prev.layout)];
  last = snapshot(app.dock); // the change this fires is the undo itself, not a new step
}

/** The dock, as this review last left it (`saved`) or in its starting layout. */
export function mountDock(app: ReviewApp, host: HTMLElement, saved: LastLayout | null): DockviewApi {
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
          floating
            ? hasSlot(app, group)
              ? btn('dock', 'Put it back where it was (Esc)', () => putBack(app, group.activePanel!.id))
              : btn('dock', 'Dock this window', (b) => dockMenu(app, group, b))
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
    getTabContextMenuItems: ({ panel, event }) => (tabMenu(app, panel, event), []),
  });

  app.dock = api;
  // double-click a tab: float it in place, or put a floated one back
  host.addEventListener('dblclick', (e) => {
    const tab = (e.target as Element).closest('.dv-tab');
    const p = tab && api.panels.find((x) => tab.contains(x.view.tab.element));
    if (!p || (e.target as Element).closest('.dv-default-tab-action')) return;
    if (p.group.api.location.type !== 'floating') floatInPlace(app, p.id);
    else if (api.getPanel('slot:' + p.id)) putBack(app, p.id);
  });
  // dockview's own tab buttons get tooltips too
  const labelTabs = () =>
    requestAnimationFrame(() =>
      host.querySelectorAll('.dv-default-tab-action:not([data-tip])').forEach((el) => ((el as HTMLElement).dataset.tip = 'Close panel (reopen it from the layout menu)')),
    );
  api.onDidAddPanel(labelTabs);
  api.onDidLayoutFromJSON(labelTabs);
  let restored = false;
  if (saved) {
    try {
      api.fromJSON(saved.dock as SerializedDockview);
      restored = api.panels.length > 0;
    } catch (e) {
      console.warn('[reviewroom] stale layout, using preset', e);
      api.clear();
    }
  }
  if (restored) {
    currentId = saved!.layout && layouts(app)[saved!.layout] ? saved!.layout : startId(app);
    current = layouts(app)[currentId];
    offered = new Set(saved!.offered);
  } else resetLayout(app);

  last = snapshot(api);
  const saver = createActor(layoutSaveMachine.provide({ actors: { save: fromPromise(({ input }) => app.backend.saveLastLayout(input)) } }), {
    input: {
      read: () => {
        if (passing(api)) return null;
        track(api);
        return { dock: api.toJSON(), offered: [...offered], layout: currentId };
      },
    },
  }).start();
  api.onDidLayoutChange(() => saver.send({ type: 'change' }));
  addEventListener('pagehide', () => saver.send({ type: 'flush' }));
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
  });
}

/** Add panel `id` where the current layout puts it; undefined if the layout has no place for it. */
function placePanel(app: ReviewApp, id: string, params?: Record<string, unknown>) {
  const api = app.dock;
  const def = registry.get(id);
  const at = def && current && placement(current.root, id, (x) => !!api.getPanel(x));
  if (!at) return undefined;
  const ref = at.ref ? api.getPanel(at.ref) : undefined;
  const front = at.dir === 'within' ? ref?.group.activePanel : undefined;
  const axis = at.dir === 'left' || at.dir === 'right' ? 'width' : 'height';
  const room = ref ? ref.group.api[axis] : api[axis];
  const p = api.addPanel({ id, component: def.id, title: def.title, params, position: at.ref ? { referencePanel: at.ref, direction: at.dir } : { direction: at.dir as Exclude<Direction, 'within'> } });
  // at the dock's edge, a fraction is of what the pixel-sized siblings leave of it
  if (at.size) p.group.api.setSize({ [axis]: Math.round(at.size > 1 ? at.size : at.size * (room - (ref ? 0 : (at.px ?? 0)))) });
  front?.api.setActive(); // a panel joining a stack doesn't take its front
  return p;
}

/** The PR's panels arrive with the first GitHub snapshot that has them, once per review. */
export function offerGitHubPanels(app: ReviewApp) {
  for (const id of github) {
    if (!hasGitHub(app, id) || app.dock.getPanel(id) || offered.has(id)) continue;
    offered.add(id);
    placePanel(app, id);
    last = snapshot(app.dock); // the PR's panels arriving is part of the starting layout, not something to undo
  }
}

// The rest of the app asks for panels through these, never dockview itself: a phone or tablet layout replaces them.
export const hasPanel = (app: ReviewApp, id: string) => !!app.dock?.getPanel(id);
export const closePanel = (app: ReviewApp, id: string) => app.dock?.getPanel(id)?.api.close();
export const setPanelTitle = (app: ReviewApp, id: string, title: string) => app.dock?.getPanel(id)?.api.setTitle(title);
/** The first open panel `match` accepts. */
export const findPanel = (app: ReviewApp, match: (id: string, params: Record<string, unknown> | undefined) => boolean) => app.dock?.panels.find((p) => match(p.id, p.params))?.id;

/** Bring an open panel to the front; false if it isn't open. */
export function showPanel(app: ReviewApp, id: string) {
  const p = app.dock?.getPanel(id);
  if (!p) return false;
  // dockview re-appends an already shown panel on setActive, which resets its scroll (and CodeView's idea of it);
  // a panel behind another group's maximize still needs setActive, which brings it out
  const covered = app.dock.hasMaximizedGroup() && !p.group.api.isMaximized();
  if (p.api.isVisible && !covered) p.group.api.setActive();
  else p.api.setActive();
  return true;
}

export type Placement = 'right' | 'below' | 'float' | 'center';
/** Add a panel beside `near` (else the code panel, else the active one), below it, or as a window. */
export function addPanelAt(app: ReviewApp, panel: { id: string; component: string; title: string; params: Record<string, unknown> }, placement: Placement, near?: string) {
  const api = app.dock;
  const ref = (near && api.getPanel(near)) || api.getPanel('code') || api.activePanel;
  if (placement === 'float' || placement === 'center') api.addPanel({ ...panel, floating: placement === 'center' ? centerBox(app) : floatBox(app) });
  else api.addPanel({ ...panel, position: ref ? { referencePanel: ref.id, direction: placement === 'below' ? 'below' : 'right' } : undefined });
}

/** A thread as a panel: beside the narrative, or stacked with the threads already docked. */
export function dockThread(app: ReviewApp, id: string, title: string) {
  const api = app.dock;
  const pid = 'thread:' + id;
  if (!api.getPanel(pid)) {
    const other = api.panels.find((p) => p.id.startsWith('thread:'));
    const near = other ?? api.getPanel('narrative') ?? api.activePanel;
    api.addPanel({ id: pid, component: 'thread', title, params: { id }, position: near ? { referencePanel: near.id, direction: other ? 'within' : 'right' } : undefined });
    if (!other) api.getPanel(pid)?.group.api.setSize({ width: 420 });
  }
  showPanel(app, pid);
}

/** Ensure a panel exists (re-adding it next to a sensible neighbour if the user closed it) and focus it. */
export function ensurePanel(app: ReviewApp, id: string, params?: Record<string, unknown>) {
  const api = app.dock;
  // back where the layout puts it, else beside a sensible neighbour
  let p = api.getPanel(id) ?? placePanel(app, id, params);
  if (!p) {
    const kind = id.split(':')[0];
    const near = kind === 'code' ? (api.getPanel('narrative') ? { panel: 'narrative', dir: 'right' as const } : undefined) : api.getPanel('toc') ? { panel: 'toc', dir: 'within' as const } : api.getPanel('narrative') ? { panel: 'narrative', dir: 'left' as const } : undefined;
    const def = registry.get(kind)!;
    p = api.addPanel({ id, component: kind, title: def.title + (id.includes(':') ? ' ' + id.split(':')[1] : ''), params, position: near ? { referencePanel: near.panel, direction: near.dir } : undefined });
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

const hasSlot = (app: ReviewApp, group: DockviewGroupPanel) => !!group.activePanel && !!app.dock.getPanel('slot:' + group.activePanel.id);

function tabMenu(app: ReviewApp, p: IDockviewPanel, e: MouseEvent) {
  e.preventDefault();
  const tab = ((e.target as Element).closest('.dv-tab') ?? e.target) as HTMLElement;
  const g = p.group;
  const floating = g.api.location.type === 'floating';
  void import('./chrome').then(({ popMenu, menuItem }) =>
    popMenu(tab, (close) => [
      p.id.startsWith('slot:')
        ? menuItem('Put it back', () => (close(), putBack(app, p.id.slice(5))), { icon: 'dock', hint: 'Esc' })
        : floating
        ? app.dock.getPanel('slot:' + p.id) ? menuItem('Put it back', () => (close(), putBack(app, p.id)), { icon: 'dock', hint: 'Esc' }) : null
        : menuItem('Float as a window', () => (close(), floatInPlace(app, p.id)), { icon: 'popout', hint: 'double-click' }),
      floating ? null : menuItem(g.api.isMaximized() ? 'Restore' : 'Maximise', () => (close(), g.api.isMaximized() ? g.api.exitMaximized() : (p.api.setActive(), g.api.maximize())), { icon: 'maximize' }),
      menuItem('Close', () => (close(), p.api.close()), { icon: 'close' }),
      g.panels.length > 1 ? menuItem('Close others', () => (close(), g.panels.filter((x) => x !== p).forEach((x) => x.api.close()))) : null,
    ]),
  );
}

function dockMenu(app: ReviewApp, group: DockviewGroupPanel, anchor: HTMLElement) {
  const targets = app.dock.groups.filter((g) => g.api.location.type === 'grid' && g !== group);
  const named = (g: DockviewGroupPanel) => g.panels.map((p) => p.title).join(' · ');
  const go = (target: DockviewGroupPanel | undefined, position: 'left' | 'right' | 'top' | 'bottom' | 'center') => {
    if (!target) return;
    group.api.moveTo({ group: target, position });
  };
  const main = targets.find((g) => g.panels.some((p) => p.id === 'code')) ?? targets.find((g) => g.panels.some((p) => p.id === 'narrative')) ?? targets[0];
  void import('./chrome').then(({ popMenu, menuItem, menuLabel }) =>
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

/** Esc runs `back` once, if the panel is still floating then. */
export function onEscape(app: ReviewApp, id: string, back: () => void) {
  const f = () => {
    app.escapers.splice(app.escapers.indexOf(f), 1);
    const p = app.dock.getPanel(id);
    if (!p || p.group.api.location.type !== 'floating') return false;
    back();
    return true;
  };
  app.escapers.push(f);
}

// ---------------------------------------------------------------- float in place
/** Float a docked panel to the centre. A stand-in keeps its docked spot so nothing else moves;
 *  Esc, "Put it back" or closing the window returns it to exactly that spot. Every way of floating
 *  a panel (header button, tab double-click or menu, double-clicking a section, file or pin) comes here. */
export function floatInPlace(app: ReviewApp, id: string) {
  if (id.startsWith('slot:')) return putBack(app, id.slice(5)); // the stand-in itself: bring the panel home
  const p = app.dock.getPanel(id);
  if (!p) return;
  if (p.group.api.location.type === 'floating') return p.api.setActive();
  const group = p.group;
  app.dock.addPanel({ id: 'slot:' + id, component: 'slot', title: p.title ?? id, params: { for: id, component: id.split(':')[0], params: p.params }, position: { referenceGroup: group, index: group.panels.indexOf(p) + 1 }, inactive: group.activePanel !== p });
  app.dock.addFloatingGroup(p, centerBox(app));
  onEscape(app, id, () => putBack(app, id));
}

export function putBack(app: ReviewApp, id: string) {
  const slot = app.dock.getPanel('slot:' + id);
  if (!slot) return;
  const group = slot.group;
  const index = group.panels.indexOf(slot);
  const keep = group.activePanel !== slot ? group.activePanel : undefined;
  const p = app.dock.getPanel(id);
  if (p) p.api.moveTo({ group, position: 'center', index });
  else app.dock.addPanel({ id, component: slot.params!.component, params: slot.params!.params, title: slot.title, position: { referenceGroup: group, index } }); // its window was closed
  slot.api.close();
  keep?.api.setActive();
}

definePanel({
  id: 'slot',
  title: 'Open in a window',
  onDemand: true,
  create: (app, params, panelId) => {
    const id = params.for as string;
    const name = app.dock.getPanel(panelId)?.title ?? 'This panel';
    const el = h(
      'div',
      { class: 'rr-slot' },
      h('p', null, `${name} is open in a window.`),
      h('button', { class: 'rr-btn', title: 'Back into this spot', 'data-keys': 'Escape', onclick: () => putBack(app, id) }, 'Put it back'),
    );
    const sub = app.dock.onDidLayoutChange(() =>
      queueMicrotask(() => {
        const slot = app.dock.getPanel(panelId);
        const p = app.dock.getPanel(id);
        if (!slot) return;
        if (!p) putBack(app, id);
        // docked somewhere else by hand: this spot has no job left
        else if (p.group.api.location.type !== 'floating' && p.group !== slot.group) slot.api.close();
      }),
    );
    return { element: el, dispose: () => sub.dispose() };
  },
});
