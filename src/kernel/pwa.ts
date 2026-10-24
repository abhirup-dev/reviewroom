// The silent update: register the service worker (src/sw.ts), notice a new build, reload into it once.
// Collie's rules: reload only on controllerchange (never while a worker installs: that strands the page on a deleted
// shell), once per build, and never over unsent work. Without a worker the server's build-info.json says when to reload.
//
//   check (60 s, tab visible, server restarted) -> reg.update(), build-info.json
//   new worker installs, skips waiting, claims  -> controllerchange -> reload (held while busy: toast "Update ready")
//   server newer twice in a row, no worker      -> reload (same hold)
//   still on the old build 8 s after that       -> delete rr-* caches, unregister, reload (once per build)
//   a lazy chunk fails to load                  -> reload (at most once a minute)
import { h } from './dom';
import type { StateBackend } from './providers/contracts';

/** What the update flow reads of the review page: its backend's unsent ops and server start (a `ReviewApp` fits). */
type UpdatesHost = { backend?: Pick<StateBackend, 'pending'> };

/** What makes reloading now lose something: ops not yet stored, a comment being written, a dialog open. */
export type Busy = { unsent: boolean; composing: boolean; dialog: boolean };
export const shouldHoldReload = (b: Busy) => b.unsent || b.composing || b.dialog;

/** The worker lives at the hub root (ADR 0001): strip `_rr/<entry>` and, under the hub proxy, `r/<id>/`. */
export const workerScope = (entry: string) => new URL(entry.replace(/(\/r\/[^/]+)?\/_rr\/[^/]*$/, '/'));

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

/** A newer build is waiting for a reload (held over unsent work): what to call to take it. Read by the phone's menu. */
let ready: (() => void) | null = null;
export const updateReady = () => ready;

/** Start the update flow. `app` (the review page) adds its unsent ops and server restarts; the hub passes none. */
export function startUpdates(app?: UpdatesHost) {
  const entry = import.meta.url;
  const serverBuild = () =>
    fetch(new URL('build-info.json', entry), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { id?: string } | null) => b?.id ?? null)
      .catch(() => null);

  let due: { nuke: boolean } | null = null; // a reload is wanted; nuke: drop the worker and its caches first
  let toast: HTMLElement | null = null;
  const reload = async () => {
    if (due?.nuke) {
      for (const k of await caches.keys()) if (k.startsWith('rr-')) await caches.delete(k);
      await reg?.unregister();
    }
    sessionStorage.setItem('reviewroom:scroll', String(document.querySelector('.rr-narrative-scroll')?.scrollTop ?? 0)); // boot() restores it
    location.reload();
  };
  const tryReload = () => {
    if (!due) return;
    if (!shouldHoldReload(busy(app))) return void reload();
    if (toast) return;
    const host = document.querySelector<HTMLElement>('.rr-toasts') ?? document.body.appendChild(h('div', { class: 'rr-toasts', 'aria-live': 'polite', popover: 'manual' }));
    toast = h('div', { class: 'rr-toast' }, 'Update ready', h('button', { class: 'rr-toast__action', type: 'button', title: 'Reload into the new version of reviewroom', onclick: () => void reload() }, 'Reload'));
    host.append(toast);
    host.hidePopover();
    host.showPopover();
  };
  const want = (why: string, nuke = false) => {
    console.info(`[reviewroom] reload due: ${why}`);
    due = { nuke: nuke || !!due?.nuke };
    ready = () => void reload();
    tryReload();
  };

  let reg: ServiceWorkerRegistration | undefined;
  let newer = 0; // checks in a row that found the server on another build (one could catch a build half-written)
  let hatch: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    await reg?.update().catch(() => {});
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage has no target origin
    if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); // ours skip waiting themselves; an older one might not
    const id = await serverBuild();
    newer = id && id !== __RR_BUILD__ ? newer + 1 : 0;
    if (newer < 2 || due) return;
    if (!reg) return void (once('reviewroom:reloaded-for', id!) && want(`server runs build ${id}`));
    // the worker should take over within seconds; if it doesn't, start clean
    hatch ??= setTimeout(async () => {
      const now = await serverBuild();
      if (!due && now && now !== __RR_BUILD__ && once('reviewroom:nuked-for', now)) want(`still not on build ${now}: dropping the service worker`, true);
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
      (r) => ((reg = r), check()),
      (e) => (console.warn('[reviewroom] service worker not registered:', e), check()),
    );
  } else void check();

  window.addEventListener('unhandledrejection', (e) => {
    if (CHUNK_ERROR.test(String((e.reason as Error | undefined)?.message ?? e.reason)) && chunkReloadDue(Date.now())) want('a code file failed to load');
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check());
  setInterval(() => void check(), 60_000);
  let started = app?.backend?.pending?.().started ?? null;
  setInterval(() => {
    tryReload(); // a held reload goes once the hold clears
    const now = app?.backend?.pending?.().started ?? null;
    if (now && started && now !== started) void check(); // the event stream reconnected to a restarted server
    started = now ?? started;
  }, 1000);
}
