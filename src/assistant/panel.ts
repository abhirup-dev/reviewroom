// Experimental assistant panel (rr-2l7): on the desktop (src/presentation.ts), when the server runs one for this page
// (`assistant` in its meta: on for this review, reached directly). The chat is a lazy React island (./thread.tsx:
// assistant-ui on AI SDK); nothing loads React until it opens. Ask actions elsewhere show only once this registered.
import { h } from '../kernel/dom';
import { addPanelAt, definePanel, showPanel } from '../kernel/dock';
import type { ReviewApp } from '../app';
import { askRef, excerptLines, type AskContext } from './context.shared';
import type { AssistantChat } from './chat';

const PANEL = { id: 'assistant', component: 'assistant', title: 'Assistant', params: {} };
const open = (app: ReviewApp) => showPanel(app, PANEL.id) || addPanelAt(app, PANEL, 'right');

/** Registers the panel and its commands; returns how generation's loading screen shows the same conversation
 *  (read-only), so composition hands it over. */
export function registerAssistant(app: ReviewApp) {
  // the context asked about last, until the chat takes it (it may still be loading)
  let pending: AskContext | undefined;
  let take: ((c: AskContext) => void) | undefined;
  let latestAsk = 0;
  app.onDispose(() => { latestAsk++; });
  // the page's one conversation (./chat.ts), made when a view first shows it: nothing loads React before
  let chat: Promise<AssistantChat> | undefined;
  const service = () => (chat ??= import('./chat').then((m) => {
    const c = m.createAssistantChat();
    void c.sync();
    return c;
  }));
  const sync = () => void chat?.then((c) => c.sync());
  // it follows what the server does: a turn that ended elsewhere, a generation that started (sync waits while it streams)
  app.onDispose(app.bus.on('assistant-turn', sync));
  app.onDispose(app.bus.on('generation', (s) => { if (s.context.progress.generation?.running) sync(); }));
  /** A view of the conversation in `host`; returns the unmount. */
  const view = (host: HTMLElement, options: Parameters<typeof import('./thread').mount>[3], failed: (e: unknown) => void) => {
    let unmount: (() => void) | undefined, gone = false;
    void Promise.all([import('./thread'), service()])
      .then(async ([m, c]) => {
        const initial = await c.latest();
        if (!gone) unmount = m.mount(host, c, initial, options);
      })
      .catch(failed);
    return () => { gone = true; unmount?.(); };
  };
  app.onDispose(definePanel({
    id: PANEL.id,
    title: PANEL.title,
    icon: 'thread',
    create: () => {
      const island = h('div', { class: 'rr-assistant__island' });
      // nothing requested yet: the assistant can write the walkthrough and report (generation.generate, review/generation.ts)
      const suggest = h('div', { class: 'rr-assistant__suggest', hidden: true }, h('span', null, 'No walkthrough or report yet.'), h('button', { class: 'rr-btn rr-btn--primary', onclick: () => app.commands.run('generation.generate') }, 'Generate them'));
      const paintSuggest = () => {
        const c = app.commands.get('generation.generate');
        suggest.hidden = !(app.generation?.matches({ stage: 'idle' }) && c && (!c.when || c.when()));
      };
      paintSuggest();
      // a failed load says why here, beside the chat (a moved-aside conversation, invalid settings)
      const failure = h('div', { class: 'rr-assistant__error', role: 'alert', hidden: true });
      const element = h('div', { class: 'rr-side rr-assistant' }, suggest, failure, island);
      const unmount = view(island, { onAsk: (fn) => {
        take = fn;
        if (pending) fn(pending);
        pending = undefined;
        return () => (take = take === fn ? undefined : take);
      } }, (error) => {
        failure.textContent = error instanceof Error ? error.message : String(error);
        failure.hidden = false;
      });
      const offGen = app.bus.on('generation', paintSuggest);
      return { element, dispose: () => { offGen(); unmount(); } };
    },
  }));
  app.onDispose(app.bus.on('ask-assistant', async ({ anchor, quote }) => {
    const request = ++latestAsk;
    // fixed now: navigating afterwards doesn't change what was attached
    const ref = askRef(anchor, app.range);
    const rev = anchor.kind === 'code' ? app.range[anchor.rev] : '';
    const label = app.label(ref);
    try {
      const text = anchor.kind === 'doc' ? excerptLines(anchor.quote?.exact ?? quote ?? '', 1, 40) : excerptLines((await app.services.code.read(anchor.path, rev)) ?? '', anchor.start, anchor.end);
      if (request !== latestAsk) return; // a slower file read must not replace a newer question
      const context = { text, messageId: '', ref, label };
      open(app);
      if (take) take(context);
      else pending = context;
    } catch {
      if (request === latestAsk) app.toast('Could not attach that selection. Try again.', 'error');
    }
  }));
  app.onDispose(app.commands.register(
    { id: 'assistant.open', title: 'Ask the assistant', group: 'Panels', hint: 'Claude Code on this machine, about this review', run: () => open(app) },
    { id: 'assistant.ask', title: 'Ask the assistant about the selection', group: 'Panels', when: () => !!app.selection, run: () => {
      const s = app.selection!;
      app.bus.emit('ask-assistant', s.kind === 'code' ? { anchor: { kind: 'code', path: s.path, rev: s.side, start: s.start, end: s.end } } : { anchor: s.anchor, quote: s.label });
    } },
  ));
  return (host: HTMLElement) => view(host, { readOnly: true }, (e) => console.error(`reviewroom: the assistant on the loading screen: ${e instanceof Error ? e.message : String(e)}`));
}
