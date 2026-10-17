// Stale-link check for the rr: links in review.html and walkthrough.json. A link with a line range is fingerprinted (a hash
// of the lines it points at) the first time it is seen, a symbol link by having a definition; later
// checks compare against the current code.
// Used by the server (on start and whenever review.html changes) and by `reviewroom check`.
import crypto from 'node:crypto';
import type { Provider } from './git.ts';
import { parseRef } from '../../src/shared/refs.ts';

export type LinkStatus = 'ok' | 'new' | 'moved' | 'changed' | 'broken';
export interface LinkResult {
  ref: string;
  status: LinkStatus;
  why?: string;
  /** where it is in walkthrough.json (`<chapter>/<step>`, or `<chapter>` for a lead) */
  where?: string[];
  /** for `moved`: the fixed link */
  to?: string;
}
/** ref -> fingerprint (a line-range hash, or 'definition' for a symbol): state.json `links`. */
export type Links = Record<string, string>;

const DRIFT = 5; // a block that moved further than this is reported for the agent to fix, not healed
const LINK = /rr:(?:code|file|sym|doc)\/[^\s"'<>`)\\]+/g; // no backslash: links inside JSON strings end at \"
const LINES = /#L(\d+)(?:-L?(\d+))?$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hash = (lines: string[], s: number, e: number) => crypto.createHash('sha1').update(lines.slice(s - 1, e).join('\n')).digest('hex').slice(0, 16);

/** Every distinct rr: link in the narrative, outside HTML comments (trailing sentence punctuation dropped). */
export const extractLinks = (html: string) => [...new Set((html.match(LINK) ?? []).map((l) => l.replace(/[.,;:]+$/, '')))];
const uncomment = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');


/**
 * Check every link in `html`, and in `extra` (walkthrough.json's text), against the code. `known` is the ref -> hash map from the last check
 * (state.json `links`); the returned `links` is the new one (links no longer in the narrative drop out).
 * status: ok | new (fingerprinted now) | moved (same code within +/-5 lines; `to` is the fixed link) |
 * changed (the code at those lines changed, or the symbol lost its definition) | broken (file, symbol or section is gone).
 */
export function checkLinks(html: string, prov: Pick<Provider, 'head' | 'base' | 'read' | 'search'>, known: Links = {}, extra = '') {
  html = uncomment(html);
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
  const out = (ref: string, status: LinkStatus, why?: string | null, to?: string) => results.push({ ref, status, ...(why && { why }), ...(to && { to }) });
  for (const ref of extractLinks(html + '\n' + extra)) {
    const r = parseRef(ref);
    if (!r || r.type === 'thread' || r.type === 'round' || r.type === 'tour') {
      out(ref, 'broken', 'not a valid link');
      continue;
    }
    if (r.type === 'doc') {
      if (new RegExp(`\\bid=["']?${esc(r.id)}["'\\s>]`).test(html)) out(ref, 'ok');
      else out(ref, 'broken', 'no element with this id in the narrative');
      continue;
    }
    if (r.type === 'sym') {
      // definitions come first; only a symbol that had one is held to it (the search misses some forms)
      const hit = prov.search(r.name, prov.head, true, 1)[0];
      if (!hit) out(ref, 'broken', 'symbol not found at head');
      else if (known[ref] && hit.kind !== 'definition') out(ref, 'changed', 'its definition is gone, only references are left');
      else out(ref, known[ref] || hit.kind !== 'definition' ? 'ok' : 'new');
      if (known[ref] || hit?.kind === 'definition') links[ref] = 'definition';
      continue;
    }
    const text = read(r.rev, r.path);
    if (text == null) {
      out(ref, 'broken', `file not found at ${r.rev}`);
      continue;
    }
    if (!r.start) {
      out(ref, 'ok'); // a whole-file link only needs the file
      continue;
    }
    const lines = text.split('\n');
    const end = r.end!; // set whenever start is
    const now = end <= lines.length ? hash(lines, r.start, end) : null;
    const prev = known[ref];
    if (!prev) {
      if (now) {
        links[ref] = now;
        out(ref, 'new');
      } else out(ref, 'broken', `past the end of the file (${lines.length} lines)`);
      continue;
    }
    links[ref] = prev; // keep the original fingerprint until the link is fixed or accepted
    if (now === prev) {
      out(ref, 'ok');
      continue;
    }
    const n = end - r.start;
    let to: number | undefined;
    for (let d = 1; d <= DRIFT && !to; d++) to = [r.start + d, r.start - d].find((s) => s >= 1 && s + n <= lines.length && hash(lines, s, s + n) === prev);
    if (to) out(ref, 'moved', null, ref.replace(LINES, n ? `#L${to}-${to + n}` : `#L${to}`));
    else out(ref, 'changed', now ? 'the code at these lines changed' : `past the end of the file (${lines.length} lines)`);
  }
  return { results, links };
}

export const problems = (results: LinkResult[]) => results.filter((x) => x.status === 'moved' || x.status === 'changed' || x.status === 'broken');

/** One line per problem, for the agent. */
export const report = (bad: LinkResult[]) =>
  bad.map((x) => `  ${x.status.padEnd(7)} ${x.ref}${x.to ? ' -> ' + x.to.match(LINES)![0] : ''}${x.why ? `  (${x.why})` : ''}${x.where ? `  [walkthrough ${x.where.join(', ')}]` : ''}`).join('\n');

/** Rewrite moved links in one pass (so #L4->#L7 and #L7->#L10 can't chain) and move their fingerprints along. */
export function applyFixes(html: string, results: LinkResult[], links: Links) {
  const to = new Map(results.filter((x) => x.status === 'moved').map((x) => [x.ref, x.to!]));
  const moved = [...to].map(([from, dest]) => [dest, links[from]]);
  links = { ...links };
  for (const from of to.keys()) delete links[from];
  for (const [dest, h] of moved) links[dest] = h;
  html = html.replace(LINK, (m) => {
    const ref = m.replace(/[.,;:]+$/, '');
    return to.has(ref) ? to.get(ref)! + m.slice(ref.length) : m;
  });
  return { html, links };
}
