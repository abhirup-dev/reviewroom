// Saved-layout policy: selecting, restoring, offering, undoing and persisting a review's arrangement.
import type { DockviewApi, SerializedDockview, Direction } from 'dockview';
import type { ReviewApp } from '../../app';
import { createActor, fromPromise } from 'xstate';
import { layoutSaveMachine } from './save.machine';
import { builtinLayouts, fromDockview, layoutId, placement, toDockview, type DockJSON, type LastLayout, type Layout } from './layout.shared';
import { addDockPanel, createDock, panelDef, panelDefs } from '../dock';
import { layoutState, type LayoutSnapshot, type PanelAvailability } from './state';

export type { PanelAvailability } from './state';

// ---------------------------------------------------------------- layout files
/** Every layout by name: the shipped ones, then the reviewer's saved ones (in menu and alt+N order). */
export const layouts = (app: ReviewApp): Record<string, Layout> => ({ ...builtinLayouts, ...app.layouts });
// the review's starting layout: the reviewer's default, else its layout="" attribute, else Reading
const startId = (app: ReviewApp) => [app.defaultLayout ?? '', app.root.getAttribute('layout') ?? '', 'reading'].find((id) => layouts(app)[id])!;

// the panels reviewroom itself defines; any other a layout leaves out (an agent's own) joins the walkthrough's tabs
const ownPanels = ['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description'];

/** Back to the review's starting layout. */
export function resetLayout(app: ReviewApp) {
  applyLayout(app, startId(app));
}

/** Rebuild the dock from layout `id`; false if there is no such layout. */
export function applyLayout(app: ReviewApp, id: string) {
  const state = layoutState(app);
  const l = layouts(app)[id];
  if (!l) return false;
  const api = app.dock;
  const json = toDockview(l.root, api.width || window.innerWidth, api.height || window.innerHeight, (pid) => {
    const def = panelDef(pid);
    // On-demand panels stay out of layouts; conditional panels wait for their provider.
    if (!def || def.onDemand || (state.availability?.ids.includes(pid) && !state.availability.isAvailable(pid))) return undefined;
    return { id: pid, contentComponent: pid, title: def.title };
  });
  if (json) api.fromJSON(json as SerializedDockview);
  else api.clear();
  state.current = l;
  state.currentId = id;
  state.offered = new Set(state.availability?.ids.filter((pid) => api.getPanel(pid)));
  for (const d of panelDefs()) if (!d.onDemand && !ownPanels.includes(d.id)) addDockPanel(api, d.id, { panel: 'narrative', dir: 'within' });
  if (!api.panels.length) addDockPanel(api, 'narrative'); // a layout of nothing reviewroom has
  api.getPanel('narrative')?.api.setActive();
  return true;
}

/** Save the current arrangement as a new layout named `title`, to pick from the layout menu in any review
 *  (and start from, `asDefault`). A taken name (shipped or saved) is refused: false, nothing changed. */
export async function saveLayout(app: ReviewApp, title: string, asDefault = false) {
  const id = layoutId(title);
  if (!id) return app.toast('Name it with some letters or digits', 'error'), false;
  if (layouts(app)[id]) return app.toast(`“${title}” is taken: pick another name`, 'error'), false;
  const { last } = layoutState(app);
  const now = passing(app) && last ? JSON.parse(last.raw) : app.dock.toJSON();
  const root = fromDockview(now as DockJSON, (pid) => !pid.includes(':')); // no on-demand panels, no windows
  if (!root) return app.toast('Nothing to save: no panels are open', 'error'), false;
  const layout = { title, root };
  if (!(await app.backend.saveLayout(id, layout).catch(() => false))) return app.toast('Could not save the layout', 'error'), false;
  app.layouts[id] = layout;
  app.commands.register(layoutCommand(app, id));
  if (asDefault && !(await setDefaultLayout(app, id))) return true; // saved; setDefaultLayout said what failed
  app.toast(asDefault ? `Saved “${title}”: reviews without a layout of their own open like this` : `Saved layout “${title}”`);
  return true;
}

/** Make saved layout `id` the one reviews start from, or have none (null). */
export async function setDefaultLayout(app: ReviewApp, id: string | null) {
  if (!(await app.backend.setDefaultLayout(id).catch(() => false))) return app.toast('Could not change the default layout', 'error'), false;
  app.defaultLayout = id;
  if (!id) app.toast('No default layout: new reviews start from their built-in layout');
  return true;
}

/** Delete one of the reviewer's saved layouts (it stops being the default, if it was). */
export async function deleteLayout(app: ReviewApp, id: string) {
  const title = app.layouts[id]?.title;
  if (!(await app.backend.saveLayout(id, null).catch(() => false))) return app.toast('Could not delete the layout', 'error');
  delete app.layouts[id];
  if (app.defaultLayout === id) app.defaultLayout = null;
  app.toast(`Deleted layout “${title}”`);
}

/** The palette command for layout `id` (alt+N for the first nine). */
export function layoutCommand(app: ReviewApp, id: string) {
  const i = Object.keys(layouts(app)).indexOf(id);
  const l = layouts(app)[id];
  return { id: 'layout.' + id, title: `Layout: ${l.title}`, group: 'Layout', hint: l.hint, keys: i >= 0 && i < 9 ? [`alt+${i + 1}`] : undefined, when: () => !!layouts(app)[id], run: () => applyLayout(app, id) };
}

// a pin or section opened big over the layout (focus.ts) isn't a layout change: not saved, not an undo step
export const passingPanels = (app: ReviewApp) => layoutState(app).passingPanels;
const passing = (app: ReviewApp) => app.dock.panels.some((p) => p.id.startsWith('slot:') || (passingPanels(app).has(p.id) && p.group.api.location.type === 'floating'));

// ---------------------------------------------------------------- undo
// Settled layouts (kernel/layouts/save.machine.ts reads the dock once it settles), newest last. Switching tabs isn't a layout change, and
// neither is the window resizing: that only moves the baseline.
// `layout`: the layout file the dock was built from, which undo brings back with it.
const snapshot = (app: ReviewApp): LayoutSnapshot => {
  const j = app.dock.toJSON();
  return { raw: JSON.stringify(j), key: JSON.stringify(j, (k, v) => (k === 'activeGroup' || k === 'activeView' ? undefined : v)), w: j.grid.width, h: j.grid.height, layout: layoutState(app).currentId };
};
function track(app: ReviewApp) {
  const state = layoutState(app);
  const { last, undoStack } = state;
  const s = snapshot(app);
  if (last && s.key !== last.key && s.w === last.w && s.h === last.h) {
    undoStack.push(last);
    if (undoStack.length > 30) undoStack.shift();
  }
  state.last = s;
}
export const canUndoLayout = (app: ReviewApp) => layoutState(app).undoStack.length > 0;
/** Back to the layout before the last change (switching layouts and resets included). */
export function undoLayout(app: ReviewApp) {
  const state = layoutState(app);
  const prev = state.undoStack.pop();
  if (!prev) return;
  app.dock.fromJSON(JSON.parse(prev.raw));
  if (prev.layout && layouts(app)[prev.layout]) {
    state.currentId = prev.layout;
    state.current = layouts(app)[prev.layout];
  }
  state.last = snapshot(app); // the change this fires is the undo itself, not a new step
}

export interface MountDockOptions {
  panelAvailability?: PanelAvailability;
}

/** The dock, as this review last left it (`saved`) or in its starting layout. */
export function mountDock(app: ReviewApp, host: HTMLElement, saved: LastLayout | null, options: MountDockOptions = {}): DockviewApi {
  const state = layoutState(app);
  state.availability = options.panelAvailability;
  const api = createDock(app, host);
  let restored = false;
  if (saved) {
    try {
      api.fromJSON(saved.dock as SerializedDockview);
      restored = api.panels.length > 0;
    } catch (e) {
      console.warn('[reviewroom] stale layout, starting over', e);
      api.clear();
    }
  }
  if (restored) {
    state.currentId = saved!.layout && layouts(app)[saved!.layout] ? saved!.layout : startId(app);
    state.current = layouts(app)[state.currentId];
    state.offered = new Set(saved!.offered);
  } else resetLayout(app);

  state.last = snapshot(app);
  const saver = createActor(layoutSaveMachine.provide({ actors: { save: fromPromise(({ input }) => app.backend.saveLastLayout(input)) } }), {
    input: {
      read: () => {
        if (passing(app)) return null;
        track(app);
        return { dock: api.toJSON(), offered: [...state.offered], layout: state.currentId };
      },
    },
  }).start();
  const changes = api.onDidLayoutChange(() => saver.send({ type: 'change' }));
  const flush = () => saver.send({ type: 'flush' });
  addEventListener('pagehide', flush);
  app.onDispose(() => {
    changes.dispose();
    removeEventListener('pagehide', flush);
    // Capture before the dock and layout state are disposed; finish queued saves asynchronously.
    saver.send({ type: 'dispose' });
  });
  return api;
}

/** Add panel `id` where the current layout puts it; undefined if the layout has no place for it. */
function placePanel(app: ReviewApp, id: string, params?: Record<string, unknown>) {
  const { current } = layoutState(app);
  const api = app.dock;
  const def = panelDef(id);
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

/** Offer conditional panels once per review as their provider makes them available. */
export function offerAvailablePanels(app: ReviewApp) {
  const state = layoutState(app);
  const availability = state.availability;
  if (!availability) return;
  for (const id of availability.ids) {
    if (!availability.isAvailable(id) || app.dock.getPanel(id) || state.offered.has(id)) continue;
    state.offered.add(id);
    placePanel(app, id);
    state.last = snapshot(app); // provider panels arriving belong to the starting layout, not an undo step
  }
}

/** Ensure a panel exists (re-adding it next to a sensible neighbour if the user closed it) and focus it. */
export function ensurePanel(app: ReviewApp, id: string, params?: Record<string, unknown>) {
  const api = app.dock;
  // back where the layout puts it; one the layout has no place for joins the walkthrough's tabs (as in applyLayout)
  let p = api.getPanel(id) ?? placePanel(app, id, params);
  if (!p) {
    const kind = id.split(':')[0];
    const def = panelDef(kind)!;
    p = api.addPanel({ id, component: kind, title: def.title + (id.includes(':') ? ' ' + id.split(':')[1] : ''), params, position: api.getPanel('narrative') ? { referencePanel: 'narrative', direction: 'within' } : undefined });
  }
  if (!p.api.isVisible) p.api.setActive();
  return p;
}
