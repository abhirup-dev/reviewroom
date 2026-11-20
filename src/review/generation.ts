// Generation in the page: generation.machine.ts decides, this draws. The loading screen over the review while the
// walkthrough is being written (or after a stop), the header indicator once that screen is closed, Generate and Retry.
// Everything else that cares (the report's placeholder, the headers, the assistant panel) reads `app.generation` on
// the bus's `generation` event.
import { createActor, fromPromise } from 'xstate';
import type { ReviewApp } from '../app';
import { avatarUrl, h, icon, relTime } from '../kernel/dom';
import { CLAWD } from '../kernel/clawd';
import { awaitingApproval, generateOffered, generationMachine, generationSteps, indicatorShown, remembered, screenShown, stageIn, statusText, type GenerationSnapshot, type GenStep, type Remembered } from './generation.machine';

/** Clawd, the built-in assistant's mark; bobbing while it works. */
export const clawdMark = (size: number, working = false) => h('img', { class: `rr-clawd${working ? ' is-working' : ''}`, src: CLAWD, width: size, height: size, alt: '' });
/** The one busy signal: three dots in Margin Orange (controls.css). */
export const busyDots = () => h('span', { class: 'rr-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
/** The steps as a list: numbered square markers joined by a line, each step's detail as its tooltip, pass rows under checking (the
 *  last two; earlier ones fold into a count, so the column never outgrows the assistant's box). */
function stepList(steps: GenStep[]) {
  return h('ol', { class: 'rr-gen-steps' }, ...steps.map((st, i) => {
    const passes = st.passes ?? [], earlier = passes.length - 2;
    return h('li', { class: `rr-gen-step is-${st.state}`, title: st.detail, ...(st.state === 'current' && { 'aria-current': 'step' }) },
      h('span', { class: 'rr-gen-step__mk', 'aria-hidden': 'true' }, st.state === 'done' ? icon('check', 14) : st.state === 'stopped' ? '!' : st.state === 'current' ? h('span', { class: 'rr-gen-step__dot' }) : String(i + 1)),
      h('div', null,
        h('b', null, st.title),
        passes.length ? h('ul', { class: 'rr-gen-step__passes' },
          earlier > 0 ? h('li', { class: 'is-done' }, h('span', null, `${earlier} earlier ${earlier === 1 ? 'save' : 'saves'}`)) : null,
          ...passes.slice(-2).map((p) => h('li', { class: `is-${p.state}`, title: p.text }, h('span', null, p.text)))) : null));
  }));
}

/** api/generate's refusals, readable: never a raw code. */
const REFUSED: Record<string, string> = {
  busy: 'The assistant is answering a question. Generate when it is done.',
  starting: 'The review is still starting. Try again in a moment.',
  assistant_off: 'The built-in assistant is off for this review.',
  closing: 'The review is closing.',
  via_hub: 'Generate works only on this machine’s own review URL.',
  read_only: 'This review is read-only.',
};
function refused({ code, error }: { code?: string; error?: string }) {
  if (code && REFUSED[code]) return REFUSED[code];
  return code === 'assistant_unavailable' && error ? error : 'Could not start generating. Try again.'; // the server's own words: Claude Code missing, say
}

/** A read-only view of the page's conversation with the assistant in `host` (it follows the running turn); returns the
 *  unmount. The desktop supplies it (src/presentation.ts) where the server runs the assistant; without it the steps
 *  stand alone. */
export type LiveChat = (host: HTMLElement, extra?: HTMLElement) => () => void;
const liveChats = new WeakMap<ReviewApp, { mount?: LiveChat; repaint?: () => void }>();
const liveOf = (app: ReviewApp) => liveChats.get(app) ?? (liveChats.set(app, {}), liveChats.get(app)!);
export function provideLiveChat(app: ReviewApp, mount: LiveChat) {
  const l = liveOf(app);
  l.mount = mount;
  l.repaint?.();
}

// The header's controls are made once per page and updated in place, so a progress update never takes their focus
type Variant = 'full' | 'icon';
const header = new WeakMap<ReviewApp, { indicator: Partial<Record<Variant, HTMLButtonElement>>; generate: Partial<Record<Variant, HTMLButtonElement>> }>();
const headerOf = (app: ReviewApp) => header.get(app) ?? (header.set(app, { indicator: {}, generate: {} }), header.get(app)!);

function paintIndicator(el: HTMLButtonElement, s: GenerationSnapshot) {
  const stage = stageIn(s), stopped = stage === 'stopped' || stage === 'report-stopped';
  const label = stage === 'report-stopped' ? 'Report not finished' : stage === 'stopped' ? 'Generation stopped' : stage === 'playable' ? 'Writing the report' : 'Generating';
  el.classList.toggle('is-stopped', stopped);
  el.querySelector('.rr-clawd')?.classList.toggle('is-working', !stopped);
  el.title = `${statusText(s)}. ${stage === 'playable' ? 'Play the walkthrough' : stage === 'report-stopped' ? 'Show the report' : 'Show the progress'}`;
  if (el.classList.contains('rr-hbtn--icon')) el.setAttribute('aria-label', label);
  else el.querySelector('.rr-gen-ind__label')!.textContent = label;
}

export function mountGeneration(app: ReviewApp) {
  // what this tab keeps over a reload: the request the screen was closed on, the walkthrough request it waited for and played
  const KEY = `reviewroom:generation:${app.meta.routeId}`;
  let kept: Remembered = {};
  try { kept = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Remembered; } catch { /* storage off, or not ours */ }
  // the POST's answer only settles the request: what happens to it comes over SSE
  const post = fromPromise(async () => {
    const r = await app.backend.generate?.().catch(() => undefined);
    if (r?.ok) return r.started;
    throw new Error(refused(r ?? {}));
  });
  const actor = createActor(generationMachine.provide({ actors: { generate: post } }), { input: { canGenerate: !!app.meta.generate, ...kept } });
  const snap = () => actor.getSnapshot();
  const generate = () => actor.send({ type: 'generate' });
  actor.on('refused', ({ error }) => { if (!screenShown(snap())) app.toast(error, 'error'); }); // the screen shows it already
  const dismiss = () => actor.send({ type: 'dismiss' });
  // in playable the screen has nothing left to show: the indicator plays the walkthrough; a stopped report is shown
  // (with Retry) where the report goes
  const show = () => {
    if (stageIn(snap()) === 'playable') return app.bus.emit('walkthrough-open', {});
    if (stageIn(snap()) === 'report-stopped') return void app.showPanel('narrative');
    actor.send({ type: 'reopen' });
  };

  // the screen's controls, made once and updated in place
  const heading = h('h2', { class: 'rr-gen__label' });
  // the stepper says it on screen; this line is what a screen reader hears (and the phone's one line)
  const status = h('p', { class: 'rr-gen__status', role: 'status' });
  const repo = h('p', { class: 'rr-gen__repo' });
  const title = h('h1');
  const byline = h('p', { class: 'rr-gen__by' });
  const steps = h('div', { class: 'rr-gen__steps' });
  const external = h('p', { class: 'rr-gen__agent' }, 'Your own agent is writing this review. Progress shows as it saves.');
  // the overlay is inert-making: close it before the assistant opens, or the panel opens behind it
  const openAssistant = h('button', { class: 'rr-link-btn', onclick: () => { dismiss(); app.commands.run('assistant.open'); } }, 'Open the assistant');
  const approval = h('p', { class: 'rr-gen__note' }, 'The assistant is waiting for your approval. ', openAssistant);
  const error = h('p', { class: 'rr-gen__error', role: 'status' });
  const btn = (label: string, onclick: () => void) => h('button', { class: 'rr-btn', onclick }, label);
  const retry = btn('Retry', generate);
  const takeOver = btn('Generate', generate);
  const soFar = btn('Peek at the walkthrough', () => { dismiss(); app.bus.emit('walkthrough-show', undefined); });
  const cont = btn('Continue to the review', dismiss);
  // the right column: the built-in assistant's read-only transcript, in a box of fixed size; shown only where its stream is
  const live = h('div', { class: 'rr-gen__live' });
  // no head: the transcript starts level with the steps' label; Claude's name, the busy dots and Stop sit at its foot
  const side = h('section', { class: 'rr-gen__side', 'aria-label': 'What Claude is doing', hidden: true }, live);
  // the actions fill the row under Claude's line; without the box, they sit under the steps. Never a bar of their own
  const actions = h('div', { class: 'rr-gen__actions' }, retry, takeOver, soFar, cont);
  const main = h('div', { class: 'rr-gen__main' }, heading, steps, external, status, approval, error, actions);
  const screen = h('div', { class: 'rr-gen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Generation', tabindex: '-1', hidden: true },
    h('div', { class: 'rr-gen__body' },
      h('header', { class: 'rr-gen__head' }, repo, title, byline),
      main,
      side));
  app.root.append(screen);
  // the change: its repository and branches, title, author (with GitHub's avatar once it loads) and size. No clock: the
  // screen says what is happening, never how long it has taken
  const paintHead = () => {
    const m = app.meta, gh = app.github?.description, who = gh?.login ?? m.author;
    const added = app.files.reduce((n, f) => n + f.additions, 0), deleted = app.files.reduce((n, f) => n + f.deletions, 0);
    repo.replaceChildren(icon(m.url ? 'github' : 'book', 14), ...[m.repo, m.number ? `#${m.number}` : '', m.headLabel && m.baseLabel ? `${m.headLabel} → ${m.baseLabel}` : ''].filter(Boolean).map((t) => h('span', null, t)));
    title.textContent = m.title;
    // the author's GitHub avatar; without one (no GitHub, or not loaded yet) their initials in a tile of the same size
    const initials = (who ?? '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const avatar = gh?.avatar ? h('img', { class: 'rr-gen__avatar', src: avatarUrl(gh.avatar, 40), alt: '' }) : h('span', { class: 'rr-gen__avatar', 'aria-hidden': 'true' }, initials);
    const sep = () => h('span', { class: 'rr-gen__sep', 'aria-hidden': 'true' }, '·');
    byline.replaceChildren(
      ...(who ? [avatar, h('b', null, who), ...(gh?.at ? [h('span', null, `opened ${relTime(gh.at)}`)] : []), sep()] : []),
      h('span', { class: 'rr-gen__size' }, h('span', { class: 'rr-add' }, `+${added}`), ' ', h('span', { class: 'rr-del' }, `\u2212${deleted}`)), sep(),
      h('span', null, `${app.files.length} ${app.files.length === 1 ? 'file' : 'files'}`));
  };
  for (const e of ['state', 'meta', 'files'] as const) app.onDispose(app.bus.on(e, () => { if (!screen.hidden) paintHead(); }));

  // shown, the screen is modal: the review behind it can't be clicked, tabbed to or read out
  let back: HTMLElement | null = null;
  const modal = (on: boolean) => {
    if (on) back = document.activeElement as HTMLElement | null; // before inert: inert moves focus to the body
    for (const el of app.root.children) if (el !== screen) (el as HTMLElement).inert = on;
    if (on) return screen.focus();
    if (!screen.contains(document.activeElement) && document.activeElement !== document.body) return;
    // back where it was, if that survived; else the indicator that now stands for the screen, or the report. After the
    // `generation` event: the header puts the indicator in on it
    queueMicrotask(() => {
      const at = document.activeElement;
      if (at && at !== document.body && !screen.contains(at)) return; // focus went somewhere on purpose (not still in the hidden screen)
      const { indicator } = headerOf(app);
      const to = [back, indicator.full, indicator.icon, app.root.querySelector<HTMLElement>('.rr-narrative-scroll')].find((el) => el && el !== document.body && el.isConnected && !el.closest('[inert]'));
      to?.focus();
    });
  };
  const paint = (s: GenerationSnapshot) => {
    const stage = stageIn(s), stopped = stage === 'stopped', w = s.context.progress.walkthrough;
    // the assistant's stream: only where the built-in assistant writes it and this page reaches it (never through the hub)
    const stream = w.by === 'assistant' && !!app.meta.assistant && !!liveOf(app).mount;
    heading.textContent = stopped ? 'Generation stopped' : 'Writing the review';
    status.textContent = statusText(s);
    status.classList.toggle('is-busy', !stopped);
    steps.replaceChildren(stepList(generationSteps(s.context.progress)));
    side.hidden = !stream;
    external.hidden = w.by !== 'agent';
    screen.classList.toggle('has-side', stream);
    approval.hidden = !awaitingApproval(s);
    openAssistant.hidden = !app.commands.get('assistant.open');
    error.textContent = s.context.error ?? '';
    error.hidden = !s.context.error;
    retry.hidden = !(stopped && generateOffered(s));
    takeOver.hidden = stopped || !generateOffered(s);
    retry.classList.add('rr-btn--primary');
    // what was written so far: the walkthrough on its way, or one a stop left behind
    soFar.hidden = !(w.hash && (stage === 'writing' || stopped));
    soFar.textContent = stopped ? 'Show the walkthrough so far' : 'Peek at the walkthrough';
    cont.classList.toggle('rr-btn--primary', !stopped);
    for (const el of Object.values(headerOf(app).indicator)) paintIndicator(el, s);
    const on = screenShown(s);
    if (on === screen.hidden) {
      if (on) paintHead();
      screen.hidden = !on;
      modal(on);
    }
    paintLive(stream && on);
  };
  /** The conversation's view, while the screen is up; the page's chat follows a new turn itself. */
  const paintLive = (shown: boolean) => {
    if (shown === !!unmountLive) return;
    unmountLive?.();
    if (!shown) main.append(actions);
    unmountLive = shown ? liveOf(app).mount?.(live, actions) : undefined;
  };
  let unmountLive: (() => void) | undefined;
  liveOf(app).repaint = () => paint(snap());
  app.onDispose(() => unmountLive?.());

  let saved = '';
  actor.subscribe((s) => {
    app.generation = s;
    paint(s);
    app.bus.emit('generation', s);
    const keep = JSON.stringify(remembered(s));
    if (keep !== saved) {
      saved = keep;
      try { sessionStorage.setItem(KEY, keep); } catch { /* storage off: shown again after a reload */ }
    }
  });
  // the walkthrough validated for a request this page waited for: the player opens at slide 1, once per request (the URL
  // carries it over a reload; the player opens only if it isn't open already)
  actor.on('play', () => {
    const u = new URL(location.href);
    u.searchParams.set('walkthrough', '/');
    history.replaceState(history.state, '', u);
    app.bus.emit('walkthrough-show', undefined);
  });
  actor.start();
  actor.send({ type: 'progress', progress: app.progress });
  app.onDispose(app.bus.on('progress', (progress) => actor.send({ type: 'progress', progress })));
  screen.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dismiss();
  });
  app.onDispose(() => { actor.stop(); screen.remove(); });

  app.commands.register(
    { id: 'generation.generate', title: 'Generate review artifacts', group: 'Navigate', hint: 'The built-in assistant writes the unfinished artifacts', when: () => generateOffered(snap()), run: generate },
    { id: 'generation.show', title: 'Show generation progress', group: 'Navigate', when: () => indicatorShown(snap()), run: show },
  );
}

/** The header's indicator: generation under way (or stopped) with the loading screen closed; a click opens it again.
 *  The same element every time, updated in place. */
export function generationIndicator(app: ReviewApp, iconOnly = false): HTMLElement | null {
  const s = app.generation;
  if (!s || !indicatorShown(s)) return null;
  const all = headerOf(app).indicator, variant: Variant = iconOnly ? 'icon' : 'full';
  const run = () => app.commands.run('generation.show');
  const el = (all[variant] ??= (iconOnly
    ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-gen-ind', onclick: run }, clawdMark(18, true))
    : h('button', { class: 'rr-hbtn rr-gen-ind', onclick: run }, clawdMark(14, true), h('span', { class: 'rr-gen-ind__label' }), busyDots())));
  paintIndicator(el, s);
  return el;
}

/** Generate, in the header: offered for unfinished artifacts, where the server can generate. The same element every time. */
export function generateButton(app: ReviewApp, iconOnly = false): HTMLElement | null {
  if (!app.generation || !generateOffered(app.generation)) return null;
  const all = headerOf(app).generate, title = 'Generate unfinished artifacts with the built-in assistant';
  const run = () => app.commands.run('generation.generate');
  return (all[iconOnly ? 'icon' : 'full'] ??= (iconOnly
    ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-gen-btn', 'aria-label': 'Generate', title, onclick: run }, icon('bolt', 24))
    : h('button', { class: 'rr-hbtn rr-gen-btn', title, onclick: run }, icon('bolt', 14), h('span', null, 'Generate'))));
}

/** Repaints a header only when generation adds or removes one of its controls; otherwise they update in place. */
export function onGenerationHeader(app: ReviewApp, paint: () => void) {
  let last = '';
  return app.bus.on('generation', (s) => {
    const now = `${indicatorShown(s)}|${generateOffered(s)}`;
    if (now !== last) {
      last = now;
      paint();
    }
  });
}
