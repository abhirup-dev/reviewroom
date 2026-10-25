// Back (Android's button, the browser's): each layer opened (a dialog such as the menu, search or a thread; the code
// peek; a sheet) and each area visited is a history entry, and Back closes the newest. A layer closed some other way
// takes its entry back out. Chrome on Android closes a modal dialog on Back by itself (a close watcher), without
// traversing history: its close then drops the entry like any other.
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
/** Back closes onBack's layers: the phone shell listens, and the phone player under the dock (a turned phone). */
export const watchBack = (app: ReviewApp) =>
  app.listen(window, 'popstate', (e: PopStateEvent) => {
    if (skip) return void (--skip || flush());
    // as deep as the entry Back (or the browser's history menu) went to
    const depth = (e.state as { rrBack?: number } | null)?.rrBack ?? 0;
    while (backs.length > depth) backs.pop()!.close();
  });
