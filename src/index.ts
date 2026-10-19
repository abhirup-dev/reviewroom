// reviewroom - entry point.
//
// A review page is any HTML file that loads this module and contains:
//
//   <rr-app>                                  (attributes: provider, api, layout, repo, base, head)
//     <script type="application/json" id="rr-meta">{ "title": "...", ... }</script>   (optional)
//     <rr-review> ...freeform HTML: sections, diagrams, scripts, anything... </rr-review>
//   </rr-app>
//
// Everything else - docking layout, diffs, files, contents, threads, rounds,
// palette, theming - is provided. See skills/reviewroom/references/authoring.md.
import cssText from './styles/bundle.css' with { type: 'text' };
import { h } from './core/dom';
import { parseRef, formatRef } from './core/refs';
import { anchorOf } from './shared/refs';
import { renderMarkdown } from './core/markdown';
import { emptyState, type ReviewMeta, type ReviewState, type Rev } from './core/types';
import { ReviewApp } from './shell/app';
import { mountDock, applyLayout, canUndoLayout, definePanel, ensurePanel, layoutCommand, layouts, offerGitHubPanels, resetLayout, undoLayout, type PanelDef } from './shell/layout';
import type { LastLayout } from './shared/layout';
import { buildHeader, saveLayoutDialog, sendDialog, submitReviewDialog } from './shell/chrome';
import { BrowserState, GitHubProvider, LocalProvider, ServerState, StaticProvider, type CodeProvider, type Fixture, type StateBackend } from './providers';
import { defineElements, provideApp, renderPreview } from './elements';
import { mountThreadPopup } from './overlays/thread';
import { mountHoverCards, mountPalette, mountSelectionRelease, mountToasts } from './overlays/misc';
import { mountTooltips, tip } from './overlays/tooltip';
import { mountWalkthrough } from './overlays/walkthrough';
import './panels/narrative';
import './panels/code';
import './panels/sidebar';
import { recapOnNewRound } from './panels/recap';

export { ReviewApp, definePanel, parseRef, formatRef, renderMarkdown, renderPreview, LocalProvider, GitHubProvider, StaticProvider, ServerState, BrowserState };
export type { CodeProvider, StateBackend, PanelDef, Fixture, ReviewMeta, ReviewState };

function injectCSS() {
  if (document.querySelector('style[data-reviewroom]') || document.querySelector('link[data-reviewroom]')) return;
  const s = document.createElement('style');
  s.dataset.reviewroom = '';
  s.textContent = cssText.replaceAll('__RR_FONTS__', new URL('./fonts', import.meta.url).href);
  document.head.prepend(s);
}

function readJSON(sel: string, root: ParentNode = document): unknown {
  const el = root.querySelector(sel);
  if (!el?.textContent?.trim()) return null;
  try {
    return JSON.parse(el.textContent);
  } catch (e) {
    console.error('[reviewroom] bad JSON in', sel, e);
    return null;
  }
}

async function pickProvider(root: HTMLElement, meta: Partial<ReviewMeta>, fx: Fixture | null): Promise<{ provider: CodeProvider; backend: 'server' | 'browser' }> {
  const want = root.getAttribute('provider') || 'auto';
  const api = root.getAttribute('api') || '/api';
  if (want === 'local' || want === 'auto') {
    const local = await LocalProvider.detect(api);
    if (local) return { provider: local, backend: 'server' };
    if (want === 'local') console.warn('[reviewroom] local server not reachable, falling back');
  }
  if (want === 'static' || (want === 'auto' && fx)) {
    if (!fx) throw new Error('provider="static" needs <script type="application/json" id="rr-fixture">');
    return { provider: new StaticProvider(fx), backend: 'browser' };
  }
  const repo = root.getAttribute('repo') || meta.repo;
  if (repo && meta.base && meta.head) {
    let token: string | undefined;
    try {
      token = localStorage.getItem('reviewroom:github-token') || undefined;
    } catch {
      /* ignore */
    }
    return { provider: new GitHubProvider(repo, meta.base, meta.head, token), backend: 'browser' };
  }
  throw new Error('No code source: run `reviewroom pr` or `reviewroom review`, or set repo/base/head for GitHub, or embed #rr-fixture.');
}

/** Agent-supplied colours: { "theme": { "light": { "surface-doc": "#fffdf8" }, "dark": { "bg": "#000" } } } in #rr-meta. */
export type ThemeOverrides = { light?: Record<string, string>; dark?: Record<string, string> };
function applyThemeOverrides(t: ThemeOverrides) {
  const decl = (o: Record<string, string> = {}) =>
    Object.entries(o)
      .filter(([k, v]) => /^[\w-]+$/.test(k) && !/[;{}<]/.test(v))
      .map(([k, v]) => `${k.startsWith('--') ? k : '--rr-' + k}:${v};`)
      .join('');
  const s = document.createElement('style');
  s.dataset.reviewroomTheme = '';
  s.textContent = `:root{${decl(t.light)}}:root[data-rr-theme='dark']{${decl(t.dark)}}`;
  document.head.append(s);
}

export async function boot(root: HTMLElement | null = document.querySelector('rr-app')): Promise<ReviewApp> {
  if (!root) throw new Error('reviewroom: no <rr-app> element');
  injectCSS();
  defineElements();
  const app = new ReviewApp(root);
  app.applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.prefs.theme === 'system' && app.applyTheme());

  const authored = (readJSON('#rr-meta', root) as (Partial<ReviewMeta> & { theme?: ThemeOverrides }) | null) ?? {};
  if (authored.theme) applyThemeOverrides(authored.theme);
  for (const k of ['repo', 'base', 'head', 'title'] as const) if (root.getAttribute(k)) authored[k] = root.getAttribute(k)!;
  const fixture = readJSON('#rr-fixture') as Fixture | null;
  const seedState = readJSON('#rr-state') as ReviewState | null;
  const seedTour = document.querySelector('#rr-walkthrough')?.textContent ?? undefined;
  const review = root.querySelector('rr-review') as HTMLElement | null;
  const doc = review ?? h('rr-review', null, h('p', { class: 'rr-muted' }, 'No <rr-review> content yet.'));
  doc.remove();
  doc.classList.add('rr-prose', 'rr-doc');
  app.doc = doc;
  root.replaceChildren(h('div', { class: 'rr-loading' }, h('div', { class: 'rr-skeleton' }), 'Loading review…'));

  let lastLayout: LastLayout | null = null;
  try {
    const { provider, backend } = await pickProvider(root, authored, fixture);
    app.provider = provider;
    const pm = await provider.meta();
    const meta = { ...pm, ...authored, ...(provider.name === 'local' ? { base: pm.base, head: pm.head } : {}) } as ReviewMeta;
    meta.title ||= document.title || 'Code review';
    meta.base ||= 'base';
    meta.head ||= 'head';
    meta.id ||= [meta.repo, meta.number, meta.title].filter(Boolean).join('#').replace(/\s+/g, '-').slice(0, 80);
    app.meta = meta;
    if (!document.title) document.title = meta.title;
    app.backend = backend === 'server' ? new ServerState(root.getAttribute('api') || '/api') : new BrowserState(meta.id, seedState ?? undefined, seedTour);
    app.state = { ...emptyState(), ...(await app.backend.load()) };
    let saved;
    [saved, lastLayout] = await Promise.all([app.backend.layouts().catch(() => null), app.backend.lastLayout().catch(() => null)]);
    app.layouts = saved?.layouts ?? {};
    app.defaultLayout = saved?.default ?? null;
    app.viewRound = app.state.round;
    app.commits = await provider.commits().catch(() => []);
    await app.setRange({ base: meta.base, head: meta.head, label: 'All changes', key: 'all' });
  } catch (e) {
    root.replaceChildren(h('div', { class: 'rr-fatal' }, h('strong', null, 'Could not load the review'), h('pre', null, e instanceof Error ? e.message : String(e))));
    throw e;
  }

  provideApp(app);
  const dockHost = h('div', { class: 'rr-dock' });
  root.replaceChildren(buildHeader(app), dockHost);
  root.classList.add('rr-root');
  mountToasts(app);
  mountTooltips(app);
  mountPalette(app);
  mountSelectionRelease(app);
  mountHoverCards(app);
  mountThreadPopup(app);
  const tour = mountWalkthrough(app);
  mountDock(app, dockHost, lastLayout);
  registerCommands(app);
  app.commands.scopeOf = (t) => ((t as Element | null)?.closest?.('[data-rr-scope]')?.getAttribute('data-rr-scope') as 'code' | 'narrative' | null) ?? 'global';
  app.commands.attach(document);

  app.backend.subscribe?.({
    state: (s) => {
      app.state = s;
      app.bus.emit('state', s);
    },
    error: (text) => app.toast(text, 'error'),
    unsaved: (on) => app.root.classList.toggle('is-unsaved', on),
    status: (s) => (['waiting', 'approved', 'offline'] as const).forEach((k) => app.root.classList.toggle('is-' + k, s === k)),
    ready: (round) => app.toast(`Round ${round} is ready.`),
    github: (s) => app.setGitHub(s),
    // the backend has let a save in flight finish first
    review: () => {
      sessionStorage.setItem('reviewroom:scroll', String(document.querySelector('.rr-narrative-scroll')?.scrollTop ?? 0));
      location.reload();
    },
  });
  const y = sessionStorage.getItem('reviewroom:scroll');
  if (y) {
    sessionStorage.removeItem('reviewroom:scroll');
    requestAnimationFrame(() => document.querySelector('.rr-narrative-scroll')?.scrollTo({ top: +y }));
  }
  app.bus.emit('state', app.state);
  app.bus.emit('prefs', app.prefs);
  recapOnNewRound(app);
  if (app.backend.github) {
    const age = () => Date.now() - Date.parse(app.github?.at ?? '');
    // the server answers from its cache at once; refetch when that cache is old
    app.backend.github().then(
      (s) => {
        app.setGitHub(s);
        if (s.ok && age() > 30_000) app.refreshGitHub().catch(() => {});
      },
      () => {},
    );
    app.bus.on('state', () => offerGitHubPanels(app));
    // colleagues comment while you read: refetch when you come back to the tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && app.github?.ok && age() > 30_000) app.refreshGitHub().catch(() => {});
    });
    // while CI runs on the latest commit, follow it
    setInterval(() => {
      if (document.visibilityState === 'visible' && app.github?.ci?.[0]?.state === 'pending' && age() > 30_000) app.refreshGitHub().catch(() => {});
    }, 10_000);
  }

  // Public API for agent-authored scripts inside the review.
  const api = {
    app,
    open: (ref: string) => app.open(ref),
    /** Play the walkthrough, at a chapter and step (ids) or from the start. */
    walkthrough: (chapter?: string, step?: string) => app.bus.emit('walkthrough-open', { chapter, step }),
    /** For `reviewroom walkthrough lint`, not for review authors: measure a step on screen. */
    auditWalkthrough: tour.audit,
    findSymbol: (name: string) => app.findSymbol(name),
    read: (path: string, rev: Rev = 'head') => app.read(path, rev === 'base' || rev === 'head' ? app.revFor(rev) : rev),
    files: () => app.files,
    search: (q: string, symbol = false) => app.search(q, symbol),
    comment: (ref: string, body?: string) => {
      const anchor = anchorOf(ref);
      return body ? app.createThread(anchor, body) : app.compose(anchor);
    },
    on: app.bus.on.bind(app.bus),
    commands: app.commands,
    definePanel,
    addPanel: (id: string, params?: Record<string, unknown>) => ensurePanel(app, id, params),
    layout: (name: string) => applyLayout(app, name),
    toast: (t: string) => app.toast(t),
    theme: () => app.resolvedTheme(),
    markdown: renderMarkdown,
    tip,
  };
  Object.assign(window, { rr: api });
  window.dispatchEvent(new CustomEvent('reviewroom:ready', { detail: api }));
  return app;
}

function registerCommands(app: ReviewApp) {
  const C = app.commands;
  const pal = (q = '') => () => app.openPalette(q);
  const codeCmd = (name: string) => () => {
    const scroller = (document.activeElement?.closest('.rr-code-panel') ?? document.querySelector('.rr-code-panel'));
    scroller?.dispatchEvent(new CustomEvent('rr-code-cmd', { detail: name }));
  };
  C.register(
    { id: 'palette', title: 'Go to anything', group: 'Navigate', keys: ['mod+k'], run: pal('') },
    { id: 'palette.commands', title: 'Show all commands', group: 'Navigate', keys: ['mod+shift+p', '?'], run: pal('>') },
    { id: 'palette.symbols', title: 'Find symbol', group: 'Navigate', keys: ['mod+shift+o', '#'], run: pal('#') },
    { id: 'palette.search', title: 'Search code', group: 'Navigate', keys: ['mod+shift+f', '/'], run: pal('/') },
    { id: 'hub', title: 'All reviews', group: 'Navigate', hint: 'Every review running on this machine', when: () => app.backend.kind === 'server', run: () => window.open('/api/hub', '_blank') },
    { id: 'focus.narrative', title: 'Focus narrative', group: 'Panels', keys: ['g n'], run: () => (ensurePanel(app, 'narrative'), (document.querySelector('.rr-narrative-scroll') as HTMLElement)?.focus()) },
    { id: 'focus.code', title: 'Focus code', group: 'Panels', keys: ['g c'], run: () => (ensurePanel(app, 'code'), (document.querySelector('.rr-code-scroll') as HTMLElement)?.focus()) },
    { id: 'focus.files', title: 'Show files', group: 'Panels', keys: ['g f'], run: () => ensurePanel(app, 'files') },
    { id: 'focus.threads', title: 'Show threads', group: 'Panels', keys: ['g t'], run: () => ensurePanel(app, 'threads') },
    { id: 'focus.toc', title: 'Show contents', group: 'Panels', keys: ['g o'], run: () => ensurePanel(app, 'toc') },
    { id: 'walkthrough.play', title: 'Play guided walkthrough', group: 'Navigate', keys: ['g w'], run: () => app.bus.emit('walkthrough-open', {}) },
    { id: 'layout.saveDefault', title: 'Save layout as default…', group: 'Layout', hint: 'Reviews without a layout of their own open like this', run: () => saveLayoutDialog(app, true) },
    { id: 'layout.undo', title: 'Undo layout change', group: 'Layout', hint: 'Back to the layout before the last change', when: canUndoLayout, run: () => undoLayout(app) },
    { id: 'layout.reset', title: 'Reset layout', group: 'Layout', hint: 'Every panel back where it started', run: () => resetLayout(app) },
    ...Object.keys(layouts(app)).map((id) => layoutCommand(app, id)),
    { id: 'theme.toggle', title: 'Toggle light / dark', group: 'View', run: () => app.setPref('theme', app.resolvedTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'theme.system', title: 'Theme: follow system', group: 'View', run: () => app.setPref('theme', 'system') },
    { id: 'diff.split', title: 'Toggle split / unified diff', group: 'Code', keys: ['s'], scope: 'code', run: () => app.setPref('diffStyle', app.prefs.diffStyle === 'split' ? 'unified' : 'split') },
    { id: 'diff.wrap', title: 'Toggle line wrap', group: 'Code', keys: ['w'], scope: 'code', run: () => app.setPref('wrap', !app.prefs.wrap) },
    { id: 'diff.ws', title: 'Toggle ignore whitespace', group: 'Code', keys: ['i'], scope: 'code', run: () => app.setPref('ignoreWhitespace', !app.prefs.ignoreWhitespace) },
    { id: 'diff.focus.add', title: 'Focus on new code', group: 'Code', keys: ['+'], scope: 'code', run: () => app.setPref('focus', app.prefs.focus === 'additions' ? 'all' : 'additions') },
    { id: 'diff.focus.del', title: 'Focus on old code', group: 'Code', keys: ['-'], scope: 'code', run: () => app.setPref('focus', app.prefs.focus === 'deletions' ? 'all' : 'deletions') },
    { id: 'diff.next', title: 'Next change', group: 'Code', keys: ['j'], scope: 'code', run: codeCmd('next') },
    { id: 'diff.prev', title: 'Previous change', group: 'Code', keys: ['k'], scope: 'code', run: codeCmd('prev') },
    { id: 'diff.nextFile', title: 'Next file', group: 'Code', keys: ['] f', 'shift+j'], scope: 'code', run: codeCmd('nextFile') },
    { id: 'diff.prevFile', title: 'Previous file', group: 'Code', keys: ['[ f', 'shift+k'], scope: 'code', run: codeCmd('prevFile') },
    { id: 'diff.viewed', title: 'Mark current file viewed', group: 'Code', keys: ['v'], scope: 'code', run: () => app.activeFile && app.setViewed(app.activeFile, app.state.viewed[app.activeFile] === undefined) },
    { id: 'files.tests', title: 'Toggle test files', group: 'Files', run: () => app.setPref('hideTests', !app.prefs.hideTests) },
    { id: 'doc.next', title: 'Next section', group: 'Narrative', keys: [']', 'n'], scope: 'narrative', run: () => stepSection(app, 1) },
    { id: 'doc.prev', title: 'Previous section', group: 'Narrative', keys: ['[', 'p'], scope: 'narrative', run: () => stepSection(app, -1) },
    { id: 'pick', title: 'Pick an element to comment on', group: 'Comments', keys: ['x'], run: () => app.bus.emit('picker', !app.root.classList.contains('is-picking')) },
    { id: 'comment.selection', title: 'Comment on selection', group: 'Comments', keys: ['c'], when: () => !!app.selection, run: () => {
      const s = app.selection!;
      app.compose(s.kind === 'code' ? { kind: 'code', path: s.path, rev: s.side, start: s.start, end: s.end } : s.anchor, s.kind === 'doc' ? s.label : undefined);
    } },
    { id: 'comment.general', title: 'New general comment', group: 'Comments', run: () => app.compose({ kind: 'general' }) },
    { id: 'round.send', title: 'Finish round & send feedback (Team review: submit your GitHub review)', group: 'Rounds', keys: ['mod+shift+enter'], run: () => (app.teamMode ? submitReviewDialog(app) : sendDialog(app)) },
    { id: 'github.refresh', title: 'Refresh GitHub comments', group: 'GitHub', run: () => app.refreshGitHub() },
    { id: 'round.current', title: 'Back to current round', group: 'Rounds', run: () => app.bus.emit('round-view', 0) },
    { id: 'escape', title: 'Close / clear selection', group: 'View', keys: ['escape'], run: () => {
      // innermost first: overlays (newest first), then the selection, then pick mode
      for (const f of [...app.escapers].reverse()) if (f()) return;
      if (app.root.classList.contains('is-picking')) return app.bus.emit('picker', false);
      app.selection = null;
      document.getSelection()?.removeAllRanges();
      app.bus.emit('selection', null);
    } },
  );
}

function stepSection(app: ReviewApp, dir: 1 | -1) {
  const secs = [...(app.doc?.querySelectorAll('section[id]') ?? [])].filter((s) => !s.parentElement?.closest('section[id]'));
  const sc = document.querySelector('.rr-narrative-scroll') as HTMLElement;
  if (!sc || !secs.length) return;
  const top = sc.getBoundingClientRect().top + 60;
  const idx = secs.findIndex((s) => s.getBoundingClientRect().top > top + 2);
  const cur = idx < 0 ? secs.length : idx;
  const target = dir > 0 ? secs[cur] : secs[Math.max(0, cur - 2)];
  if (target) app.bus.emit('reveal-doc', { id: target.id });
}

// Auto-boot when loaded on a page with <rr-app> (opt out with <rr-app manual>).
if (typeof document !== 'undefined') {
  const go = () => {
    const root = document.querySelector('rr-app');
    if (root && !root.hasAttribute('manual')) boot(root as HTMLElement).catch((e) => console.error('[reviewroom]', e));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
}
