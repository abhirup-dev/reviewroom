import { Marked, type Token } from 'marked';
import { diffArrays, diffWordsWithSpace } from 'diff';

export interface BlockSide { html: string; start: number; end: number; type: string; raw: string }
export interface Block { status: 'equal' | 'modified' | 'added' | 'removed'; before?: BlockSide; after?: BlockSide }
export interface DocumentDiff { blocks: Block[]; limited?: boolean }
export interface Span { start: number; end: number }
export interface InlineDiff { before: Span[]; after: Span[] }
export type Request = { kind: 'document'; before: string | null; after: string | null } | { kind: 'inline'; pairs: { before: string; after: string }[] };

const parser = new Marked({ gfm: true });
const MAX_BYTES = 500_000;
const MAX_BLOCKS = 500;

function blocks(source: string): BlockSide[] {
  const tokens = parser.lexer(source);
  let line = 1;
  return tokens.flatMap((token: Token) => {
    const start = line;
    const count = (token.raw.match(/\n/g) ?? []).length;
    line += count;
    if (token.type === 'space' || token.type === 'def') return [];
    // Keep the complete document's reference definitions when rendering each block.
    const one = Object.assign([token], { links: tokens.links });
    return [{ html: parser.parser(one), start, end: Math.max(start, line - Number(token.raw.endsWith('\n'))), type: token.type, raw: token.raw }];
  });
}

export function documentDiff(before: string | null, after: string | null): DocumentDiff {
  if ((before?.length ?? 0) + (after?.length ?? 0) > MAX_BYTES) return { blocks: [], limited: true };
  const old = blocks(before ?? '');
  const next = blocks(after ?? '');
  if (old.length > MAX_BLOCKS || next.length > MAX_BLOCKS) return { blocks: [], limited: true };
  const changes = diffArrays(old, next, { comparator: (a, b) => a.type === b.type && a.html === b.html, timeout: 100 });
  if (!changes) return { blocks: [], limited: true };
  const result: Block[] = [];
  let oi = 0;
  let ni = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      for (let n = 0; n < change.count; n++) result.push({ status: 'equal', before: before === null ? undefined : old[oi++], after: after === null ? undefined : next[ni++] });
    } else if (change.removed) {
      const added = changes[i + 1]?.added ? changes[++i] : undefined;
      const length = Math.max(change.count, added?.count ?? 0);
      for (let n = 0; n < length; n++) {
        const a = n < change.count ? old[oi++] : undefined;
        const b = n < (added?.count ?? 0) ? next[ni++] : undefined;
        if (a && b && a.type === b.type) result.push({ status: 'modified', before: a, after: b });
        else {
          if (a) result.push({ status: 'removed', before: a });
          if (b) result.push({ status: 'added', after: b });
        }
      }
    } else for (let n = 0; n < change.count; n++) result.push({ status: 'added', after: next[ni++] });
  }
  return { blocks: result };
}

export function inlineDiff(before: string, after: string): InlineDiff {
  const result: InlineDiff = { before: [], after: [] };
  // A document-wide caller budget plus a per-pair timeout bounds refinement.
  if (before.length + after.length > 20_000 || before === after) return result;
  const changes = diffWordsWithSpace(before, after, { timeout: 12, maxEditLength: 1200 });
  if (!changes) return result;
  let old = 0;
  let next = 0;
  for (const c of changes) {
    if (c.removed) result.before.push({ start: old, end: old + c.value.length });
    if (c.added) result.after.push({ start: next, end: next + c.value.length });
    if (!c.added) old += c.value.length;
    if (!c.removed) next += c.value.length;
  }
  return result;
}
