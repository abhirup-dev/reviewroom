// The review page in a headless browser, for `slide-lint` and `shot`: a fresh Chrome (never the
// user's own, even with remote debugging on) at an exact viewport, else on macOS the system WebKit. Bun.WebView is
// experimental: every use of it stays in this file.
import { fail } from './args.ts';
import { loadConfig } from './config.ts';
import { listen, startServer } from './server.ts';
import type { StepAudit } from '../../src/slides/model.shared.ts';

export type Viewport = { width: number; height: number };
export const vpName = (v: Viewport) => `${v.width}x${v.height}`;
export function parseViewports(s: string): Viewport[] {
  return s.split(',').map((v) => {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(v.trim());
    if (!m) fail(`--viewport: "${v}" is not WIDTHxHEIGHT (like 1280x800)`, 2);
    return { width: +m[1], height: +m[2] };
  });
}

/** The review served from this process while `fn` runs: the current build (whatever a running server has), read-only
 *  (the page is the author's HTML; it must not write the review or call GitHub behind a live server's back). */
export async function withServer<T>(repo: string | null, dir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const r = repo ?? fail('not inside a git repository (use --repo)');
  const { app, close } = startServer({ repo: r, dir, cfg: loadConfig(dir, r), readOnly: true });
  const server = listen(app, 0);
  try {
    return await fn(`http://127.0.0.1:${server.port}/`);
  } finally {
    close();
    void server.stop(true);
  }
}

// a ResizeObserver loop notice is the browser's, harmless, and not the author's
const CATCH = `addEventListener('error', (e) => e.message.startsWith('ResizeObserver loop') || console.error(e.message)); addEventListener('unhandledrejection', (e) => console.error('unhandled rejection: ' + (e.reason?.message ?? e.reason)));`;

/** `p`, or a rejection after `ms` (unref'd, so a stuck browser call can't keep the process up either). */
const within = <T>(p: Promise<T>, ms: number, what: string) => {
  let t: Timer;
  return Promise.race([p, new Promise<never>((_, no) => void (t = setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000} s`)), ms).unref()))]).finally(() => clearTimeout(t));
};

export type Page = { engine: 'chrome' | 'webkit'; audit(chapter: string, step: string, theme?: 'light' | 'dark'): Promise<StepAudit>; errors(): string[]; screenshot(): Promise<Blob>; evaluate<T>(js: string): Promise<T>; resize(width: number, height: number): Promise<void>; close(): Promise<void> };

/** `fn` with the review page open (see openPage), closing it however `fn` ends. */
export async function withPage<T>(url: string, vp: Viewport, fn: (page: Page) => Promise<T>, scale = 1): Promise<T> {
  const page = await openPage(url, vp, scale);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** The review page at `url` in a browser at `vp` (`scale`: device pixels per CSS px), once its walkthrough can be measured. */
export async function openPage(url: string, vp: Viewport, scale = 1): Promise<Page> {
  const errors: string[] = []; // console errors since the last errors()
  const capture = (type: string, ...args: unknown[]) => void (type === 'error' && errors.push(args.map(String).join(' ')));
  let view: Bun.WebView | undefined;
  let engine: Page['engine'] = 'chrome';
  try {
    view = new Bun.WebView({ ...vp, backend: { type: 'chrome', url: false }, console: capture });
    await within(view.navigate('about:blank'), 30_000, 'starting the browser'); // the protocol session exists from the first navigation
    // the window's frame takes height from the viewport; pin it to exactly what was asked
    await within(view.cdp('Emulation.setDeviceMetricsOverride', { ...vp, deviceScaleFactor: scale, mobile: false }), 10_000, 'sizing the browser');
  } catch (e) {
    try {
      view?.close();
    } catch {}
    if (process.platform !== 'darwin') fail(`no browser to render in: install Chrome or Chromium (or set BUN_CHROME_PATH). ${(e as Error).message}`);
    view = new Bun.WebView({ ...vp, backend: 'webkit', console: capture });
    engine = 'webkit';
  }
  try {
    // uncaught errors reach the console too (Chrome; WebKit reports console.error only)
    if (engine === 'chrome') await within(view.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CATCH }), 10_000, 'preparing the page');
    // load waits for every image and script: a stalled one must not stall us; the app may be up before it
    await Promise.race([view.navigate(url), new Promise((r) => setTimeout(r, 20_000).unref())]); // unref: the timer must not keep the process up
    const started = await within(view.evaluate(`new Promise((ok) => { const t0 = Date.now(); const t = () => window.rr?.auditWalkthrough ? ok(true) : Date.now() - t0 > 20000 ? ok(false) : setTimeout(t, 50); t(); })`), 25_000, 'waiting for the page');
    if (!started) fail(`the review page did not start in 20 s (review.html must wrap <rr-review> in <rr-app>, as its scaffold does)${errors.length ? `; page errors:\n  ${errors.join('\n  ')}` : ''}`);
    // diagrams render after the app starts (Pele loads each type lazily): wait, so their errors count as the page's, not the first slide's
    await within(view.evaluate(`new Promise((ok) => { const t0 = Date.now(); const t = () => !document.querySelector('[aria-busy="true"]') || Date.now() - t0 > 10000 ? ok(true) : setTimeout(t, 50); t(); })`), 15_000, 'waiting for the diagrams');
  } catch (e) {
    view.close();
    throw e;
  }
  return {
    engine,
    audit: (...at) => within(view.evaluate(`window.rr.auditWalkthrough(...${JSON.stringify(at)})`), 30_000, 'measuring the slide') as Promise<StepAudit>,
    errors: () => errors.splice(0),
    screenshot: () => within(view.screenshot({ format: 'png' }), 30_000, 'the screenshot'),
    evaluate: (js) => within(view.evaluate(js), 30_000, 'the page') as Promise<never>,
    resize: (width, height) => within(engine === 'chrome' ? view.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }).then(() => {}) : view.resize(width, height), 10_000, 'sizing the browser'),
    close: async () => view.close(),
  };
}
