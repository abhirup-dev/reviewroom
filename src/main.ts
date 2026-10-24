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
import cssText from './bundle.css' with { type: 'text' };
import { canInstall, install } from './kernel/install'; // first: it listens for Chrome's install prompt
import { h, icon } from './kernel/dom';
import { loadRaw, rekeyStorage } from './kernel/store';
import { anchorOf, parseRef, formatRef } from './kernel/refs/refs.shared';
import { renderMarkdown } from './kernel/markdown';
import { emptyState, type ReviewMeta, type ReviewState, type Rev } from './kernel/state/model.shared';
import { ReviewApp } from './app';
import { createReviewServices } from './services';
import { definePanel, ensurePanel, type PanelDef } from './kernel/dock';
import type { LastLayout } from './kernel/layouts/layout.shared';
import { buildHeader, buildPhoneBar, hubHref, saveLayoutDialog, type PhoneBarContributions } from './kernel/header';
import { mountPhone } from './kernel/phone';
import { restoreShell, turnedPhone, wantsPhone, watchShell } from './kernel/device';
import { startUpdates } from './kernel/pwa';
import { githubPanelAvailability, recapAvailable } from './threads/docking';
import { sendDialog, submitReviewDialog, githubControls, feedbackButton, threadHeaderControls, roundStatusControls, subscribeThreadHeader, roundMenu, reviewModeSwitch } from './threads/controls';
import type { CodeProvider, StateBackend } from './kernel/providers/contracts';
import { BrowserState } from './kernel/providers/browser-state';
import { ServerState } from './kernel/providers/server-state';
import { GitHubProvider } from './review/providers/github';
import { LocalProvider } from './review/providers/local';
import { StaticProvider, type Fixture } from './review/providers/static';
import { defineElements, provideApp } from './review/elements';
import { mountThreadPopup } from './threads/view';
import { mountHoverCards, mountPalette, mountSelectionRelease } from './review/overlays';
import { mountToasts } from './kernel/toasts';
import { mountTooltips, tip } from './kernel/tooltip';
import { mountWalkthrough, renderWalkthroughPreview } from './slides/player';
import { renderPreview, registerPreviewExtensions } from './review/previews';
import { provideFocusCode } from './review/focus';
import { openInNewPanel } from './review/code';
import './review/walkthrough';
import './review/code';
import './review/files';
import './review/contents';
import './threads/panels';
import './threads/ci';
import { recapOnNewRound } from './threads/recap';

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
  const api = root.getAttribute('api') || 'api';
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
    const token = loadRaw('reviewroom:github-token') || undefined;
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

export interface BootOptions {
  provider?: CodeProvider;
  backend?: StateBackend;
  reload?: () => void;
}

export async function boot(root: HTMLElement | null = document.querySelector('rr-app'), options: BootOptions = {}): Promise<ReviewApp> {
  if (!root) throw new Error('reviewroom: no <rr-app> element');
  injectCSS();
  defineElements();
  const app = new ReviewApp(root, createReviewServices, wantsPhone() ? 'phone' : 'dock');
  const phone = app.presentation.kind === 'phone';
  startUpdates(app); // before loading: an old shell that can't load the review still updates
  app.applyTheme();
  const themeQuery = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { if (app.prefs.theme === 'system') app.applyTheme(); };
  themeQuery.addEventListener('change', onTheme);
  app.onDispose(() => themeQuery.removeEventListener('change', onTheme));

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
    const { provider, backend } = options.provider ? { provider: options.provider, backend: 'browser' as const } : await pickProvider(root, authored, fixture);
    app.provider = provider;
    const pm = await provider.meta();
    const meta = { ...pm, ...authored, ...(provider.name === 'local' ? { base: pm.base, head: pm.head } : {}) } as ReviewMeta;
    meta.title ||= document.title || 'Code review';
    meta.base ||= 'base';
    meta.head ||= 'head';
    const titleId = [meta.repo, meta.number, meta.title].filter(Boolean).join('#').replace(/\s+/g, '-').slice(0, 80);
    meta.id ||= titleId; // the server sends its review id: titles collide once every review shares the hub's origin
    rekeyStorage(titleId, meta.id);
    app.meta = meta;
    if (!document.title) document.title = meta.title;
    app.backend = options.backend ?? (backend === 'server' ? new ServerState(root.getAttribute('api') || 'api') : new BrowserState(meta.id, seedState ?? undefined, seedTour));
    app.state = { ...emptyState(), ...(await app.backend.load()) };
    let saved;
    [saved, lastLayout] = await Promise.all([app.backend.layouts().catch(() => null), app.backend.lastLayout().catch(() => null)]);
    app.layout.saved = saved?.layouts ?? {};
    app.layout.defaultId = saved?.default ?? null;
    app.viewRound = app.state.round;
    app.commits = await provider.commits().catch(() => []);
    await app.setRange({ base: meta.base, head: meta.head, label: 'All changes', key: 'all' });
  } catch (e) {
    app.dispose();
    root.replaceChildren(h('div', { class: 'rr-fatal' }, h('strong', null, 'Could not load the review'), h('pre', null, e instanceof Error ? e.message : String(e))));
    throw e;
  }

  registerPreviewExtensions({ tour: renderWalkthroughPreview });
  provideFocusCode(app, { openFile: (path, view, at) => openInNewPanel(app, path, view, 'center', undefined, at) });
  provideApp(app);
  const dockHost = h('div', { class: 'rr-dock' });
  root.replaceChildren(phone ? buildPhoneBar(app, phoneBar(app)) : buildHeader(app, {
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
  }), dockHost);
  root.classList.add('rr-root');
  mountToasts(app);
  mountTooltips(app);
  mountPalette(app);
  mountSelectionRelease(app);
  mountHoverCards(app);
  mountThreadPopup(app);
  const tour = mountWalkthrough(app);
  if (phone)
    mountPhone(app, dockHost, {
      panelAvailability: githubPanelAvailability(app),
      // Last round while a round has threads from the last one; the PR conversation for a GitHub PR that has one
      available: (id) =>
        id === 'recap' ? recapAvailable(app) : id === 'thread:gh_conversation' ? app.services.threads.threads().some((t) => t.gh?.conversation) : true,
      openThreads: () => openThreadCount(app),
    });
  else app.layout.mount(dockHost, turnedPhone() ? null : lastLayout, { panelAvailability: githubPanelAvailability(app), save: !turnedPhone() });
  watchShell(app, phone);
  registerCommands(app);
  app.commands.scopeOf = (t) => ((t as Element | null)?.closest?.('[data-rr-scope]')?.getAttribute('data-rr-scope') as 'code' | 'narrative' | null) ?? 'global';
  app.onDispose(app.commands.attach(document));

  app.backend.subscribe?.({
    state: (s) => {
      app.state = s;
      app.bus.emit('state', s);
    },
    error: (text) => app.toast(text, 'error'),
    unsaved: (on) => app.root.classList.toggle('is-unsaved', on),
    status: (s) => (['waiting', 'approved', 'offline'] as const).forEach((k) => app.root.classList.toggle('is-' + k, s === k)),
    ready: (round) => app.toast(`Round ${round} is ready.`),
    github: (s) => app.services.github.set(s),
    // the backend has let a save in flight finish first
    review: () => {
      sessionStorage.setItem('reviewroom:scroll', String(document.querySelector('.rr-narrative-scroll')?.scrollTop ?? 0));
      (options.reload ?? (() => location.reload()))();
    },
  });
  const y = sessionStorage.getItem('reviewroom:scroll');
  if (y) {
    sessionStorage.removeItem('reviewroom:scroll');
    requestAnimationFrame(() => document.querySelector('.rr-narrative-scroll')?.scrollTo({ top: +y }));
  }
  restoreShell(app, phone);
  app.bus.emit('state', app.state);
  app.bus.emit('prefs', app.prefs);
  recapOnNewRound(app);
  if (app.backend.github) {
    const age = () => Date.now() - Date.parse(app.github?.at ?? '');
    // the server answers from its cache at once; refetch when that cache is old
    app.backend.github().then(
      (s) => {
        app.services.github.set(s);
        if (s.ok && age() > 30_000) app.services.github.refresh().catch(() => {});
      },
      () => {},
    );
    if (!phone) app.bus.on('state', () => app.layout.offerAvailable()); // the phone shell repaints its pages on state itself
    // colleagues comment while you read: refetch when you come back to the tab
    app.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible' && app.github?.ok && age() > 30_000) app.services.github.refresh().catch(() => {});
    });
    // while CI runs on the latest commit, follow it
    const refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && app.github?.ci?.[0]?.state === 'pending' && age() > 30_000) app.services.github.refresh().catch(() => {});
    }, 10_000);
    app.onDispose(() => clearInterval(refreshTimer));
  }

  // Public API for agent-authored scripts inside the review.
  const api = {
    app,
    open: (ref: string) => app.open(ref),
    /** Play the walkthrough, at a chapter and step (ids) or from the start. */
    walkthrough: (chapter?: string, step?: string) => app.bus.emit('walkthrough-open', { chapter, step }),
    /** For `reviewroom slide-lint`, not for review authors: measure a step on screen. */
    auditWalkthrough: tour.audit,
    findSymbol: (name: string) => app.findSymbol(name),
    read: (path: string, rev: Rev = 'head') => app.services.code.read(path, rev === 'base' || rev === 'head' ? app.services.code.revFor(rev) : rev),
    files: () => app.files,
    search: (q: string, symbol = false) => app.services.code.search(q, symbol),
    comment: (ref: string, body?: string) => {
      const anchor = anchorOf(ref);
      return body ? app.services.threads.createThread(anchor, body) : app.compose(anchor);
    },
    on: app.bus.on.bind(app.bus),
    commands: app.commands,
    definePanel,
    // the dock hands agents its panel; a phone has nothing to arrange, so a layout that exists is already applied
    addPanel: (id: string, params?: Record<string, unknown>) => (app.presentation.canArrange ? app.layout.ensurePanel(id, params) : void ensurePanel(app, id, params)),
    layout: (name: string) => (app.presentation.canArrange ? app.layout.apply(name) : !!app.layout.all()[name]),
    toast: (t: string) => app.toast(t),
    theme: () => app.resolvedTheme(),
    markdown: renderMarkdown,
    tip,
  };
  Object.assign(window, { rr: api });
  app.onDispose(() => { if (Reflect.get(window, 'rr') === api) Reflect.deleteProperty(window, 'rr'); });
  window.dispatchEvent(new CustomEvent('reviewroom:ready', { detail: api }));
  return app;
}

function registerCommands(app: ReviewApp) {
  const C = app.commands;
  const pal = (q = '') => () => app.openPalette(q);
  const codeCmd = (name: string) => () => {
    const scroller = (document.activeElement?.closest('.rr-code-panel') ?? document.querySelector('.rr-code-panel'));
    if (scroller && !scroller.checkVisibility({ visibilityProperty: true })) ensurePanel(app, 'code'); // on a phone, from another tab: show where it moves
    scroller?.dispatchEvent(new CustomEvent('rr-code-cmd', { detail: name }));
  };
  C.register(
    { id: 'palette', title: 'Go to anything', group: 'Navigate', keys: ['mod+k'], run: pal('') },
    { id: 'palette.commands', title: 'Show all commands', group: 'Navigate', keys: ['mod+shift+p', '?'], run: pal('>') },
    { id: 'palette.symbols', title: 'Find symbol', group: 'Navigate', keys: ['mod+shift+o', '#'], run: pal('#') },
    { id: 'palette.search', title: 'Search code', group: 'Navigate', keys: ['mod+shift+f', '/'], run: pal('/') },
    { id: 'hub', title: 'All reviews', group: 'Navigate', hint: 'Every review running on this machine', when: () => app.backend.kind === 'server', run: () => window.open(hubHref(), '_blank') },
    { id: 'focus.narrative', title: 'Focus narrative', group: 'Panels', keys: ['g n'], run: () => (ensurePanel(app, 'narrative'), (document.querySelector('.rr-narrative-scroll') as HTMLElement)?.focus()) },
    { id: 'focus.code', title: 'Focus code', group: 'Panels', keys: ['g c'], run: () => (ensurePanel(app, 'code'), (document.querySelector('.rr-code-scroll') as HTMLElement)?.focus()) },
    { id: 'focus.files', title: 'Show files', group: 'Panels', keys: ['g f'], run: () => ensurePanel(app, 'files') },
    { id: 'focus.threads', title: 'Show threads', group: 'Panels', keys: ['g t'], run: () => ensurePanel(app, 'threads') },
    { id: 'focus.toc', title: 'Show contents', group: 'Panels', keys: ['g o'], run: () => ensurePanel(app, 'toc') },
    { id: 'walkthrough.play', title: 'Play guided walkthrough', group: 'Navigate', keys: ['g w'], run: () => app.bus.emit('walkthrough-open', {}) },
    { id: 'layout.saveDefault', title: 'Save layout as default…', group: 'Layout', hint: 'Reviews without a layout of their own open like this', when: () => app.presentation.canArrange, run: () => saveLayoutDialog(app, true) },
    { id: 'layout.undo', title: 'Undo layout change', group: 'Layout', hint: 'Back to the layout before the last change', when: () => app.layout.canUndo(), run: () => app.layout.undo() },
    { id: 'layout.reset', title: 'Reset layout', group: 'Layout', hint: 'Every panel back where it started', when: () => app.presentation.canArrange, run: () => app.layout.reset() },
    ...Object.keys(app.layout.all()).map((id) => app.layout.command(id)),
    { id: 'theme.toggle', title: 'Toggle light / dark', group: 'View', run: () => app.setPref('theme', app.resolvedTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'app.install', title: 'Install app', group: 'View', hint: 'Its own window; on a phone, an icon on the home screen', when: canInstall, run: () => void install() },
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
    { id: 'round.send', title: 'Finish round & send feedback (Team review: submit your GitHub review)', group: 'Rounds', keys: ['mod+shift+enter'], run: () => (app.services.threads.teamMode ? submitReviewDialog(app) : sendDialog(app)) },
    { id: 'github.refresh', title: 'Refresh GitHub comments', group: 'GitHub', when: () => onGitHub(app), run: () => app.services.github.refresh() },
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
  if (!sc.checkVisibility()) ensurePanel(app, 'narrative'); // on a phone, from another tab: hidden, it measures nothing
  const top = sc.getBoundingClientRect().top + 60;
  const idx = secs.findIndex((s) => s.getBoundingClientRect().top > top + 2);
  const cur = idx < 0 ? secs.length : idx;
  const target = dir > 0 ? secs[cur] : secs[Math.max(0, cur - 2)];
  if (target) app.bus.emit('reveal-doc', { id: target.id });
}

/** A review of a GitHub PR (reachable or not): what offers its GitHub controls. */
function onGitHub(app: ReviewApp) {
  const g = app.github;
  return !!g && !(!g.ok && !g.threads?.length && /not a GitHub/.test(g.error ?? ''));
}

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
    // a round ink icon button, its count a badge on the corner (phone.css)
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

// Auto-boot when loaded on a page with <rr-app> (opt out with <rr-app manual>).
if (typeof document !== 'undefined') {
  const go = () => {
    const root = document.querySelector('rr-app');
    if (root && !root.hasAttribute('manual')) boot(root as HTMLElement).catch((e) => console.error('[reviewroom]', e));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
}
