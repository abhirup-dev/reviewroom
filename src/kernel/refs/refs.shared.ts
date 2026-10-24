// Shared by the CLI and the browser: no DOM or Node imports.
//
// The rr: link grammar, in one place: per link type, a formula (a free-spaced `regex` with named groups) and the
// formatter that writes it back. Everything that reads or writes an rr: link string goes through here; labels, icons,
// previews and opening dispatch on the parsed Ref (refs/browser.ts, ReviewApp.open), never on the string.
import { pattern, regex } from 'regex';
import type { SearchHit } from '../state/model.shared';
import type { Anchor } from '../state/schema.shared';

// Durable links. Every addressable thing in a review has an `rr:` ref that
// survives reloads and rounds and can be pasted into comments, markdown, HTML
// (<a href="rr:...">) or passed to rr.open().
//
//   rr:doc/<id>                 a section or any element with an id in the walkthrough
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
type RefOf<T extends Ref['type']> = Extract<Ref, { type: T }>;

// ---------------------------------------------------------------- formulas

/** `<rr:...>`, as markdown autolinks write it. */
const BRACKETED = regex`^ < (?<inner> .* ) > $`;
/** `rr:<type>/<rest>`: the rest is read by the type's formula below. */
const ENVELOPE = regex`^ rr: (?<type> [a-z]+ ) \/ (?<rest> .* ) $`;
/** `#L12`, `#L12-20`, or `#L12-L20` as older links wrote it. */
const LINES = pattern`\#L (?<start> \d+ ) (?: -L? (?<end> \d+ ) )?`;
const LINE_SPAN = regex`${LINES} $`;
/** `<path>[@<rev>][#L..]`. A rev follows the last @ and has no /, so `packages/@scope/x.ts` stays a path. */
// shortcut: an @ in the file name itself (a/x@2.ts) still reads as a rev; escape @ in the path if that shows up
const LOCATION = regex`^ (?<path> .*? ) (?: @ (?<rev> [^@\/\#]+ ) )? (?: ${LINES} )? $`;
/** `<id>[/<css-path>]`: the path is everything after the first /. */
const DOC = regex`^ (?<id> [^\/]* ) (?: \/ (?<path> .* ) )? $`;
/** `<chapter>/<step>`: exactly two parts. */
const TOUR = regex`^ (?<chapter> [^\/]+ ) \/ (?<step> [^\/]+ ) $`;
const ROUND = regex`^ \d+ $`;
/** A symbol name: `[<path>:]<rest>`, the path being everything before the last colon... */
const SYMBOL = regex`^ (?: (?<path> .+ ) : )? (?<rest> .* ) $`;
/** ...and the rest `[<Owner>.]<word>`, the owner everything before the last dot. */
const OWNER = regex`^ (?<owner> .+ ) \. (?<word> [^.]* ) $`;
/** A GitHub thread id: `gh_<comment number>`, or `gh_conversation` for the PR's conversation tab. */
const GITHUB_THREAD = regex`^ gh_ (?<n> \d+ | conversation ) $`;

/** The rr: links the link checker follows, in any text (thread and round links point at nothing that can move). */
export const LINK_IN_TEXT = regex('g')`rr: (?: code | file | sym | doc | tour ) \/ [^\s"'<>\`\)]+`;
const TRAILING_PUNCTUATION = regex`[.,;:]+ $`;

// ---------------------------------------------------------------- forms: parse and format, per type

type Form<T extends Ref['type']> = { parse(rest: string): RefOf<T> | null; format(r: RefOf<T>): string };
const int = (s: string | undefined) => (s === undefined ? undefined : +s);

/** `#L12` or `#L12-20` ('' without a start). */
export const lineSpan = (start?: number, end?: number) => (start ? `#L${start}${end && end !== start ? '-' + end : ''}` : '');

const location = <T extends 'code' | 'file'>(type: T) =>
  ({
    parse(rest: string) {
      const g = LOCATION.exec(rest)?.groups;
      if (!g?.path) return null; // a code or file link needs a path
      const start = int(g.start);
      return { type, path: decodeURI(g.path), rev: g.rev ?? 'head', start, end: int(g.end) ?? start };
    },
    // a code link means head unless it says otherwise; a file link always names its rev
    format: (r: RefOf<'code' | 'file'>) => encodeURI(r.path) + (type === 'code' && r.rev === 'head' ? '' : '@' + r.rev) + lineSpan(r.start, r.end),
  }) as Form<T>;

const forms: { [T in Ref['type']]: Form<T> } = {
  doc: {
    parse(rest) {
      const { id, path } = DOC.exec(rest)!.groups!;
      return { type: 'doc', id: decodeURIComponent(id), ...(path !== undefined && { path: decodeURIComponent(path) }) };
    },
    format: (r) => encodeURIComponent(r.id) + (r.path ? '/' + encodeURIComponent(r.path) : ''),
  },
  code: location('code'),
  file: location('file'),
  sym: { parse: (rest) => ({ type: 'sym', name: decodeURIComponent(rest) }), format: (r) => encodeURIComponent(r.name) },
  thread: { parse: (rest) => ({ type: 'thread', id: rest }), format: (r) => r.id },
  round: { parse: (rest) => (ROUND.test(rest) ? { type: 'round', n: +rest } : null), format: (r) => String(r.n) },
  tour: {
    parse(rest) {
      const g = TOUR.exec(rest)?.groups;
      return g ? { type: 'tour', chapter: decodeURIComponent(g.chapter), step: decodeURIComponent(g.step) } : null;
    },
    format: (r) => `${encodeURIComponent(r.chapter)}/${encodeURIComponent(r.step)}`,
  },
};

// ---------------------------------------------------------------- the API

export function parseRef(input: string): Ref | null {
  const s = input.trim();
  const link = ENVELOPE.exec(BRACKETED.exec(s)?.groups!.inner ?? s)?.groups;
  if (!link || !Object.hasOwn(forms, link.type)) return null;
  try {
    return (forms[link.type as Ref['type']] as Form<Ref['type']>).parse(link.rest);
  } catch {
    return null; // a bad %-escape
  }
}

export const formatRef = (r: Ref): string => `rr:${r.type}/${(forms[r.type] as Form<Ref['type']>).format(r)}`;

/** Whether a string is written as an rr: link (valid or not): what markdown and HTML hand to the link elements. */
export const looksLikeRef = (s: string | null | undefined) => !!s?.startsWith('rr:');

/** An rr: link as found in text, without the sentence punctuation after it. */
export const trimLink = (s: string) => s.replace(TRAILING_PUNCTUATION, '');

/** The link's `#L..` part ('' without one). */
export const lineSpanOf = (ref: string) => LINE_SPAN.exec(ref)?.[0] ?? '';

/** The same link pointing at other lines; the rest of it stays as it was written. */
export const withLineSpan = (ref: string, start: number, end?: number) => ref.replace(LINE_SPAN, lineSpan(start, end));

/** The GitHub comment number of a `gh_` thread id, or 'conversation'; null for a local thread. */
export const githubThread = (id: string) => GITHUB_THREAD.exec(id)?.groups!.n ?? null;

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
  const { path, rest } = SYMBOL.exec(name)!.groups!;
  const q = OWNER.exec(rest)?.groups;
  return q ? { word: q.word, path, owner: q.owner } : { word: rest, path };
}

/**
 * The symbol search hits for `rr:sym/<name>`, definitions first. A qualifier keeps only the hits it matches: none
 * means the qualified symbol is gone, not that any `Name` will do.
 */
// shortcut: Owner matches by text on the declaration line or a path segment, so a method declared inside a class body
// (TS, Python) isn't narrowed by its class; use a path:Name link there, or a real symbol index if one lands.
export function symbolHits<H extends Pick<SearchHit, 'path' | 'text' | 'kind'>>(hits: H[], name: string): H[] {
  const { path, owner } = symbolQuery(name);
  const word = owner && regex`(^ | [^\w$]) ${owner} ([^\w$] | $)`; // the owner as a whole word (interpolation escapes it)
  const fits = (h: H) =>
    (!path || h.path === path || h.path.endsWith('/' + path)) && (!word || word.test(h.text) || h.path.split('/').includes(owner));
  const kept = path || owner ? hits.filter(fits) : hits;
  return [...kept.filter((h) => h.kind === 'definition'), ...kept.filter((h) => h.kind !== 'definition')];
}

/** Document anchor for the pull request description. */
export const PR_DESCRIPTION = 'rr-pr-description';
