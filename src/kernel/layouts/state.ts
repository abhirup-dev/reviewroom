// Mutable layout policy belongs to one review, even when several reviews share a page.
import type { ReviewApp } from '../../app';
import type { Layout } from './layout.shared';

/** Conditional panels are offered once, when their provider first has content. */
export interface PanelAvailability {
  ids: readonly string[];
  isAvailable(id: string): boolean;
}
export type LayoutSnapshot = { raw: string; key: string; w: number; h: number; layout?: string };
interface LayoutState {
  current?: Layout;
  currentId?: string;
  availability?: PanelAvailability;
  offered: Set<string>;
  passingPanels: Set<string>;
  undoStack: LayoutSnapshot[];
  last?: LayoutSnapshot;
}
const states = new WeakMap<ReviewApp, LayoutState>();
export function layoutState(app: ReviewApp): LayoutState {
  let state = states.get(app);
  if (!state) {
    state = { offered: new Set(), passingPanels: new Set(), undoStack: [] };
    states.set(app, state);
    app.onDispose(() => states.delete(app));
  }
  return state;
}
