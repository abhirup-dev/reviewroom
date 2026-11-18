// The page's one conversation with the assistant, and its one store: the AI SDK Chat (the messages) plus what the
// server says of the conversation, the connection and the context asked about. Views (./thread.tsx: the panel, the
// loading screen's window) read it with useSyncExternalStore and keep no state of their own.
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { errorText } from '../kernel/errors.shared';
import type { Connection } from '../kernel/providers/contracts';
import { TURN_HEADER, type AskContext } from './context.shared';

/** GET api/assistant: the saved conversation and the turn it ends in (`activeStreamId`, the AI SDK's resumable stream
 *  id; `origin`: any page can stop a question's turn, none a generation's). */
export type Conversation = { model: string; status: 'idle' | 'working' | 'interrupted' | 'failed'; messages: UIMessage[]; activeStreamId: string | null; origin: 'question' | 'generation' | null };
/** `error`: why the conversation could not load, or why a question was refused. `quote`, `draft`: for the composer to
 *  take (the context asked about; a refused question's text). */
export type AssistantState = Omit<Conversation, 'messages'> & { connected: boolean; error?: string; quote?: AskContext; draft?: string };

const text = (m: UIMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** `body`, telling `done` once when it ends, fails or its reader leaves. */
function whileRead(body: ReadableStream<Uint8Array>, done: () => void) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const x = await reader.read();
        if (x.done) {
          done();
          c.close();
        } else c.enqueue(x.value);
      } catch (e) {
        done();
        c.error(e);
      }
    },
    cancel: (why) => {
      done();
      return reader.cancel(why);
    },
  });
}

export function createAssistantChat() {
  let state: AssistantState = { model: '', status: 'idle', activeStreamId: null, origin: null, connected: true };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AssistantState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  let since: string | null = null; // the server's start the store last saw
  /** The stream this chat is attached to, from the request it made (a question's POST, a resume) until that response
   *  ends, fails or is dropped; `turn` once the response names it. Detached, a sync takes the saved history. */
  let attached: { turn: string | null } | undefined;
  let want = ''; // the turn the last snapshot named, for the resume request
  const chat = new Chat<UIMessage>({
    id: 'review', // one conversation per review: the server ignores it
    transport: new DefaultChatTransport({
      api: 'api/assistant', // relative: the page's own review server
      // the turn the history named: 204 if it ended meanwhile (or another took its place)
      prepareReconnectToStreamRequest: ({ api, id }) => ({ api: `${api}/${id}/stream?turn=${encodeURIComponent(want)}` }),
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsc with Bun's types needs it (see below)
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const mine = { turn: null as string | null };
        attached = mine;
        const release = () => void (attached === mine && (attached = undefined));
        try {
          const response = await fetch(input, init);
          mine.turn = response.headers.get(TURN_HEADER);
          if (!response.body || !mine.turn) {
            release(); // refused, or 204: nothing to attach to
            if (response.status === 204) void sync(); // the turn ended, its end event perhaps missed: what is it now
            return response;
          }
          return new Response(whileRead(response.body, release), response);
        } catch (e) {
          release();
          throw e;
        }
      }) as typeof fetch, // Bun's fetch type adds `preconnect`, which the transport never calls
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses, // an Allow or Deny continues the turn
    // any end: the history again; refused (another window asked first) or dropped, why, a refused question back
    onFinish: ({ isError }) => {
      const asked = chat.messages.at(-1);
      void sync().then(() => {
        const gone = asked?.role === 'user' && !chat.messages.some((m) => m.id === asked.id);
        if (isError) set({ error: errorText(chat.error), ...(gone ? { draft: text(asked) } : {}) });
      });
    },
    onError: (e) => set({ error: errorText(e) }), // a failed replay isn't retried: the next snapshot follows again
  });

  /** The saved history into the chat; its running turn followed, not awaited (a stalled replay never holds a sync). */
  async function once() {
    let conversation: Conversation;
    try {
      const response = await fetch('api/assistant');
      if (!response.ok) throw new Error(await response.text()); // a moved-aside conversation, invalid settings
      conversation = await response.json();
    } catch (e) {
      // the transcript shown stays; no turn is known to run until a snapshot says so
      return set({ error: errorText(e), activeStreamId: null, origin: null });
    }
    const { messages, ...c } = conversation;
    set({ ...c, error: undefined });
    if (attached?.turn && attached.turn !== c.activeStreamId) void chat.stop(); // a stream it no longer names: let go
    else if (attached) return;
    chat.messages = messages;
    if (!c.activeStreamId) return;
    want = c.activeStreamId;
    void chat.resumeStream(); // to its end (onFinish: the history again), or 204: over, one fresh snapshot
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
      if (back) void sync();
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
