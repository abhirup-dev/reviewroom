// The guided walkthrough player on a phone (either way up, under either shell): it restyles the shared skeleton
// (player.ts) into a full-screen player and wires the card, the gestures, the chrome and full screen.
import { createActor, fromPromise, type Actor, type SnapshotFrom } from 'xstate';
import { h, icon, plural } from '../kernel/dom';
import { onBack, watchBack } from '../kernel/history';
import { sanitizeProse } from '../kernel/markdown';
import { openSheet, sheetDialog } from '../kernel/sheet';
import { gestureMachine } from '../kernel/gesture.machine';
import type { ReviewApp } from '../app';
import type { CodeAt, paneMachine, Slot, walkthroughMachine } from './player.machine';
import { cardMachine, chromeMachine, type Detent } from './phone.machine';
import { navMachine } from './nav.machine';
import { current, target } from './model.shared';

/** The skeleton's parts the phone player rearranges and listens on. */
type PhoneParts = {
  app: ReviewApp;
  actor: Actor<typeof walkthroughMachine>;
  root: HTMLElement;
  player: HTMLElement;
  split: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
  pane: HTMLElement;
  /** where a link lands (player.ts's codeAt) */
  codeAt: (ref: string) => Promise<CodeAt | null>;
  bottom: HTMLElement;
  progress: HTMLElement;
  lead: HTMLElement;
  leadToggle: HTMLElement;
  prev: HTMLElement;
  next: HTMLElement;
  comment: HTMLElement;
  chapterBtn: HTMLElement;
};

/** How far sideways a swipe on the card goes to turn the slide. */
const SWIPE_PX = 60;

/** A phone plays full screen (slides.phone.css): the code under the whole screen, a slide card (a bottom sheet) and a
 *  floating toolbar of Back, Contents, Comment and Next over it, the walkthrough's progress a thin row at the foot. IDLE_MS
 *  untouched the chrome fades, and only Show controls in the card's corner brings it back (chromeMachine); the card
 *  drags between two lines, its text and tall (cardMachine); it swipes sideways to the next or previous slide
 *  (gestureMachine). Back (the phone's) closes the player. On its side (data-orient) the slide is a column
 *  beside the code, not a sheet over it. */
export function phonePlayer({ app, actor, root, player, split, left, right, pane, codeAt, bottom, progress, lead, leadToggle, prev, next, comment, chapterBtn }: PhoneParts) {
  const ctx = () => actor.getSnapshot().context;
  root.dataset.form = 'phone';
  if (app.presentation.kind !== 'phone') watchBack(app); // a turned phone has the dock: no phone shell to hear Back
  // the floating toolbar: Back, Contents, Comment and Next, plain icon buttons on one pill
  prev.replaceChildren(icon('chevron', 20));
  prev.className = 'rr-icon-btn rr-tour__back';
  next.replaceChildren(icon('chevron', 20));
  next.className = 'rr-icon-btn rr-tour__fwd';
  comment.replaceChildren(icon('chat', 20));
  comment.className = 'rr-tour__comment';
  comment.setAttribute('aria-label', 'Comment on this slide');
  const contents = h('button', { class: 'rr-tour__contents', title: 'Chapters and slides', 'aria-label': 'Chapters and slides', 'aria-haspopup': 'dialog', onclick: () => contentsSheet() }, icon('toc', 20));
  next.before(h('div', { class: 'rr-tour__pair', role: 'group', 'aria-label': 'Contents and comment' }, contents, comment));
  chapterBtn.title = 'Chapters and slides';
  chapterBtn.setAttribute('aria-haspopup', 'dialog');
  // no intro toggle: the intro opens the chapter's first slide, and on the others is folded to its first line with More
  // (unfolded for that slide only)
  leadToggle.remove();
  let leadOpen = true;
  const more = h('button', { class: 'rr-link-btn rr-tour__more', hidden: true, title: 'Show the whole chapter intro', onclick: () => ((leadOpen = true), paintLead()) }, 'More');
  lead.after(more);
  const paintLead = () => {
    const fold = ctx().step > 0 && !leadOpen;
    lead.classList.toggle('is-folded', fold);
    more.hidden = !current(ctx()).chapter.lead || !fold;
  };
  // Contents: a bottom sheet of the chapters, the current one open on its slides. A <dialog>, so the chrome holds
  // while it's open and Back closes it (PhoneShell's watchDialogs; under the dock, its own entry); kept, so it can slide
  // away (slides.phone.css)
  const sheet = sheetDialog({ class: 'rr-tour-toc', 'aria-label': 'Chapters and slides', tabindex: '-1' });
  const jump = (chapter: number, step: number) => (sheet.close(), actor.send({ type: 'goto', chapter, step }));
  const gist = (html: string) => Object.assign(h('div'), { innerHTML: sanitizeProse(html) }).textContent.trim();
  const contentsSheet = () => {
    const { doc, chapter: at, step: on } = ctx();
    const chapters = doc!.chapters.map((c, ci) =>
      h(
        'section',
        { class: 'rr-tour-toc__chapter' + (ci === at ? ' is-on' : '') },
        h('button', { class: 'rr-tour-toc__head', title: `Go to ${c.title}`, 'aria-current': ci === at ? 'true' : undefined, onclick: () => jump(ci, 0) }, h('span', { class: 'rr-tour-toc__num' }, String(ci + 1)), h('span', null, c.title), h('small', null, plural(c.steps.length, 'slide'))),
        ci === at
          ? h('ol', { class: 'rr-tour-toc__slides' }, ...c.steps.map((s, si) => h('li', null, h('button', { class: 'rr-tour-toc__slide', title: `Go to slide ${si + 1}`, 'aria-current': si === on ? 'step' : undefined, onclick: () => jump(ci, si) }, h('span', { class: 'rr-tour-toc__num' }, String(si + 1)), h('span', null, gist(s.text))))))
          : null,
      ),
    );
    // under the dock no PhoneShell gives the sheet a history entry: without one, Back would close the player under it
    if (!sheet.open && app.presentation.kind !== 'phone') sheet.addEventListener('close', onBack(() => sheet.close()), { once: true });
    openSheet(sheet, h('h2', { class: 'rr-tour-toc__title' }, 'Contents'), h('nav', { class: 'rr-tour-toc__list' }, ...chapters));
    sheet.focus(); // the sheet, not its first chapter: no ring on open
    sheet.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
  };
  player.append(progress); // always on screen, over the code, even immersive
  // the viewport, not the screen: `?phone` in a window follows its shape
  const land = matchMedia('(orientation: landscape)');
  // the card: a bottom sheet with three detents, kept across slides (cardMachine); this measures and renders
  const DETENTS = ['collapsed', 'default', 'tall'] as const;
  const card = createActor(cardMachine).start();
  const detent = () => card.getSnapshot().context.detent;
  /** The card's height at detent d (its CSS max-height and its content decide). */
  const heightAt = (d: number) => {
    const css = left.style.cssText;
    left.style.cssText = '';
    left.dataset.detent = DETENTS[d];
    const px = left.offsetHeight;
    left.dataset.detent = DETENTS[detent()];
    left.style.cssText = css;
    return px;
  };
  const heights = () => [heightAt(0), heightAt(1), heightAt(2)] as [number, number, number];
  const size = (d: Detent) => card.send({ type: 'size', detent: d, height: left.offsetHeight, heights: heights() });
  const grip = h('button', { class: 'rr-tour__grip', onclick: () => size(detent() ? 0 : 1) });
  const paintCard = (s: SnapshotFrom<typeof cardMachine>) => {
    const d = s.context.detent;
    left.dataset.detent = DETENTS[d];
    grip.title = d ? 'Collapse the slide to two lines (or drag)' : 'Show the whole slide (or drag up)';
    grip.setAttribute('aria-label', grip.title);
    grip.setAttribute('aria-expanded', String(d > 0));
    left.classList.remove('is-settling');
    if (s.matches('rest')) return void (left.style.cssText = '');
    if (s.matches('dragging')) return void (left.style.cssText = `height:${s.context.height}px;max-height:none`);
    // settling: glide from where it was to the detent's height
    if (!d) left.scrollTo({ top: 0 });
    left.style.cssText = `height:${s.context.from}px;max-height:none`;
    void left.offsetHeight;
    left.classList.add('is-settling');
    left.style.height = `${s.context.heights[d]}px`;
  };
  paintCard(card.getSnapshot());
  card.subscribe(paintCard);
  left.addEventListener('click', (e) => !detent() && !(e.target as Element).closest('button, a') && size(1));
  lead.addEventListener('click', () => lead.classList.contains('is-folded') && more.click());
  left.prepend(grip);
  // touches on the card (gestureMachine): sideways changes the slide; up and down size the sheet when the card
  // claims that way (cardMachine's draggable), else the text scrolls
  const touch = createActor(gestureMachine).start();
  const pt = (e: TouchEvent) => ({ x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY });
  const claims = (e: TouchEvent, up: boolean) => !land.matches && card.getSnapshot().can({ type: 'grab', up, grip: e.target === grip, scrollTop: left.scrollTop, height: 0, heights: [0, 0, 0] });
  const cancel = () => (touch.send({ type: 'cancel' }), card.send({ type: 'cancel' }));
  // a zoomed-in diagram (Pele sets touch-action: none on it) pans under the finger: not a swipe or a card drag
  const pans = (e: TouchEvent) => (e.target as Element).closest<SVGElement>('svg.pele')?.style.touchAction === 'none';
  left.addEventListener('touchstart', (e) => (e.touches.length === 1 && !pans(e) ? touch.send({ type: 'start', ...pt(e), up: claims(e, true), down: claims(e, false) }) : cancel()), { passive: true });
  left.addEventListener('touchmove', (e) => {
    const was = touch.getSnapshot();
    touch.send({ type: 'move', ...pt(e) });
    const g = touch.getSnapshot();
    // a swipe up opens everything: the folded chapter intro too (before the heights are measured), not a second tap on More
    if (was.matches('pending') && g.context.dy < 0 && (g.matches('vertical') || g.matches('scroll')) && !more.hidden) more.click();
    if (!g.matches('vertical')) return;
    if (!was.matches('vertical')) card.send({ type: 'grab', up: g.context.dy < 0, grip: e.target === grip, scrollTop: left.scrollTop, height: left.offsetHeight, heights: heights() });
    e.preventDefault();
    card.send({ type: 'drag', dy: g.context.dy });
  }, { passive: false });
  left.addEventListener('touchcancel', cancel);
  left.addEventListener('touchend', (e) => {
    touch.send({ type: 'end', ...pt(e) });
    const g = touch.getSnapshot();
    if (g.matches('vertical')) card.send({ type: 'release', dy: g.context.dy });
    else if (g.matches('horizontal') && !getSelection()?.toString() && Math.abs(g.context.dx) > SWIPE_PX) (g.context.dx < 0 ? next : prev).click();
  });
  // scrolling the code brings a tall card back to its default, so the code it covered shows
  right.addEventListener('touchmove', () => !land.matches && detent() === 2 && card.getSnapshot().matches('rest') && size(1), { passive: true });
  // the code pane shows one chunk at a time (slides.phone.css stacks them, the others hidden but laid out, so their
  // lines are already in place); the file tab on the card's top edge picks which. Every jump to code (the tab, a link,
  // a symbol, a chunk's name) goes through navMachine, which waits out a pane mid-change and picks the chunk
  let slots: Slot[] | null = null, active = 0;
  const files = h('div', { class: 'rr-tour__files', role: 'group', 'aria-label': 'Files on this slide' });
  const filesSheet = sheetDialog({ class: 'rr-tour-toc', 'aria-label': 'Files on this slide', tabindex: '-1' });
  const nav = createActor(
    navMachine.provide({
      actors: { resolve: fromPromise(({ input }) => codeAt(input)) },
      actions: {
        select: ({ context: { landing } }) => {
          if (!landing || !('index' in landing)) return;
          const { index, code } = landing;
          active = index;
          paintFiles();
          const panel = chunks()[index]?.getAttribute('data-panel');
          if (code && panel) app.bus.emit('reveal-code', { ...code, panel });
        },
        focus: ({ context: { landing } }) => landing && 'focus' in landing && actor.send({ type: 'focus', refs: [landing.focus] }),
      },
    }),
  ).start();
  /** the chunks on screen (not the layer they replace, fading out over them) */
  const chunks = () => [...pane.querySelectorAll(':scope > .rr-tour__layer:not(.is-leaving) > .rr-tour__chunk')];
  const pick = (index: number) => (filesSheet.close(), nav.send({ type: 'go', jump: { index } }));
  const name = (s: Slot) => (s.code ? s.code.path.split('/').pop()! : app.label(s.ref));
  let away = false; // the pane shows a link's code, not the slide's own
  const paintFiles = () => {
    const ss = slots ?? [];
    chunks().forEach((c, i) => c.classList.toggle('is-active', i === active));
    files.hidden = !ss.length;
    const tab = (s: Slot, i: number) => h('button', { class: 'rr-tour__file', title: app.label(s.ref), 'aria-pressed': String(i === active), onclick: () => pick(i) }, name(s));
    files.replaceChildren(
      ...(ss.length <= 2
        ? ss.map(tab)
        : [h('button', { class: 'rr-tour__file', title: 'Files on this slide', 'aria-haspopup': 'dialog', 'aria-pressed': 'true', onclick: openFiles }, name(ss[active]), icon('chevronDown', 12), h('small', null, `+${ss.length - 1}`))]),
      ...(away ? [h('button', { class: 'rr-tour__file', title: 'Back to this slide\'s code', 'aria-label': 'Back to this slide\'s code', onclick: () => actor.send({ type: 'focus' }) }, icon('undo', 14))] : []),
    );
  };
  const openFiles = () => {
    if (!filesSheet.open && app.presentation.kind !== 'phone') filesSheet.addEventListener('close', onBack(() => filesSheet.close()), { once: true });
    const list = (slots ?? []).map((s, i) => h('button', { class: 'rr-tour-toc__slide', 'aria-current': i === active ? 'step' : undefined, onclick: () => pick(i) }, h('span', { class: 'rr-tour-toc__num' }, String(i + 1)), h('span', null, app.label(s.ref))));
    openSheet(filesSheet, h('h2', { class: 'rr-tour-toc__title' }, 'Files'), h('nav', { class: 'rr-tour-toc__list' }, ...list));
    filesSheet.focus();
  };
  // the pane's chunks, once on screen (landing or showing: mounted); mid-change (resolving, fading) navMachine waits
  let paneRef: unknown, paneOff: (() => void) | undefined;
  const watchPane = (p: Actor<typeof paneMachine> | undefined) => {
    if (p === paneRef) return;
    paneOff?.();
    paneRef = p;
    if (!p) {
      slots = null; // closed
      nav.send({ type: 'pane', slots: null });
    }
    const sub = p?.subscribe((ps) => {
      const shown = ps.matches('landing') || ps.matches('showing') ? ps.context.shown : null;
      const now = shown?.kind === 'refs' ? shown.slots : shown ? [] : null;
      if (now && now !== slots) {
        active = 0; // a new slide (or a link's code): its first chunk
        away = JSON.stringify(ps.context.want) !== JSON.stringify(target(ctx()));
      }
      if (now) slots = now;
      paintFiles();
      nav.send({ type: 'pane', slots: now });
    });
    paneOff = sub && (() => sub.unsubscribe());
  };
  // the card's height, for the tab riding on its top edge
  const cardH = new ResizeObserver(() => player.style.setProperty('--rr-card-h', `${left.offsetHeight}px`));
  cardH.observe(left);
  // immersive (chromeMachine): IDLE_MS after the last touch or slide change, never while a menu, the composer or a
  // selection is open, the top bar and the toolbar fade; Show controls, in the card's corner, brings them back
  const held = () => !!(getSelection()?.toString() || app.selection || document.querySelector('dialog[open], [popover=auto]:popover-open'));
  const chrome = createActor(chromeMachine.provide({ guards: { held } })).start();
  const immersive = () => chrome.getSnapshot().matches('immersive');
  chrome.subscribe(() => player.classList.toggle('is-immersive', immersive()));
  const wake = () => chrome.send({ type: 'wake' });
  const restore = h('button', { class: 'rr-icon-btn rr-tour__restore', title: 'Show controls', 'aria-label': 'Show controls', onclick: wake }, icon('dots', 20)); // immersive only (slides.phone.css)
  // upright: Show controls in the card's corner, the toolbar at the screen's foot; on its side: Show controls top
  // right, the toolbar at the foot of the code
  const orient = () => {
    root.dataset.orient = land.matches ? 'landscape' : 'portrait';
    (land.matches ? player : left).append(restore);
    (land.matches ? split : player).append(bottom);
    if (land.matches) left.prepend(files);
    else left.before(files);
  };
  orient();
  land.addEventListener('change', orient); // ?phone in a window turned; a phone reloads into the other shell anyway
  app.onDispose(() => land.removeEventListener('change', orient));
  // touching anything while the chrome shows keeps it up; once immersive, only Show controls brings it back
  player.addEventListener('touchstart', () => chrome.send({ type: 'touch' }), { passive: true, capture: true });
  player.addEventListener('click', () => chrome.send({ type: 'touch' }), true);
  // full screen while it plays (Fullscreen API): no status or navigation bar, and the code under a cutout too. It
  // needs a tap, so the opening tap and every later one ask; once the reviewer leaves it (Back), only a reopen asks
  let declined = false;
  const installedFullscreen = matchMedia('(display-mode: fullscreen)').matches; // the installed app already is (manifest): asking again only shows Chrome's notice
  const fullscreen = () => {
    if (declined || installedFullscreen || !document.fullscreenEnabled || document.fullscreenElement || !actor.getSnapshot().matches({ open: 'playing' })) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); // no tap to go on: the next one asks
  };
  player.addEventListener('pointerup', fullscreen, true);
  app.listen(document, 'fullscreenchange', () => {
    if (!document.fullscreenElement && actor.getSnapshot().matches({ open: 'playing' })) declined = true;
  });
  // a slide change: the card glides from its old height to the new slide's (player.ts paints it after this listener)
  const glide = (from: number) =>
    queueMicrotask(() => {
      const to = left.offsetHeight;
      if (land.matches || Math.abs(to - from) < 2 || !card.getSnapshot().matches('rest')) return;
      left.style.cssText = `height:${from}px;max-height:none`;
      void left.offsetHeight;
      left.classList.add('is-settling');
      left.style.height = `${to}px`;
      const end = (e: TransitionEvent) => {
        if (e.target !== left || e.propertyName !== 'height') return;
        left.removeEventListener('transitionend', end);
        if (!card.getSnapshot().matches('rest')) return; // grabbed meanwhile: the card's own paint has it
        left.classList.remove('is-settling');
        left.style.cssText = '';
      };
      left.addEventListener('transitionend', end);
    });
  let drop: (() => void) | undefined;
  let was = '', wasPlaying = false;
  actor.subscribe((s) => {
    // a new slide: the card from its top, so a swipe down collapses it rather than scrolling
    const playing = s.matches({ open: 'playing' });
    const slide = `${s.context.chapter}/${s.context.step}`;
    watchPane(s.children.pane as Actor<typeof paneMachine> | undefined);
    if (slide === was && playing === wasPlaying) return; // not every snapshot is a move: a code panel landing must not wake the chrome
    if (slide !== was) {
      left.scrollTo({ top: 0 });
      nav.send({ type: 'cancel' });
      if (was && playing) glide(left.offsetHeight);
    }
    [was, wasPlaying] = [slide, playing];
    if (playing && !drop) drop = onBack(() => ((drop = undefined), actor.send({ type: 'close' })));
    else if (!playing && drop) {
      drop();
      drop = undefined;
    }
    if (playing) fullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (!playing) declined = false;
    chrome.send({ type: !playing ? 'stop' : chrome.getSnapshot().matches('off') ? 'wake' : 'touch' }); // a slide change keeps immersive
  });
  app.onDispose(() => (card.stop(), touch.stop(), chrome.stop(), nav.stop(), paneOff?.(), cardH.disconnect(), sheet.remove(), filesSheet.remove()));
  return {
    contents: contentsSheet,
    // each slide folds the intro again (but the chapter's first), unless the card is tall
    foldLead: () => ((leadOpen = left.dataset.detent === 'tall'), paintLead()),
    // upright, the card is over the code's lower part
    cardBelow: () => !land.matches,
    focus: (ref: string) => nav.send({ type: 'go', jump: { ref } }),
    // the last slide's Next is off: the top bar's close ends the walkthrough
    paintNav: ({ isFirst, isLast }: ReturnType<typeof current>) => {
      next.toggleAttribute('disabled', isLast);
      next.title = isLast ? 'Last slide' : 'Next slide';
      prev.title = isFirst ? 'First slide' : 'Previous slide';
      next.setAttribute('aria-label', next.title);
      prev.setAttribute('aria-label', prev.title);
    },
  };
}
