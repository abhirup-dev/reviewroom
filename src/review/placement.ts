// Where centred code goes in its pane (the walkthrough's code panel): pure, so it is tested without a browser.

/** The least space left above the focus when it is taller than the pane, in px. */
export const MIN_GAP = 8;

/** Centre code `code` px tall in a pane `pane` px tall by its focus: the first of `spans` (top and bottom in the code,
 *  px; widest first, e.g. a slide's change, then its own lines) that fits the pane goes to the pane's middle, else the
 *  last starts `MIN_GAP` from the top. Near a file's ends the code lacks room to move that far: the room is blank
 *  (`above` its first line, `below` its last), so the focus is centred all the same. No focus: code that fits is
 *  centred whole, longer code stays where it is (`scroll` null). */
export function place(pane: number, code: number, spans: readonly (readonly [number, number])[] = []): { above: number; below: number; scroll: number | null } {
  const fits = ([a, b]: readonly [number, number]) => b - a <= pane - 2 * MIN_GAP;
  const span = spans.find(fits) ?? spans[spans.length - 1];
  if (!span) return code <= pane ? { above: Math.floor((pane - code) / 2), below: 0, scroll: 0 } : { above: 0, below: 0, scroll: null };
  const want = Math.round(fits(span) ? (span[0] + span[1] - pane) / 2 : span[0] - MIN_GAP);
  return { above: Math.max(0, -want), below: Math.max(0, want + pane - code), scroll: Math.max(0, want) };
}
