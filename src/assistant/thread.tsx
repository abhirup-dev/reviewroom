// The assistant's chat: assistant-ui's primitives on its AI SDK runtime. The runtime owns the messages, streaming,
// stop and approvals; this file owns only which primitives show and their Review Room classes.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, type QuoteInfo, type TextMessagePartProps, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { AssistantChatTransport, useAISDKChat, useChatRuntime } from '@assistant-ui/ai-sdk';
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { renderMarkdown } from '../kernel/markdown';
import { h } from '../kernel/dom';
import { wantReload } from '../kernel/pwa';
import type { AskContext } from './context.shared';

/** Hands the chat each context the reviewer asks about; returns the unsubscribe. */
type OnAsk = (take: (c: AskContext) => void) => () => void;
type AgentStatus = { model: string; instance: string; status: 'idle' | 'working' | 'interrupted' | 'failed' };
type InitialConversation = AgentStatus & { messages: UIMessage[] };
/** What the reviewer has in the composer: kept when the conversation is shown again from the server. */
export type Draft = { text: string; quote?: QuoteInfo };

// Review Room's sanitised Markdown, as in threads
const Text = ({ text }: TextMessagePartProps) => <div className="rr-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;

/** A native tool call: its name and state; a call the native policy asks about waits for Allow or Deny. */
function Tool({ toolName, args, status, isError, approval, respondToApproval }: ToolCallMessagePartProps) {
  const summary = typeof args?.command === 'string' ? args.command : typeof args?.file_path === 'string' ? args.file_path : '';
  const asking = approval && approval.approved === undefined;
  const state = asking ? 'needs approval' : status.type === 'running' ? 'running' : isError || status.type === 'incomplete' ? 'failed' : approval?.approved === false ? 'denied' : 'done';
  return (
    <div className={`rr-assistant__tool is-${state.replace(' ', '-')}`}>
      <span className="rr-assistant__tool-name">{toolName}</span>
      <code title={summary}>{summary}</code>
      <span className="rr-muted">{state}</span>
      {asking && (
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

const UserMessage = () => (
  <MessagePrimitive.Root className="rr-assistant__msg is-user">
    <MessagePrimitive.Quote>{(quote) => <About quote={quote} />}</MessagePrimitive.Quote>
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

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

function AgentLabel({ agent, connected }: { agent: AgentStatus; connected: boolean }) {
  const running = useAuiState((s) => s.thread.isRunning);
  // Stop ends the browser stream before the server has saved/checkpointed it. Hold reload through both.
  const busy = running || agent.status === 'working';
  const status = !connected ? 'Disconnected. Waiting for the server…' : busy ? 'Working…' : agent.status === 'interrupted' ? 'Interrupted. You can ask it to continue.' : agent.status === 'failed' ? 'Failed. You can try again.' : 'Ready';
  return <div className="rr-assistant__model rr-muted" role="status" data-rr-assistant-running={busy ? '' : undefined}>Model: {agent.model} · {status}</div>;
}

/** A turn this window didn't start (a generation, or a question asked in another window) runs on the server: the AI
 *  SDK's resumable stream follows it from its start (api/assistant/<id>/stream; nothing to follow: 204). */
function Resume() {
  const chat = useAISDKChat(); // provided after the first render
  const resumed = useRef(false);
  useEffect(() => {
    if (!chat || resumed.current) return;
    resumed.current = true;
    void chat.resumeStream().catch(console.error);
  }, [chat]);
  return null;
}

function Chat({ onAsk, host, initial, draft, expose, readOnly }: { onAsk: OnAsk; host: HTMLElement; initial: InitialConversation; draft?: Draft; expose: (read: () => Draft) => void; readOnly?: boolean }) {
  const [agent, setAgent] = useState<AgentStatus>(initial);
  const [connected, setConnected] = useState(true);
  const runtime = useChatRuntime({
    messages: initial.messages,
    transport: new AssistantChatTransport({ api: 'api/assistant' }), // relative: the page's own review server
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses, // an Allow or Deny continues the turn
  });
  useEffect(() => {
    const composer = runtime.thread.composer;
    if (draft?.text) composer.setText(draft.text);
    if (draft?.quote) composer.setQuote(draft.quote);
    expose(() => ({ text: composer.getState().text, quote: composer.getState().quote }));
  }, [runtime]); // eslint-disable-line react-hooks/exhaustive-deps -- once per runtime: the draft it starts with
  useEffect(() => runtime.thread.subscribe(() => {
    if (runtime.thread.getState().isRunning) setAgent((current) => current.status === 'working' ? current : { ...current, status: 'working' });
  }), [runtime]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('api/assistant/model', { signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const next: AgentStatus = await response.json();
        if (controller.signal.aborted) return;
        setAgent(next);
        setConnected(next.instance === initial.instance);
        // The old browser runtime cannot continue a turn from the previous server. Restore the saved transcript.
        if (next.instance !== initial.instance) wantReload('review', 'the assistant server restarted');
      } catch {
        if (!controller.signal.aborted) setConnected(false);
      }
    };
    const timer = setInterval(() => void refresh(), 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [initial.instance]);
  useEffect(() => onAsk((c) => {
    runtime.thread.composer.setQuote(c);
    host.querySelector('textarea')?.focus();
  }), [runtime, onAsk, host]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Resume />
      <ThreadPrimitive.Root className="rr-assistant__thread">
        <ThreadPrimitive.Viewport className="rr-scroll rr-assistant__viewport">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="rr-empty">Ask Claude Code about this review. It runs on this machine with your login, and can read the diff and run git, gh and reviewroom.</div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <AuiIf condition={(s) => s.thread.isRunning}>
            <div className="rr-assistant__working rr-muted">Working…</div>
          </AuiIf>
        </ThreadPrimitive.Viewport>
        {!readOnly && <ComposerPrimitive.Root className="rr-composer rr-assistant__composer">
          <ComposerPrimitive.Quote className="rr-assistant__quote">
            <ComposerAbout />
            <ComposerPrimitive.QuoteDismiss className="rr-icon-btn" title="Don't attach this" aria-label="Remove the attached context">×</ComposerPrimitive.QuoteDismiss>
          </ComposerPrimitive.Quote>
          <AgentLabel agent={agent} connected={connected} />
          <ComposerPrimitive.Input className="rr-composer__input" placeholder="Ask about this change" rows={2} />
          <div className="rr-assistant__actions">
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send className="rr-btn rr-btn--primary" disabled={!connected || agent.status === 'working'}>Send</ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel className="rr-btn" title="Stop Claude's current turn">Stop</ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </ComposerPrimitive.Root>}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

/** Mounts the chat in `host`, with `draft` in its composer; `draft()` reads what is there now. `readOnly`: no composer
 *  (generation's loading screen). */
export function mount(host: HTMLElement, onAsk: OnAsk, initial: InitialConversation, draft?: Draft, readOnly = false) {
  const root = createRoot(host);
  let read: () => Draft = () => draft ?? { text: '' };
  root.render(<Chat onAsk={onAsk} host={host} initial={initial} draft={draft} expose={(r) => (read = r)} readOnly={readOnly} />);
  return { unmount: () => root.unmount(), draft: () => read() };
}
