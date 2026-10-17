// The review page in a headless browser, for `walkthrough lint` and `walkthrough shot`: a fresh Chrome (never the
// user's own, even with remote debugging on) at an exact viewport, else on macOS the system WebKit. Bun.WebView is
// experimental: every use of it stays in this file.
import { fail } from './args.ts';
import { loadConfig, repoOf } from './config.ts';
import { listen, startServer } from './server.ts';
import type { StepAudit } from '../../src/shared/walkthrough.ts';

export type Viewport = { width: number; height: number };
export const vpName = (v: Viewport) => `${v.width}x${v.height}`;
export function parseViewports(s: string): Viewport[] {
  return s.split(',').map((v) => {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(v.trim());
    if (!m) fail(`--viewport: "${v}" is not WIDTHxHEIGHT (like 1280x800)`, 2);
    return { width: +m[1], height: +m[2] };
  });
}

/** The review served from this process (the current build, whatever a running server has) while `fn` runs. */
export async function withServer<T>(repo: string | null, dir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const r = repoOf(dir, repo);
  const { app, close } = startServer({ repo: r, dir, cfg: loadConfig(dir, r) });
  const server = listen(app, 0);
  try {
    return await fn(`http://127.0.0.1:${server.port}/`);
  } finally {
    close();
    void server.stop(true);
  }
}

export type Page = { engine: 'chrome' | 'webkit'; audit(chapter: string, step: string, theme?: 'light' | 'dark'): Promise<StepAudit>; errors(): string[]; screenshot(): Promise<Blob>; close(): Promise<void> };

/** The review page at `url` in a browser at `vp` (`scale`: device pixels per CSS px), once its walkthrough can be measured. */
export async function openPage(url: string, vp: Viewport, scale = 1): Promise<Page> {
  const errors: string[] = []; // console errors since the last errors()
  const capture = (type: string, ...args: unknown[]) => void (type === 'error' && errors.push(args.map(String).join(' ')));
  let view: Bun.WebView;
  let engine: Page['engine'] = 'chrome';
  try {
    view = new Bun.WebView({ ...vp, backend: { type: 'chrome', url: false }, console: capture });
    await view.navigate('about:blank'); // the protocol session exists from the first navigation
    // the window's frame takes height from the viewport; pin it to exactly what was asked
    await view.cdp('Emulation.setDeviceMetricsOverride', { ...vp, deviceScaleFactor: scale, mobile: false });
  } catch (e) {
    if (process.platform !== 'darwin') fail(`no browser to render in: install Chrome or Chromium (or set BUN_CHROME_PATH). ${(e as Error).message}`);
    view = new Bun.WebView({ ...vp, backend: 'webkit', console: capture });
    engine = 'webkit';
  }
  await view.navigate(url);
  const started = await view.evaluate(`new Promise((ok) => { const t0 = Date.now(); const t = () => window.rr?.auditWalkthrough ? ok(true) : Date.now() - t0 > 20000 ? ok(false) : setTimeout(t, 50); t(); })`);
  if (!started) fail(`the review page did not start in 20 s (review.html must load /_rr/reviewroom.js and wrap <rr-review> in <rr-app>, as its scaffold does)${errors.length ? `; page errors:\n  ${errors.join('\n  ')}` : ''}`);
  return {
    engine,
    audit: (...at) => view.evaluate(`window.rr.auditWalkthrough(...${JSON.stringify(at)})`) as Promise<StepAudit>,
    errors: () => errors.splice(0),
    screenshot: () => view.screenshot({ format: 'png' }),
    close: async () => view.close(),
  };
}
