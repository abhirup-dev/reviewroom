import { icon } from '../dom';
import type { Ref } from './refs.shared';
// the rr: grammar lives in src/kernel/refs/refs.shared.ts (the CLI parses it too)
export { parseRef, formatRef, type Ref } from './refs.shared';
/** Short human label for chips; never shows ids or CSS paths (ReviewApp.label adds DOM-aware names). */
export function refLabel(r: Ref, resolveDocTitle?: (id: string) => string | undefined): string {
  switch (r.type) {
    case 'doc':
      return (r.id && resolveDocTitle?.(r.id)) || 'Review';
    case 'code':
    case 'file': {
      const base = r.path.split('/').pop()!;
      const lines = r.start ? `:${r.start}${r.end && r.end !== r.start ? '–' + r.end : ''}` : '';
      const rev = r.rev === 'base' ? ' (before)' : r.rev !== 'head' ? ` @${r.rev.slice(0, 7)}` : '';
      return base + lines + rev;
    }
    case 'sym':
      return r.name;
    case 'thread':
      return 'Thread';
    case 'round':
      return 'Round ' + r.n;
    case 'tour':
      return 'Guided walkthrough slide'; // ReviewApp.label names the chapter and step
  }
}

export function refIcon(r: Ref): SVGSVGElement {
  return icon(({ doc: 'doc', code: 'code', file: 'files', sym: 'symbol', thread: 'thread', round: 'round', tour: 'play' } as const)[r.type], 12);
}

/** Build a CSS path from `ancestor` down to `el` (used for elements without ids). */
export function cssPathWithin(ancestor: Element, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== ancestor) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const tag = cur.tagName.toLowerCase();
    const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join('>');
}
