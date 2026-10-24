// The guided walkthrough player: an overlay over the workbench (narration left, the step's code right), or a pill while
// paused. walkthroughMachine and its paneMachine child (src/slides/player.machine.ts) own every state and transition;
// this file renders snapshots and implements the pane's actions (resolve links, fade, mount, glide, unmount).
// A chunk is a code panel pinned to one file (the same CodeView setup as the dock); several stack, under one set of
// display toggles (split/unified, focus, whitespace, wrap, inline threads). Prose is the
// author's HTML, sanitized: a walkthrough can come from a PR.
import { createActor, fromPromise, waitFor, type SnapshotFrom } from 'xstate';
import { backdropCloses, h, icon, onDrag, plural } from '../kernel/dom';
import { onBack, watchBack } from '../kernel/history';
import { phonePlayer as phoneSized } from '../kernel/device';
import { proseRemoved, sanitizeProse } from '../kernel/markdown';
import { REF_ELEMENTS, refIcon } from '../kernel/refs/browser';
import { renderPreview, type PreviewOptions } from '../review/previews';
import { paneMachine, walkthroughMachine, type CodeAt, type PaneShown, type Slot } from './player.machine';
import { cardMachine, chromeMachine, type Detent } from './phone.machine';
import { gestureMachine } from '../kernel/gesture.machine';
import type { ReviewApp } from '../app';
import { menuItem, popMenu } from '../kernel/menus';
import { loadJSON, saveLocal } from '../kernel/store';
import { panelDefs, type PanelInstance } from '../kernel/dock';
import { displayTools } from '../review/code';
import { current, deepLink, target, decodeWalkthrough, edgeBetween, inFocus, stepRefs, type StepAudit, type Walkthrough } from './model.shared';
import { measure, settle } from './audit';
import { parseRef, type Ref } from '../kernel/refs/refs.shared';

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

let panes = 0;

/** Where a slide's link lands in the code pane; null for links that show no code. */
export async function codeAt(app: ReviewApp, ref: string): Promise<CodeAt | null> {
  const r = parseRef(ref);
  if (r?.type === 'code' || r?.type === 'file') {
    const rev = /^(base|head)$/.test(r.rev) ? undefined : r.rev;
    return { path: r.path, side: r.rev === 'base' ? 'base' : 'head', start: r.start, end: r.end, rev, view: r.type === 'file' ? 'file' : 'diff' };
  }
  if (r?.type !== 'sym') return null;
  const hits = await app.searchSymbol(r.name).catch(() => []); // definitions first, narrowed by an Owner. or path: qualifier
  const d = hits.find((x) => x.kind === 'definition') ?? hits[0];
  return d ? { path: d.path, side: 'head', start: d.line, end: d.line, view: app.files.some((f) => f.path === d.path) ? 'diff' : 'file' } : null;
}

export function mountWalkthrough(app: ReviewApp) {
  let disposed = false;
  const btn = (ic: Parameters<typeof icon>[0], title: string, onclick: () => void, keys?: string) =>
    h('button', { class: 'rr-icon-btn', title, 'aria-label': title, 'data-keys': keys, onclick }, icon(ic, 14));

  // ------------------------------------------------------------ the code pane (paneMachine's actions)
  const pane = h('div', { class: 'rr-tour__pane' });
  const split = h('div', { class: 'rr-tour__body' });
  // the display toggles, once for every chunk (prefs: each panel follows them); hidden when no code is shown
  const tools = h('div', { class: 'rr-toolbar rr-tour__tools', hidden: true });
  let toolsMode: 'diff' | 'file' = 'diff';
  const paintTools = () => tools.replaceChildren(h('div', { class: 'rr-toolbar__spacer' }), h('div', { class: 'rr-toolbar__group' }, ...displayTools(app, toolsMode)));
  app.bus.on('prefs', paintTools);
  /** per chunk on screen: its code panel (null: a preview) and its header (stacked only) */
  let views: { panel: PanelInstance | null; id: string; head: HTMLElement | null }[] = [];
  const dispose = () => {
    views.forEach((v) => v.panel?.dispose?.());
    views = [];
  };
  // a header names the chunk (in its code panel's toolbar); stacked, clicking it shows only that one
  const nameHead = (head: HTMLElement, ref: string) => {
    const r = parseRef(ref);
    head.replaceChildren(...(r ? [refIcon(r)] : []), h('span', null, app.label(ref)));
    if (head instanceof HTMLButtonElement) head.onclick = () => actor.send({ type: 'focus', refs: [ref] });
  };
  const chunk = (slot: Slot, many: boolean): HTMLElement => {
    const id = `code:tour-${++panes}`;
    const head = many ? h('button', { class: 'rr-tour__chunk-head', title: 'Show only this in the pane' }) : slot.code ? h('span', { class: 'rr-tour__chunk-head' }) : null;
    if (head) nameHead(head, slot.ref);
    const panel = slot.code ? panelDefs().find((d) => d.id === 'code')!.create(app, { ...slot.code, pin: slot.code.path, embedded: true, head }, id) : null;
    const body = panel?.element ?? h('div', { class: 'rr-tour__preview' });
    if (!panel) void renderPreview(app, slot.ref).then((el) => body.replaceChildren(el));
    views.push({ panel, id, head });
    return h('div', { class: 'rr-tour__chunk' + (many ? ' is-stacked' : '') }, panel ? null : head, body);
  };
  const mount = (s: PaneShown) => {
    dispose();
    const code = s.kind === 'refs' ? s.slots.flatMap((x) => (x.code ? [x.code] : [])) : [];
    tools.hidden = !code.length;
    toolsMode = code.some((c) => c.view === 'diff') ? 'diff' : 'file';
    paintTools();
    if (s.kind === 'refs') pane.replaceChildren(...s.slots.map((slot) => chunk(slot, s.slots.length > 1)));
    else pane.replaceChildren();
    // no code: the narration takes the whole player, centred
    split.classList.toggle('is-solo', s.kind === 'empty');
  };
  const pane$ = paneMachine.provide({
    actors: { resolve: fromPromise(async ({ input }) => (input.kind === 'refs' ? { kind: 'refs', slots: await Promise.all(input.refs.map(async (ref) => ({ ref, code: await codeAt(app, ref) }))) } : input)) },
    actions: {
      fadeOut: () => pane.classList.add('is-out'),
      fadeIn: () => pane.classList.remove('is-out'),
      mount: ({ context }) => mount(context.next!),
      // same files: each view's highlight moves to its new lines
      glide: ({ context }) =>
        context.next!.kind === 'refs' &&
        context.next!.slots.forEach((s, i) => {
          if (views[i]?.head) nameHead(views[i].head, s.ref);
          if (s.code) app.bus.emit('reveal-code', { ...s.code, panel: views[i].id });
        }),
      unmount: () => (dispose(), pane.replaceChildren(), (tools.hidden = true)),
    },
  });
  const actor = createActor(walkthroughMachine.provide({ actors: { pane: pane$ } })).start();
  const shownRefs = () => {
    const s = actor.getSnapshot().children.pane?.getSnapshot().context.shown;
    return s?.kind === 'refs' ? s.slots.map((x) => x.ref) : [];
  };

  // ------------------------------------------------------------ skeleton
  const chapterPrev = btn('chevron', 'Previous chapter', () => go(-1));
  const chapterNext = btn('chevron', 'Next chapter', () => go(1));
  chapterPrev.classList.add('rr-tour__flip');
  let contentsSheet: (() => void) | undefined; // a phone's chapters and slides (phonePlayer); the desktop's a menu
  const chapterBtn = h('button', { class: 'rr-tour__chapter', title: 'Jump to a chapter', 'aria-haspopup': 'menu', onclick: () => (contentsSheet ?? chapterMenu)() });
  const position = h('span', { class: 'rr-tour__pos' });
  const lead = h('div', { class: 'rr-tour__lead rr-prose' });
  const divider = h('div', { class: 'rr-tour__divider' });
  // a big lead (a whole-system diagram) can be folded away for the rest of the walkthrough, and back
  let leadOpen = true;
  const leadToggle = h('button', { class: 'rr-icon-btn rr-tour__lead-toggle', onclick: () => ((leadOpen = !leadOpen), paintLead()) }, icon('chevronDown', 14));
  // a phone has no such toggle: the intro opens the chapter's first slide, and on the others is folded to its first
  // line with More (unfolded for that slide only). The phone player goes by the device, either way up, under either shell
  const phone = phoneSized();
  const more = h('button', { class: 'rr-link-btn rr-tour__more', hidden: true, title: 'Show the whole chapter intro', onclick: () => ((leadOpen = true), paintLead()) }, 'More');
  const paintLead = () => {
    const has = !!current(ctx()).chapter.lead;
    const fold = phone && ctx().step > 0 && !leadOpen;
    lead.hidden = !has || (!phone && !leadOpen);
    lead.classList.toggle('is-folded', fold);
    more.hidden = !has || !fold;
    leadToggle.hidden = !has || phone;
    leadToggle.classList.toggle('is-closed', !leadOpen);
    leadToggle.title = leadOpen ? 'Hide the chapter intro' : 'Show the chapter intro';
    leadToggle.setAttribute('aria-label', leadToggle.title);
    leadToggle.setAttribute('aria-expanded', String(leadOpen));
  };
  // the diagram nodes this slide is about light up (the rest dim); a frame later, so the change animates
  const label = (n: Element) => [...n.childNodes].filter((c) => !(c instanceof Element && c.classList.contains('rr-node__badge'))).map((c) => c.textContent).join('').trim();
  const paintFocus = () => {
    const c = ctx();
    if (!c.doc) return;
    const want = target(c);
    const refs = want.kind === 'refs' ? want.refs : [];
    const { focus } = current(c).step;
    // Mermaid nodes (rendered later: `rr-mermaid:ready` repaints) take their label from the text, their ref from a `click` link
    requestAnimationFrame(() =>
      root.querySelectorAll('rr-flow, rr-mermaid').forEach((flow) => {
        let any = false;
        flow.querySelectorAll('rr-node, .pele-node').forEach((n) => {
          const node = n.matches('rr-node') ? { label: label(n), ref: n.getAttribute('ref') } : { label: n.querySelector('.pele-label')?.textContent ?? '', ref: n.querySelector('a')?.getAttribute('href') ?? null };
          const on = inFocus(node, focus, refs);
          n.classList.toggle('is-focus', on);
          any ||= on;
        });
        flow.classList.toggle('has-focus', any);
        // a Mermaid edge between two lit nodes flows
        const lit = [...flow.querySelectorAll('.pele-node.is-focus')].map((n) => n.getAttribute('data-id') ?? '');
        flow.querySelectorAll('.pele-edge').forEach((e) => e.classList.toggle('is-focus', edgeBetween(e.getAttribute('data-id') ?? '', lit)));
      }),
    );
  };
  const stepText = h('div', { class: 'rr-tour__text rr-prose' });
  const chips = h('div', { class: 'rr-tour__refs' });
  const stepBox = h('div', { class: 'rr-tour__step' }, stepText, chips);
  const anchor = () => {
    const { chapter, step } = current(ctx());
    return { kind: 'tour' as const, chapter: chapter.id, step: step.id };
  };
  // the step's threads go through the usual composer and thread popup (threadMachine), and the feedback round
  const comment = h('button', { class: 'rr-btn rr-btn--small rr-tour__comment', title: 'Comment on this slide: the agent gets it with your comment', onclick: () => app.compose(anchor()) }, icon('thread', 12), h('span', null, 'Comment'));
  const badge = h('button', { class: 'rr-tour__badge', title: 'Open the thread on this slide' });
  const threadsOn = (chapter: string, step: string) => app.state.threads.filter((t) => t.status === 'open' && t.anchor.kind === 'tour' && t.anchor.chapter === chapter && t.anchor.step === step);
  const paintThreads = () => {
    if (!ctx().doc) return;
    const { chapter, step } = anchor();
    const ts = threadsOn(chapter, step);
    badge.hidden = !ts.length;
    badge.replaceChildren(icon('thread', 12), String(ts.length));
    badge.onclick = () => ts[0] && app.bus.emit('open-thread', { id: ts[0].id });
    progress.querySelectorAll<HTMLElement>('.rr-tour__tick').forEach((t) => t.classList.toggle('has-threads', threadsOn(t.dataset.chapter!, t.dataset.step!).length > 0));
  };
  const left = h('div', { class: 'rr-tour__left' }, lead, more, h('div', { class: 'rr-tour__divider-row' }, divider, badge, leadToggle), stepBox, h('div', { class: 'rr-tour__actions' }, comment));
  const openHere = btn('popout', 'Pause and open this in the workbench', () => {
    const [ref] = shownRefs();
    actor.send({ type: 'pause' });
    if (ref) void app.open(ref);
  });
  // the boundary between the narration and the code drags to resize (side by side only: CSS hides it otherwise); the
  // share of the width is kept per device, a double-click goes back to the default
  const SPLIT = 'reviewroom:tour-split';
  const splitAt = (f: unknown) => (typeof f === 'number' ? split.style.setProperty('--rr-tour-split', `clamp(240px, ${f * 100}%, calc(100% - 240px))`) : split.style.removeProperty('--rr-tour-split'));
  splitAt(loadJSON(SPLIT));
  const resize = h('div', { class: 'rr-tour__resize', title: 'Drag to resize', 'aria-hidden': 'true', ondblclick: () => (saveLocal(SPLIT, null), splitAt(null)) });
  let box: DOMRect, share = 0;
  onDrag(resize, {
    start: () => (box = split.getBoundingClientRect()),
    move: (_dx, _dy, e) => splitAt((share = (e.clientX - box.left) / box.width)),
    end: (dx) => dx && saveLocal(SPLIT, share),
  });
  const right = h('div', { class: 'rr-tour__right' }, resize, tools, pane);
  const prev = btn('chevron', 'Previous slide', () => actor.send({ type: 'prev' }), '←');
  prev.classList.add('rr-tour__flip');
  const next = h('button', { class: 'rr-btn rr-btn--primary rr-tour__next', 'data-keys': '→', onclick: () => (current(ctx()).isLast ? actor.send({ type: 'close' }) : actor.send({ type: 'next' })) });
  const progress = h('div', { class: 'rr-tour__progress' });
  const bottom = h('div', { class: 'rr-tour__bottom' }, prev, progress, next);
  const player = h(
    'div',
    { class: 'rr-tour__player', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Guided walkthrough', tabindex: '-1' },
    h('div', { class: 'rr-tour__top' }, chapterPrev, chapterBtn, chapterNext, position, h('span', { class: 'rr-toolbar__spacer' }), openHere, btn('pause', 'Pause: shrink to a pill and use the workbench', () => actor.send({ type: 'pause' }), 'Esc'), btn('close', 'Close the guided walkthrough', () => actor.send({ type: 'close' }))),
    (split.append(left, right), split),
    bottom,
  );
  const pillText = h('span', { class: 'rr-tour__pill-text' });
  const pillBar = h('i');
  const pill = h('button', { class: 'rr-tour__pill', title: 'Resume the guided walkthrough at this slide', onclick: () => actor.send({ type: 'resume' }) }, h('span', { class: 'rr-tour__pill-play' }, icon('play', 12)), pillText, h('span', { class: 'rr-tour__pill-bar' }, pillBar));
  const root = h('div', { class: 'rr-tour', 'data-mode': 'closed', 'data-form': phone ? 'phone' : undefined }, h('div', { class: 'rr-tour__scrim', onclick: () => actor.send({ type: 'pause' }) }), player, pill);
  root.addEventListener('rr-mermaid:ready', paintFocus);
  app.root.append(root);
  if (phone) phonePlayer();
  /** A phone plays full screen (phone.css): the code under the whole screen, a slide card (a bottom sheet) and a
   *  floating toolbar of Back, Contents, Comment and Next over it, the walkthrough's progress a thin row at the foot. IDLE_MS
   *  untouched the chrome fades and the toolbar shrinks to a round button that brings it back (chromeMachine); the card
   *  drags between one line, its text and tall (cardMachine); it swipes sideways to the next or previous slide
   *  (gestureMachine). Back (the phone's) closes the player. On its side (data-orient, phone.css) the slide is a column
   *  beside the code, not a sheet over it. */
  function phonePlayer() {
    if (app.presentation.kind !== 'phone') watchBack(app); // a turned phone has the dock: no phone shell to hear Back
    // the floating toolbar: Back, Contents, Comment and Next, plain icon buttons on one pill
    prev.replaceChildren(icon('chevron', 20));
    prev.className = 'rr-icon-btn rr-tour__back';
    next.replaceChildren(icon('chevron', 20));
    next.className = 'rr-icon-btn rr-tour__fwd';
    comment.replaceChildren(icon('chat', 20));
    comment.className = 'rr-tour__comment';
    comment.setAttribute('aria-label', 'Comment on this slide');
    const contents = h('button', { class: 'rr-tour__contents', title: 'Chapters and slides', 'aria-label': 'Chapters and slides', 'aria-haspopup': 'dialog', onclick: () => contentsSheet!() }, icon('toc', 20));
    next.before(h('div', { class: 'rr-tour__pair', role: 'group', 'aria-label': 'Contents and comment' }, contents, comment));
    chapterBtn.title = 'Chapters and slides';
    chapterBtn.setAttribute('aria-haspopup', 'dialog');
    // Contents: a bottom sheet of the chapters, the current one open on its slides. A <dialog>, so the chrome holds
    // while it's open and Back closes it (PhoneShell's watchDialogs); kept, so it can slide away (phone.css)
    const sheet = h('dialog', { class: 'rr-modal rr-sheet rr-tour-toc', 'aria-label': 'Chapters and slides', tabindex: '-1', onmousedown: backdropCloses });
    document.body.append(sheet);
    const jump = (chapter: number, step: number) => (sheet.close(), actor.send({ type: 'goto', chapter, step }));
    const gist = (html: string) => Object.assign(h('div'), { innerHTML: sanitizeProse(html) }).textContent.trim();
    contentsSheet = () => {
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
      sheet.replaceChildren(h('h2', { class: 'rr-tour-toc__title' }, 'Contents'), h('nav', { class: 'rr-tour-toc__list' }, ...chapters));
      sheet.showModal();
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
      grip.title = d ? 'Collapse the slide to one line (or drag)' : 'Show the whole slide (or drag up)';
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
      else if (g.matches('horizontal') && !getSelection()?.toString() && Math.abs(g.context.dx) > 60) (g.context.dx < 0 ? next : prev).click();
    });
    // immersive (chromeMachine): IDLE_MS after the last touch or slide change, never while a menu, the composer or a
    // selection is open, the top bar fades and the toolbar shrinks to one round button in the corner, which grows it
    // back (so does a tap on the content)
    const held = () => !!(getSelection()?.toString() || app.selection || document.querySelector('dialog[open], [popover=auto]:popover-open'));
    const chrome = createActor(chromeMachine.provide({ guards: { held } })).start();
    const immersive = () => chrome.getSnapshot().matches('immersive');
    chrome.subscribe(() => player.classList.toggle('is-immersive', immersive()));
    const wake = () => chrome.send({ type: 'wake' });
    const restore = h('button', { class: 'rr-icon-btn rr-tour__restore', title: 'Show controls', 'aria-label': 'Show controls', onclick: wake }, icon('dots', 20)); // immersive only (phone.css)
    // upright: Show controls in the card's corner, the toolbar at the screen's foot; on its side: Show controls top
    // right, the toolbar at the foot of the code
    const orient = () => {
      root.dataset.orient = land.matches ? 'landscape' : 'portrait';
      (land.matches ? player : left).append(restore);
      (land.matches ? split : player).append(bottom);
    };
    orient();
    land.onchange = orient; // ?phone in a window turned; a phone reloads into the other shell anyway
    // touching anything while the chrome shows keeps it up
    player.addEventListener('touchstart', () => chrome.send({ type: 'touch' }), { passive: true, capture: true });
    // a tap on the content brings it back (one on a link, a chip or a selection does what it does, and navigating wakes it anyway)
    player.addEventListener('click', (e) => {
      if (immersive() && ((e.target as Element).closest(`button, a, ${REF_ELEMENTS}`) || getSelection()?.toString())) return;
      wake();
    }, true);
    let drop: (() => void) | undefined;
    let was = '', wasPlaying = false;
    actor.subscribe((s) => {
      // a new slide: the card from its top, so a swipe down collapses it rather than scrolling
      const playing = s.matches({ open: 'playing' });
      const slide = `${s.context.chapter}/${s.context.step}`;
      if (slide === was && playing === wasPlaying) return; // not every snapshot is a move: a code panel landing must not wake the chrome
      if (slide !== was) left.scrollTo({ top: 0 });
      [was, wasPlaying] = [slide, playing];
      if (playing && !drop) drop = onBack(() => ((drop = undefined), actor.send({ type: 'close' })));
      else if (!playing && drop) {
        drop();
        drop = undefined;
      }
      chrome.send({ type: playing ? 'wake' : 'stop' });
    });
    app.onDispose(() => (card.stop(), touch.stop(), chrome.stop(), sheet.remove()));
  }

  const ctx = () => actor.getSnapshot().context;
  const go = (d: number) => actor.send({ type: 'goto', chapter: ctx().chapter + d, step: 0 });
  const chapterMenu = () =>
    popMenu(chapterBtn, (close) =>
      ctx().doc!.chapters.map((c, i) =>
        menuItem(c.title, () => (close(), actor.send({ type: 'goto', chapter: i, step: 0 })), { checked: i === ctx().chapter, hint: plural(c.steps.length, 'slide') }),
      ),
    );

  // links in the narration: code goes to the pane (the step stays); anything else pauses and opens in the workbench
  left.addEventListener(
    'click',
    (e) => {
      const link = (e.target as Element).closest(REF_ELEMENTS);
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const ref = link.getAttribute('href') ?? link.getAttribute('ref')!;
      const type = parseRef(ref)?.type;
      if (type === 'code' || type === 'file' || type === 'sym') actor.send({ type: 'focus', refs: [ref] });
      else {
        actor.send({ type: 'pause' });
        void app.open(ref);
      }
    },
    true,
  );

  // ------------------------------------------------------------ render the player's snapshot
  let last = { chapter: -1, step: -1, doc: null as Walkthrough | null };
  const prose = (el: HTMLElement, html: string) => (el.innerHTML = sanitizeProse(html));
  // the step (or chapter) changed: new content at once, a CSS entrance (nothing to race)
  const enter = (el: HTMLElement) => {
    el.classList.remove('is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
  };
  // playing, the player is modal: the workbench behind it can't be clicked, tabbed to or read out (paused, it's in use)
  let back: HTMLElement | null = null;
  const modal = (on: boolean) => {
    for (const el of app.root.children) if (el !== root) (el as HTMLElement).inert = on;
    if (on) {
      back = document.activeElement as HTMLElement | null;
      player.focus();
    } else if (player.contains(document.activeElement)) back?.focus();
  };
  actor.subscribe((s) => {
    const mode = s.matches({ open: 'paused' }) ? 'paused' : s.matches('open') ? 'playing' : 'closed';
    const was = root.dataset.mode;
    root.dataset.mode = mode; // first: the player can't take focus while hidden
    pill.inert = mode !== 'paused'; // transparent, not hidden: keep it out of the tab order
    if ((mode === 'playing') !== (was === 'playing')) modal(mode === 'playing');
    if (!s.matches('open')) return void (last = { chapter: -1, step: -1, doc: null });
    const { chapter, step, doc: d } = s.context;
    const cur = current(s.context);
    const ch = cur.chapter, n = ch.steps.length;
    const total = d!.chapters.reduce((a, c) => a + c.steps.length, 0);
    const done = d!.chapters.slice(0, chapter).reduce((a, c) => a + c.steps.length, 0) + step + 1;
    pillText.textContent = `Resume · ${ch.title} · ${step + 1}/${n}`;
    pillBar.style.width = `${(done / total) * 100}%`;
    if (chapter === last.chapter && step === last.step && d === last.doc) return;

    if (chapter !== last.chapter || d !== last.doc) {
      chapterBtn.replaceChildren(h('span', null, ch.title), icon('chevronDown', 12));
      prose(lead, ch.lead ?? '');
      enter(lead);
    }
    if (phone) leadOpen = left.dataset.detent === 'tall'; // each slide folds the intro again (but the chapter's first), unless the card is tall
    paintLead();
    position.textContent = `Chapter ${chapter + 1} of ${d!.chapters.length}`;
    chapterPrev.toggleAttribute('disabled', chapter === 0);
    chapterNext.toggleAttribute('disabled', chapter === d!.chapters.length - 1);
    divider.textContent = `Slide ${step + 1} of ${n}`;
    prose(stepText, cur.step.text);
    paintFocus();
    const refs = stepRefs(cur.step);
    chips.replaceChildren(
      ...refs.map((ref) => h('button', { class: 'rr-tour__ref', title: refs.length > 1 ? 'Show only this in the code pane' : 'Show this in the code pane', onclick: () => actor.send({ type: 'focus', refs: [ref] }) }, refIcon(parseRef(ref)!), h('span', null, app.label(ref)))),
      ...(refs.length > 1 ? [h('button', { class: 'rr-tour__ref', title: 'Show all of this slide\'s code again', onclick: () => actor.send({ type: 'focus' }) }, icon('split', 12), h('span', null, `All ${refs.length}`))] : []),
    );
    enter(stepBox);
    prev.toggleAttribute('disabled', cur.isFirst);
    next.title = cur.isLast ? 'End the guided walkthrough' : 'Next slide';
    if (phone) {
      // the last slide's Next is off: the top bar's close ends the walkthrough
      next.toggleAttribute('disabled', cur.isLast);
      next.title = cur.isLast ? 'Last slide' : 'Next slide';
      prev.title = cur.isFirst ? 'First slide' : 'Previous slide';
      next.setAttribute('aria-label', next.title);
      prev.setAttribute('aria-label', prev.title);
    } else next.replaceChildren(cur.isLast ? 'Finish' : 'Next', cur.isLast ? icon('check', 14) : icon('chevron', 14));
    progress.replaceChildren(
      ...d!.chapters.map((c, ci) =>
        h(
          'div',
          { class: 'rr-tour__seg' + (ci === chapter ? ' is-on' : ''), style: `flex:${c.steps.length}` },
          h('span', { class: 'rr-tour__seg-title', title: c.title }, c.title),
          h(
            'div',
            { class: 'rr-tour__ticks' },
            ...c.steps.map((_, si) => {
              const at = ci < chapter || (ci === chapter && si < step) ? ' is-done' : ci === chapter && si === step ? ' is-on' : '';
              return h('button', { class: 'rr-tour__tick' + at, 'data-chapter': c.id, 'data-step': c.steps[si].id, title: `${c.title} · slide ${si + 1}`, 'aria-label': `${c.title}, slide ${si + 1}`, onclick: () => actor.send({ type: 'goto', chapter: ci, step: si }) });
            }),
          ),
        ),
      ),
    );
    last = { chapter, step, doc: d };
    paintThreads();
  });
  app.bus.on('state', paintThreads);
  app.bus.on('code-landed', ({ panel }) => views.some((v) => v.id === panel) && actor.send({ type: 'landed' }));

  // ← → while playing (not while typing or in a menu or dialog; toasts and tooltips are manual popovers, never in the way);
  // Esc pauses. The workbench's own shortcuts are held meanwhile (mod chords still run: the palette opens above the player)
  const playing = () => actor.getSnapshot().matches({ open: 'playing' });
  app.commands.held = playing;
  app.listen(window, 
    'keydown',
    (e) => {
      if (!playing() || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open], [popover=auto]:popover-open')) return;
      const type = ({ ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'pause' } as const)[e.key as 'ArrowRight'];
      if (type) {
        e.preventDefault();
        e.stopPropagation();
        actor.send({ type });
      }
    },
    true,
  );

  app.bus.on('walkthrough-open', ({ chapter, step }) => {
    if (!app.walkthrough) return app.toast('No guided walkthrough for this review');
    actor.send({ type: 'open', chapter, step });
  });
  const loaded = app.backend.walkthrough?.().then(
    (input) => {
      if (disposed) return;
      const w = decodeWalkthrough(input);
      app.walkthrough = w && 'version' in w ? w : null;
      app.walkthroughIssues = w && 'issues' in w ? w.issues : null;
      const link = deepLink(location.search); // first: once loaded, the URL follows the player
      actor.send({ type: 'load', doc: app.walkthrough });
      app.bus.emit('walkthrough', app.walkthrough);
      if (link && app.walkthrough) actor.send({ type: 'open', ...link });
    },
    () => {},
  );

  // The slide rides in the URL (?walkthrough=<chapter>/<step>), so a reload, or the macOS app reloading a tab it
  // unloaded, comes back to it. The app (app/src/main.rs) also hears the player's state, for its menu.
  const native = (window as { __TAURI_INTERNALS__?: { invoke(cmd: string, args: object): Promise<unknown> } }).__TAURI_INTERNALS__;
  let told = '';
  actor.subscribe((s) => {
    if (s.context.doc) {
      const u = new URL(location.href);
      if (s.matches('open')) {
        const { chapter, step } = current(s.context);
        u.searchParams.set('walkthrough', `${chapter.id}/${step.id}`);
      } else u.searchParams.delete('walkthrough');
      if (u.href !== location.href) history.replaceState(history.state, '', u);
    }
    const state = !s.context.doc ? 'none' : s.matches({ open: 'paused' }) ? 'paused' : s.matches('open') ? 'playing' : 'closed';
    if (native && state !== told) native.invoke('walkthrough_state', { state: (told = state) }).catch(() => {});
  });
  // the app's Reviews menu: play (or resume), next and previous slide
  if (native)
    (window as { reviewroomWalkthrough?: (cmd: 'play' | 'next' | 'prev') => void }).reviewroomWalkthrough = (cmd) => {
      const s = actor.getSnapshot();
      if (cmd === 'play') {
        if (s.matches({ open: 'paused' })) actor.send({ type: 'resume' });
        else if (!s.matches('open')) app.bus.emit('walkthrough-open', {});
      } else if (s.matches('open')) actor.send({ type: cmd });
    };

  /** For `reviewroom slide-lint`: open a step in a theme, wait until the pane shows it and its code has
   *  landed, measure what is on screen. */
  async function audit(chapter: string, step: string, theme?: 'light' | 'dark'): Promise<StepAudit> {
    await loaded;
    if (!ctx().doc) throw new Error(app.walkthroughIssues ? `walkthrough.json is invalid: ${app.walkthroughIssues[0]}` : 'no walkthrough.json');
    if (theme) {
      app.prefs = { ...app.prefs, theme }; // for this page only: not saved, the reviewer's pref stays as it is
      app.applyTheme();
    }
    actor.send({ type: 'open', chapter, step });
    const want = JSON.stringify(target(ctx()));
    // showing: the code has landed (or landing gave up: late)
    const { shown, late } = (await waitFor(actor.getSnapshot().children.pane!, (s) => s.matches('showing') && JSON.stringify(s.context.want) === want, { timeout: 10_000 })).context;
    // the entrance; an author's endless or paused animation would never finish
    await Promise.race([Promise.all(left.getAnimations({ subtree: true }).map((a) => a.finished)), new Promise((r) => setTimeout(r, 1000))]);
    const settled = (await settle(left)) && !late;
    const { chapter: ch, step: st } = current(ctx());
    return measure({ left, lead, pane }, shown, { lead: proseRemoved(ch.lead ?? ''), text: proseRemoved(st.text) }, settled);
  }
  app.onDispose(() => { disposed = true; actor.stop(); dispose(); root.remove(); });
  return { actor, audit };
}

/** A walkthrough step as a card: where it is, its text, its code (compact: the links only), and a way to play the
 *  walkthrough from it. A walkthrough section that expands on a step embeds it like this. */
export async function renderWalkthroughPreview(app: ReviewApp, r: Extract<Ref, { type: 'tour' }>, opts: PreviewOptions) {
  // the page may not have loaded walkthrough.json yet
  const loaded = app.walkthrough ?? decodeWalkthrough(await app.backend.walkthrough?.().catch(() => null));
  const w = loaded && 'version' in loaded ? loaded : null;
  const ch = w?.chapters.find((c) => c.id === r.chapter);
  const i = ch?.steps.findIndex((s) => s.id === r.step) ?? -1;
  if (!ch || i < 0) return h('div', { class: 'rr-empty' }, 'This guided walkthrough slide no longer exists');
  const step = ch.steps[i];
  const text = h('div', { class: 'rr-prose rr-slide__text' });
  text.innerHTML = sanitizeProse(step.text); // a walkthrough can come from a PR
  const refs = stepRefs(step);
  const code = opts.compact
    ? refs.length ? [h('div', { class: 'rr-slide__refs' }, ...refs.map((x) => h('span', { class: 'rr-slide__ref' }, refIcon(parseRef(x)!), app.label(x))))] : []
    : await Promise.all(refs.map((x) => renderPreview(app, x, { compact: true })));
  const title = 'Play the guided walkthrough from this slide';
  const play = h('button', {
    class: 'rr-icon-btn',
    title,
    'aria-label': title,
    onclick: (e: MouseEvent) => {
      // from inside a thread popup: the player opens under the page, not behind the modal
      (e.currentTarget as Element).closest('dialog')?.close();
      app.bus.emit('walkthrough-open', { chapter: r.chapter, step: r.step });
    },
  }, icon('play', 14));
  // the play button sits on top: an embed shows a preview's first lines only
  return h('div', { class: 'rr-slide' }, h('div', { class: 'rr-slide__where' }, h('span', null, `${ch.title} · slide ${i + 1} of ${ch.steps.length}`), play), text, ...code);
}
