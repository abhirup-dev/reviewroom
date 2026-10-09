import { icon } from './dom';
// Durable links. Every addressable thing in a review has an `rr:` ref that
// survives reloads and rounds and can be pasted into comments, markdown, HTML
// (<a href="rr:…">) or passed to rr.open().
//
//   rr:doc/<id>                 a section or any element with an id in the narrative
//   rr:doc/<id>/<css-path>      an element without an id, addressed below an ancestor id
//   rr:code/<path>[@base|@head|@<sha>][#L12[-20]]   a file or line range in the diff
//   rr:file/<path>@<rev>[#L12[-20]]                  the full file at a revision
//   rr:sym/<name>               a symbol (resolved via provider search)
//   rr:thread/<id>              a comment thread
//   rr:round/<n>                a review round

export type Ref =
  | { type: 'doc'; id: string; path?: string }
  | { type: 'code'; path: string; rev: string; start?: number; end?: number }
  | { type: 'file'; path: string; rev: string; start?: number; end?: number }
  | { type: 'sym'; name: string }
  | { type: 'thread'; id: string }
  | { type: 'round'; n: number };

const LINES = /#L(\d+)(?:-L?(\d+))?$/;

export function parseRef(input: string): Ref | null {
  let s = input.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  if (!s.startsWith('rr:')) return null;
  s = s.slice(3);
  const slash = s.indexOf('/');
  if (slash < 0) return null;
  const type = s.slice(0, slash);
  let rest = s.slice(slash + 1);
  try {
    switch (type) {
      case 'doc': {
        const i = rest.indexOf('/');
        if (i < 0) return { type: 'doc', id: decodeURIComponent(rest) };
        return { type: 'doc', id: decodeURIComponent(rest.slice(0, i)), path: decodeURIComponent(rest.slice(i + 1)) };
      }
      case 'code':
      case 'file': {
        let start: number | undefined, end: number | undefined;
        const m = rest.match(LINES);
        if (m) {
          start = +m[1];
          end = m[2] ? +m[2] : start;
          rest = rest.slice(0, m.index);
        }
        let rev = type === 'code' ? 'head' : 'head';
        const at = rest.lastIndexOf('@');
        if (at > 0) {
          rev = rest.slice(at + 1);
          rest = rest.slice(0, at);
        }
        return { type, path: decodeURI(rest), rev, start, end } as Ref;
      }
      case 'sym':
        return { type: 'sym', name: decodeURIComponent(rest) };
      case 'thread':
        return { type: 'thread', id: rest };
      case 'round':
        return { type: 'round', n: +rest };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

export function formatRef(r: Ref): string {
  switch (r.type) {
    case 'doc':
      return `rr:doc/${encodeURIComponent(r.id)}${r.path ? '/' + encodeURIComponent(r.path) : ''}`;
    case 'code':
    case 'file': {
      const lines = r.start ? `#L${r.start}${r.end && r.end !== r.start ? '-' + r.end : ''}` : '';
      const rev = r.type === 'code' && r.rev === 'head' ? '' : `@${r.rev}`;
      return `rr:${r.type}/${encodeURI(r.path)}${rev}${lines}`;
    }
    case 'sym':
      return `rr:sym/${encodeURIComponent(r.name)}`;
    case 'thread':
      return `rr:thread/${r.id}`;
    case 'round':
      return `rr:round/${r.n}`;
  }
}

/** Short human label for chips. */
export function refLabel(r: Ref, resolveDocTitle?: (id: string) => string | undefined): string {
  switch (r.type) {
    case 'doc':
      return (r.id ? resolveDocTitle?.(r.id) ?? r.id : 'Review') + (r.path ? ' › ' + r.path.split('>').pop()!.replace(/:nth-of-type\((\d+)\)/, ' $1') : '');
    case 'code':
    case 'file': {
      const base = r.path.split('/').pop()!;
      const lines = r.start ? `:${r.start}${r.end && r.end !== r.start ? '–' + r.end : ''}` : '';
      const rev = r.rev !== 'head' ? ` @${r.rev.slice(0, 7)}` : '';
      return base + lines + rev;
    }
    case 'sym':
      return r.name;
    case 'thread':
      return 'thread ' + r.id.slice(0, 6);
    case 'round':
      return 'round ' + r.n;
  }
}

export function refIcon(r: Ref): SVGSVGElement {
  return icon(({ doc: 'doc', code: 'code', file: 'files', sym: 'symbol', thread: 'thread', round: 'round' } as const)[r.type], 12);
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
