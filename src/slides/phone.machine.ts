// The phone's guided review, render-agnostic (the view, src/slides/player.phone.ts, measures, renders and sends):
//
//   chromeMachine   off ─wake─▶ shown ─(IDLE_MS untouched)─▶ immersive ─wake─▶ shown
//                   off: paused or closed (`stop` from any state). shown: a `wake` or a `touch` restarts the wait;
//                   `held` (a menu, the composer or a selection open) waits another IDLE_MS. immersive: the bars and the
//                   toolbar fade, Show controls in the card's corner; a `touch` (a tap, a swipe, a drag, a slide change) does nothing
//                   there; only Show controls sends `wake`. `hide` (the toolbar's Full screen) goes immersive at once
//
//   coachMachine    off ─start─▶ swipes ─(done)─▶ between ─▶ pointing ─(POINT_MS)─▶ leaving ─▶ asking ─(ASK_MS)─▶ off
//                   start: going immersive, or the toolbar's Full screen (`forced`): only if the orientation isn't
//                   skipped, and unforced only once a page load per orientation. swipes: the note, the spotlight on
//                   the card and the touch dot's strokes (the view's `swipes` actor). pointing: the spotlight on Show
//                   controls, glowing. asking: Skip next time (remembered for the orientation it started in) or Repeat.
//                   `end` (leaving immersive, turning, dispose) from anywhere: off
//
//   cardMachine     the slide card, a bottom sheet with detents collapsed (0), default (1), tall (2)
//                   rest ─grab─▶ dragging ─release / cancel─▶ settling ─(SETTLE_MS)─▶ rest
//                   rest | settling ─size─▶ settling        (the grip tapped, a tap on a collapsed card)
//                   grab only `draggable`: from the grip always; else up while short of tall, down from the text's top
//                   (otherwise the text scrolls). The view measures: every grab and size carries the card's height
//                   now and its height at each detent.
import { assign, fromPromise, setup } from 'xstate';

export const IDLE_MS = 4000;
/** The card's glide to a detent (slides.phone.css); not transitionend: reduced motion has no transition. */
export const SETTLE_MS = 400;
/** A release this far past where it started moves at least one detent its way. */
const FLICK = 40;

export const chromeMachine = setup({
  types: { events: {} as { type: 'wake' } | { type: 'touch' } | { type: 'hide' } | { type: 'stop' } },
  guards: { held: () => false },
  delays: { idle: IDLE_MS },
}).createMachine({
  id: 'chrome',
  initial: 'off',
  on: { stop: '.off' },
  states: {
    off: { on: { wake: 'shown' } },
    shown: {
      on: { wake: { target: 'shown', reenter: true }, touch: { target: 'shown', reenter: true }, hide: 'immersive' },
      after: { idle: [{ guard: 'held', target: 'shown', reenter: true }, { target: 'immersive' }] },
    },
    immersive: { on: { wake: 'shown' } },
  },
});

export type Detent = 0 | 1 | 2;
type Heights = [number, number, number];
type CardCtx = { detent: Detent; heights: Heights; from: number; grabbed: number; height: number };
type CardEvent =
  | { type: 'size'; detent: Detent; height: number; heights: Heights }
  | { type: 'grab'; up: boolean; grip: boolean; scrollTop: number; height: number; heights: Heights }
  | { type: 'drag'; dy: number }
  | { type: 'release'; dy: number }
  | { type: 'cancel' };

/** Where a release lands: the nearest detent, a flick at least one step its way, tall only if the text needs it. */
export const landing = ({ detent, heights, height }: CardCtx, dy: number): Detent => {
  let d = heights.reduce((best, px, i) => (Math.abs(px - height) < Math.abs(heights[best] - height) ? i : best), 0);
  if (d === detent && Math.abs(dy) > FLICK) d = Math.min(2, Math.max(0, detent + (dy < 0 ? 1 : -1)));
  if (d === 2 && heights[2] - heights[1] < 8) d = 1;
  return d as Detent;
};

const settle = { target: 'settling', reenter: true } as const;
const sizeTo = { ...settle, actions: 'sized' } as const;
const grabIt = { guard: 'draggable', target: 'dragging', actions: 'grabbed' } as const;

export const cardMachine = setup({
  types: { context: {} as CardCtx, events: {} as CardEvent },
  guards: {
    draggable: ({ context, event }) => event.type === 'grab' && (event.grip || (event.up ? context.detent < 2 : event.scrollTop <= 0)),
  },
  actions: {
    sized: assign(({ event: e }) => (e.type === 'size' ? { detent: e.detent, heights: e.heights, from: e.height } : {})),
    grabbed: assign(({ event: e }) => (e.type === 'grab' ? { heights: e.heights, grabbed: e.height, height: e.height } : {})),
  },
  delays: { settle: SETTLE_MS },
}).createMachine({
  id: 'card',
  context: { detent: 1, heights: [0, 0, 0], from: 0, grabbed: 0, height: 0 },
  initial: 'rest',
  states: {
    rest: { on: { size: sizeTo, grab: grabIt } },
    dragging: {
      on: {
        // the finger's height, between one line and tall (or the card's height when grabbed, if taller)
        drag: { actions: assign(({ context: c, event: e }) => ({ height: Math.min(Math.max(c.heights[2], c.grabbed), Math.max(c.heights[0], c.grabbed - e.dy)) })) },
        release: { ...settle, actions: assign(({ context: c, event: e }) => ({ detent: landing(c, e.dy), from: c.height })) },
        cancel: { ...settle, actions: assign(({ context: c }) => ({ from: c.height })) },
      },
    },
    settling: {
      after: { settle: 'rest' },
      on: { size: sizeTo, grab: grabIt },
    },
  },
});

export type Orient = 'portrait' | 'landscape';
/** start: `skipped`, Skip next time was chosen for that orientation (the view keeps it, in local storage) */
type CoachEvent = { type: 'start'; orient: Orient; forced?: boolean; skipped?: boolean } | { type: 'end' } | { type: 'skip' } | { type: 'repeat' };
/** How long the coach points at Show controls, and waits for Skip or Repeat. */
export const POINT_MS = 5700, ASK_MS = 6000;
/** A note fading out before the next one fades in. */
const FADE_MS = 300;

export const coachMachine = setup({
  types: {
    context: {} as { orient: Orient; seen: Orient[] },
    events: {} as CoachEvent,
  },
  actors: {
    /** the touch dot's strokes over the card (the view animates; done when they are) */
    swipes: fromPromise<void, Orient>(async () => {}),
  },
  guards: {
    /** not skipped, and unforced only once a page load per orientation */
    due: ({ context, event }) => event.type === 'start' && !event.skipped && (!!event.forced || !context.seen.includes(event.orient)),
  },
  actions: {
    /** the first note, the spotlight on the card */
    showSwipes: () => {},
    /** the note and the spotlight fade out */
    fade: () => {},
    /** "Tap ⋯ to show the controls", the spotlight on Show controls, which glows */
    point: () => {},
    /** "Show this again next time?" with Skip next time and Repeat */
    ask: () => {},
    /** remember Skip next time for the orientation it started in (context.orient) */
    remember: () => {},
    started: assign(({ context, event }) => (event.type === 'start' ? { orient: event.orient, seen: [...new Set([...context.seen, event.orient])] } : {})),
    /** everything the coach shows goes */
    hide: () => {},
  },
  delays: { fade: FADE_MS, point: POINT_MS, ask: ASK_MS },
}).createMachine({
  id: 'coach',
  context: { orient: 'portrait', seen: [] },
  initial: 'off',
  on: {
    start: {
      guard: 'due',
      target: '.swipes',
      reenter: true,
      actions: 'started',
    },
    end: '.off',
  },
  states: {
    off: { entry: 'hide' },
    swipes: {
      entry: ['hide', 'showSwipes'],
      invoke: { src: 'swipes', input: ({ context }) => context.orient, onDone: 'between' },
    },
    between: { entry: 'fade', after: { fade: 'pointing' } },
    pointing: { entry: 'point', after: { point: 'leaving' } },
    leaving: { entry: 'fade', after: { fade: 'asking' } },
    asking: {
      entry: 'ask',
      after: { ask: 'off' }, // unanswered: it plays again next time
      on: {
        skip: { target: 'off', actions: 'remember' },
        repeat: { target: 'swipes', reenter: true },
      },
    },
  },
});
