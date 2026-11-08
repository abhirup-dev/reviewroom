// The phone's part of the walkthrough panel (rr-486.10): the Contents panel (the desktop's, whole) a tap away, as a
// sheet over the walkthrough. src/phone.ts hands it to the panel (registerWalkthroughExtension).
import { h, icon } from '../kernel/dom';
import { panelDef } from '../kernel/dock';
import { openSheet, sheetDialog } from '../kernel/sheet';
import type { ReviewApp } from '../app';
import type { WalkthroughExtension } from './walkthrough';

export const contentsButton: WalkthroughExtension = (app, panel) =>
  panel.append(h('button', { class: 'rr-toc-fab', title: 'Contents', 'aria-label': 'Contents', 'aria-haspopup': 'dialog', onclick: () => contentsSheet(app) }, icon('toc', 22)));

/** Contents as a bottom sheet; following an entry closes it (the entry then scrolls the walkthrough to its place). */
function contentsSheet(app: ReviewApp) {
  const toc = panelDef('toc')?.create(app, {}, 'toc');
  if (!toc) return;
  const sheet = sheetDialog({ class: 'rr-tour-toc rr-toc-sheet', 'aria-label': 'Contents', tabindex: '-1' });
  const off = app.bus.on('reveal-doc', () => sheet.close());
  sheet.addEventListener('close', () => { off(); toc.dispose?.(); sheet.remove(); }, { once: true });
  openSheet(sheet, h('h2', { class: 'rr-tour-toc__title' }, 'Contents'), toc.element);
  sheet.focus(); // the sheet, not its first entry: no ring on open
}
