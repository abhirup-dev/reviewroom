// One finger's touch, arbitrated: which way it goes once it has travelled SLOP px (docs/design/phone.md). Pure, no
// DOM: the view sends the points (clientX/clientY) and reads the state.
//
//   idle ─start─▶ pending ─move past SLOP─▶ horizontal   mostly sideways
//                    │                     vertical     mostly up or down, and the owner claims that way
//                    │                     scroll       up or down the owner leaves to the platform (start's up/down)
//                    └──────cancel (any state)──▶ cancelled   a second finger, touchcancel
//
//   start   { x, y, up?, down? }   up / down (default true): a vertical move that way is the owner's
//   move    { x, y }               updates dx, dy (context); locks the axis once past SLOP
//   end     { x, y }               updates dx, dy and keeps the state: read it to finish the gesture
//   cancel                         the gesture is void
//   a new `start` from any state begins anew. While `vertical` or `horizontal`, the view should preventDefault.
import { assign, not, setup } from 'xstate';

/** How far a touch travels before its axis locks. */
export const SLOP = 10;

export type GestureEvent =
  | { type: 'start'; x: number; y: number; up?: boolean; down?: boolean }
  | { type: 'move'; x: number; y: number }
  | { type: 'end'; x: number; y: number }
  | { type: 'cancel' };
type Ctx = { x: number; y: number; dx: number; dy: number; up: boolean; down: boolean };

export const gestureMachine = setup({
  types: { context: {} as Ctx, events: {} as GestureEvent },
  actions: { track: assign(({ context, event }) => (event.type === 'move' || event.type === 'end' ? { dx: event.x - context.x, dy: event.y - context.y } : {})) },
  guards: {
    far: ({ context: c }) => Math.hypot(c.dx, c.dy) > SLOP,
    sideways: ({ context: c }) => Math.abs(c.dx) > Math.abs(c.dy),
    claimed: ({ context: c }) => (c.dy < 0 ? c.up : c.down),
  },
}).createMachine({
  id: 'gesture',
  context: { x: 0, y: 0, dx: 0, dy: 0, up: true, down: true },
  initial: 'idle',
  on: {
    start: { target: '.pending', actions: assign(({ event: e }) => ({ x: e.x, y: e.y, dx: 0, dy: 0, up: e.up ?? true, down: e.down ?? true })) },
    cancel: '.cancelled',
  },
  states: {
    idle: {},
    pending: {
      on: { move: { target: 'deciding', actions: 'track' }, end: { actions: 'track' } },
    },
    // guards see the context before a transition's actions: decide in a step of its own, after the move is tracked
    deciding: {
      always: [{ guard: not('far'), target: 'pending' }, { guard: 'sideways', target: 'horizontal' }, { guard: 'claimed', target: 'vertical' }, { target: 'scroll' }],
    },
    horizontal: { on: { move: { actions: 'track' }, end: { actions: 'track' } } },
    vertical: { on: { move: { actions: 'track' }, end: { actions: 'track' } } },
    scroll: {},
    cancelled: {},
  },
});
