// Thread panel placement and the availability of panels backed by GitHub.
import type { ReviewApp } from '../app';
import { showPanel } from '../kernel/dock';
import type { PanelAvailability } from '../kernel/layouts/state';

/** Inject into mountDock: these panels wait for a GitHub snapshot that has content. */
export function githubPanelAvailability(app: ReviewApp): PanelAvailability {
  return {
    ids: ['ci', 'description'],
    isAvailable: (id) => !!(id === 'ci' ? app.github?.ci?.length : id === 'description' && app.github?.description),
  };
}

/** A thread as a panel: beside the walkthrough, or stacked with the threads already docked. */
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
