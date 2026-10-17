// The walkthrough player as two machines, render-agnostic (the view, src/overlays/walkthrough.ts, provides the
// rendering actions and the ref resolver):
//
//   walkthroughMachine   closed ──open──▶ open { playing ⇄ paused } ──close──▶ closed
//                        while open it runs a paneMachine child and tells it what the current step shows
//   paneMachine          idle ─show─▶ resolving ─▶ gliding (same files: move the highlights) ─▶ showing
//                                              └─▶ leaving (fade out) ─▶ entering (mount) ──────────┘
//                        showing fades in, whichever way it was reached
//                        a new `show` in any state starts over; the stale lookup or fade is cancelled with its state
//
// Autoplay, later, is an open.auto substate.
import { assign, fromPromise, sendTo, setup } from 'xstate';
import { stepRefs, type Walkthrough } from '../shared/walkthrough';

// ------------------------------------------------------------------ the code pane

/** What the pane is asked to show. */
export type PaneWant = { kind: 'refs'; refs: string[] } | { kind: 'diagram'; html: string } | { kind: 'empty' };
/** Where a code link lands (a CodeTarget). */
export type CodeAt = { path: string; side: 'base' | 'head'; start?: number; end?: number; rev?: string; view?: 'diff' | 'file' };
/** One stacked chunk: a code view of `code`, or (no code: a section, an unknown symbol) a preview of the link. */
export type Slot = { ref: string; code: CodeAt | null };
/** What the pane shows, resolved. */
export type PaneShown = { kind: 'refs'; slots: Slot[] } | { kind: 'diagram'; html: string } | { kind: 'empty' };

type PaneCtx = { want: PaneWant | null; next: PaneShown | null; shown: PaneShown | null };
export type PaneEvent = { type: 'show'; want: PaneWant } | { type: 'clear' };

/** Same files in the same order: the views stay, only their highlights move. */
export const sameLayout = (a: PaneShown | null, b: PaneShown | null) =>
  a?.kind === 'refs' && b?.kind === 'refs' && a.slots.length === b.slots.length && a.slots.every((s, i) => !!s.code && s.code.path === b.slots[i].code?.path && s.code.view === b.slots[i].code?.view);

// a show from any state starts over at resolving; from resolving itself it re-enters, which stops the stale lookup
const show = { show: { target: '#pane.resolving', actions: 'want' } } as const;

export const paneMachine = setup({
  types: { context: {} as PaneCtx, events: {} as PaneEvent, input: {} as PaneWant | null },
  actors: {
    /** links -> where each lands (symbols need a search); diagrams and empty pass through */
    resolve: fromPromise<PaneShown, PaneWant>(async ({ input }) => (input.kind === 'refs' ? { kind: 'refs', slots: input.refs.map((ref) => ({ ref, code: null })) } : input)),
  },
  actions: {
    /** start hiding what is on screen */
    fadeOut: () => {},
    /** show what is on screen (whichever way it got there: a fade can be cut short by a glide) */
    fadeIn: () => {},
    /** replace what is on screen (disposing its views) with `context.next` and fade in */
    mount: () => {},
    /** move the highlights of the views on screen to `context.next` */
    glide: () => {},
    /** dispose the views on screen */
    unmount: () => {},
    want: assign({ want: ({ event }) => (event.type === 'show' ? event.want : null) }),
  },
  guards: { sameLayout: ({ context }) => sameLayout(context.shown, context.next), wanted: ({ context }) => context.want !== null },
  delays: { fade: 150 },
}).createMachine({
  id: 'pane',
  context: ({ input }) => ({ want: input ?? null, next: null, shown: null }),
  initial: 'starting',
  on: { clear: { target: '.idle', actions: ['unmount', assign({ shown: null, next: null, want: null })] } },
  states: {
    starting: { always: [{ guard: 'wanted', target: 'resolving' }, { target: 'idle' }] },
    idle: { on: show },
    resolving: {
      on: { show: { target: 'resolving', reenter: true, actions: 'want' } },
      invoke: {
        src: 'resolve',
        input: ({ context }) => context.want!,
        onDone: { target: 'deciding', actions: assign({ next: ({ event }) => event.output }) },
        onError: { target: 'leaving', actions: assign({ next: { kind: 'empty' } }) },
      },
    },
    deciding: { always: [{ guard: 'sameLayout', target: 'gliding' }, { target: 'leaving' }] },
    gliding: {
      entry: ['glide', assign({ shown: ({ context }) => context.next })],
      always: 'showing',
    },
    leaving: { entry: 'fadeOut', after: { fade: 'entering' }, on: show },
    entering: {
      entry: ['mount', assign({ shown: ({ context }) => context.next })],
      always: 'showing',
    },
    showing: { entry: 'fadeIn', on: show },
  },
});

// ------------------------------------------------------------------ the player

type Ctx = { doc: Walkthrough | null; chapter: number; step: number };

export type WalkthroughEvent =
  | { type: 'load'; doc: Walkthrough | null }
  /** by ids; unknown or missing ids start at the first chapter / step */
  | { type: 'open'; chapter?: string; step?: string }
  | { type: 'next' }
  | { type: 'prev' }
  /** by indices, clamped */
  | { type: 'goto'; chapter: number; step: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'close' }
  /** show these links in the pane without changing the step (a link in the narration, a chip); none: the step's own */
  | { type: 'focus'; refs?: string[] };

const clamp = (n: number, max: number) => Math.max(0, Math.min(Math.trunc(n) || 0, max)); // NaN, fractions: still a real index
const at = (doc: Walkthrough, chapter: number, step: number) => {
  const c = clamp(chapter, doc.chapters.length - 1);
  return { chapter: c, step: clamp(step, doc.chapters[c].steps.length - 1) };
};

/** Where the player is, for views. */
export function current({ doc, chapter, step }: Ctx) {
  const ch = doc!.chapters[chapter];
  const last = doc!.chapters.length - 1;
  return { chapter: ch, step: ch.steps[step], isFirst: chapter === 0 && step === 0, isLast: chapter === last && step === ch.steps.length - 1 };
}

const FLOW = /<rr-flow[\s>][\s\S]*<\/rr-flow>/;

/** What the code pane shows for the current step: its links; else the chapter's last links so far; else the chapter
 *  lead's diagram; else the last links of an earlier chapter; else nothing. */
export function target({ doc, chapter, step }: Ctx): PaneWant {
  const ch = doc!.chapters[chapter];
  const last = (steps: Walkthrough['chapters'][number]['steps']) => stepRefs(steps.findLast((s) => s.ref) ?? {});
  const back = last(ch.steps.slice(0, step + 1));
  if (back.length) return { kind: 'refs', refs: back };
  const flow = ch.lead?.match(FLOW)?.[0];
  if (flow) return { kind: 'diagram', html: flow };
  const earlier = last(doc!.chapters.slice(0, chapter).flatMap((c) => c.steps));
  return earlier.length ? { kind: 'refs', refs: earlier } : { kind: 'empty' };
}

/** The `?walkthrough=<chapter>/<step>` deep link (either part optional); null when absent. */
export function deepLink(search: string): { chapter?: string; step?: string } | null {
  const v = new URLSearchParams(search).get('walkthrough');
  if (v === null) return null;
  const [chapter, step] = v.split('/');
  return { chapter: chapter || undefined, step: step || undefined };
}

// every move re-aims the pane at the new step
const move = { next: { actions: ['next', 'aim'] }, prev: { actions: ['prev', 'aim'] }, goto: { actions: ['goto', 'aim'] } } as const;

export const walkthroughMachine = setup({
  types: { context: {} as Ctx, events: {} as WalkthroughEvent },
  actors: { pane: paneMachine },
  guards: { loaded: ({ context }) => context.doc !== null, docless: ({ event }) => event.type === 'load' && !event.doc },
  actions: {
    open: assign(({ context: { doc }, event }) => {
      if (event.type !== 'open' || !doc) return {};
      const c = Math.max(0, doc.chapters.findIndex((ch) => ch.id === event.chapter));
      return { chapter: c, step: Math.max(0, doc.chapters[c].steps.findIndex((s) => s.id === event.step)) };
    }),
    next: assign(({ context: { doc, chapter, step } }) =>
      step < doc!.chapters[chapter].steps.length - 1 ? { step: step + 1 } : chapter < doc!.chapters.length - 1 ? { chapter: chapter + 1, step: 0 } : {},
    ),
    prev: assign(({ context: { doc, chapter, step } }) =>
      step > 0 ? { step: step - 1 } : chapter > 0 ? { chapter: chapter - 1, step: doc!.chapters[chapter - 1].steps.length - 1 } : {},
    ),
    goto: assign(({ context, event }) => (event.type === 'goto' ? at(context.doc!, event.chapter, event.step) : {})),
    // a reloaded document keeps the position where it still exists
    load: assign(({ context, event }) => (event.type !== 'load' ? {} : event.doc ? { doc: event.doc, ...at(event.doc, context.chapter, context.step) } : { doc: null })),
    /** point the pane at the current step, or at the links of a `focus` */
    aim: sendTo('pane', ({ context, event }) => ({ type: 'show' as const, want: event.type === 'focus' && event.refs?.length ? { kind: 'refs' as const, refs: event.refs } : target(context) })),
  },
}).createMachine({
  id: 'walkthrough',
  context: { doc: null, chapter: 0, step: 0 },
  initial: 'closed',
  on: { load: [{ guard: 'docless', target: '.closed', actions: 'load' }, { actions: 'load' }] },
  states: {
    closed: { on: { open: { guard: 'loaded', target: 'open', actions: 'open' } } },
    open: {
      // the pane starts on the step opened; every move after that re-aims it
      invoke: { id: 'pane', src: 'pane', input: ({ context }) => target(context) },
      // a stopped actor runs no exit actions: have the pane dispose its views while it still can
      exit: sendTo('pane', { type: 'clear' }),
      initial: 'playing',
      on: { ...move, load: [{ guard: 'docless', target: 'closed', actions: 'load' }, { actions: ['load', 'aim'] }], focus: { actions: 'aim' }, close: 'closed' },
      states: {
        playing: { on: { open: { actions: ['open', 'aim'] }, pause: 'paused' } },
        paused: { on: { open: { target: 'playing', actions: ['open', 'aim'] }, resume: 'playing' } },
      },
    },
  },
});
