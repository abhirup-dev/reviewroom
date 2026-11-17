// Experimental assistant panel (rr-2l7), only when the server runs one (REVIEWROOM_ASSISTANT=1, `assistant` in its
// meta). The chat is a lazy React island (./thread.tsx: assistant-ui on AI SDK); nothing loads React until it opens.
import { h } from '../kernel/dom';
import { addPanelAt, definePanel, showPanel } from '../kernel/dock';
import type { ReviewApp } from '../app';
import { askRef, excerptLines, type AskContext } from './context.shared';

const PANEL = { id: 'assistant', component: 'assistant', title: 'Assistant', params: {} };
const open = (app: ReviewApp) => showPanel(app, PANEL.id) || addPanelAt(app, PANEL, 'right');

export function registerAssistant(app: ReviewApp) {
  // the context asked about last, until the chat takes it (it may still be loading)
  let pending: AskContext | undefined;
  let take: ((c: AskContext) => void) | undefined;
  let latestAsk = 0;
  app.onDispose(() => { latestAsk++; });
  app.onDispose(definePanel({
    id: PANEL.id,
    title: PANEL.title,
    icon: 'thread',
    create: () => {
      const element = h('div', { class: 'rr-side rr-assistant' });
      let unmount: (() => void) | undefined, gone = false;
      void import('./thread').then(async (m) => {
        const response = await fetch('api/assistant');
        if (!response.ok) throw new Error('Could not load the saved assistant conversation.');
        const initial = await response.json();
        if (gone) return;
        unmount = m.mount(element, (fn) => {
          take = fn;
          if (pending) fn(pending);
          pending = undefined;
          return () => (take = take === fn ? undefined : take);
        }, initial);
      }).catch((error: unknown) => {
        if (!gone) element.textContent = error instanceof Error ? error.message : String(error);
      });
      const dispose = () => {
        gone = true;
        unmount?.();
      };
      return { element, dispose };
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
  return () => open(app);
}
