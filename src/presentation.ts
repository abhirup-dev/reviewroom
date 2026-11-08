// What a presentation draws: its header, its panel surface, and its part of each seam (Refactor 3.0, rr-486). main.ts
// picks one by app.presentation (kernel/presentation.ts) and loads it lazily; this is the desktop's, the phone's is
// src/phone.ts, a turned phone's src/turned.ts. Only the presentations with a dock import dockview.
import { h, icon } from './kernel/dom';
import { buildHeader } from './kernel/header';
import * as dock from './kernel/dockview';
import type { LastLayout } from './kernel/layouts/layout.shared';
import { githubPanelAvailability } from './threads/docking';
import { feedbackButton, githubControls, roundStatusControls, subscribeThreadHeader, threadHeaderControls } from './threads/controls';
import type { WalkthroughExtension } from './review/walkthrough';
import type { PaletteHost, PaletteVariant } from './review/overlays';
import type { PhoneFormFactory } from './slides/player';
import type { ReviewApp } from './app';

export interface PresentationModule {
  /** The header above the panels. */
  header(app: ReviewApp): HTMLElement;
  /** The panel surface (the dock, or the phone shell) into `host`; `lastLayout` is the dock's last layout. */
  mountSurface(app: ReviewApp, host: HTMLElement, ctx: { lastLayout: LastLayout | null }): void;

  // Each seam's part (rr-486): features never ask which presentation they're in, they take what main.ts hands them.
  /** What it adds to the walkthrough panel (not the description): the phone's Contents button. */
  walkthrough?: WalkthroughExtension;
  /** The palette's variant; none is the desktop's ⌘K. */
  palette?: (app: ReviewApp, host: PaletteHost) => PaletteVariant;
  /** The guided walkthrough player's form; none is the desktop's. */
  player?: PhoneFormFactory;
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
  mountSurface: (app, host, { lastLayout }) => app.layout.mount(host, lastLayout, { dock, panelAvailability: githubPanelAvailability(app) }),
};
