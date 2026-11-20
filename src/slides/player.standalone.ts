import { backdropCloses, h, icon } from '../kernel/dom';
import { sanitizeProse } from '../kernel/markdown';
import { REF_ELEMENTS } from '../kernel/refs/browser';
import { parseRef } from '../kernel/refs/refs.shared';
import { loadJSON, saveLocal } from '../kernel/store';
import type { WalkthroughBundle } from './bundle.shared';
import { current } from './model.shared';
import type { PlayerFormFactory, PlayerParts } from './player';
import { desktopNavigation } from './player.desktop';

type DeckPage =
  | { kind: 'cover' | 'end'; hash: string }
  | { kind: 'divider'; hash: string; chapter: number }
  | { kind: 'step'; hash: string; chapter: number; step: number };

const skipDividersKey = 'reviewroom:export:skip-dividers';
const number = (index: number) => String(index + 1).padStart(2, '0');
const intro = (html: string) => h('div', { class: 'rr-export-intro rr-prose', html: sanitizeProse(html) });

export const standalonePlayer = (bundle: WalkthroughBundle): PlayerFormFactory => (parts) => {
  const desktop = desktopNavigation(parts);
  const { app, actor, root, player, reset, bottom } = parts;
  const { source, walkthrough: { chapters, title } } = bundle;
  const pages: DeckPage[] = [
    { kind: 'cover', hash: '#cover' },
    ...chapters.flatMap<DeckPage>((chapter, ci) => [
      // These ids are valid chapters too. A trailing slash distinguishes their dividers.
      { kind: 'divider', hash: '#' + chapter.id + (/^(cover|end)$/.test(chapter.id) ? '/' : ''), chapter: ci },
      ...chapter.steps.map((step, si) => ({ kind: 'step' as const, hash: `#${chapter.id}/${step.id}`, chapter: ci, step: si })),
    ]),
    { kind: 'end', hash: '#end' },
  ];
  const indexByHash = new Map(pages.map((page, i) => [page.hash, i]));
  let index = -1;
  let ready = false;
  let skipDividers = loadJSON(skipDividersKey) === true;
  const skip = h('button', {
    class: 'rr-icon-btn rr-icon-btn--label', title: "Skip each chapter's intro page", 'aria-label': 'Skip chapter intro',
    'aria-pressed': String(skipDividers), onclick: () => {
      skipDividers = !skipDividers;
      skip.setAttribute('aria-pressed', String(skipDividers));
      saveLocal(skipDividersKey, skipDividers);
      if (pages[index]?.kind === 'divider') go(index);
    },
  }, 'Skip chapter intro');
  const move = (direction: -1 | 1) => {
    const adjacent = index + direction;
    go(skipDividers && pages[adjacent]?.kind === 'divider' ? adjacent + direction : adjacent);
  };
  const prev = h('button', { class: 'rr-btn rr-export-prev', title: 'Previous page', 'data-keys': '←', onclick: () => move(-1) }, icon('chevron', 14), 'Prev');
  const next = h('button', { class: 'rr-btn rr-btn--primary', title: 'Next page', 'data-keys': '→', onclick: () => move(1) }, 'Next', icon('chevron', 14));
  const status = h('span', { class: 'rr-export-position', role: 'status' });
  const groups = chapters.map((chapter, ci) => {
    const ticks = chapter.steps.map((step, si) => {
      const label = `${chapter.title} · Slide ${si + 1}`;
      const at = indexByHash.get(`#${chapter.id}/${step.id}`)!;
      return { at, button: h('button', { class: 'rr-export-tick', title: label, 'aria-label': label, 'data-chapter': chapter.id, 'data-step': step.id, onclick: () => go(at) }) };
    });
    const group = h('div', { class: 'rr-export-segment' },
      h('span', { class: 'rr-export-segment-name', title: chapter.title }, `${number(ci)} ${chapter.title}`),
      h('div', { class: 'rr-export-ticks' }, ticks.map(({ button }) => button)),
    );
    group.style.flexGrow = String(chapter.steps.length);
    return { group, ticks };
  });
  const progress = h('nav', { class: 'rr-export-progress', 'aria-label': 'Walkthrough progress' }, groups.map(({ group }) => group));
  const footer = h('footer', { class: 'rr-export-footer' }, prev, progress, status, next);
  const solo = h('section', { class: 'rr-export-solo', 'aria-labelledby': 'rr-export-title' });
  const body = h('main', { class: 'rr-export-body' }, player, solo);
  const card = h('div', { class: 'rr-export-card' }, toolbar(parts, source, skip), body, footer);
  root.classList.add('rr-export-stage');
  player.removeAttribute('role');
  player.removeAttribute('aria-modal');
  bottom.remove();
  root.prepend(card);

  const chapterList = () => h('nav', { class: 'rr-export-chapters', 'aria-label': 'Chapters' },
    h('h2', null, 'Chapters'),
    h('ol', null, chapters.map((chapter, ci) => {
      const at = pages.findIndex((page) => page.kind === 'divider' && page.chapter === ci);
      return h('li', null, h('button', { onclick: () => go(at) },
        h('span', { class: 'rr-export-number' }, number(ci)), h('span', null, chapter.title), icon('chevron', 14),
      ));
    })),
  );
  const heading = (text: string) => h('h1', { id: 'rr-export-title', tabindex: '-1', 'data-size': text.length >= 85 ? 'small' : text.length >= 55 ? 'medium' : undefined }, text);
  const revision = (label: string | undefined, sha: string) => h('span', null, label && label !== sha ? label + ' ' : '', h('code', null, sha.slice(0, 7)));
  const cover = () => [
    h('div', { class: 'rr-export-story' },
      heading(title),
      source.author && h('p', { class: 'rr-export-author' }, source.author),
      h('p', { class: 'rr-export-revisions' }, revision(source.baseLabel, source.base), ' → ', revision(source.headLabel, source.head)),
      h('p', { class: 'rr-export-cue' }, 'Press ', h('kbd', null, '→'), ' to begin'),
      chapters[0].lead && intro(chapters[0].lead),
    ),
    chapterList(),
  ];
  const risks = chapters.find((chapter) => chapter.id === 'risks');
  const riskNotes = () => risks?.steps.map((step) => {
    const note = intro(step.text);
    const text = note.querySelector('p')?.firstChild;
    if (text instanceof Text) {
      const severity = /^(High|Medium):/i.exec(text.data)?.[0];
      if (severity) {
        text.splitText(severity.length);
        text.replaceWith(h('strong', { class: severity.toLowerCase() === 'high:' ? 'rr-export-risk-high' : 'rr-export-risk-medium' }, severity));
      }
    }
    return note;
  });
  const divider = (ci: number) => [h('div', { class: 'rr-export-story' },
    h('p', { class: 'rr-export-chapter-number' }, number(ci)),
    heading(chapters[ci].title),
  )];
  const replay = h('button', { class: 'rr-btn rr-btn--primary', onclick: () => go(0) }, icon('round', 14), 'Replay');
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(source.exportedAt));
  const end = () => [
    h('div', { class: 'rr-export-story' },
      heading('End of walkthrough'),
      risks && h('section', { class: 'rr-export-recap' }, h('h2', null, risks.title), riskNotes()),
      h('div', null, replay),
      h('p', { class: 'rr-export-cue' }, `Exported from reviewroom · ${source.head.slice(0, 7)} · ${date}`),
    ),
    chapterList(),
  ];

  function show(at: number) {
    if (index === at) return;
    const focused = document.activeElement;
    index = at;
    const page = pages[at];
    root.dataset.page = page.kind;
    const isStep = page.kind === 'step';
    solo.hidden = isStep;
    player.hidden = !isStep;
    if (isStep) solo.replaceChildren();
    else {
      solo.replaceChildren(...(page.kind === 'cover' ? cover() : page.kind === 'divider' ? divider(page.chapter) : end()));
      solo.scrollTop = 0;
    }
    prev.disabled = at === 0;
    next.disabled = at === pages.length - 1;
    if (page.kind === 'step') status.textContent = `Slide ${page.step + 1} of ${chapters[page.chapter].steps.length}`;
    else status.textContent = page.kind === 'divider' ? `Chapter ${page.chapter + 1} of ${chapters.length}` : page.kind === 'cover' ? 'Cover' : 'End';
    for (const [chapter, { group, ticks }] of groups.entries()) {
      group.toggleAttribute('data-current', 'chapter' in page && page.chapter === chapter);
      for (const tick of ticks) {
        tick.button.classList.toggle('is-done', tick.at < at);
        if (tick.at === at) tick.button.setAttribute('aria-current', 'step');
        else tick.button.removeAttribute('aria-current');
      }
    }
    if (location.hash !== page.hash) history.replaceState(history.state, '', page.hash);
    if (focused && (!focused.isConnected || (focused === prev && prev.disabled) || (focused === next && next.disabled) || (!isStep && (focused === reset || player.contains(focused))))) {
      (isStep ? player : solo.querySelector<HTMLElement>('h1'))?.focus({ preventScroll: true });
    }
    card.classList.remove('is-in');
    void card.offsetWidth;
    card.classList.add('is-in');
  }

  function go(requested: number) {
    const at = skipDividers && pages[requested]?.kind === 'divider' ? requested + 1 : requested;
    const page = pages[at];
    if (!ready || !page) return;
    if (index === at) {
      if (location.hash !== page.hash) history.replaceState(history.state, '', page.hash);
      return;
    }
    if (page.kind === 'step') actor.send({ type: 'open', chapter: chapters[page.chapter].id, step: chapters[page.chapter].steps[page.step].id });
    else {
      show(at);
      actor.send({ type: 'close' });
    }
  }

  // The cover and recap can carry code links. Open the source chapter's first step before following one.
  solo.addEventListener('click', (e) => {
    const link = (e.target instanceof Element ? e.target : null)?.closest(REF_ELEMENTS);
    const href = link?.getAttribute('href') ?? link?.getAttribute('ref');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    const ref = parseRef(href);
    if (ref?.type === 'code' || ref?.type === 'file') {
      const page = pages[index];
      const ci = page.kind === 'end' ? chapters.findIndex((chapter) => chapter === risks) : 0;
      const chapter = chapters[ci];
      if (chapter) go(indexByHash.get(`#${chapter.id}/${chapter.steps[0].id}`)!);
    }
    void app.open(href);
  }, true);

  const followHash = () => go(indexByHash.get(location.hash) ?? 0);
  const sub = actor.subscribe((snapshot) => {
    if (snapshot.matches('open')) {
      const { chapter, step } = current(snapshot.context);
      show(indexByHash.get(`#${chapter.id}/${step.id}`)!);
    }
    if (!ready && snapshot.context.doc) {
      ready = true;
      followHash();
    }
  });
  app.onDispose(() => sub.unsubscribe());
  app.listen(window, 'hashchange', followHash);

  return { ...desktop, dismissible: false, move };
};

function toolbar({ app, reset }: PlayerParts, source: WalkthroughBundle['source'], skip: HTMLButtonElement) {
  reset.prepend(icon('undo'));
  const showHelp = () => { if (!help.open) help.showModal(); };
  const helpButton = h('button', { class: 'rr-icon-btn', title: 'Keyboard shortcuts', 'aria-label': 'Keyboard shortcuts', 'data-keys': '?', onclick: showHelp }, '?');
  const shortcuts = [['←', 'Previous page'], ['→', 'Next page'], ['?', 'Keyboard shortcuts']];
  if (document.fullscreenEnabled) shortcuts.push(['F', 'Toggle full screen']);
  shortcuts.push(['Esc', 'Close shortcuts']);
  const help = h('dialog', { class: 'rr-export-help', 'aria-labelledby': 'rr-export-help-title', onmousedown: backdropCloses },
    h('header', null,
      h('h2', { id: 'rr-export-help-title' }, 'Keyboard shortcuts'),
      h('button', { class: 'rr-icon-btn', title: 'Close shortcuts', 'aria-label': 'Close shortcuts', autofocus: true, onclick: () => help.close() }, icon('close')),
    ),
    h('dl', null, shortcuts.map(([key, label]) => h('div', null, h('dt', null, h('kbd', null, key)), h('dd', null, label)))),
    h('p', null, 'Use ', h('strong', null, 'Skip chapter intro'), ' in the toolbar to move directly between slides.'),
  );

  const theme = h('button', { class: 'rr-icon-btn', onclick() {
    const themes = ['system', 'light', 'dark'] as const;
    app.setPref('theme', themes[(themes.indexOf(app.prefs.theme) + 1) % themes.length]);
  } });
  const paintTheme = () => {
    const currentTheme = app.prefs.theme;
    const nextTheme = currentTheme === 'system' ? 'light' : currentTheme === 'light' ? 'dark' : 'system';
    theme.title = `Theme: ${currentTheme}. Switch to ${nextTheme}.`;
    theme.setAttribute('aria-label', theme.title);
    theme.replaceChildren(icon(currentTheme === 'system' ? 'theme' : currentTheme === 'light' ? 'sun' : 'moon'));
  };
  paintTheme();
  app.onDispose(app.bus.on('theme', paintTheme));

  const toggleFullscreen = async () => {
    if (!document.fullscreenEnabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      app.toast('This browser could not enter or leave full screen.');
    }
  };
  const fullscreen = h('button', { class: 'rr-icon-btn', title: 'Toggle full screen', 'aria-label': 'Full screen', 'aria-pressed': 'false', 'data-keys': 'F', hidden: !document.fullscreenEnabled, onclick: () => void toggleFullscreen() }, icon('maximize'));
  app.listen(document, 'fullscreenchange', () => fullscreen.setAttribute('aria-pressed', String(!!document.fullscreenElement)));
  app.listen(window, 'keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || help.open || document.querySelector('[popover=auto]:popover-open')) return;
    if (e.key === '?') {
      e.preventDefault();
      showHelp();
    } else if (e.key.toLowerCase() === 'f' && document.fullscreenEnabled) {
      e.preventDefault();
      void toggleFullscreen();
    }
  });
  const context = [source.repo, source.pr && `PR #${source.pr}`].filter(Boolean).join(' · ');
  return h('header', { class: 'rr-export-toolbar' },
    h('div', { class: 'rr-export-repo', title: context || undefined }, icon('book'), h('span', null, context || 'Walkthrough')),
    h('div', { class: 'rr-export-tools' }, reset, theme, skip, fullscreen, helpButton),
    help,
  );
}
