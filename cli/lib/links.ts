// Stale-link check for the rr: links in review.html and walkthrough.json. A link with a line range is fingerprinted (a hash
// of the lines it points at) the first time it is seen, a symbol link by having a definition; later
// checks compare against the current code.
// Used by the server (on start and whenever review.html or walkthrough.json changes) and by `reviewroom check`.
import crypto from 'node:crypto';
import type { Provider } from './git.ts';
import { regex } from 'regex';
import { formatRef, LINK_IN_TEXT, lineSpanOf, parseRef, symbolHits, symbolQuery, trimLink, withLineSpan } from '../../src/kernel/refs/refs.shared.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';

export type LinkStatus = 'ok' | 'new' | 'moved' | 'changed' | 'broken';
export interface LinkResult {
  ref: string;
  status: LinkStatus;
  why?: string;
  /** where it is in walkthrough.json (`<chapter>/<step>`, or `<chapter>` for a lead) */
  where?: string[];
  /** for `moved`: the fixed link */
  to?: string;
  /** a stack: the PR whose layer it was checked at (a link in its chapter or `data-pr` section), and its key in `links` */
  pr?: number;
  key?: string;
}
/** Text a link can sit in; `pr`: about that PR of a stack, so its links read at that PR's layer. */
export type Piece = { text: string; pr?: number };
/** ref -> fingerprint (a line-range hash, or 'definition' for a symbol): state.json `links`. */
export type Links = Record<string, string>;

const DRIFT = 5; // a block that moved further than this is reported for the agent to fix, not healed
const hash = (lines: string[], s: number, e: number) => crypto.createHash('sha1').update(lines.slice(s - 1, e).join('\n')).digest('hex').slice(0, 16);

/** Every distinct rr: link in the walkthrough, outside HTML comments (trailing sentence punctuation dropped). */
export const extractLinks = (html: string) => [...new Set((html.match(LINK_IN_TEXT) ?? []).map(trimLink))];
export const uncomment = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

/** The links of review.html, each with the PR of the innermost `data-pr` element it is in (Bun's HTMLRewriter marks
 *  where those start and end; the text between the marks is scanned like the rest). */
function sectionLinks(html: string): { ref: string; pr?: number }[] {
  const marked = new HTMLRewriter()
    .on('[data-pr]', {
      element(e) {
        const n = e.getAttribute('data-pr')!;
        e.prepend(`\u0001${/^[1-9]\d*$/.test(n) ? n : ''}\u0001`, { html: true });
        e.onEndTag((end) => void end.before('\u0001/\u0001', { html: true }));
      },
    })
    .transform(html);
  const out: { ref: string; pr?: number }[] = [];
  const open: (number | undefined)[] = [];
  for (const [i, part] of marked.split('\u0001').entries()) {
    if (i % 2) void (part === '/' ? open.pop() : open.push(part ? +part : undefined));
    else for (const ref of extractLinks(part)) out.push({ ref, pr: open.at(-1) });
  }
  return out;
}
/** In a PR's chapter or section, a plain code or file link is that PR's layer: its key in `links` says so (`@pr:<n>`). */
function inLayer(ref: string, pr?: number) {
  const r = parseRef(ref);
  const layered = !!pr && (r?.type === 'code' || r?.type === 'file') && !r.pr && (r.rev === 'head' || r.rev === 'base');
  return { r: layered ? { ...r, pr } : r, key: layered ? formatRef({ ...r, pr }) : ref };
}


/**
 * Check every link in `html`, and in `extra` (walkthrough.json's prose and refs: tourText), against the code. `known` is the ref -> hash map from the last check
 * (state.json `links`); `tour` is the parsed walkthrough.json a `rr:tour` link must point into; the returned `links` is the new one (links no longer in the walkthrough drop out).
 * status: ok | new (fingerprinted now) | moved (same code within +/-5 lines; `to` is the fixed link) |
 * changed (the code at those lines changed, or the symbol lost its definition) | broken (file, symbol or section is gone).
 */
export function checkLinks(html: string, prov: Pick<Provider, 'head' | 'base' | 'read' | 'search'> & Partial<Pick<Provider, 'layers'>>, known: Links = {}, extra: string | Piece[] = '', tour: Walkthrough | null = null) {
  html = uncomment(html);
  // a stack: every link with the PR it is about; one key per link and layer
  const stacked = !!prov.layers;
  const items = [...(stacked ? sectionLinks(html) : extractLinks(html).map((ref) => ({ ref, pr: undefined as number | undefined }))), ...[extra].flat().flatMap((p) => (typeof p === 'string' ? { text: p } : p)).flatMap((p) => extractLinks(uncomment(p.text)).map((ref) => ({ ref, pr: stacked ? p.pr : undefined })))];
  const seen = new Set<string>();
  const results: LinkResult[] = [], links: Links = {}, files = new Map<string, string | null>();
  const read = (rev: string, p: string) => {
    const sha = rev === 'head' ? prov.head : rev === 'base' ? prov.base : rev;
    if (!files.has(sha + ':' + p)) {
      let text = null;
      try {
        text = prov.read(sha, p);
      } catch {} // unknown rev
      files.set(sha + ':' + p, text);
    }
    return files.get(sha + ':' + p);
  };
  for (const item of items) {
    const { ref } = item;
    const { r, key } = inLayer(ref, item.pr);
    if (seen.has(key)) continue;
    seen.add(key);
    const at = key !== ref ? { pr: item.pr, key } : {};
    const out = (_: string, status: LinkStatus, why?: string | null, to?: string) => results.push({ ref, status, ...(why && { why }), ...(to && { to }), ...at });
    if (!r || r.type === 'thread' || r.type === 'round') {
      out(ref, 'broken', 'not a valid link');
      continue;
    }
    if (r.type === 'tour') {
      if (!tour) out(ref, 'broken', 'no walkthrough.json');
      else if (!tour.chapters.some((c) => c.id === r.chapter && c.steps.some((s) => s.id === r.step))) out(ref, 'broken', 'no such chapter/step in walkthrough.json');
      else out(ref, 'ok');
      continue;
    }
    if (r.type === 'doc') {
      if (regex`\b id= ["']? ${r.id} ["'\s>]`.test(html)) out(ref, 'ok');
      else out(ref, 'broken', 'no element with this id in the walkthrough');
      continue;
    }
    if (r.type === 'sym') {
      // definitions come first; only a symbol that had one is held to it (the search misses some forms)
      const hit = symbolHits(prov.search(symbolQuery(r.name).word, prov.head, true, 500), r.name)[0];
      if (!hit) out(ref, 'broken', 'symbol not found at head');
      else if (known[key] && hit.kind !== 'definition') out(ref, 'changed', 'its definition is gone, only references are left');
      else out(ref, known[key] || hit.kind !== 'definition' ? 'ok' : 'new');
      if (known[key] || hit?.kind === 'definition') links[key] = 'definition';
      continue;
    }
    // @pr:<n>: that side of the PR's layer
    const layer = r.pr ? prov.layers?.find((l) => l.number === r.pr) : undefined;
    if (r.pr && !layer) {
      out(ref, 'broken', `PR #${r.pr} is not in this review's stack`);
      continue;
    }
    const text = read(layer ? (r.rev === 'base' ? layer.base : layer.head) : r.rev, r.path);
    if (text == null) {
      out(ref, 'broken', `file not found at ${r.pr ? `#${r.pr}'s ${r.rev}` : r.rev}`);
      continue;
    }
    if (!r.start) {
      out(ref, 'ok'); // a whole-file link only needs the file
      continue;
    }
    const lines = text.split('\n');
    const end = r.end!; // set whenever start is
    const now = end <= lines.length ? hash(lines, r.start, end) : null;
    const prev = known[key];
    if (!prev) {
      if (now) {
        links[key] = now;
        out(ref, 'new');
      } else out(ref, 'broken', `past the end of the file (${lines.length} lines)`);
      continue;
    }
    links[key] = prev; // keep the original fingerprint until the link is fixed or accepted
    if (now === prev) {
      out(ref, 'ok');
      continue;
    }
    const n = end - r.start;
    let to: number | undefined;
    for (let d = 1; d <= DRIFT && !to; d++) to = [r.start + d, r.start - d].find((s) => s >= 1 && s + n <= lines.length && hash(lines, s, s + n) === prev);
    if (to) out(ref, 'moved', null, withLineSpan(ref, to, to + n));
    else out(ref, 'changed', now ? 'the code at these lines changed' : `past the end of the file (${lines.length} lines)`);
  }
  return { results, links };
}

export const problems = (results: LinkResult[]) => results.filter((x) => x.status === 'moved' || x.status === 'changed' || x.status === 'broken');

/** One line per problem, for the agent. */
export const report = (bad: LinkResult[]) =>
  bad.map((x) => `  ${x.status.padEnd(7)} ${x.ref}${x.pr ? ` (at #${x.pr}'s layer)` : ''}${x.to ? ' -> ' + lineSpanOf(x.to) : ''}${x.why ? `  (${x.why})` : ''}${x.where ? `  [guided walkthrough ${x.where.join(', ')}]` : ''}`).join('\n');

/** Rewrite moved links in one pass (so #L4->#L7 and #L7->#L10 can't chain) and move their fingerprints along. */
export function applyFixes(html: string, results: LinkResult[], links: Links) {
  // a link written once but checked at two layers is rewritten only when both say the same
  const to = new Map(results.filter((x) => x.status === 'moved' && results.every((y) => y.ref !== x.ref || y.to === x.to)).map((x) => [x.ref, x.to!]));
  const keyOf = (ref: string, x: LinkResult) => (x.key ? inLayer(ref, x.pr).key : ref);
  const fixed = results.filter((x) => to.has(x.ref));
  const moved = fixed.map((x) => [keyOf(x.to!, x), links[x.key ?? x.ref]] as const);
  links = { ...links };
  for (const x of fixed) delete links[x.key ?? x.ref];
  for (const [dest, h] of moved) links[dest] = h;
  html = html.replace(LINK_IN_TEXT, (m) => {
    const ref = trimLink(m);
    return to.has(ref) ? to.get(ref)! + m.slice(ref.length) : m;
  });
  return { html, links };
}
