import { expect, test } from 'bun:test';
import { place } from './placement';

test('the focus sits in the middle of the pane', () => {
  // a 100px focus at 1000px in 4000px of code: its middle (1050) at the pane's middle (400)
  expect(place(800, 4000, [[1000, 1100]])).toEqual({ above: 0, below: 0, scroll: 650 });
  // taller than the pane: its top a little below the pane's
  expect(place(800, 4000, [[1000, 2000]])).toEqual({ above: 0, below: 0, scroll: 992 });
  // a change taller than the pane (a file added whole): the slide's own lines instead
  expect(place(800, 4000, [[0, 1040], [720, 1020]])).toEqual({ above: 0, below: 0, scroll: 470 });
});

test("near a file's ends the focus is still centred: blank room above or below", () => {
  expect(place(800, 4000, [[100, 200]])).toEqual({ above: 250, below: 0, scroll: 0 });
  expect(place(800, 4000, [[3900, 3980]])).toEqual({ above: 0, below: 340, scroll: 3540 });
  // code shorter than the pane, its focus at its foot
  expect(place(800, 700, [[500, 700]])).toEqual({ above: 0, below: 300, scroll: 200 });
});

test('no focus: code that fits is centred whole, longer code stays put', () => {
  expect(place(800, 200)).toEqual({ above: 300, below: 0, scroll: 0 });
  expect(place(800, 4000)).toEqual({ above: 0, below: 0, scroll: null });
});
