// Installing reviewroom as an app. Chrome (Android, desktop) fires beforeinstallprompt: keep it and prompt from our
// own button, since Chrome's mini-infobar is easy to dismiss for good. iOS has no prompt: explain Share → Add to Home
// Screen instead. Imported by both entry points before they boot, so the event is never missed. While installing is
// possible, <html data-rr-installable> shows the `.rr-install-btn` controls (shell.css).
import { backdropCloses, h, icon } from '../core/dom';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPrompt | null = null;
const standalone = () => matchMedia('(display-mode: standalone)');
/** iPhone, iPad, or an iPad asking for the desktop site (it says MacIntel but has touch). */
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Whether to offer installing: not already running as the app, and Chrome handed us a prompt or this is iOS. */
export const canInstall = () => !standalone().matches && !(navigator as { standalone?: boolean }).standalone && (!!deferred || ios);
const sync = () => document.documentElement.toggleAttribute('data-rr-installable', canInstall());

// not in tests, which load the panels without a DOM
if (typeof matchMedia === 'function') {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    sync();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    sync();
  });
  standalone().addEventListener('change', sync);
  sync();
}

/** Chrome's own install prompt, or on iOS a sheet with the steps. */
export async function install() {
  if (!deferred) return ios && iosSheet();
  const p = deferred;
  deferred = null; // a prompt can be shown once; Chrome fires beforeinstallprompt again if it was dismissed
  sync();
  await p.prompt();
}

/** The header control, an icon or with its label; hidden unless installing is possible. */
export const installButton = (labelled = false) =>
  h(
    'button',
    { class: 'rr-hbtn rr-install-btn' + (labelled ? '' : ' rr-hbtn--icon'), title: 'Install reviewroom as an app: its own window, and on a phone an icon on the home screen', 'aria-label': 'Install app', onclick: () => void install() },
    icon('install', 16),
    labelled ? h('span', null, 'Install app') : null,
  );

function iosSheet() {
  const close = () => box.close();
  const ok = h('button', { class: 'rr-btn rr-btn--primary', onclick: close }, 'Got it');
  const box = h(
    'dialog',
    { class: 'rr-modal rr-modal--narrow', 'aria-label': 'Install reviewroom', onmousedown: backdropCloses, onclose: () => box.remove() },
    h('header', { class: 'rr-thread__head' }, h('strong', null, 'Install reviewroom'), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Close', title: 'Close', onclick: close }, icon('close', 14))),
    h(
      'div',
      { class: 'rr-send__body rr-install-steps' },
      h('p', null, 'In Safari, tap ', h('strong', null, 'Share '), icon('share', 14), ', then ', h('strong', null, 'Add to Home Screen'), '.'),
      h('p', { class: 'rr-muted' }, 'reviewroom then opens from its icon in a window of its own.'),
    ),
    h('footer', { class: 'rr-composer__foot' }, ok),
  );
  document.body.append(box);
  box.showModal();
  ok.focus();
}
