// Shared by the CLI and the browser: no DOM or Node imports.
import type { Anchor, SearchHit } from '../state/model.shared';

// Durable links. Every addressable thing in a review has an `rr:` ref that
// survives reloads and rounds and can be pasted into comments, markdown, HTML
// (<a href="rr:...">) or passed to rr.open().
//
//   rr:doc/<id>                 a section or any element with an id in the narrative
//   rr:doc/<id>/<css-path>      an element without an id, addressed below an ancestor id
//   rr:code/<path>[@base|@head|@<sha>][#L12[-20]]   a file or line range in the diff
//   rr:file/<path>@<rev>[#L12[-20]]                  the full file at a revision
//   rr:sym/<name>               a symbol (resolved via provider search): Name, Owner.Name or path/file.go:Name
//   rr:thread/<id>              a comment thread
//   rr:round/<n>                a review round
//   rr:tour/<chapter>/<step>    a step of the walkthrough (walkthrough.json ids)

export type Ref =
  | { type: 'doc'; id: string; path?: string }
  | { type: 'code'; path: string; rev: string; start?: number; end?: number }
  | { type: 'file'; path: string; rev: string; start?: number; end?: number }
  | { type: 'sym'; name: string }
  | { type: 'thread'; id: string }
  | { type: 'round'; n: number }
  | { type: 'tour'; chapter: string; step: string };

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
        let rev = 'head';
        const at = rest.lastIndexOf('@');
        if (at > 0) {
          rev = rest.slice(at + 1);
          rest = rest.slice(0, at);
        }
        return { type, path: decodeURI(rest), rev, start, end };
      }
      case 'sym':
        return { type: 'sym', name: decodeURIComponent(rest) };
      case 'thread':
        return { type: 'thread', id: rest };
      case 'round':
        return { type: 'round', n: +rest };
      case 'tour': {
        const [chapter, step, ...more] = rest.split('/').map(decodeURIComponent);
        return chapter && step && !more.length ? { type: 'tour', chapter, step } : null;
      }
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
    case 'tour':
      return `rr:tour/${encodeURIComponent(r.chapter)}/${encodeURIComponent(r.step)}`;
  }
}

/** The rr: link for a stored anchor; null for a general thread. */
export function anchorRef(a: Anchor): string | null {
  switch (a.kind) {
    case 'doc':
      return formatRef({ type: 'doc', id: a.target, path: a.path });
    case 'code':
      return formatRef({ type: 'code', path: a.path, rev: a.rev, start: a.start, end: a.end });
    case 'symbol':
      return formatRef({ type: 'sym', name: a.name });
    case 'tour':
      return formatRef({ type: 'tour', chapter: a.chapter, step: a.step });
    default:
      return null;
  }
}

/** The anchor an rr: link points at (what the CLI stores for `comment <ref>`); anything else is a general thread. */
export function anchorOf(ref: string): Anchor {
  const r = parseRef(ref);
  switch (r?.type) {
    case 'doc':
      return { kind: 'doc', target: r.id, path: r.path };
    case 'code':
      return { kind: 'code', path: r.path, rev: r.rev === 'base' ? 'base' : 'head', start: r.start ?? 1, end: r.end ?? r.start ?? 1 };
    case 'sym':
      return { kind: 'symbol', name: r.name };
    case 'tour':
      return { kind: 'tour', chapter: r.chapter, step: r.step };
    default:
      return { kind: 'general' };
  }
}

/**
 * `rr:sym/<name>` forms: `Name`; `Owner.Name`, where Owner is a receiver, type or package; `path/to/file.go:Name`.
 * `word` is what to search for; the rest narrows the hits.
 */
export function symbolQuery(name: string): { word: string; path?: string; owner?: string } {
  const colon = name.lastIndexOf(':');
  const path = colon > 0 ? name.slice(0, colon) : undefined;
  const rest = colon > 0 ? name.slice(colon + 1) : name;
  const dot = rest.lastIndexOf('.');
  return dot > 0 ? { word: rest.slice(dot + 1), path, owner: rest.slice(0, dot) } : { word: rest, path };
}

/**
 * The symbol search hits for `rr:sym/<name>`, definitions first. A qualifier keeps only the hits it matches: none
 * means the qualified symbol is gone, not that any `Name` will do.
 */
// shortcut: Owner matches by text on the declaration line or a path segment, so a method declared inside a class body
// (TS, Python) isn't narrowed by its class; use a path:Name link there, or a real symbol index if one lands.
export function symbolHits<H extends Pick<SearchHit, 'path' | 'text' | 'kind'>>(hits: H[], name: string): H[] {
  const { path, owner } = symbolQuery(name);
  const word = owner && new RegExp(`(^|[^\\w$])${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`);
  const fits = (h: H) =>
    (!path || h.path === path || h.path.endsWith('/' + path)) && (!word || word.test(h.text) || h.path.split('/').includes(owner));
  const kept = path || owner ? hits.filter(fits) : hits;
  return [...kept.filter((h) => h.kind === 'definition'), ...kept.filter((h) => h.kind !== 'definition')];
}

/** Document anchor for the pull request description. */
export const PR_DESCRIPTION = 'rr-pr-description';
