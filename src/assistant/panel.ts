// Experimental assistant panel (rr-2l7), only when the server runs one (REVIEWROOM_ASSISTANT=1, `assistant` in its
// meta). The chat is a lazy React island (./thread.tsx: assistant-ui on AI SDK); nothing loads React until it opens.
import { h } from '../kernel/dom';
import { addPanelAt, definePanel, showPanel } from '../kernel/dock';
import type { ReviewApp } from '../app';

const PANEL = { id: 'assistant', component: 'assistant', title: 'Assistant', params: {} };
const open = (app: ReviewApp) => showPanel(app, PANEL.id) || addPanelAt(app, PANEL, 'right');

export function mountAssistant(app: ReviewApp) {
  definePanel({
    id: PANEL.id,
    title: PANEL.title,
    icon: 'thread',
    create: () => {
      const element = h('div', { class: 'rr-side rr-assistant' });
      let unmount: (() => void) | undefined, gone = false;
      void import('./thread').then((m) => (gone ? undefined : (unmount = m.mount(element))));
      const dispose = () => {
        gone = true;
        unmount?.();
      };
      return { element, dispose };
    },
  });
  app.commands.register({ id: 'assistant.open', title: 'Ask the assistant', group: 'Panels', hint: 'Claude Code on this machine, about this review', run: () => open(app) });
  open(app);
}
