// The walkthrough player: an overlay over the workbench (narration left, the step's code right), or a pill while
// paused. The lifecycle is walkthroughMachine (src/flows/walkthrough.ts); this only renders it. The code pane is a
// second code panel (the same CodeView setup, pinned to one file); prose is the author's HTML, sanitized.
import { createActor } from 'xstate';
import { h, icon } from '../core/dom';
import { sanitizeProse } from '../core/markdown';
import { parseRef, refIcon } from '../core/refs';
import { renderPreview } from '../elements';
import { current, target, walkthroughMachine } from '../flows/walkthrough';
import type { CodeTarget, ReviewApp } from '../shell/app';
import { menuItem, popMenu } from '../shell/chrome';
import { panelDefs, type PanelInstance } from '../shell/layout';
import type { Walkthrough } from '../shared/walkthrough';

const LINK = 'a[href^="rr:"], rr-ref, rr-node[ref]';
const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

let panes = 0;

export function mountWalkthrough(app: ReviewApp) {
  const actor = createActor(walkthroughMachine).start();
  const btn = (ic: Parameters<typeof icon>[0], title: string, onclick: () => void, keys?: string) =>
    h('button', { class: 'rr-icon-btn', title, 'aria-label': title, 'data-keys': keys, onclick }, icon(ic, 14));

  // ------------------------------------------------------------ skeleton
  const chapterPrev = btn('chevron', 'Previous chapter', () => go(-1));
  const chapterNext = btn('chevron', 'Next chapter', () => go(1));
  chapterPrev.classList.add('rr-tour__flip');
  const chapterBtn = h('button', { class: 'rr-tour__chapter', title: 'Jump to a chapter', 'aria-haspopup': 'menu', onclick: () => chapterMenu() });
  const position = h('span', { class: 'rr-tour__pos' });
  const lead = h('div', { class: 'rr-tour__lead rr-prose' });
  const divider = h('div', { class: 'rr-tour__divider' });
  const stepText = h('div', { class: 'rr-tour__text rr-prose' });
  const refChip = h('button', { class: 'rr-tour__ref', title: 'Show this in the code pane', onclick: () => show(true) });
  const stepBox = h('div', { class: 'rr-tour__step' }, stepText, refChip);
  const left = h('div', { class: 'rr-tour__left' }, lead, divider, stepBox);
  const pane = h('div', { class: 'rr-tour__pane' });
  const openHere = btn('popout', 'Pause and open this in the workbench', () => {
    actor.send({ type: 'pause' });
    if (shown) void app.open(shown);
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
  const doc = () => ctx().doc!;
  const go = (d: number) => actor.send({ type: 'goto', chapter: ctx().chapter + d, step: 0 });
  const chapterMenu = () =>
    popMenu(chapterBtn, (close) =>
      doc().chapters.map((c, i) =>
        menuItem(c.title, () => (close(), actor.send({ type: 'goto', chapter: i, step: 0 })), { checked: i === ctx().chapter, hint: `${c.steps.length} step${c.steps.length > 1 ? 's' : ''}` }),
      ),
    );

  // ------------------------------------------------------------ the code pane
  let code: { pin: string; panel: PanelInstance; id: string } | null = null;
  let shown: string | null = null; // the rr: link on screen
  const fade = (el: HTMLElement, fn: () => void) => {
    el.classList.add('is-out');
    setTimeout(() => (fn(), el.classList.remove('is-out')), 150);
  };
  async function codeTarget(ref: string): Promise<CodeTarget | null> {
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
  async function showRef(ref: string, force = false) {
    if (ref === shown && !force) return;
    shown = ref;
    const t = await codeTarget(ref);
    if (shown !== ref) return; // a newer step won
    if (t && code?.pin === t.path) return app.bus.emit('reveal-code', { ...t, panel: code.id }); // same file: glide
    fade(pane, () => {
      if (shown !== ref) return;
      code?.panel.dispose?.();
      code = null;
      if (!t) return void renderPreview(app, ref).then((el) => shown === ref && pane.replaceChildren(el));
      const id = `code:tour-${++panes}`;
      const panel = panelDefs().find((d) => d.id === 'code')!.create(app, { ...t, pin: t.path, sticky: true }, id);
      code = { pin: t.path, panel, id };
      pane.replaceChildren(panel.element);
    });
  }
  function showDiagram() {
    shown = null;
    fade(pane, () => {
      code?.panel.dispose?.();
      code = null;
      const flow = h('div', { class: 'rr-tour__diagram rr-prose' });
      flow.innerHTML = sanitizeProse(doc().chapters[ctx().chapter].lead!.match(/<rr-flow[\s\S]*<\/rr-flow>/)?.[0] ?? '');
      pane.replaceChildren(flow);
    });
  }
  function show(force = false) {
    const t = target(ctx());
    openHere.hidden = !t || t === 'diagram';
    if (t === 'diagram') showDiagram();
    else if (t) void showRef(t.ref, force);
    else fade(pane, () => (code?.panel.dispose?.(), (code = null), (shown = null), pane.replaceChildren(h('div', { class: 'rr-empty' }, 'Nothing to show for this step'))));
  }
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
      if (type === 'code' || type === 'file' || type === 'sym') void showRef(ref, true);
      else {
        actor.send({ type: 'pause' });
        void app.open(ref);
      }
    },
    true,
  );

  // ------------------------------------------------------------ render
  let last = { chapter: -1, step: -1, doc: null as Walkthrough | null };
  const prose = (el: HTMLElement, html: string) => (el.innerHTML = sanitizeProse(html));
  actor.subscribe((s) => {
    root.dataset.mode = s.value;
    if (s.value === 'closed') {
      code?.panel.dispose?.();
      code = null;
      shown = null;
      last = { chapter: -1, step: -1, doc: null };
      return;
    }
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
      fade(lead, () => prose(lead, ch.lead ?? ''));
      lead.hidden = !ch.lead;
    }
    position.textContent = `Chapter ${chapter + 1} of ${d!.chapters.length}`;
    chapterPrev.toggleAttribute('disabled', chapter === 0);
    chapterNext.toggleAttribute('disabled', chapter === d!.chapters.length - 1);
    divider.textContent = `Step ${step + 1} of ${n}`;
    fade(stepBox, () => {
      prose(stepText, cur.step.text);
      refChip.hidden = !cur.step.ref;
      if (cur.step.ref) refChip.replaceChildren(refIcon(parseRef(cur.step.ref)!), h('span', null, app.label(cur.step.ref)));
    });
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
              return h('button', { class: 'rr-tour__tick' + at, title: `${c.title} · step ${si + 1}`, 'aria-label': `${c.title}, step ${si + 1}`, onclick: () => actor.send({ type: 'goto', chapter: ci, step: si }) });
            }),
          ),
        ),
      ),
    );
    last = { chapter, step, doc: d };
    show();
  });

  // ← → while playing (not while typing); Esc pauses
  document.addEventListener('keydown', (e) => {
    if (!actor.getSnapshot().matches('playing') || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(':popover-open, dialog[open]')) return;
    const type = ({ ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'pause' } as const)[e.key as 'ArrowRight'];
    if (!type) return;
    e.preventDefault();
    e.stopPropagation();
    actor.send({ type });
  }, true);

  app.bus.on('walkthrough-open', ({ chapter, step }) => {
    if (!app.walkthrough) return app.toast('No walkthrough for this review');
    actor.send({ type: 'open', chapter, step });
  });
  void app.backend.walkthrough?.().then((w) => {
    app.walkthrough = w && 'version' in w ? w : null;
    app.walkthroughIssues = w && 'issues' in w ? w.issues : null;
    actor.send({ type: 'load', doc: app.walkthrough });
    app.bus.emit('walkthrough', app.walkthrough);
  }, () => {});
  return actor;
}
