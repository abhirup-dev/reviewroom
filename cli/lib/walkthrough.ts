// walkthrough.json on the CLI side: where a link sits in it (for `check`), the PR block (`pr`, `walkthrough publish`).
import type { Walkthrough } from '../../src/shared/walkthrough.ts';
import type { LinkResult } from './links.ts';

/** Tag each result with where its link appears in the walkthrough: `<chapter>/<step>`, or `<chapter>` for a lead. */
export function locate(results: LinkResult[], w: Walkthrough | null) {
  if (!w) return results;
  const has = (s: string | undefined, ref: string) => !!s && (s === ref || s.includes(ref + '"') || s.includes(ref + "'") || s.includes(ref + '<'));
  return results.map((r) => {
    const where = w.chapters.flatMap((c) => [...(has(c.lead, r.ref) ? [c.id] : []), ...c.steps.filter((s) => has(s.ref, r.ref) || has(s.text, r.ref)).map((s) => `${c.id}/${s.id}`)]);
    return where.length ? { ...r, where } : r;
  });
}
