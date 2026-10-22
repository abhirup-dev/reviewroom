// The walkthrough player: an overlay over the workbench (narration left, the step's code right), or a pill while
// paused. walkthroughMachine and its paneMachine child (src/flows/walkthrough.ts) own every state and transition;
// this file renders snapshots and implements the pane's actions (resolve links, fade, mount, glide, unmount).
// A chunk is a code panel pinned to one file (the same CodeView setup as the dock); several stack, under one set of
// display toggles (split/unified, focus, whitespace, wrap, inline threads). Prose is the
// author's HTML, sanitized: a walkthrough can come from a PR.
import { createActor, fromPromise, waitFor } from 'xstate';
import { h, icon, onDrag } from '../core/dom';
import { proseRemoved, sanitizeProse } from '../core/markdown';
import { parseRef, refIcon } from '../core/refs';
import { renderPreview } from '../elements';
import { current, deepLink, paneMachine, target, walkthroughMachine, type CodeAt, type PaneShown, type Slot } from '../flows/walkthrough';
import type { ReviewApp } from '../shell/app';
import { menuItem, popMenu } from '../shell/chrome';
import { panelDefs, type PanelInstance } from '../shell/layout';
import { isPhone, onBack } from '../shell/phone';
import { displayTools } from '../panels/code';
import { inFocus, stepRefs, type StepAudit, type Walkthrough } from '../shared/walkthrough';
import { measure, settle } from './walkthrough-audit';

const LINK = 'a[href^="rr:"], rr-ref, rr-node[ref]';
const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

let panes = 0;

export function mountWalkthrough(app: ReviewApp) {
  const btn = (ic: Parameters<typeof icon>[0], title: string, onclick: () => void, keys?: string) =>
    h('button', { class: 'rr-icon-btn', title, 'aria-label': title, 'data-keys': keys, onclick }, icon(ic, 14));

  // ------------------------------------------------------------ the code pane (paneMachine's actions)
  const pane = h('div', { class: 'rr-tour__pane' });
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
  async function codeAt(ref: string): Promise<CodeAt | null> {
    const r = parseRef(ref);
    if (r?.type === 'code' || r?.type === 'file') {
      const rev = /^(base|head)$/.test(r.rev) ? undefined : r.rev;
      return { path: r.path, side: r.rev === 'base' ? 'base' : 'head', start: r.start, end: r.end, rev, view: r.type === 'file' ? 'file' : 'diff' };
    }
    if (r?.type !== 'sym') return null;
    const hits = await app.search(r.name, true).catch(() => []);
    const d = hits.find((x) => x.kind === 'definition') ?? hits[0];
    return d ? { path: d.path, side: 'head', start: d.line, end: d.line, view: app.files.some((f) => f.path === d.path) ? 'diff' : 'file' } : null;
  }
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
    else if (s.kind === 'diagram') {
      const flow = h('div', { class: 'rr-tour__diagram rr-prose' });
      flow.innerHTML = sanitizeProse(s.html);
      pane.replaceChildren(flow);
      paintFocus();
    } else pane.replaceChildren(h('div', { class: 'rr-empty' }, 'Nothing to show for this slide'));
  };
  const pane$ = paneMachine.provide({
    actors: { resolve: fromPromise(async ({ input }) => (input.kind === 'refs' ? { kind: 'refs', slots: await Promise.all(input.refs.map(async (ref) => ({ ref, code: await codeAt(ref) }))) } : input)) },
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
  const chapterBtn = h('button', { class: 'rr-tour__chapter', title: 'Jump to a chapter', 'aria-haspopup': 'menu', onclick: () => chapterMenu() });
  const position = h('span', { class: 'rr-tour__pos' });
  const lead = h('div', { class: 'rr-tour__lead rr-prose' });
  const divider = h('div', { class: 'rr-tour__divider' });
  // a big lead (a whole-system diagram) can be folded away for the rest of the walkthrough, and back
  let leadOpen = true;
  const leadToggle = h('button', { class: 'rr-icon-btn rr-tour__lead-toggle', onclick: () => ((leadOpen = !leadOpen), paintLead()) }, icon('chevronDown', 14));
  // a phone folds it to its first line instead of hiding it: the code above stays in view (phonePlayer)
  const more = h('button', { class: 'rr-link-btn rr-tour__more', hidden: true, onclick: () => ((leadOpen = true), paintLead()) }, 'More');
  const paintLead = () => {
    const has = !!current(ctx()).chapter.lead;
    const fold = isPhone() && !leadOpen;
    lead.hidden = !has || (!leadOpen && !fold);
    lead.classList.toggle('is-folded', fold);
    more.hidden = !has || !fold;
    leadToggle.hidden = !has;
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
    requestAnimationFrame(() =>
      root.querySelectorAll('rr-flow').forEach((flow) => {
        let any = false;
        flow.querySelectorAll('rr-node').forEach((n) => {
          const on = inFocus({ label: label(n), ref: n.getAttribute('ref') }, focus, refs);
          n.classList.toggle('is-focus', on);
          any ||= on;
        });
        flow.classList.toggle('has-focus', any);
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
  const right = h('div', { class: 'rr-tour__right' }, tools, pane);
  const prev = btn('chevron', 'Previous slide', () => actor.send({ type: 'prev' }), '←');
  prev.classList.add('rr-tour__flip');
  const next = h('button', { class: 'rr-btn rr-btn--primary rr-tour__next', 'data-keys': '→', onclick: () => (current(ctx()).isLast ? actor.send({ type: 'close' }) : actor.send({ type: 'next' })) });
  const progress = h('div', { class: 'rr-tour__progress' });
  const player = h(
    'div',
    { class: 'rr-tour__player', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Guided walkthrough', tabindex: '-1' },
    h('div', { class: 'rr-tour__top' }, chapterPrev, chapterBtn, chapterNext, position, h('span', { class: 'rr-toolbar__spacer' }), openHere, btn('pause', 'Pause: shrink to a pill and use the workbench', () => actor.send({ type: 'pause' }), 'Esc'), btn('close', 'Close the guided walkthrough', () => actor.send({ type: 'close' }))),
    h('div', { class: 'rr-tour__body' }, left, right),
    h('div', { class: 'rr-tour__bottom' }, prev, progress, next),
  );
  const pillText = h('span', { class: 'rr-tour__pill-text' });
  const pillBar = h('i');
  const pill = h('button', { class: 'rr-tour__pill', title: 'Resume the guided walkthrough at this slide', onclick: () => actor.send({ type: 'resume' }) }, h('span', { class: 'rr-tour__pill-play' }, icon('play', 12)), pillText, h('span', { class: 'rr-tour__pill-bar' }, pillBar));
  const root = h('div', { class: 'rr-tour', 'data-mode': 'closed' }, h('div', { class: 'rr-tour__scrim', onclick: () => actor.send({ type: 'pause' }) }), player, pill);
  app.root.append(root);
  if (isPhone()) phonePlayer();
  /** A phone plays full screen (walkthrough.css): code above a slide card whose own row has Back, Comment and Next,
   *  the card swipes to the next or previous slide, and Back (the phone's) closes the player. */
  function phonePlayer() {
    // the floating toolbar: Back and Comment as icon buttons, Next the one filled pill
    prev.replaceChildren(icon('chevron', 24));
    prev.className = 'rr-icon-btn rr-tour__back';
    comment.replaceChildren(icon('comment', 24));
    comment.className = 'rr-icon-btn rr-tour__comment';
    comment.setAttribute('aria-label', 'Comment on this slide');
    next.before(comment);
    // the card: a grip to fold the chapter intro (drag down) or unfold it (drag up, or tap the folded intro), its progress at the foot
    const grip = h('div', { class: 'rr-tour__grip', title: 'Drag up for the whole chapter intro, down to fold it', 'aria-hidden': 'true' });
    const fold = (open: boolean) => ((leadOpen = open), paintLead(), left.scrollTo({ top: 0 }));
    onDrag(grip, { move: () => {}, end: (_, dy) => Math.abs(dy) > 24 && fold(dy < 0) });
    lead.addEventListener('click', () => lead.classList.contains('is-folded') && fold(true));
    left.prepend(grip);
    left.append(progress);
    let from: { x: number; y: number } | null = null;
    left.addEventListener('pointerdown', (e) => (from = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null));
    left.addEventListener('pointercancel', () => (from = null)); // the card scrolled instead
    left.addEventListener('pointerup', (e) => {
      if (!from || getSelection()?.toString()) return;
      const dx = e.clientX - from.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(e.clientY - from.y)) {
        if (dx < 0) next.click();
        else prev.click();
      }
      from = null;
    });
    let drop: (() => void) | undefined;
    actor.subscribe((s) => {
      const playing = s.matches({ open: 'playing' });
      if (playing && !drop) drop = onBack(() => ((drop = undefined), actor.send({ type: 'close' })));
      else if (!playing && drop) {
        drop();
        drop = undefined;
      }
    });
  }

  const ctx = () => actor.getSnapshot().context;
  const go = (d: number) => actor.send({ type: 'goto', chapter: ctx().chapter + d, step: 0 });
  const chapterMenu = () =>
    popMenu(chapterBtn, (close) =>
      ctx().doc!.chapters.map((c, i) =>
        menuItem(c.title, () => (close(), actor.send({ type: 'goto', chapter: i, step: 0 })), { checked: i === ctx().chapter, hint: `${c.steps.length} slide${c.steps.length > 1 ? 's' : ''}` }),
      ),
    );

  // links in the narration: code goes to the pane (the step stays); anything else pauses and opens in the workbench
  left.addEventListener(
    'click',
    (e) => {
      const link = (e.target as Element).closest(LINK);
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
      if (isPhone()) leadOpen = false; // each chapter's intro starts folded on a phone
      paintLead();
      enter(lead);
    }
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
    next.replaceChildren(cur.isLast ? 'Finish' : 'Next', cur.isLast ? icon('check', 14) : icon('chevron', 14));
    next.title = cur.isLast ? 'End the guided walkthrough' : 'Next slide';
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
  window.addEventListener(
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
    (w) => {
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

  /** For `reviewroom walkthrough lint`: open a step in a theme, wait until the pane shows it and its code has
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
  return { actor, audit };
}
