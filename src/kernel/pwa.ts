// The silent update: register the service worker (src/sw.ts), notice a new build, reload into it once.
// Collie's rules: reload only on controllerchange (never while a worker installs: that strands the page on a deleted
// shell), once per build, and never over unsent work. Without a worker the server's build-info.json says when to reload.
//
//   check (60 s, tab visible, server restarted) -> reg.update(), build-info.json
//   new worker installs, skips waiting, claims  -> controllerchange -> reload (held while busy: toast "Update ready";
//                                                 reload.machine.ts, shared with the screen changing form, device.ts)
//   server newer twice in a row, no worker      -> reload (same hold)
//   still on the old build 8 s after that       -> delete rr-* caches, unregister, reload (once per build)
//   a lazy chunk fails to load                  -> reload (at most once a minute)
import { createActor } from 'xstate';
import { h } from './dom';
import { reloadMachine, type Reasons } from './reload.machine';
import type { StateBackend } from './providers/contracts';

/** What the update flow reads of the review page: its backend's unsent ops and server start (a `ReviewApp` fits). */
type UpdatesHost = { backend?: Pick<StateBackend, 'pending'> };

/** What makes reloading now lose something: ops not yet stored, a comment being written, a dialog open. */
export type Busy = { unsent: boolean; composing: boolean; dialog: boolean };
export const shouldHoldReload = (b: Busy) => b.unsent || b.composing || b.dialog;

/** The worker lives at the hub root (ADR 0001): strip `_rr/<entry>` and, under the hub proxy, `r/<id>/`. */
export const workerScope = (entry: string) => new URL(entry.replace(/(\/r\/[^/]+)?\/_rr\/[^/]*$/, '/'));

const SCROLL = 'reviewroom:scroll';
const narrative = () => document.querySelector('.rr-narrative-scroll');
const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
/** Before any reload: remember where the walkthrough was scrolled, and how tall it was (restoreScroll puts it back). */
export const keepScroll = () => {
  const s = narrative();
  sessionStorage.setItem(SCROLL, JSON.stringify([s?.scrollTop ?? 0, s?.scrollHeight ?? 0]));
};
/** At boot: put the walkthrough back where keepScroll left it. Diagrams and code render after boot and grow it, so
 *  hold the spot until it is as tall as it was, the reader scrolls, or 5s pass. */
export function restoreScroll() {
  const raw = sessionStorage.getItem(SCROLL);
  if (!raw) return;
  sessionStorage.removeItem(SCROLL);
  const saved = JSON.parse(raw) as number | [number, number]; // a bare number: written by an older build
  const [top, height] = typeof saved === 'number' ? [saved, 0] : saved;
  requestAnimationFrame(() => {
    const s = narrative() as HTMLElement | null;
    if (!s) return;
    s.style.overflowAnchor = 'none'; // the browser's scroll anchoring would shift it as content above renders
    const hold = new ResizeObserver(() => {
      s.scrollTo({ top });
      if (s.scrollHeight >= height) stop();
    });
    const stop = () => {
      hold.disconnect();
      clearTimeout(timer);
      s.style.removeProperty('overflow-anchor');
      for (const t of READER_INPUT) s.removeEventListener(t, stop);
    };
    const timer = setTimeout(stop, 5000);
    for (const t of READER_INPUT) s.addEventListener(t, stop, { passive: true });
    for (const c of s.children) hold.observe(c);
  });
}

/** sessionStorage-backed "once": true the first time for `id`, false after (survives the reload it causes). */
export function once(key: string, id: string, store: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage) {
  if (store.getItem(key) === id) return false;
  store.setItem(key, id);
  return true;
}

/** A failed lazy chunk reloads at most once a minute: a chunk that's gone for good doesn't loop. */
export function chunkReloadDue(now: number, store: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage) {
  if (now - Number(store.getItem('reviewroom:chunk-reload') ?? 0) < 60_000) return false;
  store.setItem('reviewroom:chunk-reload', String(now));
  return true;
}

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

export function busy(app?: UpdatesHost): Busy {
  const text = (el: Element) => (el instanceof HTMLTextAreaElement ? el.value : el.querySelector('.cm-placeholder') ? '' : (el.textContent ?? ''));
  return {
    unsent: app?.backend?.pending?.().unsent ?? false,
    composing: [...document.querySelectorAll('.rr-composer__input')].some((el) => text(el).trim() !== ''),
    // a task dialog (send feedback, save layout); the thread popup holds only through its composer, so saving a comment releases it
    dialog: !!document.querySelector('dialog[open].rr-modal--narrow'),
  };
}

// The page's reloads (reload.machine.ts): a new build and a screen that suits another form (device.ts) share one hold
// over unsent work and one offer. `before` runs just before the reload, per reason.
let host: UpdatesHost | undefined;
let reg: ServiceWorkerRegistration | undefined;
const before = new Map<string, () => void>();
const OFFERS: Record<string, [text: string, label: string, title: string]> = {
  update: ['Update ready', 'Reload', 'Reload into the new version of reviewroom'],
  layout: ['This screen suits a different layout.', 'Switch layout', 'Reload into the layout for this screen'],
};
let toast: { el: HTMLElement; key: string } | null = null;
const withdraw = () => { toast?.el.remove(); toast = null; };
const offer = (reasons: Reasons) => {
  const key = 'update' in reasons ? 'update' : Object.keys(reasons)[0];
  // outside an open modal dialog the toast is inert (menus.ts does the same): show it in the modal, if one opened since
  const parent = document.querySelector('dialog:modal') ?? document.body;
  if (toast?.key === key && toast.el.parentElement?.parentElement === parent) return;
  withdraw();
  const [text, label, title] = OFFERS[key] ?? OFFERS.update;
  const box = parent.querySelector<HTMLElement>(':scope > .rr-toasts') ?? parent.appendChild(h('div', { class: 'rr-toasts', 'aria-live': 'polite', popover: 'manual' }));
  toast = { key, el: h('div', { class: 'rr-toast' }, text, h('button', { class: 'rr-toast__action', type: 'button', title, onclick: () => reloads.send({ type: 'go' }) }, label)) };
  box.append(toast.el);
  box.hidePopover();
  box.showPopover();
};
const reloadNow = async (reasons: Reasons) => {
  if (Object.values(reasons).some((r) => r.nuke)) {
    for (const k of await caches.keys()) if (k.startsWith('rr-')) await caches.delete(k);
    await reg?.unregister();
  }
  for (const k of Object.keys(reasons)) before.get(k)?.();
  keepScroll();
  location.reload();
};
const reloads = createActor(
  reloadMachine.provide({ actions: { offer: ({ context }) => offer(context.reasons), withdraw, reload: ({ context }) => void reloadNow(context.reasons) } }),
).start();
const tick = () => reloads.send({ type: 'tick', held: shouldHoldReload(busy(host)) });
const wanted = (key: string) => key in reloads.getSnapshot().context.reasons;

/** Ask for a reload, held while it would lose work (offered meanwhile, taken once the work is sent). */
export function wantReload(key: string, why: string, opts: { nuke?: boolean; before?: () => void } = {}) {
  if (!wanted(key)) console.info(`[reviewroom] reload due: ${why}`);
  if (opts.before) before.set(key, opts.before);
  reloads.send({ type: 'want', key, nuke: opts.nuke });
  tick();
}
/** That reason no longer applies: drop it, and the offer with the last one. */
export function dropReload(key: string) {
  before.delete(key);
  reloads.send({ type: 'drop', key });
}
/** A newer build is waiting for a reload (held over unsent work): what to call to take it. Read by the phone's menu. */
export const updateReady = () => (wanted('update') ? () => reloads.send({ type: 'go' }) : null);

/** A code chunk failed to load: reload into the current build, at most once a minute. True when that reload is wanted. */
export function reloadOnChunkError(reason: unknown) {
  if (!CHUNK_ERROR.test(String((reason as Error | undefined)?.message ?? reason)) || !chunkReloadDue(Date.now())) return false;
  wantReload('update', 'a code file failed to load');
  return true;
}

/**
 * Start the update flow. `entry` is the entry script's URL (its import.meta.url): this module may sit in a shared
 * chunk under chunks/, and build-info.json and sw.js live beside the entry. `app` (the review page) adds its unsent
 * ops and server restarts; the hub passes none.
 */
export function startUpdates(entry: string, app?: UpdatesHost) {
  host = app;
  const serverBuild = () =>
    fetch(new URL('build-info.json', entry), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { id?: string } | null) => b?.id ?? null)
      .catch(() => null);
  const want = (why: string, nuke = false) => wantReload('update', why, { nuke });

  let newer = 0; // checks in a row that found the server on another build (one could catch a build half-written)
  let hatch: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    await reg?.update().catch(() => {});
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage has no target origin
    if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); // ours skip waiting themselves; an older one might not
    const id = await serverBuild();
    newer = id && id !== __RR_BUILD__ ? newer + 1 : 0;
    if (newer < 2 || wanted('update')) return;
    if (!reg) return void (once('reviewroom:reloaded-for', id!) && want(`server runs build ${id}`));
    // the worker should take over within seconds; if it doesn't, start clean
    hatch ??= setTimeout(async () => {
      const now = await serverBuild();
      if (!wanted('update') && now && now !== __RR_BUILD__ && once('reviewroom:nuked-for', now)) want(`still not on build ${now}: dropping the service worker`, true);
    }, 8000);
  };

  const sw = navigator.serviceWorker as ServiceWorkerContainer | undefined;
  if (isSecureContext && sw && !new URLSearchParams(location.search).has('nosw')) {
    const scope = workerScope(entry);
    sw.addEventListener('controllerchange', async () => {
      const id = await serverBuild();
      // the first install claims the page too, but the page already runs that build
      if (id !== __RR_BUILD__ && once('reviewroom:reloaded-for', id ?? 'unknown')) want(`new service worker, build ${id}`);
    });
    void sw.register(new URL('sw.js', scope), { scope: scope.pathname }).then(
      (r) => { reg = r; return check(); },
      (e) => { console.warn('[reviewroom] service worker not registered:', e); return check(); },
    );
  } else void check();

  window.addEventListener('unhandledrejection', (e) => void reloadOnChunkError(e.reason));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check());
  setInterval(() => void check(), 60_000);
  let started = app?.backend?.pending?.().started ?? null;
  setInterval(() => {
    tick(); // a held reload goes once the hold clears
    const now = app?.backend?.pending?.().started ?? null;
    if (now && started && now !== started) void check(); // the event stream reconnected to a restarted server
    started = now ?? started;
  }, 1000);
}
