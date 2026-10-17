// Taking a code panel to some lines, render-agnostic (the panel, src/panels/code.ts, provides the steps):
//
//   idle ─reveal─▶ preparing ─▶ landing ─▶ unfolding ─▶ glowing ─(glow)─▶ idle
//                  wait for the    highlight   lines in folded    the highlight pulses; `landed` is
//                  panel, open     the lines,  context: unfold,   emitted (the walkthrough's pane waits
//                  the file        scroll      land again         for it); after, a workbench panel
//                                                                  drops the highlight
//   nothing to highlight (a whole file, a file that is gone) ─▶ idle, `landed` all the same
//   a new `reveal` in any state starts over: the stale wait, unfold or glow timer is cancelled with its state
//   the user selecting lines at any point ─▶ idle, their selection kept (no glow, no clearing it later)
//   leaving glowing any way stops the pulse
import { assign, fromPromise, setup } from 'xstate';
import type { CodeTarget } from '../shell/app';

type RevealEvent = { type: 'reveal'; target: CodeTarget } | { type: 'select' };
/** What `prepare` found: lines to highlight, or nothing to (the view only scrolled, or the file is not there). */
export type Prepared = 'lines' | 'nothing';

export const revealMachine = setup({
  types: { context: {} as { target: CodeTarget | null }, events: {} as RevealEvent },
  actors: {
    /** wait for the panel to be ready for the target (rebuilds, the file loaded, filters lifted) */
    prepare: fromPromise<Prepared, CodeTarget>(async () => 'nothing'),
    /** unfold folded context around the lines once the file is drawn; true: it did (land again) */
    unfold: fromPromise<boolean, CodeTarget>(async () => false),
  },
  actions: {
    /** highlight the target's lines and scroll them into view */
    land: () => {},
    /** start the pulse */
    glow: () => {},
    /** stop the pulse */
    unglow: () => {},
    /** drop the highlight (a workbench panel; the walkthrough's keeps it) */
    clear: () => {},
    /** tell whoever waits that the target is on screen */
    landed: () => {},
    target: assign({ target: ({ event }) => (event.type === 'reveal' ? event.target : null) }),
  },
  delays: { glow: 3000 },
}).createMachine({
  id: 'reveal',
  context: { target: null },
  initial: 'idle',
  // a reveal from any state starts over; from preparing it re-enters, which drops the stale work. The user's own
  // selection ends whatever reveal is going on.
  on: { reveal: { target: '.preparing', reenter: true, actions: 'target' }, select: '.idle' },
  states: {
    idle: {},
    preparing: {
      invoke: {
        src: 'prepare',
        input: ({ context }) => context.target!,
        onDone: [{ guard: ({ event }) => event.output === 'lines', target: 'landing' }, { target: 'idle', actions: 'landed' }],
        onError: { target: 'idle', actions: 'landed' },
      },
    },
    landing: { entry: 'land', always: 'unfolding' },
    unfolding: {
      // our highlight is up: it goes before the next reveal lands (or before nothing does)
      on: { reveal: { target: 'preparing', actions: ['clear', 'target'] } },
      invoke: {
        src: 'unfold',
        input: ({ context }) => context.target!,
        onDone: [{ guard: ({ event }) => event.output, target: 'glowing', actions: 'land' }, { target: 'glowing' }],
        onError: 'glowing',
      },
    },
    glowing: {
      entry: ['glow', 'landed'],
      exit: 'unglow',
      after: { glow: { target: 'idle', actions: 'clear' } },
      on: { reveal: { target: 'preparing', actions: ['clear', 'target'] } },
    },
  },
});
