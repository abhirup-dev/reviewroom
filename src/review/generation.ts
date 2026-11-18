// Generation in the page: generation.machine.ts decides, this draws. The loading screen over the review while the
// walkthrough is being written (or after a stop), the header indicator once that screen is closed, Generate and Retry.
// Everything else that cares (the report's placeholder, the headers, the assistant panel) reads `app.generation` on
// the bus's `generation` event.
import { createActor } from 'xstate';
import type { ReviewApp } from '../app';
import { h, icon } from '../kernel/dom';
import { awaitingApproval, generateOffered, generationMachine, indicatorShown, screenShown, stageIn, statusText, type GenerationSnapshot } from './generation.machine';

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

const btn = (label: string, onclick: () => void, primary = false) => h('button', { class: 'rr-btn' + (primary ? ' rr-btn--primary' : ''), onclick }, label);

export function mountGeneration(app: ReviewApp) {
  const actor = createActor(generationMachine, { input: { canGenerate: !!app.meta.generate } });
  const snap = () => actor.getSnapshot();
  const generate = async () => {
    if (!generateOffered(snap()) || !app.backend.generate) return;
    actor.send({ type: 'generate' });
    const r = await app.backend.generate().catch(() => ({ ok: false as const, code: undefined }));
    if (r.ok) return actor.send({ type: 'generated', progress: r.progress });
    const error = refused(r);
    actor.send({ type: 'failed', error });
    app.toast(error, 'error');
  };
  // in playable the screen has nothing left to show: the indicator plays the walkthrough
  const show = () => (stageIn(snap()) === 'playable' ? app.bus.emit('walkthrough-open', {}) : actor.send({ type: 'reopen' }));

  const heading = h('h1');
  const status = h('p', { class: 'rr-gen__status' });
  const approval = h('p', { class: 'rr-gen__note' });
  const error = h('p', { class: 'rr-gen__error', role: 'alert' });
  const actions = h('div', { class: 'rr-gen__actions' });
  const added = app.files.reduce((n, f) => n + f.additions, 0), deleted = app.files.reduce((n, f) => n + f.deletions, 0);
  const screen = h('div', { class: 'rr-gen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Generation', tabindex: '-1', hidden: true },
    h('div', { class: 'rr-gen__body', role: 'status' },
      heading,
      h('p', { class: 'rr-gen__title' }, app.meta.title),
      h('p', { class: 'rr-gen__facts' }, `${app.files.length} files changed · +${added} / -${deleted} · ${app.commits.length} commits`),
      status, approval, error, actions));
  app.root.append(screen);

  // shown, the screen is modal: the review behind it can't be clicked, tabbed to or read out
  let back: HTMLElement | null = null;
  const modal = (on: boolean) => {
    for (const el of app.root.children) if (el !== screen) (el as HTMLElement).inert = on;
    if (on) {
      back = document.activeElement as HTMLElement | null;
      screen.focus();
    } else if (screen.contains(document.activeElement)) back?.focus();
  };
  const paint = (s: GenerationSnapshot) => {
    const stage = stageIn(s), stopped = stage === 'stopped', w = s.context.progress.walkthrough;
    heading.textContent = stopped ? 'Generation stopped' : 'Writing your walkthrough';
    status.textContent = statusText(s);
    status.classList.toggle('is-busy', !stopped);
    approval.hidden = !awaitingApproval(s);
    approval.replaceChildren('The assistant is waiting for your approval.', ...(app.commands.get('assistant.open') ? [' ', h('button', { class: 'rr-link-btn', onclick: () => app.commands.run('assistant.open') }, 'Open the assistant')] : []));
    error.textContent = s.context.error ?? '';
    error.hidden = !s.context.error;
    actions.replaceChildren(...[
      stopped && generateOffered(s) ? btn('Retry', () => void generate(), true) : null,
      // what was written so far: the walkthrough on its way, or one a stop left behind
      w.hash && (stage === 'writing' || stopped) ? btn(stopped ? 'Show the walkthrough so far' : 'Show it anyway', () => { actor.send({ type: 'dismiss' }); app.bus.emit('walkthrough-show', undefined); }) : null,
      btn('Continue to the review', () => actor.send({ type: 'dismiss' }), !stopped),
    ].filter((b) => b !== null));
    const on = screenShown(s);
    if (on === screen.hidden) {
      screen.hidden = !on;
      modal(on);
    }
  };
  actor.subscribe((s) => {
    app.generation = s;
    paint(s);
    app.bus.emit('generation', s);
  });
  // playable while the reviewer waited: the player opens at slide 1 (the URL carries it over a reload)
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
    actor.send({ type: 'dismiss' });
  });
  app.onDispose(() => { actor.stop(); screen.remove(); });

  app.commands.register(
    { id: 'generation.generate', title: 'Generate the walkthrough and report', group: 'Navigate', hint: 'The built-in assistant writes both', when: () => generateOffered(snap()), run: () => void generate() },
    { id: 'generation.show', title: 'Show generation progress', group: 'Navigate', when: () => indicatorShown(snap()), run: show },
  );
}

/** The header's indicator: generation under way (or stopped) with the loading screen closed; a click opens it again. */
export function generationIndicator(app: ReviewApp): HTMLElement | null {
  const s = app.generation;
  if (!s || !indicatorShown(s)) return null;
  const stage = stageIn(s);
  const label = stage === 'stopped' ? 'Generation stopped' : stage === 'playable' ? 'Writing the report' : 'Generating';
  return h('button', { class: 'rr-hbtn rr-gen-ind' + (stage === 'stopped' ? ' is-stopped' : ''), title: `${statusText(s)}. ${stage === 'playable' ? 'Play the walkthrough' : 'Show the progress'}`, onclick: () => app.commands.run('generation.show') },
    h('span', { class: 'rr-gen-ind__dot', 'aria-hidden': 'true' }), h('span', { class: 'rr-gen-ind__label' }, label));
}

/** Generate, in the header: offered in idle and stopped, where the server can generate. */
export function generateButton(app: ReviewApp, iconOnly = false): HTMLElement | null {
  if (!app.generation || !generateOffered(app.generation)) return null;
  const title = 'Generate the walkthrough and report with the built-in assistant';
  return iconOnly
    ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-gen-btn', 'aria-label': 'Generate', title, onclick: () => app.commands.run('generation.generate') }, icon('bolt', 24))
    : h('button', { class: 'rr-hbtn rr-gen-btn', title, onclick: () => app.commands.run('generation.generate') }, icon('bolt', 14), h('span', null, 'Generate'));
}
