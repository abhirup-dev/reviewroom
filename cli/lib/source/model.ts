import { z } from 'zod';

const Position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
/** Zero-based UTF-16 positions; the end is exclusive (LSP conventions). */
const Range = z.object({ start: Position, end: Position });
export const DeclarationQuery = z.object({ name: z.string().min(1), path: z.string().optional(), owner: z.string().optional() });
export type DeclarationQuery = z.infer<typeof DeclarationQuery>;
export const SourceCheckInput = z.object({ repo: z.string().min(1), revision: z.string().min(1), queries: z.array(DeclarationQuery).min(1) });
export type SourceCheckInput = z.infer<typeof SourceCheckInput>;
export const Declaration = z.object({
  name: z.string(), path: z.string(), language: z.string(), kind: z.string(), owners: z.array(z.string()),
  range: Range, selectionRange: Range.optional(), signature: z.string(), evidence: z.literal('syntax'),
});
export type Declaration = z.infer<typeof Declaration>;
export const SourceCheckResult = z.object({
  snapshot: z.object({ repo: z.string(), revision: z.string() }),
  results: z.array(z.object({ query: DeclarationQuery, status: z.enum(['found', 'unverified']), declarations: z.array(Declaration) })),
  // An outline is not exhaustive symbol resolution. Empty matches and unreported files stay unverified.
  coverage: z.object({ filesConsidered: z.number().int().nonnegative(), unverifiedFiles: z.array(z.string()), skippedFiles: z.array(z.string()), issues: z.array(z.string()) }),
});
export type SourceCheckResult = z.infer<typeof SourceCheckResult>;
