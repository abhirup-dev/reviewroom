// Back (Android's button, the browser's): each layer opened that isn't a dialog (the code peek, a sheet, the guided
// walkthrough's player) and each area visited is a history entry, and Back closes the newest. A layer closed some other
// way takes its entry back out. A modal dialog (the menu, search, a thread) is the browser's: it closes it on Back and
// Esc by itself (a close request) where it has CloseWatcher; elsewhere (Chrome before 126) it takes an entry too.
import type { ReviewApp } from '../app';

type Entry = { close: () => void; pushed: boolean };
const backs: Entry[] = [];
let skip = 0; // popstates our own history.back() calls cause
// entries opened while such a back is on its way wait for it (pushed before it lands, it would go back over them)
const flush = () => backs.forEach((e, i) => !e.pushed && ((e.pushed = true), history.pushState({ rrBack: i + 1 }, '')));
/** A history entry for a layer; returns what to call when it closes some other way. */
export function onBack(close: () => void) {
  const e: Entry = { close, pushed: false };
  backs.push(e);
  if (!skip) flush();
  return () => {
    const i = backs.indexOf(e);
    if (i < 0) return; // Back closed it
    backs.splice(i, 1);
    if (!e.pushed) return;
    skip++;
    history.back();
  };
}
/** Close a dialog as Esc would (its cancel handlers run), where the browser can. */
const dismiss = (d: HTMLDialogElement & { requestClose?(): void }) => (d.requestClose ? d.requestClose() : d.close());

/** Back closes onBack's layers (and, without close requests, open dialogs): once per page, by the presentation (the
 *  phone shell, or src/phone.ts's turned). */
export function watchBack(app: ReviewApp) {
  app.listen(window, 'popstate', (e: PopStateEvent) => {
    if (skip) return void (--skip || flush());
    // as deep as the entry Back (or the browser's history menu) went to
    const depth = (e.state as { rrBack?: number } | null)?.rrBack ?? 0;
    while (backs.length > depth) backs.pop()!.close();
  });
  // shortcut: a history entry per dialog where Back doesn't close it natively; drop once Chrome < 126 doesn't matter
  if ('CloseWatcher' in window) return;
  const drops = new Map<HTMLDialogElement, () => void>();
  const dialogs = new MutationObserver((ms) => {
    for (const { target: d } of ms) {
      if (!(d instanceof HTMLDialogElement)) continue;
      if (d.open && !drops.has(d))
        drops.set(d, onBack(() => {
          drops.delete(d);
          dismiss(d);
        }));
      else if (!d.open) {
        drops.get(d)?.();
        drops.delete(d);
      }
    }
  });
  dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  app.onDispose(() => dialogs.disconnect());
}
