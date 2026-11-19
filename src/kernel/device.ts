// Which shell a device gets. A phone (touch, shorter screen side at most 720px) gets the phone shell upright and the
// dock on its side, like a computer; it switches on rotation. Tablets keep the dock either way.
import type { ReviewApp } from '../app';
import { currentForm } from './form';
import { dropReload, wantReload } from './pwa';
import { ensurePanel, frontPanel } from './dock';

const KEY = 'reviewroom:shell';
/** When the screen stops suiting the form picked at boot (a phone rotated, a foldable opened), reload into the right
 *  one, keeping the panel in front and the open file (restoreShell; the walkthrough's slide rides in the URL). Over
 *  unsent work the reload is offered and taken once the work is sent (pwa.ts); the screen turning back drops it. */
export function watchShell(app: ReviewApp) {
  const check = () => {
    const form = currentForm();
    if (form === app.presentation.form) return dropReload('layout');
    wantReload('layout', `the screen suits the ${form} form`, {
      before: () => sessionStorage.setItem(KEY, JSON.stringify({ front: frontPanel(app), file: app.activeFile })),
    });
  };
  app.listen(window, 'resize', check);
  // a phone may fire resize before its orientation turns: check again when it does
  screen.orientation?.addEventListener('change', check);
  app.onDispose(() => screen.orientation?.removeEventListener('change', check));
}

/** After watchShell's reload: the panel that was in front, and the file that was open. */
export function restoreShell(app: ReviewApp) {
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { front?: string; file?: string } | null;
  sessionStorage.removeItem(KEY);
  if (!saved) return;
  // the phone shows one area: there the file only when Code was in front; the dock shows code beside the rest
  if (saved.file && (app.presentation.kind !== 'phone' || saved.front === 'code')) app.bus.emit('reveal-code', { path: saved.file, side: 'head' });
  if (saved.front && !saved.front.includes(':')) ensurePanel(app, saved.front); // not a thread or a filtered list: those need their params
}
