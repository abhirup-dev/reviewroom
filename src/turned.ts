// A phone on its side (Refactor 3.0, rr-486): the desktop's dock and header with the phone's player. Its own lazy chunk,
// so the phone upright loads neither the dock nor dockview (src/main.ts).
import * as dock from './kernel/dockview';
import { watchBack } from './kernel/history';
import { githubPanelAvailability } from './threads/docking';
import { phonePlayer } from './slides/player.phone';
import { desktop, type PresentationModule } from './presentation';

/** A phone on its side: the desktop's dock and header with the phone's player, whose Back the dock doesn't hear. It
 *  starts from the tablet layout and never saves over the reviewer's last one. */
export const turned: PresentationModule = {
  ...desktop,
  mountSurface: (app, host) => {
    watchBack(app);
    app.layout.mount(host, null, { dock, panelAvailability: githubPanelAvailability(app), save: false });
  },
  player: phonePlayer,
};

