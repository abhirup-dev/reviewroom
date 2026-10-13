// Every change to state.json is one of these ops, applied by one pure reducer.
// Shared by the CLI/server (the single writer) and the browser (optimistic apply).
// Plain JS, no Node imports, so the client bundle can import it.
//
// Ops are absolute (setPin {pinned}, not a toggle) and creates are keyed by
// client-made ids, so re-applying an op that already landed changes nothing.

/** @typedef {import('../../src/core/types').ReviewState} ReviewState */
/** @typedef {import('../../src/core/types').Op} Op */

const STATUS = { bad_op: 400, not_found: 404, conflict: 409 };

export class OpError extends Error {
  /** @param {'bad_op' | 'not_found' | 'conflict'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new OpError('bad_op', `${name} must be a non-empty string`);
  return v;
};
const oneOf = (v, allowed, name) => {
  if (!allowed.includes(v)) throw new OpError('bad_op', `${name} must be one of ${allowed.join(', ')}`);
  return v;
};
const thread = (s, id) => s.threads.find((t) => t.id === id) || (() => { throw new OpError('not_found', `no thread ${id}`); })();
const message = (t, id) => t.messages.find((m) => m.id === id) || (() => { throw new OpError('not_found', `no message ${id} in thread ${t.id}`); })();
const AUTHORS = ['you', 'agent'];
const ANCHORS = ['doc', 'code', 'symbol', 'general'];

/**
 * Apply one op and return the new state (the input is not modified). Bumps `rev`.
 * @param {ReviewState} state @param {Op} op @returns {ReviewState}
 */
export function applyOp(state, op) {
  if (!op || typeof op !== 'object') throw new OpError('bad_op', 'op must be an object');
  const s = structuredClone(state);
  const now = typeof op.at === 'string' ? op.at : new Date().toISOString();
  switch (op.op) {
    case 'createThread': {
      str(op.id, 'id');
      if (s.threads.some((t) => t.id === op.id)) break; // already created
      if (!op.anchor || !ANCHORS.includes(op.anchor.kind)) throw new OpError('bad_op', 'anchor.kind must be one of ' + ANCHORS.join(', '));
      s.threads.push({ id: op.id, anchor: op.anchor, status: 'open', createdRound: s.round, messages: [{ id: str(op.msgId, 'msgId'), author: oneOf(op.author, AUTHORS, 'author'), round: s.round, body: str(op.body, 'body'), at: now }] });
      break;
    }
    case 'addMessage': {
      const t = thread(s, str(op.threadId, 'threadId'));
      if (t.messages.some((m) => m.id === op.id)) break; // already added
      t.messages.push({ id: str(op.id, 'id'), author: oneOf(op.author, AUTHORS, 'author'), round: s.round, body: str(op.body, 'body'), at: now });
      break;
    }
    case 'editMessage':
      message(thread(s, str(op.threadId, 'threadId')), str(op.msgId, 'msgId')).body = str(op.body, 'body');
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
      thread(s, str(op.threadId, 'threadId')).status = oneOf(op.status, ['open', 'resolved'], 'status');
      break;
    case 'setViewed':
      str(op.path, 'path');
      s.viewed ??= {};
      if (op.viewed) s.viewed[op.path] = s.round;
      else delete s.viewed[op.path];
      break;
    case 'setPin':
      str(op.ref, 'ref');
      s.pins = (s.pins ?? []).filter((p) => p !== op.ref);
      if (op.pinned) s.pins.push(op.ref);
      break;
    case 'setCheck':
      s.checks = { ...(s.checks ?? {}), [str(op.id, 'id')]: oneOf(op.value, ['todo', 'pass', 'fail'], 'value') };
      break;
    case 'setLinks':
      if (!op.links || typeof op.links !== 'object' || Object.values(op.links).some((v) => typeof v !== 'string')) throw new OpError('bad_op', 'links must map rr: links to hashes');
      s.links = op.links;
      break;
    case 'finishRound': {
      oneOf(op.kind, ['feedback', 'approve'], 'kind');
      const r = s.rounds.find((x) => x.n === s.round);
      if (op.round !== undefined && op.round !== s.round) throw new OpError('conflict', `round ${op.round} is already finished (now round ${s.round})`);
      if (r && r.status !== 'open') throw new OpError('conflict', `round ${s.round} is already ${r.status}`);
      // deliveredAt null = finished, not yet printed to the agent (absent on rounds from before this field existed)
      const done = { status: op.kind === 'approve' ? 'approved' : 'sent', sentAt: now, note: op.note || undefined, deliveredAt: null };
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
      throw new OpError('bad_op', `unknown op ${JSON.stringify(op.op)}`);
  }
  s.rev = (s.rev ?? 0) + 1;
  return s;
}

/** Rounds finished but never printed to the agent, oldest first. */
export const undelivered = (s) => s.rounds.filter((r) => r.status !== 'open' && r.deliveredAt === null);
