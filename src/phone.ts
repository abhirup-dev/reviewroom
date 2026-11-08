// The phone's presentation (Refactor 3.0, rr-486): the status bar and menu drawer, the phone shell, and its part of each
// seam. Phone code: only main.ts reaches it (scripts/features.ts), and later only by a lazy import.
import { h, icon } from './kernel/dom';
import { buildPhoneBar, type PhoneBarContributions } from './kernel/header.phone';
import { mountPhone } from './kernel/phone';
import { githubPanelAvailability, recapAvailable } from './threads/docking';
import { feedbackButton, onGitHub, reviewModeSwitch, roundMenu, roundStatusControls, subscribeThreadHeader } from './threads/controls';
import { contentsButton } from './review/walkthrough.phone';
import { phonePalette } from './review/overlays.phone';
import type { PresentationModule } from './presentation';
import { phonePlayer } from './slides/player.phone';
import type { ReviewApp } from './app';


export const phone: PresentationModule = {
  header: (app) => buildPhoneBar(app, phoneBar(app)),
  mountSurface: (app, host) =>
    mountPhone(app, host, {
      panelAvailability: githubPanelAvailability(app),
      // Last round while a round has threads from the last one; the PR conversation for a GitHub PR that has one
      available: (id) =>
        id === 'recap' ? recapAvailable(app) : id === 'thread:gh_conversation' ? app.services.threads.threads().some((t) => t.gh?.conversation) : true,
      openThreads: () => openThreadCount(app),
    }),
  walkthrough: contentsButton,
  palette: phonePalette,
  player: phonePlayer,
};

/** Open threads the Threads list shows by default in this review mode: the phone's Threads badge. */
function openThreadCount(app: ReviewApp) {
  const mode = app.github?.ok ? app.prefs.reviewMode : 'all';
  return app.services.threads.threads().filter((t) => !t.gh?.conversation && t.status === 'open' && (mode === 'all' || (mode === 'team') === !!t.gh)).length;
}

/** The phone's status bar and menu drawer: the review's rounds, guided review, send, GitHub and the picker. */
function phoneBar(app: ReviewApp): PhoneBarContributions {
  const team = () => app.services.threads.teamMode;
  return {
    sub: () => (team() ? 'Team review' : `Round ${app.viewRound && app.viewRound !== app.state.round ? app.viewRound + ' of ' + app.state.round : app.state.round}`),
    titleMenu: () => (team() ? null : (anchor) => roundMenu(app, anchor)),
    status: roundStatusControls,
    actions: () => [app.walkthrough ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-tour-btn', 'aria-label': 'Play guided review', title: 'Play the guided walkthrough: the main story of this diff, slide by slide', onclick: () => app.commands.run('walkthrough.play') }, icon('play', 24)) : null],
    // a round ink icon button, its count a badge on the corner (kernel/styles/phone.css)
    send: () => {
      const b = feedbackButton(app);
      b.title = team() ? 'Submit review' : 'Send round';
      b.setAttribute('aria-label', b.title);
      b.querySelector('.rr-icon')?.replaceWith(icon('send', 24));
      return b;
    },
    facts: () => {
      const open = openThreadCount(app);
      return [`Round ${app.state.round}`, `${open} open thread${open === 1 ? '' : 's'}`];
    },
    drawer: (item) => {
      const g = app.github;
      const chapters = app.walkthrough?.chapters.length ?? 0;
      return {
        top: [app.walkthrough ? item('Play guided review', 'play', 'walkthrough.play', { hint: `${chapters} chapter${chapters === 1 ? '' : 's'}` }) : null],
        review: [
          ...(onGitHub(app)
            ? [
                g?.url ? item('Open PR on GitHub', 'github', () => window.open(g.url, '_blank', 'noopener')) : null,
                item('Refresh comments', 'round', 'github.refresh'),
                g?.ok ? h('div', { class: 'rr-drawer__row' }, icon('thread', 24), h('span', null, 'Review'), reviewModeSwitch(app)) : null,
              ]
            : []),
          item('Comment on an element', 'target', 'pick', { title: 'Pick an element to comment on' }),
        ],
      };
    },
    subscribe: (paint) => {
      app.onDispose(subscribeThreadHeader(app, paint));
      app.bus.on('walkthrough', paint);
    },
  };
}
