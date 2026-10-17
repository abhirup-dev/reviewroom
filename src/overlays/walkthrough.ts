// The walkthrough player: an overlay over the workbench (narration left, the step's code right), or a pill while
// paused. walkthroughMachine and its paneMachine child (src/flows/walkthrough.ts) own every state and transition;
// this file renders snapshots and implements the pane's actions (resolve links, fade, mount, glide, unmount).
// A chunk is a code panel pinned to one file (the same CodeView setup as the dock); several stack. Prose is the
// author's HTML, sanitized: a walkthrough can come from a PR.
import { createActor, fromPromise } from 'xstate';
import { h, icon } from '../core/dom';
import { sanitizeProse } from '../core/markdown';
import { parseRef, refIcon } from '../core/refs';
import { renderPreview } from '../elements';
import { current, deepLink, paneMachine, walkthroughMachine, type CodeAt, type PaneShown, type Slot } from '../flows/walkthrough';
import type { ReviewApp } from '../shell/app';
import { menuItem, popMenu } from '../shell/chrome';
import { panelDefs, type PanelInstance } from '../shell/layout';
import { stepRefs, type Walkthrough } from '../shared/walkthrough';

const LINK = 'a[href^="rr:"], rr-ref, rr-node[ref]';
const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

let panes = 0;

export function mountWalkthrough(app: ReviewApp) {
  const btn = (ic: Parameters<typeof icon>[0], title: string, onclick: () => void, keys?: string) =>
    h('button', { class: 'rr-icon-btn', title, 'aria-label': title, 'data-keys': keys, onclick }, icon(ic, 14));

  // ------------------------------------------------------------ the code pane (paneMachine's actions)
  const pane = h('div', { class: 'rr-tour__pane' });
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
  // stacked: a header names the chunk; clicking it shows only that one
  const nameHead = (head: HTMLElement, ref: string) => {
    const r = parseRef(ref);
    head.replaceChildren(...(r ? [refIcon(r)] : []), h('span', null, app.label(ref)));
    head.onclick = () => actor.send({ type: 'focus', refs: [ref] });
  };
  const chunk = (slot: Slot, many: boolean): HTMLElement => {
    const id = `code:tour-${++panes}`;
    const panel = slot.code ? panelDefs().find((d) => d.id === 'code')!.create(app, { ...slot.code, pin: slot.code.path, embedded: true }, id) : null;
    const body = panel?.element ?? h('div', { class: 'rr-tour__preview' });
    if (!panel) void renderPreview(app, slot.ref).then((el) => body.replaceChildren(el));
    const head = many ? h('button', { class: 'rr-tour__chunk-head', title: 'Show only this in the pane' }) : null;
    if (head) nameHead(head, slot.ref);
    views.push({ panel, id, head });
    return h('div', { class: 'rr-tour__chunk' + (many ? ' is-stacked' : '') }, head, body);
  };
  const mount = (s: PaneShown) => {
    dispose();
    if (s.kind === 'refs') pane.replaceChildren(...s.slots.map((slot) => chunk(slot, s.slots.length > 1)));
    else if (s.kind === 'diagram') {
      const flow = h('div', { class: 'rr-tour__diagram rr-prose' });
      flow.innerHTML = sanitizeProse(s.html);
      pane.replaceChildren(flow);
    } else pane.replaceChildren(h('div', { class: 'rr-empty' }, 'Nothing to show for this step'));
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
      unmount: () => (dispose(), pane.replaceChildren()),
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
  const stepText = h('div', { class: 'rr-tour__text rr-prose' });
  const chips = h('div', { class: 'rr-tour__refs' });
  const stepBox = h('div', { class: 'rr-tour__step' }, stepText, chips);
  const anchor = () => {
    const { chapter, step } = current(ctx());
    return { kind: 'tour' as const, chapter: chapter.id, step: step.id };
  };
  // the step's threads go through the usual composer and thread popup (threadMachine), and the feedback round
  const comment = h('button', { class: 'rr-btn rr-btn--small rr-tour__comment', title: 'Comment on this step: the agent gets the slide with your comment', onclick: () => app.compose(anchor()) }, icon('thread', 12), h('span', null, 'Comment'));
  const badge = h('button', { class: 'rr-tour__badge', title: 'Open the thread on this step' });
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
  const left = h('div', { class: 'rr-tour__left' }, lead, h('div', { class: 'rr-tour__divider-row' }, divider, badge), stepBox, h('div', { class: 'rr-tour__actions' }, comment));
  const openHere = btn('popout', 'Pause and open this in the workbench', () => {
    const [ref] = shownRefs();
    actor.send({ type: 'pause' });
    if (ref) void app.open(ref);
  });
  const right = h('div', { class: 'rr-tour__right' }, pane);
  const prev = btn('chevron', 'Previous step', () => actor.send({ type: 'prev' }), '←');
  prev.classList.add('rr-tour__flip');
  const next = h('button', { class: 'rr-btn rr-btn--primary rr-tour__next', 'data-keys': '→', onclick: () => (current(ctx()).isLast ? actor.send({ type: 'close' }) : actor.send({ type: 'next' })) });
  const progress = h('div', { class: 'rr-tour__progress' });
  const player = h(
    'div',
    { class: 'rr-tour__player', role: 'dialog', 'aria-label': 'Walkthrough' },
    h('div', { class: 'rr-tour__top' }, chapterPrev, chapterBtn, chapterNext, position, h('span', { class: 'rr-toolbar__spacer' }), openHere, btn('pause', 'Pause: shrink to a pill and use the workbench', () => actor.send({ type: 'pause' }), 'Esc'), btn('close', 'Close the walkthrough', () => actor.send({ type: 'close' }))),
    h('div', { class: 'rr-tour__body' }, left, right),
    h('div', { class: 'rr-tour__bottom' }, prev, progress, next),
  );
  const pillText = h('span', { class: 'rr-tour__pill-text' });
  const pillBar = h('i');
  const pill = h('button', { class: 'rr-tour__pill', title: 'Resume the walkthrough at this step', onclick: () => actor.send({ type: 'resume' }) }, h('span', { class: 'rr-tour__pill-play' }, icon('play', 12)), pillText, h('span', { class: 'rr-tour__pill-bar' }, pillBar));
  const root = h('div', { class: 'rr-tour', 'data-mode': 'closed' }, h('div', { class: 'rr-tour__scrim', onclick: () => actor.send({ type: 'pause' }) }), player, pill);
  app.root.append(root);

  const ctx = () => actor.getSnapshot().context;
  const go = (d: number) => actor.send({ type: 'goto', chapter: ctx().chapter + d, step: 0 });
  const chapterMenu = () =>
    popMenu(chapterBtn, (close) =>
      ctx().doc!.chapters.map((c, i) =>
        menuItem(c.title, () => (close(), actor.send({ type: 'goto', chapter: i, step: 0 })), { checked: i === ctx().chapter, hint: `${c.steps.length} step${c.steps.length > 1 ? 's' : ''}` }),
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
  actor.subscribe((s) => {
    root.dataset.mode = s.matches({ open: 'paused' }) ? 'paused' : s.matches('open') ? 'playing' : 'closed';
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
      lead.hidden = !ch.lead;
      enter(lead);
    }
    position.textContent = `Chapter ${chapter + 1} of ${d!.chapters.length}`;
    chapterPrev.toggleAttribute('disabled', chapter === 0);
    chapterNext.toggleAttribute('disabled', chapter === d!.chapters.length - 1);
    divider.textContent = `Step ${step + 1} of ${n}`;
    prose(stepText, cur.step.text);
    const refs = stepRefs(cur.step);
    chips.replaceChildren(
      ...refs.map((ref) => h('button', { class: 'rr-tour__ref', title: refs.length > 1 ? 'Show only this in the code pane' : 'Show this in the code pane', onclick: () => actor.send({ type: 'focus', refs: [ref] }) }, refIcon(parseRef(ref)!), h('span', null, app.label(ref)))),
      ...(refs.length > 1 ? [h('button', { class: 'rr-tour__ref', title: 'Show all of this step\'s code again', onclick: () => actor.send({ type: 'focus' }) }, icon('split', 12), h('span', null, `All ${refs.length}`))] : []),
    );
    enter(stepBox);
    prev.toggleAttribute('disabled', cur.isFirst);
    next.replaceChildren(cur.isLast ? 'Finish' : 'Next', cur.isLast ? icon('check', 14) : icon('chevron', 14));
    next.title = cur.isLast ? 'End the walkthrough' : 'Next step';
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
              return h('button', { class: 'rr-tour__tick' + at, 'data-chapter': c.id, 'data-step': c.steps[si].id, title: `${c.title} · step ${si + 1}`, 'aria-label': `${c.title}, step ${si + 1}`, onclick: () => actor.send({ type: 'goto', chapter: ci, step: si }) });
            }),
          ),
        ),
      ),
    );
    last = { chapter, step, doc: d };
    paintThreads();
  });
  app.bus.on('state', paintThreads);

  // ← → while playing (not while typing or in a menu or dialog); Esc pauses
  document.addEventListener(
    'keydown',
    (e) => {
      if (!actor.getSnapshot().matches({ open: 'playing' }) || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(':popover-open, dialog[open]')) return;
      const type = ({ ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'pause' } as const)[e.key as 'ArrowRight'];
      if (!type) return;
      e.preventDefault();
      e.stopPropagation();
      actor.send({ type });
    },
    true,
  );

  app.bus.on('walkthrough-open', ({ chapter, step }) => {
    if (!app.walkthrough) return app.toast('No walkthrough for this review');
    actor.send({ type: 'open', chapter, step });
  });
  void app.backend.walkthrough?.().then(
    (w) => {
      app.walkthrough = w && 'version' in w ? w : null;
      app.walkthroughIssues = w && 'issues' in w ? w.issues : null;
      actor.send({ type: 'load', doc: app.walkthrough });
      app.bus.emit('walkthrough', app.walkthrough);
      const link = deepLink(location.search);
      if (link && app.walkthrough) actor.send({ type: 'open', ...link });
    },
    () => {},
  );
  return actor;
}
