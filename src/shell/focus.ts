// Double-click anything that has a place in the layout (a file, a section, a pin) to see it big:
// a window over the middle of the dock with the full panel in it. Esc puts things back.
import type { DockviewGroupPanel, IDockviewPanel } from 'dockview-core';
import { formatRef, parseRef, type Ref } from '../core/refs';
import { openInNewPanel } from '../panels/code';
import { PR_DESCRIPTION } from '../../cli/lib/feedback.mjs';
import type { ReviewApp } from './app';
import { centerBox } from './layout';

/** Esc runs `back` once, if the panel is still floating then. */
function onEscape(app: ReviewApp, id: string, back: () => void) {
  const f = () => {
    app.escapers.splice(app.escapers.indexOf(f), 1);
    const p = app.dock.getPanel(id);
    if (!p || p.group.api.location.type !== 'floating') return false;
    back();
    return true;
  };
  app.escapers.push(f);
}

/** Float an existing panel (Review, Description) to the centre; Esc docks it back where it was. */
function floatPanel(app: ReviewApp, id: string) {
  const p = app.dock.getPanel(id);
  if (!p) return;
  if (p.group.api.location.type === 'floating') return p.api.setActive();
  const back = returnTo(app, p);
  app.dock.addFloatingGroup(p, centerBox(app));
  onEscape(app, id, back);
}

/** How to put a panel back: into its group if others stay there, else beside the grid group it touched. */
function returnTo(app: ReviewApp, p: IDockviewPanel): () => void {
  const prev = p.group;
  if (prev.panels.length > 1) return () => app.dock.groups.includes(prev) && p.api.moveTo({ group: prev, position: 'center' });
  const r = prev.element.getBoundingClientRect();
  const near = (a: number, b: number) => Math.abs(a - b) < 10;
  const overlaps = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1) > 20;
  // the group it was split from shares a whole edge with it: prefer the closest match in length
  let best: { g: DockviewGroupPanel; side: 'top' | 'bottom' | 'left' | 'right'; miss: number } | undefined;
  for (const g of app.dock.groups as DockviewGroupPanel[]) {
    if (g === prev || g.api.location.type !== 'grid') continue;
    const q = g.element.getBoundingClientRect();
    const side = near(q.top, r.bottom) && overlaps(q.left, q.right, r.left, r.right) ? 'top'
      : near(q.bottom, r.top) && overlaps(q.left, q.right, r.left, r.right) ? 'bottom'
      : near(q.left, r.right) && overlaps(q.top, q.bottom, r.top, r.bottom) ? 'left'
      : near(q.right, r.left) && overlaps(q.top, q.bottom, r.top, r.bottom) ? 'right'
      : null;
    if (!side) continue;
    const miss = side === 'top' || side === 'bottom' ? Math.abs(q.left - r.left) + Math.abs(q.right - r.right) : Math.abs(q.top - r.top) + Math.abs(q.bottom - r.bottom);
    if (!best || miss < best.miss) best = { g, side, miss };
  }
  if (!best) return () => {};
  const { g, side } = best;
  return () => {
    if (!app.dock.groups.includes(g)) return;
    p.api.moveTo({ group: g, position: side });
    p.group.api.setSize(side === 'top' || side === 'bottom' ? { height: r.height } : { width: r.width });
  };
}

/** A file's code in its own centred window; Esc closes it. */
function openFileCentered(app: ReviewApp, path: string, at?: { side: 'base' | 'head'; start?: number; end?: number }) {
  const inDiff = app.files.some((f) => f.path === path);
  const id = openInNewPanel(app, path, inDiff ? 'diff' : at?.side === 'base' ? 'base' : 'head', 'center', undefined, at && inDiff ? { path, ...at } : undefined);
  onEscape(app, id, () => app.dock.getPanel(id)?.api.close());
}

/** Double-click on a file, section or pin: show it big in the middle of the layout. */
export async function openCentered(app: ReviewApp, ref: string | Ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!r) return;
  switch (r.type) {
    case 'file':
    case 'code':
      return openFileCentered(app, r.path, r.start ? { side: r.rev === 'base' ? 'base' : 'head', start: r.start, end: r.end ?? r.start } : undefined);
    case 'sym': {
      const def = (await app.search(r.name, true).catch(() => [])).find((x) => x.kind === 'definition');
      return def ? openFileCentered(app, def.path, { side: 'head', start: def.line, end: def.line }) : app.open(`rr:sym/${r.name}`);
    }
    case 'doc': {
      const panel = r.id === PR_DESCRIPTION ? 'description' : 'narrative';
      floatPanel(app, panel);
      return app.bus.emit('reveal-doc', { id: r.id, path: r.path });
    }
    default:
      return app.open(formatRef(r));
  }
}
