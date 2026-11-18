// Generation in the page: generation.machine.ts decides, this draws. The loading screen over the review while the
// walkthrough is being written (or after a stop), the header indicator once that screen is closed, Generate and Retry.
// Everything else that cares (the report's placeholder, the headers, the assistant panel) reads `app.generation` on
// the bus's `generation` event.
import { createActor } from 'xstate';
import type { ReviewApp } from '../app';
import { h, icon } from '../kernel/dom';
import { awaitingApproval, generateOffered, generationMachine, indicatorShown, remembered, reportStopped, screenShown, stageIn, statusText, type GenerationSnapshot, type Remembered } from './generation.machine';

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

// The header's controls are made once per page and updated in place, so a progress update never takes their focus
type Variant = 'full' | 'icon';
const header = new WeakMap<ReviewApp, { indicator: Partial<Record<Variant, HTMLButtonElement>>; generate: Partial<Record<Variant, HTMLButtonElement>> }>();
const headerOf = (app: ReviewApp) => header.get(app) ?? (header.set(app, { indicator: {}, generate: {} }), header.get(app)!);

function paintIndicator(el: HTMLButtonElement, s: GenerationSnapshot) {
  const stage = stageIn(s);
  const label = stage === 'stopped' ? (reportStopped(s) ? 'Report not finished' : 'Generation stopped') : stage === 'playable' ? 'Writing the report' : 'Generating';
  el.classList.toggle('is-stopped', stage === 'stopped');
  el.title = `${statusText(s)}. ${stage === 'playable' ? 'Play the walkthrough' : reportStopped(s) ? 'Show the report' : 'Show the progress'}`;
  if (el.classList.contains('rr-hbtn--icon')) el.setAttribute('aria-label', label);
  else el.lastElementChild!.textContent = label;
}

export function mountGeneration(app: ReviewApp) {
  // what this tab keeps over a reload: the request the screen was closed on, the walkthrough request it waited for and played
  const KEY = `reviewroom:generation:${app.meta.id}`;
  let kept: Remembered = {};
  try { kept = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Remembered; } catch { /* storage off, or not ours */ }
  const actor = createActor(generationMachine, { input: { canGenerate: !!app.meta.generate, ...kept } });
  const snap = () => actor.getSnapshot();
  const generate = async () => {
    if (!generateOffered(snap()) || !app.backend.generate) return;
    actor.send({ type: 'generate' });
    const { attempt } = snap().context;
    const r = await app.backend.generate().catch(() => ({ ok: false as const, code: undefined }));
    if (snap().context.attempt !== attempt) return; // an earlier press's answer: nothing to settle, nothing to say
    // the answer only settles the request: what happens to it comes over SSE
    if (r.ok) return actor.send({ type: 'generated', attempt, started: r.started });
    const error = refused(r);
    actor.send({ type: 'failed', attempt, error });
    if (!screenShown(snap())) app.toast(error, 'error'); // the screen shows it already
  };
  const dismiss = () => actor.send({ type: 'dismiss' });
  // in playable the screen has nothing left to show: the indicator plays the walkthrough; a stopped report is shown
  // (with Retry) where the report goes
  const show = () => {
    if (stageIn(snap()) === 'playable') return app.bus.emit('walkthrough-open', {});
    if (reportStopped(snap())) return void app.showPanel('narrative');
    actor.send({ type: 'reopen' });
  };

  // the screen's controls, made once and updated in place
  const heading = h('h1');
  const status = h('p', { class: 'rr-gen__status' });
  // the overlay is inert-making: close it before the assistant opens, or the panel opens behind it
  const openAssistant = h('button', { class: 'rr-link-btn', onclick: () => { dismiss(); app.commands.run('assistant.open'); } }, 'Open the assistant');
  const approval = h('p', { class: 'rr-gen__note' }, 'The assistant is waiting for your approval. ', openAssistant);
  const error = h('p', { class: 'rr-gen__error', role: 'alert' });
  const btn = (label: string, onclick: () => void) => h('button', { class: 'rr-btn', onclick }, label);
  const retry = btn('Retry', () => void generate());
  const soFar = btn('Show it anyway', () => { dismiss(); app.bus.emit('walkthrough-show', undefined); });
  const cont = btn('Continue to the review', dismiss);
  const added = app.files.reduce((n, f) => n + f.additions, 0), deleted = app.files.reduce((n, f) => n + f.deletions, 0);
  const screen = h('div', { class: 'rr-gen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Generation', tabindex: '-1', hidden: true },
    h('div', { class: 'rr-gen__body', role: 'status' },
      heading,
      h('p', { class: 'rr-gen__title' }, app.meta.title),
      h('p', { class: 'rr-gen__facts' }, `${app.files.length} files changed · +${added} / -${deleted} · ${app.commits.length} commits`),
      status, approval, error, h('div', { class: 'rr-gen__actions' }, retry, soFar, cont)));
  app.root.append(screen);

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
      if (document.activeElement && document.activeElement !== document.body) return; // focus went somewhere on purpose
      const { indicator } = headerOf(app);
      const to = [back, indicator.full, indicator.icon, app.root.querySelector<HTMLElement>('.rr-narrative-scroll')].find((el) => el && el !== document.body && el.isConnected && !el.closest('[inert]'));
      to?.focus();
    });
  };
  const paint = (s: GenerationSnapshot) => {
    const stage = stageIn(s), stopped = stage === 'stopped', w = s.context.progress.walkthrough;
    heading.textContent = stopped ? 'Generation stopped' : 'Writing your walkthrough';
    status.textContent = statusText(s);
    status.classList.toggle('is-busy', !stopped);
    approval.hidden = !awaitingApproval(s);
    openAssistant.hidden = !app.commands.get('assistant.open');
    error.textContent = s.context.error ?? '';
    error.hidden = !s.context.error;
    retry.hidden = !(stopped && generateOffered(s));
    retry.classList.add('rr-btn--primary');
    // what was written so far: the walkthrough on its way, or one a stop left behind
    soFar.hidden = !(w.hash && (stage === 'writing' || stopped));
    soFar.textContent = stopped ? 'Show the walkthrough so far' : 'Show it anyway';
    cont.classList.toggle('rr-btn--primary', !stopped);
    for (const el of Object.values(headerOf(app).indicator)) paintIndicator(el, s);
    const on = screenShown(s);
    if (on === screen.hidden) {
      screen.hidden = !on;
      modal(on);
    }
  };
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
    { id: 'generation.generate', title: 'Generate the walkthrough and report', group: 'Navigate', hint: 'The built-in assistant writes both', when: () => generateOffered(snap()), run: () => void generate() },
    { id: 'generation.show', title: 'Show generation progress', group: 'Navigate', when: () => indicatorShown(snap()), run: show },
  );
}

/** The header's indicator: generation under way (or stopped) with the loading screen closed; a click opens it again.
 *  The same element every time, updated in place. */
export function generationIndicator(app: ReviewApp, iconOnly = false): HTMLElement | null {
  const s = app.generation;
  if (!s || !indicatorShown(s)) return null;
  const all = headerOf(app).indicator, variant: Variant = iconOnly ? 'icon' : 'full';
  const dot = () => h('span', { class: 'rr-gen-ind__dot', 'aria-hidden': 'true' });
  const run = () => app.commands.run('generation.show');
  const el = (all[variant] ??= (iconOnly
    ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-gen-ind', onclick: run }, dot())
    : h('button', { class: 'rr-hbtn rr-gen-ind', onclick: run }, dot(), h('span'))));
  paintIndicator(el, s);
  return el;
}

/** Generate, in the header: offered in idle and stopped, where the server can generate. The same element every time. */
export function generateButton(app: ReviewApp, iconOnly = false): HTMLElement | null {
  if (!app.generation || !generateOffered(app.generation)) return null;
  const all = headerOf(app).generate, title = 'Generate the walkthrough and report with the built-in assistant';
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
