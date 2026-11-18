// The page's one conversation with the assistant, and its one store: the AI SDK Chat (the messages) plus what the
// server says of the conversation, the connection and the context asked about. Views (./thread.tsx: the panel, the
// loading screen's window) read it with useSyncExternalStore and keep no state of their own.
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { errorText } from '../kernel/errors.shared';
import type { Connection } from '../kernel/providers/contracts';
import type { AskContext } from './context.shared';

/** GET api/assistant: the saved conversation and the turn it ends in (`activeStreamId`, the AI SDK's resumable stream
 *  id; `origin`: any page can stop a question's turn, none a generation's). */
export type Conversation = { model: string; status: 'idle' | 'working' | 'interrupted' | 'failed'; messages: UIMessage[]; activeStreamId: string | null; origin: 'question' | 'generation' | null };
/** `error`: why the conversation could not load, or why a question was refused. `quote`, `draft`: for the composer to
 *  take (the context asked about; a refused question's text). */
export type AssistantState = Omit<Conversation, 'messages'> & { connected: boolean; error?: string; quote?: AskContext; draft?: string };

const text = (m: UIMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

export function createAssistantChat() {
  let state: AssistantState = { model: '', status: 'idle', activeStreamId: null, origin: null, connected: true };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AssistantState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  let since: string | null = null; // the server's start the store last saw
  // the turn this chat streams or streamed (sent here or followed): never followed twice
  let followed: string | null = null;
  const chat = new Chat<UIMessage>({
    id: 'review', // one conversation per review: the server ignores it
    transport: new DefaultChatTransport({
      api: 'api/assistant', // relative: the page's own review server
      // the turn the history named: 204 if it ended meanwhile (or another took its place)
      prepareReconnectToStreamRequest: ({ api, id }) => ({ api: `${api}/${id}/stream?turn=${encodeURIComponent(followed ?? '')}` }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses, // an Allow or Deny continues the turn
    onFinish: () => void sync(), // the saved answer (its model, a stopped one's state)
    onError: (e) => {
      // refused (another window asked first): the conversation again, the question back in the composer
      const asked = chat.messages.at(-1);
      void sync().then(() => {
        const gone = asked?.role === 'user' && !chat.messages.some((m) => m.id === asked.id);
        set({ error: errorText(e), ...(gone ? { draft: text(asked) } : {}) });
      });
    },
  });
  const busy = () => chat.status === 'submitted' || chat.status === 'streaming';

  /** The saved history into the chat, then its running turn followed to its end; the history again after. */
  async function once() {
    const response = await fetch('api/assistant');
    if (!response.ok) return set({ error: await response.text() }); // a moved-aside conversation, invalid settings
    const { messages, ...c }: Conversation = await response.json();
    set({ ...c, error: undefined });
    if (busy()) {
      followed = c.activeStreamId ?? followed; // this chat has that turn already: its end syncs again
      return;
    }
    chat.messages = messages;
    if (!c.activeStreamId || c.activeStreamId === followed) return;
    followed = c.activeStreamId;
    await chat.resumeStream(); // to its end, or at once (204)
    again = true;
  }
  // single-flight: one sync out; asked meanwhile, one more after it (the same shape as layouts/save.machine.ts)
  let out: Promise<void> | undefined;
  let again = false;
  function sync(): Promise<void> {
    if (out) {
      again = true;
      return out;
    }
    out = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again);
      } catch (e) {
        set({ error: errorText(e) });
      } finally {
        out = undefined;
      }
    })();
    return out;
  }

  return {
    chat,
    sync,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getState: () => state,
    /** The page's event stream to its server (ServerState's): back, or a server started anew, the conversation is
     *  taken again (a turn may have ended meanwhile). */
    connected({ live, started }: Connection) {
      const back = live && (!state.connected || started !== since);
      since = started;
      if (live !== state.connected) set({ connected: live });
      if (back) {
        followed = null;
        void sync();
      }
    },
    /** The composer took the quote or the draft. */
    take: (key: 'quote' | 'draft') => set({ [key]: undefined }),
    /** Asks about a context once it is read; a newer ask wins over a slower read. Throws only for the latest. */
    ask: (() => {
      let latest = 0;
      return async (read: Promise<AskContext>) => {
        const n = ++latest;
        try {
          const quote = await read;
          if (n === latest) set({ quote });
        } catch (e) {
          if (n === latest) throw e;
        }
      };
    })(),
    /** Stops the running question's turn, for every page following it (POST stop; a page that leaves only detaches). */
    stop: () => fetch('api/assistant/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streamId: state.activeStreamId }) }),
  };
}
export type AssistantChat = ReturnType<typeof createAssistantChat>;
