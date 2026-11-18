// Where the review's one conversation with the assistant stands, and what each place allows. Pure: assistant.ts holds
// the phase, moves it with these functions and does what the tables say.
import type { ReplayStream } from './replay-stream.ts';

/** What started a turn: the reviewer's question, or api/generate. A paused turn keeps its origin when continued. */
export type Origin = 'question' | 'generation';
/** `running`: its stream (`id`, the AI SDK's active stream id), the model it runs on, how to stop it and when it ended.
 *  `paused`: the native session holds the last turn on an approval (allow-all asks nothing; kept so a pause never reads
 *  as failed). `starting`: before the server holds its lock and has recovered (generation's own turn could be stopped
 *  by that recovery). */
export type Phase =
  | { name: 'starting' }
  | { name: 'idle' }
  | { name: 'running'; origin: Origin; id: string; model: string; stream: ReplayStream; abort: AbortController; done: Promise<void> }
  | { name: 'paused'; origin: Origin; model: string }
  | { name: 'closing'; done: Promise<void> };
export type Running = Extract<Phase, { name: 'running' }>;

type Key = 'starting' | 'idle' | `${'running' | 'paused'}:${Origin}` | 'closing';
export const keyOf = (p: Phase): Key => ('origin' in p ? `${p.name}:${p.origin}` : p.name);

const BUSY = { error: 'The assistant is answering a question; generate when it is done.', code: 'busy' };
const CLOSING = 'The review is closing.';
const STARTING = 'The review is still starting';
/** Why a question (POST api/assistant) is refused (409), by phase; null: taken (an approval answers a paused turn). */
const ASK: Record<Key, string | null> = {
  starting: `${STARTING}; ask in a moment.`,
  idle: null,
  'running:question': 'The assistant is already answering a question.',
  'running:generation': 'The assistant is writing the review.',
  'paused:question': null,
  'paused:generation': null,
  closing: CLOSING,
};
/** Why api/generate starts nothing, by phase: refused (409), `running` (it already runs: answered `started: false`), or
 *  null: it starts. */
const GENERATE: Record<Key, { error: string; code: string } | 'running' | null> = {
  starting: { error: `${STARTING}; generate in a moment.`, code: 'starting' },
  idle: null,
  'running:question': BUSY,
  'paused:question': BUSY,
  'running:generation': 'running',
  'paused:generation': 'running',
  closing: { error: CLOSING, code: 'closing' },
};
export const askRefusal = (p: Phase) => ASK[keyOf(p)];
export const generateRefusal = (p: Phase) => GENERATE[keyOf(p)];

/** Where a generation stands, as the pages read it (progress' `generation`). */
export const generationOf = (p: Phase) => ({ running: 'origin' in p && p.origin === 'generation', awaitingApproval: p.name === 'paused' && p.origin === 'generation' });
/** A question's turn: it continues what is paused (its origin and, for an approval, its model). */
export const originOf = (p: Phase): Origin => (p.name === 'paused' ? p.origin : 'question');
export const modelFor = (p: Phase, asking: boolean, fromSettings: () => string) => (!asking && p.name === 'paused' ? p.model : fromSettings());
/** Where a turn's end leaves the conversation: a closing review stays closing; a turn the native session holds waits. */
export const afterTurn = (now: Phase, ended: Running, paused: boolean): Phase =>
  now.name === 'closing' ? now : paused ? { name: 'paused', origin: ended.origin, model: ended.model } : { name: 'idle' };
