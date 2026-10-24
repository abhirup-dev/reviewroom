// Saved-layout policy: selecting, restoring, offering, undoing and persisting a review's arrangement.
// One Layouts per review (app.layout): it holds the layout state for the review's whole life; the dock is its view.
import type { DockviewApi, SerializedDockview, Direction } from 'dockview';
import type { ReviewApp } from '../../app';
import { createActor, fromPromise } from 'xstate';
import { layoutSaveMachine } from './save.machine';
import { builtinLayouts, fromDockview, layoutId, placement, toDockview, type DockJSON, type LastLayout, type Layout } from './layout.shared';
import { addDockPanel, createDock, isFloating, panelDef, panelDefs } from '../dock';

/** Conditional panels are offered once, when their provider first has content. */
export interface PanelAvailability {
  ids: readonly string[];
  isAvailable(id: string): boolean;
}
export interface MountDockOptions {
  panelAvailability?: PanelAvailability;
}
// A settled dock. `key` ignores which tab is in front (switching tabs isn't a layout change); `layout`: the layout file
// the dock was built from, which undo brings back with it.
type Snapshot = { raw: string; key: string; w: number; h: number; layout?: string };

// the panels reviewroom itself defines; any other a layout leaves out (an agent's own) joins the walkthrough's tabs
const ownPanels = ['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description', 'recap'];

export class Layouts {
  /** The reviewer's saved layouts by id, beside the shipped ones. */
  saved: Record<string, Layout> = {};
  /** The saved layout reviews start from. */
  defaultId: string | null = null;
  /** The layout the dock was built from: new panels go where it puts them; undo and the next reload return to it. */
  currentId?: string;
  private current?: Layout;
  /** A pin or section opened big over the layout (focus.ts) isn't a layout change: not saved, not an undo step. */
  readonly passing = new Set<string>();
  private availability?: PanelAvailability;
  private offered = new Set<string>();
  private undoStack: Snapshot[] = [];
  private last?: Snapshot;

  constructor(private app: ReviewApp) {}

  // ---------------------------------------------------------------- layout files
  /** Every layout by name: the shipped ones, then the reviewer's saved ones (in menu and alt+N order). */
  all(): Record<string, Layout> {
    return { ...builtinLayouts, ...this.saved };
  }
  // the review's starting layout: the reviewer's default, else its layout="" attribute, else Reading
  private startId() {
    return [this.defaultId ?? '', this.app.root.getAttribute('layout') ?? '', 'reading'].find((id) => this.all()[id])!;
  }
  private setCurrent(id: string) {
    this.currentId = id;
    this.current = this.all()[id];
  }
  /** A toast for what went wrong, and false for the caller to return. */
  private fail(message: string) {
    this.app.toast(message, 'error');
    return false;
  }

  /** Back to the review's starting layout. */
  reset() {
    this.apply(this.startId());
  }

  /** Rebuild the dock from layout `id`; false if there is no such layout. */
  apply(id: string) {
    const l = this.all()[id];
    if (!l) return false;
    const api = this.app.dock;
    const availability = this.availability;
    const json = toDockview(l.root, api.width || window.innerWidth, api.height || window.innerHeight, (pid) => {
      const def = panelDef(pid);
      // On-demand panels stay out of layouts; conditional panels wait for their provider.
      if (!def || def.onDemand || (availability?.ids.includes(pid) && !availability.isAvailable(pid))) return undefined;
      return { id: pid, contentComponent: pid, title: def.title };
    });
    if (json) api.fromJSON(json as SerializedDockview);
    else api.clear();
    this.setCurrent(id);
    this.offered = new Set(availability?.ids.filter((pid) => api.getPanel(pid)));
    // an agent's own panels join the walkthrough's tabs (or the dock's edge, in a layout without the walkthrough)
    for (const d of panelDefs()) if (!d.onDemand && !ownPanels.includes(d.id)) addDockPanel(api, d.id, api.getPanel('narrative') ? { panel: 'narrative', dir: 'within' } : undefined);
    if (!api.panels.length) addDockPanel(api, 'narrative'); // a layout of nothing reviewroom has
    api.getPanel('narrative')?.api.setActive();
    return true;
  }

  /** Save the current arrangement as a new layout named `title`, to pick from the layout menu in any review
   *  (and start from, `asDefault`). A taken name (shipped or saved) is refused: false, nothing changed. */
  async save(title: string, asDefault = false) {
    const app = this.app;
    const id = layoutId(title);
    if (!id) return this.fail('Name it with some letters or digits');
    if (this.all()[id]) return this.fail(`“${title}” is taken: pick another name`);
    const now = this.isPassing() && this.last ? JSON.parse(this.last.raw) : app.dock.toJSON();
    const root = fromDockview(now as DockJSON, (pid) => !pid.includes(':')); // no on-demand panels, no windows
    if (!root) return this.fail('Nothing to save: no panels are open');
    const layout = { title, root };
    if (!(await app.backend.saveLayout(id, layout).catch(() => false))) return this.fail('Could not save the layout');
    this.saved[id] = layout;
    app.commands.register(this.command(id));
    if (asDefault && !(await this.setDefault(id))) return true; // saved; setDefault said what failed
    app.toast(asDefault ? `Saved “${title}”: reviews without a layout of their own open like this` : `Saved layout “${title}”`);
    return true;
  }

  /** Make saved layout `id` the one reviews start from, or have none (null). */
  async setDefault(id: string | null) {
    if (!(await this.app.backend.setDefaultLayout(id).catch(() => false))) return this.fail('Could not change the default layout');
    this.defaultId = id;
    if (!id) this.app.toast('No default layout: new reviews start from their built-in layout');
    return true;
  }

  /** Delete one of the reviewer's saved layouts (it stops being the default, if it was). */
  async delete(id: string) {
    const title = this.saved[id]?.title;
    if (!(await this.app.backend.saveLayout(id, null).catch(() => false))) return this.app.toast('Could not delete the layout', 'error');
    delete this.saved[id];
    if (this.defaultId === id) this.defaultId = null;
    this.app.toast(`Deleted layout “${title}”`);
  }

  /** The palette command for layout `id` (alt+N for the first nine). */
  command(id: string) {
    const i = Object.keys(this.all()).indexOf(id);
    const l = this.all()[id];
    return { id: 'layout.' + id, title: `Layout: ${l.title}`, group: 'Layout', hint: l.hint, keys: i >= 0 && i < 9 ? [`alt+${i + 1}`] : undefined, when: () => !!this.all()[id], run: () => this.apply(id) };
  }

  private isPassing() {
    return this.app.dock.panels.some((p) => p.id.startsWith('slot:') || (this.passing.has(p.id) && isFloating(p.group)));
  }

  // ---------------------------------------------------------------- undo
  // Settled layouts (save.machine.ts reads the dock once it settles), newest last. Switching tabs isn't a layout
  // change, and neither is the window resizing: that only moves the baseline.
  private snapshot(): Snapshot {
    const j = this.app.dock.toJSON();
    return { raw: JSON.stringify(j), key: JSON.stringify(j, (k, v) => (k === 'activeGroup' || k === 'activeView' ? undefined : v)), w: j.grid.width, h: j.grid.height, layout: this.currentId };
  }
  private track() {
    const { last, undoStack } = this;
    const s = this.snapshot();
    if (last && s.key !== last.key && s.w === last.w && s.h === last.h) {
      undoStack.push(last);
      if (undoStack.length > 30) undoStack.shift();
    }
    this.last = s;
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  /** Back to the layout before the last change (switching layouts and resets included). */
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.app.dock.fromJSON(JSON.parse(prev.raw));
    if (prev.layout && this.all()[prev.layout]) this.setCurrent(prev.layout);
    this.last = this.snapshot(); // the change this fires is the undo itself, not a new step
  }

  // ---------------------------------------------------------------- the dock
  /** The dock, as this review last left it (`saved`) or in its starting layout. */
  mount(host: HTMLElement, saved: LastLayout | null, options: MountDockOptions = {}): DockviewApi {
    const app = this.app;
    this.availability = options.panelAvailability;
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
      this.setCurrent(saved!.layout && this.all()[saved!.layout] ? saved!.layout : this.startId());
      this.offered = new Set(saved!.offered);
    } else this.reset();

    this.last = this.snapshot();
    const saver = createActor(layoutSaveMachine.provide({ actors: { save: fromPromise(({ input }) => app.backend.saveLastLayout(input)) } }), {
      input: {
        read: () => {
          if (this.isPassing()) return null;
          this.track();
          return { dock: api.toJSON(), offered: [...this.offered], layout: this.currentId };
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
  private place(id: string, params?: Record<string, unknown>) {
    const api = this.app.dock;
    const def = panelDef(id);
    const at = def && this.current && placement(this.current.root, id, (x) => !!api.getPanel(x));
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
  offerAvailable() {
    const availability = this.availability;
    if (!availability) return;
    for (const id of availability.ids) {
      if (!availability.isAvailable(id) || this.app.dock.getPanel(id) || this.offered.has(id)) continue;
      this.offered.add(id);
      this.place(id);
      this.last = this.snapshot(); // provider panels arriving belong to the starting layout, not an undo step
    }
  }

  /** Ensure a panel exists (re-adding it next to a sensible neighbour if the user closed it) and focus it. */
  ensurePanel(id: string, params?: Record<string, unknown>) {
    const api = this.app.dock;
    // back where the layout puts it; one the layout has no place for joins the walkthrough's tabs (as in apply)
    let p = api.getPanel(id) ?? this.place(id, params);
    if (!p) {
      const kind = id.split(':')[0];
      const def = panelDef(kind)!;
      p = api.addPanel({ id, component: kind, title: def.title + (id.includes(':') ? ' ' + id.split(':')[1] : ''), params, position: api.getPanel('narrative') ? { referencePanel: 'narrative', direction: 'within' } : undefined });
    }
    if (!p.api.isVisible) p.api.setActive();
    return p;
  }
}
