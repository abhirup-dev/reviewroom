// Which diff range the panes show, render-agnostic (ReviewApp provides the file lookup and listens for the result):
//
//   idle ─select─▶ switching ─(the range's files)─▶ idle      the range and its files change together, then `shown`
//   a `select` while switching re-enters it: the stale lookup is cancelled with its state, the latest range wins
//   a `select` of the range already shown, or already on its way, does nothing
//   a lookup that fails keeps what is shown and emits `failed`
import { assign, emit, fromPromise, setup } from 'xstate';
import type { ChangedFile, DiffRange } from '../kernel/state/model.shared';

/** `want`: the range on its way (null: none) */
type RangeCtx = { range: DiffRange | null; files: ChangedFile[]; want: DiffRange | null };
type RangeEvent = { type: 'select'; range: DiffRange };

/** The same range: a restack keeps a layer's key but moves its ends, and that needs a new lookup. */
const same = (a: DiffRange | null, b: DiffRange) => a?.key === b.key && a.base === b.base && a.head === b.head;

export const rangeMachine = setup({
  types: {
    context: {} as RangeCtx,
    events: {} as RangeEvent,
    /** `shown`: the range and its files are what the panes show now; `failed`: a lookup failed, what was shown stays */
    emitted: {} as { type: 'shown'; range: DiffRange; files: ChangedFile[] } | { type: 'failed'; error: unknown },
  },
  actors: {
    /** the range's changed files, in review order */
    files: fromPromise<ChangedFile[], DiffRange>(async () => []),
  },
  actions: { want: assign({ want: ({ event }) => event.range }) },
  guards: { changes: ({ context, event }) => !same(context.want ?? context.range, event.range) },
}).createMachine({
  id: 'range',
  context: { range: null, files: [], want: null },
  initial: 'idle',
  on: { select: { guard: 'changes', target: '.switching', reenter: true, actions: 'want' } },
  states: {
    idle: {},
    switching: {
      invoke: {
        src: 'files',
        input: ({ context }) => context.want!,
        onDone: {
          target: 'idle',
          actions: [
            assign(({ context, event }) => ({ range: context.want, files: event.output, want: null })),
            emit(({ context }) => ({ type: 'shown' as const, range: context.range!, files: context.files })),
          ],
        },
        onError: { target: 'idle', actions: [assign({ want: null }), emit(({ event }) => ({ type: 'failed' as const, error: event.error }))] },
      },
    },
  },
});
