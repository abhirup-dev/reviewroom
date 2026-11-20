// Line arithmetic over diff hunks (pure, so it can be tested without rendering a diff).
type Span = { deletionStart: number; deletionCount: number; additionStart: number; additionCount: number };

/** The new-file line an unchanged old-file line becomes; undefined inside a hunk (those lines are shown already). */
export function oldToNewLine(hunks: Span[], line: number): number | undefined {
  for (const hk of hunks) {
    if (line < hk.deletionStart) return line + hk.additionStart - hk.deletionStart;
    if (line < hk.deletionStart + hk.deletionCount) return;
  }
  const last = hunks[hunks.length - 1];
  return last ? line + last.additionStart + last.additionCount - (last.deletionStart + last.deletionCount) : line;
}

type Content = { type: 'context'; lines: number } | { type: 'change'; deletions: number; additions: number; deletionLineIndex: number; additionLineIndex: number };
type Diff = { hunks: (Span & { hunkContent: Content[] })[]; deletionLines: string[]; additionLines: string[] };
type Lines = [number, number];

/** A run of removed and added lines with no unchanged line between them, by file line: its old lines, its new lines,
 *  the new line it sits before (where a removal-only run is), the old line it sits before (where an addition-only run
 *  is), and its text. */
export type ChangeBlock = { del: Lines | null; add: Lines | null; at: number; oldAt: number; lines: string[] };

/** Every change block of a diff, top to bottom (a parsed patch's lines and a whole file's index alike). */
export function changeBlocks(d: Diff): ChangeBlock[] {
  return d.hunks.flatMap((hk) => {
    let o = hk.deletionStart, n = hk.additionStart;
    return hk.hunkContent.flatMap((c) => {
      if (c.type === 'context') return ((o += c.lines), (n += c.lines), []);
      const b: ChangeBlock = {
        del: c.deletions ? [o, o + c.deletions - 1] : null,
        add: c.additions ? [n, n + c.additions - 1] : null,
        at: n,
        oldAt: o,
        lines: [...d.deletionLines.slice(c.deletionLineIndex, c.deletionLineIndex + c.deletions), ...d.additionLines.slice(c.additionLineIndex, c.additionLineIndex + c.additions)],
      };
      o += c.deletions;
      n += c.additions;
      return [b];
    });
  });
}

/** The blocks a line range touches, whole: on the new side (`additions`) or the old one (`deletions`). */
export function touchedBlocks(blocks: ChangeBlock[], side: 'additions' | 'deletions', start: number, end: number) {
  const hit = (r: Lines | null) => !!r && r[0] <= end && start <= r[1];
  // a run with nothing on this side touches the range when it sits inside it
  return blocks.filter((b) => (side === 'deletions' ? hit(b.del) || (!b.del && b.oldAt > start && b.oldAt <= end) : hit(b.add) || (!b.add && b.at >= start && b.at <= end)));
}
