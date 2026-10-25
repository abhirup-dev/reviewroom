// The phone's code sheet: the Code area as a bottom sheet over another area, at the lines a link showed.
//
//   closed --open--> open.peek --start--> open.dragging --end above 70%--> full (it is the Code area now)
//                       ^                     |   --end below 25%--> closed
//                       +------ else ---------+
//   open --close--> closed;  open --expand--> full;  full --open--> open.peek
//
// The view measures (the sheet's height when the drag starts, the stage's) and sends numbers; `height` follows the
// finger, `rising` (above 70%) shows the scrim. Leaving `open` any way runs `shut`; reaching `full` runs `full`.
import { assign, setup } from 'xstate';

export type CodeSheetEvent =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'expand' }
  /** a drag on the handle starts: the sheet's height and the stage's, in px */
  | { type: 'start'; from: number; max: number }
  /** dy: how far the finger moved down since the start (up is negative) */
  | { type: 'move'; dy: number }
  | { type: 'end'; dy: number };

type Ctx = { from: number; max: number; height: number };
const frac = (c: Ctx, dy: number) => Math.max(0, c.from - dy) / (c.max || 1);
/** Past this share of the stage a release opens the Code area; under `CLOSE`, it closes. */
export const EXPAND = 0.7;
const CLOSE = 0.25;

export const codeSheetMachine = setup({
  types: { context: {} as Ctx, events: {} as CodeSheetEvent },
  actions: {
    /** the sheet came up (a history entry) */
    opened: () => {},
    /** it went down or became the Code area */
    shut: () => {},
    /** it became the Code area */
    full: () => {},
  },
}).createMachine({
  id: 'codeSheet',
  context: { from: 0, max: 0, height: 0 },
  initial: 'closed',
  states: {
    closed: { on: { open: 'open' } },
    open: {
      entry: 'opened',
      exit: 'shut',
      initial: 'peek',
      on: { close: 'closed', expand: 'full' },
      states: {
        peek: { on: { start: { target: 'dragging', actions: assign(({ event }) => ({ from: event.from, max: event.max, height: event.from })) } } },
        dragging: {
          on: {
            move: { actions: assign({ height: ({ context, event }) => Math.max(0, context.from - event.dy) }) },
            end: [
              { guard: ({ context, event }) => frac(context, event.dy) > EXPAND, target: '#codeSheet.full' },
              { guard: ({ context, event }) => frac(context, event.dy) < CLOSE, target: '#codeSheet.closed' },
              { target: 'peek' },
            ],
          },
        },
      },
    },
    full: { entry: 'full', on: { open: 'open' } },
  },
});

/** Above 70% mid-drag: the scrim shows. */
export const rising = (c: Ctx) => c.height / (c.max || 1) > EXPAND;
