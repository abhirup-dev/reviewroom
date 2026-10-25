// One jump to code on a phone's guided review (player.phone.ts), render-agnostic: the pane shows one chunk at a time
// and the file tab, a narration link, a symbol or a chunk's name picks which, and where in it:
//
//   ready ─go─▶ waiting ─(the pane shows a slide's chunks: not mid-change)─▶ resolving ─▶ deciding ─▶ ready
//                                                     (the link's lines; a symbol searches) │
//                         one of the chunks on screen: select it, reveal the lines in it ◀──┤
//                         another file: focus the pane on the link (paneMachine replaces it) ◀┘
//   a new go in any state starts over (the stale lookup is cancelled with its state); a slide change cancels
import { assign, fromPromise, setup } from 'xstate';
import type { CodeAt, Slot } from './player.machine';

/** A tab's chunk by index, or a link (code, file or symbol) by its ref. */
export type Jump = { index: number } | { ref: string };
/** Where a jump lands: a chunk on screen and the lines to reveal in it (null: just show it), or a link the pane must show. */
export type Landing = { index: number; code: CodeAt | null } | { focus: string };

type NavCtx = { jump: Jump | null; slots: Slot[] | null; landing: Landing | null };
type NavEvent = { type: 'go'; jump: Jump } | { type: 'pane'; slots: Slot[] | null } | { type: 'cancel' };

/** The chunk on screen showing the same file (and view) as `code`. */
export const slotFor = (slots: Slot[], code: CodeAt) => slots.findIndex((s) => s.code?.path === code.path && (s.code.view ?? 'diff') === (code.view ?? 'diff'));

export const navMachine = setup({
  types: { context: {} as NavCtx, events: {} as NavEvent },
  actors: {
    /** a link -> where it lands (symbols need a search) */
    resolve: fromPromise<CodeAt | null, string>(async () => null),
  },
  actions: {
    /** show `landing.index` and reveal `landing.code` in it */
    select: () => {},
    /** have the pane show `landing.focus` instead (not on screen) */
    focus: () => {},
  },
  guards: { paneReady: ({ context }) => context.slots !== null },
}).createMachine({
  id: 'nav',
  context: { jump: null, slots: null, landing: null },
  initial: 'ready',
  on: {
    go: { target: '.waiting', reenter: true, actions: assign({ jump: ({ event }) => event.jump, landing: null }) },
    // null: the pane is changing (its chunks are about to be replaced)
    pane: { actions: assign({ slots: ({ event }) => event.slots }) },
    cancel: '.ready',
  },
  states: {
    ready: {},
    waiting: {
      always: [
        { guard: ({ context }) => context.slots !== null && 'index' in context.jump!, target: 'deciding', actions: assign({ landing: ({ context }) => ({ index: (context.jump as { index: number }).index, code: context.slots![(context.jump as { index: number }).index]?.code ?? null }) }) },
        { guard: 'paneReady', target: 'resolving' },
      ],
    },
    resolving: {
      invoke: {
        src: 'resolve',
        input: ({ context }) => (context.jump as { ref: string }).ref,
        onDone: {
          target: 'deciding',
          actions: assign({
            landing: ({ context, event }) => {
              const i = event.output && context.slots ? slotFor(context.slots, event.output) : -1;
              return i >= 0 ? { index: i, code: event.output } : { focus: (context.jump as { ref: string }).ref };
            },
          }),
        },
        onError: { target: 'deciding', actions: assign({ landing: ({ context }) => ({ focus: (context.jump as { ref: string }).ref }) }) },
      },
    },
    deciding: {
      always: [
        { guard: ({ context }) => !!context.landing && 'index' in context.landing && !!context.slots?.[context.landing.index], target: 'ready', actions: 'select' },
        { guard: ({ context }) => !!context.landing && 'focus' in context.landing, target: 'ready', actions: 'focus' },
        { target: 'ready' },
      ],
    },
  },
});
