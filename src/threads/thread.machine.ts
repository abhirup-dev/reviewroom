// The thread popup's lifecycle as a state machine: what is open, not how it is shown.
// Views subscribe and render the mode; each new `view` object means a fresh view (the old one is disposed).
// The requests a popup makes (send the first comment, resolve) run inside the state that made them,
// so an answer arriving after the popup moved on is dropped.
import { assertEvent, assign, fromPromise, setup } from 'xstate';
import type { Anchor } from '../kernel/state/model.shared';

/** A thread by id, or a new comment on an anchor. */
export type ThreadTarget = { id?: string; anchor?: Anchor; quote?: string; to?: 'agent' | 'github' };

export type ThreadEvent =
  | { type: 'open'; id: string }
  | { type: 'compose'; anchor: Anchor; quote?: string; to?: 'agent' | 'github' }
  /** send the comment being composed */
  | { type: 'submit'; body: string; toGitHub: boolean }
  /** resolve the open thread from the popup: on success it fades out, then closes */
  | { type: 'resolve' }
  | { type: 'close' };

const target = (e: ThreadEvent): ThreadTarget | null => (e.type === 'open' ? { id: e.id } : e.type === 'compose' ? { anchor: e.anchor, quote: e.quote, to: e.to } : null);

const toOpen = { open: { target: '#thread.viewing', actions: 'show' }, compose: { target: '#thread.composing', actions: 'show' } } as const;

export const threadMachine = setup({
  types: { context: {} as { view: ThreadTarget | null }, events: {} as ThreadEvent },
  actors: {
    /** the new thread's id; true: posted on GitHub, nothing to show here; false: not sent */
    create: fromPromise<string | boolean, { anchor: Anchor; body: string; toGitHub: boolean }>(async () => false),
    /** false: refused (GitHub, say) */
    resolve: fromPromise<boolean, { id: string }>(async () => false),
  },
  actions: {
    show: assign({ view: ({ event }) => target(event) }),
    // the lines a new comment was for stop being highlighted once it's sent or dropped
    clearSelection: () => {},
  },
  delays: { leave: 500 },
}).createMachine({
  id: 'thread',
  context: { view: null },
  initial: 'closed',
  states: {
    closed: { entry: assign({ view: null }), on: toOpen },
    viewing: { on: { ...toOpen, resolve: 'resolving', close: 'closed' } },
    resolving: {
      invoke: {
        src: 'resolve',
        input: ({ context }) => ({ id: context.view!.id! }),
        onDone: [{ guard: ({ event }) => event.output, target: 'leaving' }, { target: 'viewing' }],
        onError: 'viewing',
      },
      on: { ...toOpen, close: 'closed' },
    },
    // composing -> composing (another anchor) is not a re-entry, so the new selection stays
    composing: {
      exit: 'clearSelection',
      initial: 'editing',
      on: { ...toOpen, close: 'closed' },
      states: {
        editing: { on: { submit: 'sending' } },
        sending: {
          invoke: {
            src: 'create',
            input: ({ context, event }) => (assertEvent(event, 'submit'), { anchor: context.view!.anchor!, body: event.body, toGitHub: event.toGitHub }),
            onDone: [
              { guard: ({ event }) => typeof event.output === 'string', target: '#thread.viewing', actions: assign({ view: ({ event }) => ({ id: event.output as string }) }) },
              { guard: ({ event }) => event.output === true, target: '#thread.closed' },
              { target: 'editing' },
            ],
            onError: 'editing',
          },
        },
      },
    },
    leaving: { after: { leave: 'closed' }, on: { ...toOpen, close: 'closed' } },
  },
});
