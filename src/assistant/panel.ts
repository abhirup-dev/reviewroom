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
  app.onDispose(definePanel({
    id: PANEL.id,
    title: PANEL.title,
    icon: 'thread',
    create: () => {
      const element = h('div', { class: 'rr-side rr-assistant' });
      let unmount: (() => void) | undefined, gone = false;
      void import('./thread').then((m) => {
        if (gone) return;
        unmount = m.mount(element, (fn) => {
          take = fn;
          if (pending) fn(pending);
          pending = undefined;
          return () => (take = take === fn ? undefined : take);
        });
      });
      const dispose = () => {
        gone = true;
        unmount?.();
      };
      return { element, dispose };
    },
  }));
  app.onDispose(app.bus.on('ask-assistant', async ({ anchor, quote }) => {
    // fixed now: navigating afterwards doesn't change what was attached
    const ref = askRef(anchor, app.range);
    const rev = anchor.kind === 'code' ? app.range[anchor.rev] : '';
    const text = anchor.kind === 'doc' ? (anchor.quote?.exact ?? quote ?? '') : excerptLines((await app.services.code.read(anchor.path, rev)) ?? '', anchor.start, anchor.end);
    const context = { text, messageId: '', ref, label: app.label(ref) };
    open(app);
    if (take) take(context);
    else pending = context;
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
