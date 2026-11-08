// Panel registration and the panel surface the app opens panels through (the dock's, or the phone shell's). The
// dockview surface itself is dockview.ts.
import { icon } from './dom';
import type { ReviewApp } from '../app';

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
/** Register a panel kind; agents can add their own (a metrics chart, a query runner...) from review.html. The returned
 *  function restores what was registered under its id before. */
export function definePanel(def: PanelDef) {
  const before = registry.get(def.id);
  registry.set(def.id, def);
  return () => void (before ? registry.set(def.id, before) : registry.delete(def.id));
}
export const panelDefs = () => [...registry.values()];
export const panelDef = (id: string) => registry.get(id);
/** The panel kinds reviewroom itself defines; any other (an agent's) joins the narrative's tabs, a page of Read on a phone. */
export const ownPanels = ['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description', 'recap'];

export type Match = (id: string, params: Record<string, unknown> | undefined) => boolean;
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

// The rest of the app asks for panels through these, never dockview itself: through `app.surface` (DockSurface or PhoneShell).
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
