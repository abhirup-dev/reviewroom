// The walkthrough player's lifecycle: closed, playing a step, or paused to a pill (same step on resume).
// Render-agnostic; the view (src/overlays/walkthrough.ts) subscribes. Autoplay, later, is a playing.auto substate.
import { assign, setup } from 'xstate';
import type { Walkthrough } from '../shared/walkthrough';

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
  | { type: 'close' };

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

/** What the code pane shows for the current step: its ref; else the chapter's last ref so far; else the chapter
 *  lead's diagram; else the last ref of an earlier chapter; else nothing. */
export function target({ doc, chapter, step }: Ctx): { ref: string } | 'diagram' | null {
  const ch = doc!.chapters[chapter];
  const back = ch.steps.slice(0, step + 1).findLast((s) => s.ref)?.ref;
  if (back) return { ref: back };
  if (ch.lead && /<rr-flow[\s>]/.test(ch.lead)) return 'diagram';
  const earlier = doc!.chapters.slice(0, chapter).flatMap((c) => c.steps).findLast((s) => s.ref)?.ref;
  return earlier ? { ref: earlier } : null;
}

/** The `?walkthrough=<chapter>/<step>` deep link (either part optional); null when absent. */
export function deepLink(search: string): { chapter?: string; step?: string } | null {
  const v = new URLSearchParams(search).get('walkthrough');
  if (v === null) return null;
  const [chapter, step] = v.split('/');
  return { chapter: chapter || undefined, step: step || undefined };
}

const move = { next: { actions: 'next' }, prev: { actions: 'prev' }, goto: { actions: 'goto' } } as const;

export const walkthroughMachine = setup({
  types: { context: {} as Ctx, events: {} as WalkthroughEvent },
  guards: { loaded: ({ context }) => context.doc !== null },
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
  },
}).createMachine({
  id: 'walkthrough',
  context: { doc: null, chapter: 0, step: 0 },
  initial: 'closed',
  on: { load: [{ guard: ({ event }) => !event.doc, target: '.closed', actions: 'load' }, { actions: 'load' }] },
  states: {
    closed: { on: { open: { guard: 'loaded', target: 'playing', actions: 'open' } } },
    playing: { on: { ...move, open: { actions: 'open' }, pause: 'paused', close: 'closed' } },
    paused: { on: { open: { target: 'playing', actions: 'open' }, resume: 'playing', close: 'closed' } },
  },
});
