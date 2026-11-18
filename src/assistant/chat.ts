// The page's one conversation with the assistant: one AI SDK Chat, whichever view shows it (the panel, the loading
// screen's window). `sync()` takes the saved history and, when a turn runs, follows it (the SDK's resumable stream).
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type ChatTransport, type UIMessage } from 'ai';

export type AgentStatus = { model: string; instance: string; status: 'idle' | 'working' | 'interrupted' | 'failed' };
export type Conversation = AgentStatus & { messages: UIMessage[]; running: boolean };
type Reconnect = Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0];
type Send = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];

export function createAssistantChat() {
  // the turn running here is one this page sent (its Stop stops it), not one it follows
  let asked = false;
  let latest: Promise<Conversation>;
  class Transport extends DefaultChatTransport<UIMessage> {
    override sendMessages(o: Send) {
      asked = true;
      return super.sendMessages(o);
    }
    override async reconnectToStream(o: Reconnect) {
      asked = false;
      const stream = await super.reconnectToStream(o);
      if (!stream) void sync(); // 204: the turn ended meanwhile; its answer is in the history
      return stream;
    }
  }
  const chat = new Chat<UIMessage>({
    id: 'review', // one conversation per review: the server ignores it
    transport: new Transport({ api: 'api/assistant' }), // relative: the page's own review server
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses, // an Allow or Deny continues the turn
    onFinish: () => void sync(), // the saved answer (its model, a stopped one's state)
  });
  const busy = () => chat.status === 'submitted' || chat.status === 'streaming';
  /** The saved history into the chat, then the running turn followed. While the chat follows or sends a turn it waits
   *  for that turn's end, which syncs again. */
  function sync(): Promise<Conversation> {
    if (busy() && latest !== undefined) return latest;
    latest = (async () => {
      const response = await fetch('api/assistant');
      if (!response.ok) throw new Error(await response.text()); // a moved-aside conversation, invalid settings: why
      const c: Conversation = await response.json();
      if (!busy()) {
        chat.messages = c.messages;
        if (c.running) void chat.resumeStream();
      }
      return c;
    })();
    latest.catch((e: unknown) => console.error(`reviewroom: the assistant: ${e instanceof Error ? e.message : String(e)}`));
    return latest;
  }
  return { chat, sync, latest: () => latest ?? sync(), asked: () => asked };
}
export type AssistantChat = ReturnType<typeof createAssistantChat>;
