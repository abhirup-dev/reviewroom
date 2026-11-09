// The review page in a headless browser, for `slide-lint` and `shot`: a fresh Chrome (never the
// user's own, even with remote debugging on) at an exact viewport, else on macOS the system WebKit. Bun.WebView is
// experimental: every use of it stays in this file.
import { fail } from './args.ts';
import { loadConfig } from './config.ts';
import { listen, startServer } from './server.ts';
import { StepAudit, type SlideAuditOptions } from '../../src/slides/model.shared.ts';

export type Viewport = { width: number; height: number };
/** Static headless renders skip CSS motion (Pele's SVG animations and the player's fades), never layout readiness. */
type RenderOptions = { animations?: boolean; rasterHeight?: number };
type Clip = { x: number; y: number; width: number; height: number };

/** A cap affects pixels only; CSS viewport dimensions stay fixed. Never upscale a short capture. */
const rasterScale = (height: number, scale: number, cap?: number) => cap ? Math.min(scale, cap / height) : scale;

/** Physical pixel bounds, rounded inwards so a crop never includes the adjacent pane. */
function pixelClip(rect: Clip, scale: number) {
  const x = Math.ceil(rect.x * scale), y = Math.ceil(rect.y * scale);
  return { x, y, width: Math.max(1, Math.floor((rect.x + rect.width) * scale) - x), height: Math.max(1, Math.floor((rect.y + rect.height) * scale) - y) };
}

export async function pngSize(blob: Blob) {
  const header = new DataView(await blob.slice(16, 24).arrayBuffer());
  return { width: header.getUint32(0), height: header.getUint32(4) };
}
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
// Zero duration rather than animation:none: CSS animationend still retires outgoing slide prose.
const NO_MOTION = `(() => { const style = document.createElement('style'); style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important}'; document.head.append(style); return true; })()`;

/** `p`, or a rejection after `ms` (unref'd, so a stuck browser call can't keep the process up either). */
const within = <T>(p: Promise<T>, ms: number, what: string) => {
  let t: Timer;
  return Promise.race([p, new Promise<never>((_, no) => void (t = setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000} s`)), ms).unref()))]).finally(() => clearTimeout(t));
};

export type Page = { engine: 'chrome' | 'webkit'; audit(chapter: string, step: string, theme?: 'light' | 'dark', options?: SlideAuditOptions): Promise<StepAudit>; errors(): string[]; screenshot(selector?: string): Promise<Blob>; evaluate<T>(js: string): Promise<T>; resize(width: number, height: number): Promise<void>; close(): Promise<void> };

/** `fn` with the review page open (see openPage), closing it however `fn` ends. */
export async function withPage<T>(url: string, vp: Viewport, fn: (page: Page) => Promise<T>, scale = 1, options: RenderOptions & { createPage?: typeof openPage } = {}): Promise<T> {
  const page = await (options.createPage ?? openPage)(url, vp, scale, options);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** The review page at `url` in a browser at `vp` (`scale`: device pixels per CSS px), once its walkthrough can be measured. */
export async function openPage(url: string, vp: Viewport, scale = 1, options: RenderOptions = {}): Promise<Page> {
  const errors: string[] = []; // console errors since the last errors()
  const capture = (type: string, ...args: unknown[]) => void (type === 'error' && errors.push(args.map(String).join(' ')));
  let view: Bun.WebView | undefined;
  let engine: Page['engine'] = 'chrome';
  let viewport = vp;
  let pixels = rasterScale(vp.height, scale, options.rasterHeight);
  try {
    view = new Bun.WebView({ ...vp, backend: { type: 'chrome', url: false }, console: capture });
    await within(view.navigate('about:blank'), 30_000, 'starting the browser'); // the protocol session exists from the first navigation
    // the window's frame takes height from the viewport; pin it to exactly what was asked
    await within(view.cdp('Emulation.setDeviceMetricsOverride', { ...vp, deviceScaleFactor: pixels, mobile: false }), 10_000, 'sizing the browser');
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
    // Applied once, before any slide audit. CSS also covers SVGs inserted later by Pele's lazy renderer.
    if (options.animations === false) await within(view.evaluate(NO_MOTION), 10_000, 'disabling render animations');
    // diagrams render after the app starts (Pele loads each type lazily): wait, so their errors count as the page's, not the first slide's
    await within(view.evaluate(`new Promise((ok) => { const t0 = Date.now(); const t = () => !document.querySelector('[aria-busy="true"]') || Date.now() - t0 > 10000 ? ok(true) : setTimeout(t, 50); t(); })`), 15_000, 'waiting for the diagrams');
  } catch (e) {
    view.close();
    throw e;
  }
  return {
    engine,
    audit: (...at) => within(view.evaluate(`window.rr.auditWalkthrough(...${JSON.stringify(at)})`), 30_000, 'measuring the slide').then((result) => StepAudit.parse(result)),
    errors: () => errors.splice(0),
    screenshot: (selector) => within(captureScreenshot(view, engine, { vp: viewport, scale: pixels, cap: options.rasterHeight }, selector), 30_000, 'the screenshot'),
    evaluate: (js) => within(view.evaluate(js), 30_000, 'the page') as Promise<never>,
    resize: async (width, height) => {
      pixels = rasterScale(height, scale, options.rasterHeight);
      await within(engine === 'chrome' ? view.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: pixels, mobile: false }).then(() => {}) : view.resize(width, height), 10_000, 'sizing the browser');
      viewport = { width, height };
    },
    close: async () => view.close(),
  };
}

/** Capture an existing box without resizing or reflowing the page. WebKit has no CDP clipping/DPR override. */
async function captureScreenshot(view: Bun.WebView, engine: Page['engine'], { vp, scale, cap }: { vp: Viewport; scale: number; cap?: number }, selector?: string): Promise<Blob> {
  const rect = selector ? await view.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('screenshot target not found');
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) throw new Error('screenshot target is not visible');
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.right) - Math.max(0, r.left), height: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) };
  })()`) as Clip : undefined;
  if (engine === 'chrome') {
    if (!rect) return view.screenshot({ format: 'png' });
    const p = pixelClip(rect, scale);
    const result = await view.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: p.x / scale, y: p.y / scale, width: p.width / scale, height: p.height / scale, scale: 1 } }) as { data: string };
    return new Blob([Buffer.from(result.data, 'base64')], { type: 'image/png' });
  }
  const raw = await view.screenshot({ format: 'png' });
  if (!rect && !cap) return raw;
  // Preserve WebKit's layout; crop/downsample its PNG rather than shrinking the CSS viewport.
  const size = await pngSize(raw), sourceScale = size.width / vp.width;
  const source = pixelClip(rect ?? { x: 0, y: 0, ...vp }, sourceScale);
  const outputScale = cap ? Math.min(sourceScale, scale) : sourceScale;
  const data = await view.evaluate(`new Promise((ok, no) => {
    const image = new Image(); image.onerror = () => no(new Error('could not decode screenshot'));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ${Math.max(1, Math.round(source.width * outputScale / sourceScale))}; canvas.height = ${Math.max(1, Math.round(source.height * outputScale / sourceScale))};
      canvas.getContext('2d').drawImage(image, ${source.x}, ${source.y}, ${source.width}, ${source.height}, 0, 0, canvas.width, canvas.height);
      ok(canvas.toDataURL('image/png').split(',')[1]);
    };
    image.src = ${JSON.stringify(`data:image/png;base64,${Buffer.from(await raw.arrayBuffer()).toString('base64')}`)};
  })`);
  return new Blob([Buffer.from(data as string, 'base64')], { type: 'image/png' });
}
