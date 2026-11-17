// The assistant's chat: assistant-ui's primitives on its AI SDK runtime. The runtime owns the messages, streaming,
// stop and approvals; this file owns only which primitives show and their Review Room classes.
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, type TextMessagePartProps, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { renderMarkdown } from '../kernel/markdown';

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

const UserMessage = () => (
  <MessagePrimitive.Root className="rr-assistant__msg is-user">
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

function Chat() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: 'api/assistant' }), // relative: works at / and through the hub's /r/<id>/
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses, // an Allow or Deny continues the turn
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
        <ComposerPrimitive.Root className="rr-composer rr-assistant__composer">
          <ComposerPrimitive.Input className="rr-composer__input" placeholder="Ask about this change" rows={2} />
          <div className="rr-assistant__actions">
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send className="rr-btn rr-btn--primary">Send</ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel className="rr-btn" title="Stop Claude's current turn">Stop</ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export function mount(host: HTMLElement) {
  const root = createRoot(host);
  root.render(<Chat />);
  return () => root.unmount();
}
