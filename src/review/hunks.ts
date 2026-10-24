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
