// Experimental assistant panel (rr-2l7): on the desktop (src/presentation.ts), when the server runs one for this page
// (`assistant` in its meta: on for this review, reached directly). The chat is a lazy React island (./thread.tsx:
// assistant-ui on AI SDK); nothing loads React until it opens. Ask actions elsewhere show only once this registered.
import { h } from '../kernel/dom';
import { addPanelAt, definePanel, showPanel } from '../kernel/dock';
import type { ReviewApp } from '../app';
import { askRef, excerptLines, type AskContext } from './context.shared';
import type { Draft } from './thread';

const PANEL = { id: 'assistant', component: 'assistant', title: 'Assistant', params: {} };
const open = (app: ReviewApp) => showPanel(app, PANEL.id) || addPanelAt(app, PANEL, 'right');

/** The same conversation, read-only, for generation's loading screen: it follows the running turn live (the chat
 *  resumes it on mount). Returns the unmount. */
export function mountLiveChat(host: HTMLElement) {
  let chat: { unmount(): void } | undefined, gone = false;
  void Promise.all([import('./thread'), fetch('api/assistant').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))])
    .then(([m, initial]) => { if (!gone) chat = m.mount(host, () => () => {}, initial, undefined, true); })
    .catch((e: unknown) => console.error(`reviewroom: the assistant on the loading screen: ${e instanceof Error ? e.message : String(e)}`));
  return () => { gone = true; chat?.unmount(); };
}

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
      const island = h('div', { class: 'rr-assistant__island' });
      // nothing requested yet: the assistant can write the walkthrough and report (generation.generate, review/generation.ts)
      const suggest = h('div', { class: 'rr-assistant__suggest', hidden: true }, h('span', null, 'No walkthrough or report yet.'), h('button', { class: 'rr-btn rr-btn--primary', onclick: () => app.commands.run('generation.generate') }, 'Generate them'));
      const paintSuggest = () => {
        const c = app.commands.get('generation.generate');
        suggest.hidden = !(app.generation?.matches({ stage: 'idle' }) && c && (!c.when || c.when()));
      };
      paintSuggest();
      // a failed load says why here, beside the chat: a refresh that fails keeps the chat and its draft as they are
      const failure = h('div', { class: 'rr-assistant__error', role: 'alert', hidden: true });
      const element = h('div', { class: 'rr-side rr-assistant' }, suggest, failure, island);
      let chat: { unmount(): void; draft(): Draft } | undefined, gone = false, loading = false, stale = false;
      // `follow`: shown again even while busy (a generation started: its turn is the server's, and the chat follows it)
      const load = (follow = false) => {
        loading = true;
        stale = false;
        void import('./thread').then(async (m) => {
          const response = await fetch('api/assistant');
          if (!response.ok) throw new Error(await response.text()); // a moved-aside conversation, invalid settings: why
          const initial = await response.json();
          if (gone) return;
          // checked again on arrival: a turn may have started, or the reviewer started typing, while this was out
          if (chat && busy() && !follow) return void (stale = true);
          failure.hidden = true;
          const draft = chat?.draft(); // the reviewer's text and attached context carry over
          chat?.unmount();
          chat = m.mount(island, (fn) => {
            take = fn;
            if (pending) fn(pending);
            pending = undefined;
            return () => (take = take === fn ? undefined : take);
          }, initial, draft);
        }).catch((error: unknown) => {
          if (gone) return;
          failure.textContent = error instanceof Error ? error.message : String(error);
          failure.hidden = false;
        }).finally(() => {
          loading = false;
          refresh();
        });
      };
      // the conversation changed on the server (a generation's turn, or one asked elsewhere): shown again once this page's
      // own turn has finished and no fetch is out; until then it waits, never dropped
      // nor while the reviewer is typing: a remount would take the caret (the draft itself carries over)
      const busy = () => !!island.querySelector('[data-rr-assistant-running]') || island.contains(document.activeElement);
      const refresh = () => {
        if (stale && !gone && !loading && !busy()) load();
      };
      island.addEventListener('focusout', () => setTimeout(refresh));
      load();
      const offTurn = app.bus.on('assistant-turn', () => {
        stale = true;
        refresh();
      });
      // a turn that ends here clears the running mark: apply what waited
      const watch = new MutationObserver(refresh);
      watch.observe(island, { subtree: true, attributes: true, attributeFilter: ['data-rr-assistant-running'], childList: true });
      // a generation starting while this is open: shown again, so the chat follows its turn from the start
      let generating = !!app.generation?.context.progress.generation?.running;
      const offGen = app.bus.on('generation', (s) => {
        paintSuggest();
        const now = !!s.context.progress.generation?.running;
        if (now && !generating && !gone) load(true);
        generating = now;
      });
      const dispose = () => {
        gone = true;
        offTurn();
        offGen();
        watch.disconnect();
        chat?.unmount();
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
}
