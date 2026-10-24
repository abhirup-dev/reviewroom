// Which shell a device gets. Decided by the screen's shorter side, not the window, so rotating a phone keeps the
// phone shell (landscape is too short for the dock) and rotating a tablet keeps the dock.
import type { ReviewApp } from '../app';

const side = () => Math.min(screen.width, screen.height);
// no matchMedia (tests without a DOM): the desktop
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** A phone: touch and a shorter side of at most 720px, or `?phone` to try the phone shell on a desktop. */
export const wantsPhone = () => (touch() && side() <= 720) || new URLSearchParams(globalThis.location?.search).has('phone');
/** A tablet: touch and a shorter side of 721–1024px. It gets the dock, starting from the `tablet` layout. */
export const isTablet = () => touch() && side() > 720 && side() <= 1024;

/** If the screen stops suiting the shell picked at boot (a foldable opened, another display), say so once and
 *  offer a reload into the right one rather than rebuilding live. */
export function watchShell(app: ReviewApp, phone: boolean) {
  const check = () => {
    if (wantsPhone() === phone) return;
    removeEventListener('resize', check);
    app.toast('This screen suits a different layout.', 'info', { label: 'Switch layout', run: () => location.reload() });
  };
  addEventListener('resize', check);
}
