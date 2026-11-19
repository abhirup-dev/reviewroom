import { ReviewApp } from './app-core';
import { presentationFor } from './kernel/presentation';
import { formatRef, parseRef, type Ref } from './kernel/refs/refs.shared';
import { mountTooltips } from './kernel/tooltip';
import { createCodeService } from './review/code-service';
import { defineElements, provideApp } from './review/elements';
import { StaticProvider } from './review/providers/static';
import { WalkthroughBundle } from './slides/bundle.shared';
import { deepLink } from './slides/model.shared';
import { mountWalkthrough } from './slides/player';
import type { CodeAt } from './slides/player.machine';
import { standalonePlayer } from './slides/player.standalone';

const readPosition = () => deepLink('?walkthrough=' + location.hash.slice(1)) ?? {};

async function boot(root: HTMLElement, bundle: WalkthroughBundle) {
  const { source, files, contents, walkthrough } = bundle;
  const key = `reviewroom:export:${source.base}:${source.head}:${source.exportedAt}`;
  const presentation = { ...presentationFor('desktop'), canArrange: false, prefs: { key, defaults: { inlineThreads: false } } };
  const app = new ReviewApp(root, ({ code }) => ({ code: createCodeService(code) }), presentation);
  const { repo, title, author, pr, base, head, baseLabel, headLabel } = source;
  app.meta = { id: key, repo, title, author, number: pr, base, head, baseLabel, headLabel };
  app.provider = new StaticProvider({ meta: app.meta, files, contents });
  app.backend = {
    kind: 'browser',
    load: async () => null,
    apply() {},
    layouts: { get: async () => { throw new Error('No layouts in a walkthrough export'); }, put: async () => false },
    walkthrough: async () => walkthrough,
  };
  await app.setRange({ base, head, label: 'All changes', key: 'all' });
  app.applyTheme();
  const theme = matchMedia('(prefers-color-scheme: dark)');
  app.onDispose(() => theme.removeEventListener('change', themeChanged));
  theme.addEventListener('change', themeChanged);
  function themeChanged() {
    if (app.prefs.theme === 'system') app.applyTheme();
  }
  const renames = new Map(files.flatMap((file) => file.prevPath ? [[file.prevPath, file.path] as const] : []));
  const resolve = (ref: Ref | null): CodeAt | null => {
    if (ref?.type !== 'code' && ref?.type !== 'file') return null;
    const side = ref.rev === base ? 'base' : 'head';
    const knownSide = ref.rev === base || ref.rev === head;
    const path = ref.type === 'file' && side === 'base' ? renames.get(ref.path) ?? ref.path : ref.path;
    const view = ref.type === 'code' && knownSide ? 'diff' : 'file';
    return { path, side, start: ref.start, end: ref.end, view, rev: knownSide ? undefined : ref.rev };
  };
  const isSlide = (r: Ref | null): r is Extract<Ref, { type: 'tour' }> =>
    r?.type === 'tour' && walkthrough.chapters.some((c) => c.id === r.chapter && c.steps.some((s) => s.id === r.step));
  const open = async (ref: string | Ref) => {
    const r = typeof ref === 'string' ? parseRef(ref) : ref;
    if (isSlide(r)) tour.actor.send({ type: 'open', chapter: r.chapter, step: r.step });
    else if (r && resolve(r)) tour.actor.send({ type: 'focus', refs: [typeof ref === 'string' ? ref : formatRef(r)] });
  };
  app.open = open; // rr-code's own open control follows the same in-player routing as narration links
  provideApp(app, (href) => { const r = parseRef(href); return isSlide(r) || !!resolve(r); });
  defineElements();
  mountTooltips(app);
  const tour = mountWalkthrough(app, {
    formFactory: standalonePlayer,
    resolveCode: async (ref) => resolve(parseRef(ref)),
    codeOptions: { readOnly: true },
    openLink: (ref) => void open(ref),
    splitKey: key + ':split',
    position: {
      read: readPosition,
      write(at) {
        if (!at) return;
        const hash = `#${at.chapter}/${at.step}`;
        if (location.hash !== hash) history.replaceState(null, '', hash);
      },
    },
  });
  app.listen(window, 'hashchange', () => tour.actor.send({ type: 'open', ...readPosition() }));
}

const root = document.querySelector<HTMLElement>('rr-app')!;
try {
  const bundle = WalkthroughBundle.parse(JSON.parse(document.querySelector('#rr-bundle')!.textContent));
  await boot(root, bundle);
} catch (error) {
  root.textContent = 'This walkthrough could not be opened.';
  console.error(error);
}
