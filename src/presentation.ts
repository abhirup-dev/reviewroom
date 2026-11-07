// What a presentation draws: its header, its panel surface, and its part of each seam (Refactor 3.0, rr-486). main.ts
// picks one by app.presentation (kernel/presentation.ts); this is the desktop's, the phone's is src/phone.ts.
import { h, icon } from './kernel/dom';
import { buildHeader } from './kernel/header';
import type { LastLayout } from './kernel/layouts/layout.shared';
import { githubPanelAvailability } from './threads/docking';
import { feedbackButton, githubControls, roundStatusControls, subscribeThreadHeader, threadHeaderControls } from './threads/controls';
import type { WalkthroughExtension } from './review/walkthrough';
import type { ReviewApp } from './app';

export interface PresentationModule {
  /** The header above the panels. */
  header(app: ReviewApp): HTMLElement;
  /** The panel surface (the dock, or the phone shell) into `host`; `lastLayout` is the dock's last layout. */
  mountSurface(app: ReviewApp, host: HTMLElement, ctx: { lastLayout: LastLayout | null }): void;

  // The seams (rr-486.9-.12) each add their member below, with the phone's part in src/phone.ts and its use in
  // main.ts. Features never ask which presentation they're in: they take what composition hands them.

  // 2.4 walkthrough Contents (rr-486.10)
  /** What it adds to the walkthrough panel (not the description): the phone's Contents button. */
  walkthrough?: WalkthroughExtension;

  // 2.5 player form (rr-486.11): not a member. The phone player plays on any phone, a turned one under the dock, so
  // main.ts hands src/phone.ts's phonePlayer to mountWalkthrough by app.presentation.phonePlayer.

  // 2.6 palette (rr-486.12)
}

export const desktop: PresentationModule = {
  header: (app) =>
    buildHeader(app, {
      status: roundStatusControls,
      beforeLayout: () => [
        ...githubControls(app),
        app.walkthrough || app.walkthroughIssues
          ? h('button', { class: 'rr-hbtn rr-tour-btn', title: app.walkthroughIssues ? `walkthrough.json is invalid: ${app.walkthroughIssues[0]}` : 'Play the guided walkthrough: the main story of this diff, slide by slide', 'data-keys': app.walkthrough ? 'g w' : null, disabled: !app.walkthrough, onclick: () => app.bus.emit('walkthrough-open', {}) }, icon('play', 14), h('span', null, 'Guided walkthrough'))
          : null,
        ...threadHeaderControls(app),
      ],
      afterTheme: () => [feedbackButton(app)],
      subscribe: (paint) => { app.onDispose(subscribeThreadHeader(app, paint)); app.bus.on('walkthrough', paint); },
    }),
  mountSurface: (app, host, { lastLayout }) => {
    // a turned phone starts from the tablet layout and never saves over the reviewer's last one
    const turned = app.presentation.form === 'turned';
    app.layout.mount(host, turned ? null : lastLayout, { panelAvailability: githubPanelAvailability(app), save: !turned });
  },
};
