// Double-click anything that has a place in the layout (a file, a section, a pin) to see it big:
// a window over the middle of the dock with the full panel in it. Esc puts things back.
// Floating a panel in place (layout.ts) is the one mechanism; this maps a link to the panel to float.
import { formatRef, parseRef, type Ref } from '../core/refs';
import { openInNewPanel } from '../panels/code';
import { PR_DESCRIPTION } from '../shared/feedback';
import type { ReviewApp } from './app';
import { closePanel, findPanel, floatInPlace, onEscape, passingPanels } from './layout';

/** A file's code in its own centred window; Esc closes it. */
function openFileCentered(app: ReviewApp, path: string, at?: { side: 'base' | 'head'; start?: number; end?: number }) {
  // already pinned in the layout: float that one, its spot kept
  const pinned = !at && findPanel(app, (id, params) => id.startsWith('code:') && params?.pin === path);
  if (pinned) return floatInPlace(app, pinned);
  const inDiff = app.files.some((f) => f.path === path);
  const id = openInNewPanel(app, path, inDiff ? 'diff' : at?.side === 'base' ? 'base' : 'head', 'center', undefined, at && inDiff ? { path, ...at } : undefined);
  passingPanels.add(id);
  onEscape(app, id, () => closePanel(app, id));
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
      const def = (await app.searchSymbol(r.name).catch(() => [])).find((x) => x.kind === 'definition');
      return def ? openFileCentered(app, def.path, { side: 'head', start: def.line, end: def.line }) : app.open(`rr:sym/${r.name}`);
    }
    case 'doc': {
      const panel = r.id === PR_DESCRIPTION ? 'description' : 'narrative';
      floatInPlace(app, panel);
      // after the window has its size, or the panel's own scroll restore wins
      return requestAnimationFrame(() => app.bus.emit('reveal-doc', { id: r.id, path: r.path }));
    }
    default:
      return app.open(formatRef(r));
  }
}
