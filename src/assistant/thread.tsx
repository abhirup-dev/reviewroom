// A view of the page's conversation (chat.ts): assistant-ui's primitives on its AI SDK runtime, over the page's one
// Chat. The Chat owns the messages, streaming, stop and approvals; this file owns only which primitives show and their
// Review Room classes. Any number of views show the same Chat.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, type QuoteInfo, type TextMessagePartProps, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/ai-sdk';
import { useChat } from '@ai-sdk/react';
import { renderMarkdown } from '../kernel/markdown';
import { h } from '../kernel/dom';
import { CLAWD } from '../kernel/clawd';
import type { AskContext } from './context.shared';
import { toolTarget, toolVerb } from './tool.shared';
import type { AssistantChat, AssistantState } from './chat';

// a read-only view (the loading screen's): no composer, no approvals
const ReadOnly = createContext(false);

// Review Room's sanitised Markdown, as in threads
const Text = ({ text }: TextMessagePartProps) => <div className="rr-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;

/** A native tool call, in a hairline box: verb, target and a faint state word. A failed one looks like any other (the
 *  assistant carries on: nothing red). A call the native policy asks about waits for Allow or Deny. */
function Tool({ toolName, args, status, isError, approval, respondToApproval }: ToolCallMessagePartProps) {
  const summary = toolTarget(args);
  const readOnly = useContext(ReadOnly);
  const asking = approval && approval.approved === undefined;
  // asked to approve: the raw command or path, never the short form (it drops `cd …&&` and leading directories)
  const raw = typeof args?.command === 'string' ? args.command : typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : summary;
  const state = asking ? 'needs approval' : status.type === 'running' ? 'running' : isError || status.type === 'incomplete' ? 'failed' : approval?.approved === false ? 'denied' : 'done';
  return (
    <div className={`rr-assistant__tool is-${state.replace(' ', '-')}`}>
      <span className="rr-assistant__tool-name" title={toolName}>{toolVerb(toolName)}</span>
      <code title={asking ? raw : undefined}>{asking ? raw : summary}</code>
      <span className="rr-assistant__tool-state">{state}</span>
      {asking && !readOnly && (
        <span className="rr-assistant__approve">
          <button className="rr-btn rr-btn--primary" onClick={() => void respondToApproval({ approved: true }).catch(console.error)}>Allow</button>
          <button className="rr-btn" onClick={() => void respondToApproval({ approved: false, reason: 'The reviewer denied it.' }).catch(console.error)}>Deny</button>
        </span>
      )}
    </div>
  );
}

/** What a question is about: Review Room's own link chip (its label, icon and opening); the runtime keeps the quote as set. */
const About = ({ quote }: { quote: QuoteInfo | undefined }) => {
  const c = quote as AskContext | undefined;
  return c?.ref ? <span className="rr-assistant__about" title={c.text} ref={(el) => { el?.replaceChildren(h('rr-ref', { ref: c.ref })); }} /> : null;
};
const ComposerAbout = () => <About quote={useAuiState((s) => s.composer.quote)} />;

/** A long message shows its first lines; Show more opens the rest (the generate prompt reads as instructions). */
function Capped({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    const resized = new ResizeObserver(check); // a narrower panel can push a message past the cap
    resized.observe(el);
    return () => resized.disconnect();
  }, [open]);
  return (
    <>
      <div ref={ref} className={`rr-assistant__cap${open ? ' is-open' : long ? ' is-long' : ''}`}>{children}</div>
      {long && <button type="button" className="rr-link-btn rr-assistant__more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
    </>
  );
}

/** What you sent, on the right, as in a chat. The generate prompt (api/generate) is long and reads as instructions:
 *  one folded line across the transcript instead, opened on request. */
const UserMessage = () => {
  const generate = useAuiState((s) => !!s.message.metadata.custom?.generate);
  return generate ? (
    <MessagePrimitive.Root className="rr-assistant__msg is-prompt">
      <details className="rr-assistant__prompt">
        <summary title="Show the prompt the assistant was given">Generate review artifacts</summary>
        <MessagePrimitive.Parts />
      </details>
    </MessagePrimitive.Root>
  ) : (
    <MessagePrimitive.Root className="rr-assistant__msg is-user">
      <MessagePrimitive.Quote>{(quote) => <About quote={quote} />}</MessagePrimitive.Quote>
      <Capped><MessagePrimitive.Parts /></Capped>
    </MessagePrimitive.Root>
  );
};

/** The read-only view's signature, at its foot: Clawd, "Claude" and, while it works, Clawd's bob, the busy dots and a
 *  quiet Stop at the line's end. */
function Who({ service, state }: { service: AssistantChat; state: AssistantState }) {
  // the server's turn counts too: a dropped stream ends the runtime's run while Claude still works (as Status does)
  const busy = useAuiState((s) => s.thread.isRunning) || !!state.activeStreamId;
  return (
    <div className="rr-assistant__foot">
      <span className="rr-assistant__who" role="status" aria-label={busy ? 'Claude is working' : 'Claude'}>
        <img className={`rr-clawd${busy ? ' is-working' : ''}`} src={CLAWD} width={14} height={14} alt="" />
        <span>Claude</span>
        {busy && <span className="rr-dots" aria-hidden="true"><i /><i /><i /></span>}
      </span>
      {state.activeStreamId && <button type="button" className="rr-link-btn rr-assistant__stop" title="Stop Claude's current turn" disabled={!state.connected} onClick={() => void service.stop().catch(() => undefined) /* the turn's own state shows whether it stopped */}>Stop</button>}
    </div>
  );
}

/** Follows the transcript as it grows: always on the loading screen; in the panel only while you are at its foot
 *  (scroll up to read and it stays put; back at the foot, it follows again). */
function useTail(always: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let atFoot = true;
    const onScroll = () => {
      atFoot = el.scrollHeight - el.clientHeight - el.scrollTop < 32; // a line's slack
      el.toggleAttribute('data-scrolled', el.scrollTop > 0); // what scrolled away fades under the top edge (CSS)
    };
    const follow = () => {
      if (always || atFoot) el.scrollTop = el.scrollHeight;
      onScroll();
    };
    const grew = new MutationObserver(follow);
    grew.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    follow();
    return () => { grew.disconnect(); el.removeEventListener('scroll', onScroll); };
  }, [always]);
  return ref;
}

const AssistantMessage = () => (
  <MessagePrimitive.Root className="rr-assistant__msg">
    <MessagePrimitive.Parts components={{ Text, tools: { Fallback: Tool } }} />
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="rr-assistant__error">
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  </MessagePrimitive.Root>
);

/** The panel's status, at its foot beside Send: the model and what it is doing (the busy dots run at the transcript's
 *  foot, the one busy signal). */
function Status({ state }: { state: AssistantState }) {
  const running = useAuiState((s) => s.thread.isRunning);
  // Stop ends the browser stream before the server has saved/checkpointed it. Hold reload through both.
  const busy = running || !!state.activeStreamId;
  const status = !state.connected ? 'reconnecting' : busy ? 'working' : state.status === 'interrupted' ? 'interrupted, ask it to continue' : state.status === 'failed' ? 'stopped, ask again' : 'ready';
  return (
    <div className="rr-assistant__status" role="status" data-rr-assistant-running={busy ? '' : undefined}>
      <span title={state.model}>{state.model} · {status}</span>
    </div>
  );
}
function View({ service, host, readOnly, extra }: { service: AssistantChat; host: HTMLElement; readOnly: boolean; extra?: HTMLElement }) {
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const runtime = useAISDKRuntime(useChat({ chat: service.chat }));
  const tail = useTail(readOnly);
  const stop = state.activeStreamId && <button type="button" className="rr-btn" title="Stop Claude's current turn" disabled={!state.connected} onClick={() => void service.stop().catch(console.error)}>Stop</button>;
  // the composer takes what the store holds for it: the context asked about, a refused question's text
  useEffect(() => {
    if (readOnly || (!state.quote && state.draft === undefined)) return;
    if (state.quote) runtime.thread.composer.setQuote(state.quote);
    if (state.draft !== undefined) runtime.thread.composer.setText(state.draft);
    service.take(state.quote ? 'quote' : 'draft');
    host.querySelector('textarea')?.focus();
  }, [runtime, service, host, readOnly, state.quote, state.draft]);
  return (
    <ReadOnly.Provider value={readOnly}>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className={`rr-assistant__thread${readOnly ? ' is-readonly' : ''}`}>
        {state.error && <div className="rr-assistant__error" role="status">{state.error}</div>}
        <div className="rr-assistant__box">
        <ThreadPrimitive.Viewport ref={tail} autoScroll={false} className="rr-scroll rr-assistant__viewport">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="rr-empty">Ask Claude Code about this review. It runs on this machine with your login, and can read the diff and run git, gh and reviewroom.</div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <AuiIf condition={(s) => !readOnly && s.thread.isRunning}>
            <span className="rr-assistant__working rr-dots" role="status" aria-label="Working"><i /><i /><i /></span>
          </AuiIf>
        </ThreadPrimitive.Viewport>
        </div>
        {/* read-only: Claude's line under the box, then the host's own controls (the loading screen's) */}
        {readOnly && <Who service={service} state={state} />}
        {readOnly && <div className="rr-assistant__actions"><span className="rr-assistant__extra" ref={(el) => { if (el && extra && el.firstChild !== extra) el.replaceChildren(extra); }} /></div>}
        {!readOnly && <ComposerPrimitive.Root className="rr-composer rr-assistant__composer">
          <ComposerPrimitive.Quote className="rr-assistant__quote">
            <ComposerAbout />
            <ComposerPrimitive.QuoteDismiss className="rr-icon-btn" title="Don't attach this" aria-label="Remove the attached context">×</ComposerPrimitive.QuoteDismiss>
          </ComposerPrimitive.Quote>
          <ComposerPrimitive.Input className="rr-composer__input" placeholder="Ask about this change" rows={2} />
          <div className="rr-assistant__actions">
            <Status state={state} />
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send className="rr-btn rr-btn--agent" disabled={!state.connected || !!state.activeStreamId}>Send</ComposerPrimitive.Send>
            </AuiIf>
            {stop}
          </div>
        </ComposerPrimitive.Root>}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
    </ReadOnly.Provider>
  );
}

/** Shows the page's conversation in `host`. `readOnly`: no composer, approvals or sends (generation's loading screen).
 *  Returns the unmount. */
export function mount(host: HTMLElement, service: AssistantChat, { readOnly = false, extra }: { readOnly?: boolean; extra?: HTMLElement } = {}) {
  const root = createRoot(host);
  root.render(<View service={service} host={host} readOnly={readOnly} extra={extra} />);
  return () => root.unmount();
}
