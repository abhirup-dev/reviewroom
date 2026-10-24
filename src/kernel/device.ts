// Which shell a device gets. A phone (touch, shorter screen side at most 720px) gets the phone shell upright and the
// dock on its side, like a computer; it switches on rotation. Tablets keep the dock either way.
import type { ReviewApp } from '../app';
import { busy, shouldHoldReload } from './pwa';
import { ensurePanel, frontPanel } from './dock';

const side = () => Math.min(screen.width, screen.height);
// no matchMedia (tests without a DOM): the desktop
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** The shorter screen side, CSS px: a phone at most PHONE_MAX, a tablet at most TABLET_MAX. */
const PHONE_MAX = 720, TABLET_MAX = 1024;
const small = () => touch() && side() <= PHONE_MAX;
const landscape = () => screen.orientation?.type.startsWith('landscape') ?? matchMedia('(orientation: landscape)').matches;
const forced = () => new URLSearchParams(globalThis.location?.search).has('phone');
/** The phone shell: a phone held upright, or `?phone` to try it on any device. */
export const wantsPhone = () => (small() && !landscape()) || forced();
/** A phone on its side: the dock, from the `tablet` layout, never saved over the reviewer's last layout. */
export const turnedPhone = () => small() && !wantsPhone();
/** The guided review's phone player: a phone either way up, under either shell (or `?phone`); tablets and computers
 *  get the desktop player. Its portrait or landscape variant follows the viewport (slides/player.phone.ts). */
export const phonePlayer = () => small() || forced();
/** A tablet (touch, shorter side 721–1024px) or a turned phone: the dock, starting from the `tablet` layout. */
export const isTablet = () => touch() && side() <= TABLET_MAX && !wantsPhone();

const KEY = 'reviewroom:shell';
/** When the screen stops suiting the shell picked at boot (a phone rotated, a foldable opened), reload into the right
 *  one, keeping the panel in front and the open file (restoreShell; the walkthrough's slide rides in the URL). Over
 *  unsent work, offer the reload instead. */
export function watchShell(app: ReviewApp) {
  const phone = app.presentation.kind === 'phone';
  const check = () => {
    if (wantsPhone() === phone) return;
    removeEventListener('resize', check);
    screen.orientation?.removeEventListener('change', check);
    const go = () => {
      sessionStorage.setItem(KEY, JSON.stringify({ front: frontPanel(app), file: app.activeFile }));
      sessionStorage.setItem('reviewroom:scroll', String(document.querySelector('.rr-narrative-scroll')?.scrollTop ?? 0)); // boot() restores it
      location.reload();
    };
    if (shouldHoldReload(busy(app))) app.toast('This screen suits a different layout.', 'info', { label: 'Switch layout', run: go });
    else go();
  };
  addEventListener('resize', check);
  // a phone may fire resize before its orientation turns: check again when it does
  screen.orientation?.addEventListener('change', check);
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
