// Every change to state.json is one of these ops, applied by one pure reducer.
// Shared by the CLI/server (the single writer) and the browser (optimistic apply).
// No DOM or Node imports, so both the client bundle and the CLI can import it.
//
// Ops are absolute (setPin {pinned}, not a toggle) and creates are keyed by
// client-made ids, so re-applying an op that already landed changes nothing.

import type { ReviewState, Thread } from './model.shared';
import { issueText, Op, type Round } from './schema.shared';

const STATUS = { bad_op: 400, not_found: 404, conflict: 409 };
export type OpErrorCode = keyof typeof STATUS;

/** An error for whoever asked: the server answers with `status` and the message, the CLI prints the message and exits 1. */
export class ReviewroomError extends Error {
  status: number;
  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export class OpError extends ReviewroomError {
  code: OpErrorCode;
  /** Set by the server: which op of a batch failed. */
  index?: number;
  constructor(code: OpErrorCode, message: string) {
    super(message, STATUS[code]);
    this.code = code;
  }
}

const opName = (o: unknown) => JSON.stringify((o as { op?: unknown } | null)?.op ?? null);
const thread = (s: ReviewState, id: string): Thread => s.threads.find((t) => t.id === id) || (() => { throw new OpError('not_found', `no thread ${id}`); })();
const message = (t: Thread, id: string) => t.messages.find((m) => m.id === id) || (() => { throw new OpError('not_found', `no message ${id} in thread ${t.id}`); })();

/**
 * Apply one op and return the new state (the input is not modified). Bumps `rev`.
 */
export function applyOp(state: ReviewState, input: Op): ReviewState {
  // ops arrive as JSON from the browser and the CLI: check them against the schema, not just the type
  const parsed = Op.safeParse(input);
  if (!parsed.success) throw new OpError('bad_op', `bad ${opName(input)} op: ${issueText(parsed.error)}`);
  const op = parsed.data;
  const s = structuredClone(state);
  const now = 'at' in op && typeof op.at === 'string' ? op.at : new Date().toISOString();
  switch (op.op) {
    case 'createThread': {
      if (s.threads.some((t) => t.id === op.id)) break; // already created
      s.threads.push({ id: op.id, anchor: op.anchor, status: 'open', createdRound: s.round, messages: [{ id: op.msgId, author: op.author, round: s.round, body: op.body, at: now }] });
      break;
    }
    case 'addMessage': {
      const t = thread(s, op.threadId);
      if (t.messages.some((m) => m.id === op.id)) break; // already added
      t.messages.push({ id: op.id, author: op.author, round: s.round, body: op.body, at: now });
      break;
    }
    case 'editMessage':
      message(thread(s, op.threadId), op.msgId).body = op.body;
      break;
    case 'deleteMessage': {
      // already gone is fine: a retried delete must not fail
      const t = s.threads.find((x) => x.id === op.threadId);
      if (!t) break;
      t.messages = t.messages.filter((m) => m.id !== op.msgId);
      if (!t.messages.length) s.threads = s.threads.filter((x) => x !== t);
      break;
    }
    case 'setThreadStatus':
      thread(s, op.threadId).status = op.status;
      break;
    case 'setViewed':
      if (op.viewed) s.viewed[op.path] = s.round;
      else delete s.viewed[op.path];
      break;
    case 'setPin':
      s.pins = (s.pins ?? []).filter((p) => p !== op.ref);
      if (op.pinned) s.pins.push(op.ref);
      break;
    case 'setCheck':
      s.checks = { ...s.checks, [op.id]: op.value };
      break;
    case 'setLinks':
      s.links = op.links;
      break;
    case 'finishRound': {
      const r = s.rounds.find((x) => x.n === s.round);
      if (op.round !== undefined && op.round !== s.round) throw new OpError('conflict', `round ${op.round} is already finished (now round ${s.round})`);
      if (r && r.status !== 'open') throw new OpError('conflict', `round ${s.round} is already ${r.status}`);
      // deliveredAt null = finished, not yet printed to the agent (absent on rounds from before this field existed)
      const done: Pick<Round, 'status' | 'sentAt' | 'note' | 'deliveredAt'> = { status: op.kind === 'approve' ? 'approved' : 'sent', sentAt: now, note: op.note || undefined, deliveredAt: null };
      if (r) Object.assign(r, done);
      else s.rounds.push({ n: s.round, startedAt: now, ...done });
      if (op.kind === 'feedback') {
        s.round += 1;
        s.rounds.push({ n: s.round, status: 'open', startedAt: now });
      }
      break;
    }
    case 'markDelivered': {
      const r = s.rounds.find((x) => x.n === op.round);
      if (!r) throw new OpError('not_found', `no round ${op.round}`);
      r.deliveredAt ??= now;
      break;
    }
    default:
      throw new OpError('bad_op', `unknown op ${JSON.stringify((op as { op: unknown }).op)}`); // unreachable: the schema rejects it
  }
  s.rev = (s.rev ?? 0) + 1;
  return s;
}

/** Rounds finished but never printed to the agent, oldest first. */
/** The round the review is on. */
export const currentRound = (s: Pick<ReviewState, 'rounds' | 'round'>) => s.rounds.find((r) => r.n === s.round);
/** Open threads whose last word is the reviewer's: the agent owes them a reply. */
export const awaitingAgent = (s: Pick<ReviewState, 'threads'>) => s.threads.filter((t) => t.status === 'open' && t.messages.at(-1)?.author === 'you');
export const undelivered = (s: ReviewState) => s.rounds.filter((r) => r.status !== 'open' && r.deliveredAt === null);

/** Open threads at the start of a round, each list latest interaction first: `active` the reviewer wrote in last round,
 *  `rest` the others, `stale` those of the others open across more than two rounds. */
export function recapThreads(s: ReviewState) {
  const last = (t: ReviewState['threads'][number]) => t.messages.at(-1)?.at ?? '';
  const open = s.threads.filter((t) => t.status === 'open').sort((a, b) => last(b).localeCompare(last(a)));
  const active = open.filter((t) => t.messages.some((m) => m.author === 'you' && m.round === s.round - 1));
  const stale = open.filter((t) => !active.includes(t) && s.round - t.createdRound >= 2);
  return { active, rest: open.filter((t) => !active.includes(t) && !stale.includes(t)), stale };
}
