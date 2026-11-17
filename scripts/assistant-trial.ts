// Manual native-agent trial: bun scripts/assistant-trial.ts <review URL> <prompt>.
// Requires a REVIEWROOM_ASSISTANT=1 server and the user's native agent login; makes a real model call.
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai';

const [url, prompt] = process.argv.slice(2);
if (!url || !prompt) throw new Error('Usage: bun scripts/assistant-trial.ts <review URL> <prompt>');
const endpoint = new URL('api/assistant', url.endsWith('/') ? url : url + '/').href;
const initial = await fetch(endpoint);
if (!initial.ok) throw new Error(await initial.text());
const state = await initial.json() as { messages: UIMessage[]; model: string };
const messages: UIMessage[] = [...state.messages, { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] }];
const transport = new DefaultChatTransport({ api: endpoint });
const stream = await transport.sendMessages({ trigger: 'submit-message', chatId: 'trial', messageId: undefined, messages, abortSignal: AbortSignal.timeout(120000) });
let reply: UIMessage | undefined;
for await (const message of readUIMessageStream({ stream, terminateOnError: true })) reply = message;
const restored = await (await fetch(endpoint)).json() as { messages: UIMessage[]; model: string };
console.log(JSON.stringify({
  model: state.model,
  text: reply?.parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
  savedMessages: restored.messages.length,
  lastMetadata: restored.messages.at(-1)?.metadata,
  ids: restored.messages.map((m) => m.id),
}));
