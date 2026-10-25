// Thread panel placement and the availability of panels backed by GitHub.
import type { ReviewApp } from '../app';
import { addPanelAt, showPanel } from '../kernel/dock';
import type { PanelAvailability } from '../kernel/layouts/layout';
import { recapThreads } from '../kernel/state/ops.shared';

/** Inject into mountDock: these panels wait for a GitHub snapshot that has content. */
export function githubPanelAvailability(app: ReviewApp): PanelAvailability {
  return {
    ids: ['ci', 'description'],
    isAvailable: (id) => !!(id === 'ci' ? app.github?.ci?.length : id === 'description' && app.github?.description),
  };
}

/** A thread as a panel: beside the walkthrough, or stacked with the threads already docked. */
export function dockThread(app: ReviewApp, id: string, title: string) {
  const pid = 'thread:' + id;
  const api = app.dock;
  if (!app.presentation.canArrange || !api) return addPanelAt(app, { id: pid, component: 'thread', title, params: { id } }, 'right'); // a phone: a sheet
  if (!api.getPanel(pid)) {
    const other = api.panels.find((p) => p.id.startsWith('thread:'));
    const near = other ?? api.getPanel('narrative') ?? api.activePanel;
    api.addPanel({ id: pid, component: 'thread', title, params: { id }, position: near ? { referencePanel: near.id, direction: other ? 'within' : 'right' } : undefined });
    if (!other) api.getPanel(pid)?.group.api.setSize({ width: 420 });
  }
  showPanel(app, pid);
}

/** Last round applies while a round has threads from the last one: a page of Read on a phone; the dock floats it in
 *  once per round (recap.ts). */
export const recapAvailable = (app: ReviewApp) => app.state.round >= 2 && Object.values(recapThreads(app.state)).some((ts) => ts.length);
