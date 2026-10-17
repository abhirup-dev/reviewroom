// Saving a review's own layout, in two regions: `settle` waits for the dock to stop changing and reads it
// (leaving the page skips the wait); `store` saves what was read, one save at a time, the newest read next.
import { assign, fromPromise, setup } from 'xstate';
import type { LastLayout } from '../shared/layout';

/** read: the dock as it is now, or null when it isn't a layout to keep (a panel floated over it for a moment).
 *  pending: read, not saved yet; saving: the save that is out. */
type Ctx = { read: () => LastLayout | null; pending: LastLayout | null; saving: LastLayout | null };

export const layoutSaveMachine = setup({
  types: { context: {} as Ctx, events: {} as { type: 'change' } | { type: 'flush' }, input: {} as { read: () => LastLayout | null } },
  actors: { save: fromPromise<void, LastLayout>(async () => {}) },
  actions: { read: assign({ pending: ({ context }) => context.read() ?? context.pending }) },
  delays: { settle: 250 },
}).createMachine({
  id: 'layoutSave',
  context: ({ input }) => ({ read: input.read, pending: null, saving: null }),
  type: 'parallel',
  states: {
    settle: {
      initial: 'idle',
      states: {
        idle: { on: { change: 'waiting' } },
        // dragging a splitter is a stream of changes: only the last one counts
        waiting: { after: { settle: { target: 'idle', actions: 'read' } }, on: { change: { target: 'waiting', reenter: true }, flush: { target: 'idle', actions: 'read' } } },
      },
    },
    store: {
      initial: 'idle',
      states: {
        idle: { always: { guard: ({ context }) => !!context.pending, target: 'saving' } },
        // a failed save isn't retried: the next change saves the whole dock again
        saving: {
          entry: assign({ saving: ({ context }) => context.pending, pending: null }),
          invoke: { src: 'save', input: ({ context }) => context.saving!, onDone: 'idle', onError: 'idle' },
        },
      },
    },
  },
});
