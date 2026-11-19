// A view of the page's conversation (chat.ts): assistant-ui's primitives on its AI SDK runtime, over the page's one
// Chat. The Chat owns the messages, streaming, stop and approvals; this file owns only which primitives show and their
// Review Room classes. Any number of views show the same Chat.
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, type QuoteInfo, type TextMessagePartProps, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/ai-sdk';
import { useChat } from '@ai-sdk/react';
import { renderMarkdown } from '../kernel/markdown';
import { h } from '../kernel/dom';
import type { AskContext } from './context.shared';
import type { AssistantChat, AssistantState } from './chat';

// a read-only view (the loading screen's): no composer, no approvals
const ReadOnly = createContext(false);

// Review Room's sanitised Markdown, as in threads
const Text = ({ text }: TextMessagePartProps) => <div className="rr-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;

/** A native tool call: its name and state; a call the native policy asks about waits for Allow or Deny. */
function Tool({ toolName, args, status, isError, approval, respondToApproval }: ToolCallMessagePartProps) {
  const summary = typeof args?.command === 'string' ? args.command : typeof args?.file_path === 'string' ? args.file_path : '';
  const readOnly = useContext(ReadOnly);
  const asking = approval && approval.approved === undefined;
  const state = asking ? 'needs approval' : status.type === 'running' ? 'running' : isError || status.type === 'incomplete' ? 'failed' : approval?.approved === false ? 'denied' : 'done';
  return (
    <div className={`rr-assistant__tool is-${state.replace(' ', '-')}`}>
      <span className="rr-assistant__tool-name">{toolName}</span>
      <code title={asking ? summary : undefined}>{summary}</code>{/* the full command only where it is approved */}
      <span className="rr-muted">{state}</span>
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

const UserMessage = () => {
  // the generate prompt (api/generate) is long and reads as instructions: one line, opened on request
  const generate = useAuiState((s) => !!s.message.metadata.custom?.generate);
  return (
    <MessagePrimitive.Root className="rr-assistant__msg is-user">
      <MessagePrimitive.Quote>{(quote) => <About quote={quote} />}</MessagePrimitive.Quote>
      {generate ? (
        <details className="rr-assistant__prompt">
          <summary title="Show the prompt the assistant was given">Generate review artifacts</summary>
          <MessagePrimitive.Parts />
        </details>
      ) : <MessagePrimitive.Parts />}
    </MessagePrimitive.Root>
  );
};

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

function AgentLabel({ state }: { state: AssistantState }) {
  const running = useAuiState((s) => s.thread.isRunning);
  // Stop ends the browser stream before the server has saved/checkpointed it. Hold reload through both.
  const busy = running || !!state.activeStreamId;
  const status = !state.connected ? 'Disconnected. Waiting for the server…' : busy ? 'Working…' : state.status === 'interrupted' ? 'Interrupted. You can ask it to continue.' : state.status === 'failed' ? 'Failed. You can try again.' : 'Ready';
  return <div className="rr-assistant__model rr-muted" role="status" data-rr-assistant-running={busy ? '' : undefined}>Model: {state.model} · {status}</div>;
}
function View({ service, host, readOnly }: { service: AssistantChat; host: HTMLElement; readOnly: boolean }) {
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const runtime = useAISDKRuntime(useChat({ chat: service.chat }));
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
      <ThreadPrimitive.Root className="rr-assistant__thread">
        {state.error && <div className="rr-assistant__error" role="alert">{state.error}</div>}
        <ThreadPrimitive.Viewport className="rr-scroll rr-assistant__viewport">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="rr-empty">Ask Claude Code about this review. It runs on this machine with your login, and can read the diff and run git, gh and reviewroom.</div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <AuiIf condition={(s) => s.thread.isRunning}>
            <div className="rr-assistant__working rr-muted">Working…</div>
          </AuiIf>
        </ThreadPrimitive.Viewport>
        {readOnly && stop && <div className="rr-assistant__actions">{stop}</div>}
        {!readOnly && <ComposerPrimitive.Root className="rr-composer rr-assistant__composer">
          <ComposerPrimitive.Quote className="rr-assistant__quote">
            <ComposerAbout />
            <ComposerPrimitive.QuoteDismiss className="rr-icon-btn" title="Don't attach this" aria-label="Remove the attached context">×</ComposerPrimitive.QuoteDismiss>
          </ComposerPrimitive.Quote>
          <AgentLabel state={state} />
          <ComposerPrimitive.Input className="rr-composer__input" placeholder="Ask about this change" rows={2} />
          <div className="rr-assistant__actions">
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send className="rr-btn rr-btn--primary" disabled={!state.connected || !!state.activeStreamId}>Send</ComposerPrimitive.Send>
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
export function mount(host: HTMLElement, service: AssistantChat, { readOnly = false } = {}) {
  const root = createRoot(host);
  root.render(<View service={service} host={host} readOnly={readOnly} />);
  return () => root.unmount();
}
