import { desktopPlayer } from './player.desktop';
import type { PlayerFormFactory } from './player';

/** The exported walkthrough uses the desktop arrangement, including its stacked layout on narrow screens. */
export const standalonePlayer: PlayerFormFactory = (parts) => {
  const form = desktopPlayer(parts);
  parts.root.dataset.standalone = '';
  parts.player.removeAttribute('role');
  parts.player.removeAttribute('aria-modal');
  parts.close.remove();
  return {
    ...form,
    dismissible: false,
    paintNav(at) {
      form.paintNav(at);
      parts.next.hidden = at.isLast;
    },
  };
};
