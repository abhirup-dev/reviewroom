// Saving to the reviewroom server and following its live updates: one machine, two regions.
// The server is the only writer of state.json. The browser applies ops optimistically and sends them
// in order; what it shows is the last state the server broadcast plus the ops not yet in it.
import { assign, emit, enqueueActions, fromCallback, fromPromise, raise, setup, type EventObject } from 'xstate';
import { applyOp } from '../state/ops.shared';
import type { GitHubSnapshot, Op, ReviewState } from '../state/model.shared';

/** POST /ops: stored at `rev`, or the op at `rejected` can never apply (its thread is gone, say).
 *  Throws when the server can't take them now: an Error says why, a TypeError (fetch failed) that it's not answering. */
export type PostResult = { rev: number } | { rejected: number; error: string };
/** What the live stream says. */
/** hello: the walkthrough's hash and when this run of the server started. */
export type StreamEvent = { type: 'hello'; hash: string; started: string } | { type: 'state'; state: ReviewState } | { type: 'review' } | { type: 'github'; snapshot: GitHubSnapshot } | { type: 'down' };

/** queue: applied locally, not yet in `base`; ackRev: stored by the server at that rev. sent: how many unsent ops are in flight.
 *  failures: sends in a row the server didn't answer; failed: all failed sends, and reloadAt what that was when a reload became due.
 *  started: when the server we talk to started. */
type Ctx = { base: ReviewState; queue: { op: Op; ackRev?: number }[]; sent: number; failures: number; failed: number; reloadAt: number; hash: string | null; started: string | null };

const rev = (s: ReviewState) => s.rev ?? 0;
const unsentOps = (c: Pick<Ctx, 'queue'>) => c.queue.filter((q) => !q.ackRev);
export const unsent = (c: Pick<Ctx, 'queue'>) => unsentOps(c).length > 0;
const settle = (queue: Ctx['queue'], base: ReviewState) => queue.filter((q) => !(q.ackRev && q.ackRev <= rev(base)));
/** ops are idempotent, so one that already reached `base` re-applies as a no-op */
export const view = ({ base, queue }: Pick<Ctx, 'base' | 'queue'>) =>
  queue.reduce((s, q) => {
    try {
      return applyOp(s, q.op);
    } catch {
      return s; // can't apply any more; the server rejects it and the outbox drops it
    }
  }, base);

/** Where the round is, from the state alone (so a reload or another tab agrees). Finishing a round ends that run of
 *  the server; the agent works, then serves the next round: a server started after the feedback means it's back. */
export function roundStatus({ base, started }: Pick<Ctx, 'base' | 'started'>): 'waiting' | 'approved' | null {
  if (base.rounds.find((r) => r.n === base.round)?.status === 'approved') return 'approved';
  const last = base.rounds.find((r) => r.n === base.round - 1);
  return last?.status === 'sent' && last.sentAt && started && last.sentAt >= started ? 'waiting' : null; // both server-clock ISO times
}

export const syncMachine = setup({
  types: {
    context: {} as Ctx,
    events: {} as { type: 'op'; op: Op } | { type: 'connect' } | { type: 'flush' } | StreamEvent,
    input: {} as { base: ReviewState },
    emitted: {} as { type: 'state'; state: ReviewState } | { type: 'error'; text: string } | { type: 'github'; snapshot: GitHubSnapshot } | { type: 'reload' },
  },
  actors: {
    post: fromPromise<PostResult, { ops: Op[] }>(async () => ({ rev: 0 })),
    fetchState: fromPromise<ReviewState>(async () => ({}) as ReviewState),
    stream: fromCallback<EventObject>(() => {}),
  },
  actions: {
    // a state older than what we already have is dropped
    receive: assign(({ context }, s: ReviewState) => (rev(s) < rev(context.base) ? {} : { base: s, queue: settle(context.queue, s) })),
    emitView: emit(({ context }: { context: Ctx }) => ({ type: 'state' as const, state: view(context) })),
  },
  delays: { retry: 3000, reconnect: 2000 },
}).createMachine({
  id: 'sync',
  type: 'parallel',
  context: ({ input }) => ({ base: input.base, queue: [], sent: 0, failures: 0, failed: 0, reloadAt: 0, hash: null, started: null }),
  on: {
    op: { actions: assign({ queue: ({ context, event }) => [...context.queue, { op: event.op }] }) },
    state: { actions: [{ type: 'receive', params: ({ event }) => event.state }, 'emitView'] },
  },
  states: {
    outbox: {
      initial: 'idle',
      states: {
        idle: { always: { guard: ({ context }) => unsent(context), target: 'sending' } },
        sending: {
          tags: 'sending',
          entry: assign({ sent: ({ context }) => unsentOps(context).length }),
          invoke: {
            src: 'post',
            input: ({ context }) => ({ ops: unsentOps(context).map((q) => q.op) }),
            onDone: {
              target: 'idle',
              actions: enqueueActions(({ context, event, enqueue }) => {
                const out = event.output;
                if ('rejected' in out) {
                  // that op can never apply: drop it so the rest still save (the batch was all-or-nothing)
                  const bad = unsentOps(context)[out.rejected];
                  const queue = context.queue.filter((q) => q !== bad);
                  enqueue.assign({ queue, failures: 0 }); // the server answered
                  enqueue.emit({ type: 'error', text: 'Not saved: ' + out.error });
                  enqueue.emit({ type: 'state', state: view({ base: context.base, queue }) });
                  return;
                }
                // only what went out is stored: ops queued while it was in flight go next
                let n = context.sent;
                enqueue.assign({ failures: 0, queue: settle(context.queue.map((q) => (!q.ackRev && n-- > 0 ? { ...q, ackRev: out.rev } : q)), context.base) });
              }),
            },
            onError: {
              target: 'stalled',
              actions: enqueueActions(({ context, event, enqueue }) => {
                enqueue.assign({ failures: context.failures + 1, failed: context.failed + 1 });
                if (context.failures) return; // said once per stall
                const e = event.error;
                enqueue.emit({ type: 'error', text: `Not saved yet${e instanceof Error && !(e instanceof TypeError) ? ` (${e.message})` : ': the reviewroom server is not answering'}. Retrying.` });
              }),
            },
          },
        },
        // the server said hello again (it's back), or something waits on the save: don't wait out the timer
        stalled: { after: { retry: 'sending' }, on: { hello: 'sending', flush: 'sending' } },
      },
    },
    stream: {
      initial: 'off',
      states: {
        off: { on: { connect: 'open' } },
        open: {
          invoke: { src: 'stream' },
          initial: 'hello',
          on: {
            down: 'reconnecting',
            github: { actions: emit(({ event }) => ({ type: 'github' as const, snapshot: event.snapshot })) },
            review: 'newRun',
          },
          states: {
            hello: {
              on: {
                hello: [
                  // first contact also catches up: something may have changed between loading the page and now
                  { guard: ({ context }) => context.hash === null, target: 'refetch', actions: assign({ hash: ({ event }) => event.hash, started: ({ event }) => event.started }) },
                  // reconnected to a new `reviewroom review` run: pick up whatever the agent changed meanwhile
                  { guard: ({ context, event }) => event.hash !== context.hash, target: '#sync.stream.newRun' },
                  { target: 'refetch', actions: assign({ started: ({ event }) => event.started }) },
                ],
              },
            },
            // back after a drop: catch up on what was broadcast meanwhile. Counts as live (no "Disconnected" flash),
            // but the round status waits for it: `started` is already the new server's, `base` not yet
            refetch: { tags: ['live', 'catchingUp'], invoke: { src: 'fetchState', onDone: { target: 'live', actions: [{ type: 'receive', params: ({ event }) => event.output }, 'emitView'] }, onError: 'live' } },
            live: { tags: 'live' },
          },
        },
        reconnecting: { after: { reconnect: 'open' } },
        // A new run or a new walkthrough reloads the page. Unsent changes get one more try first
        // (now, if stalled): reload once they're stored or that try fails.
        newRun: {
          entry: [assign({ reloadAt: ({ context }) => context.failed }), raise({ type: 'flush' })],
          always: { guard: ({ context }) => !unsent(context) || context.failed > context.reloadAt, target: 'reloading' },
        },
        reloading: { entry: emit({ type: 'reload' }) },
      },
    },
  },
});
