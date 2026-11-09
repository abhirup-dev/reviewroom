// Stale-link check for the rr: links in review.html and walkthrough.json. A link with a line range is fingerprinted (a hash
// of the lines it points at) the first time it is seen, a symbol link by having a definition; later
// checks compare against the current code.
// Used by the server (on start and whenever review.html or walkthrough.json changes) and by `reviewroom check`.
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Provider } from './git.ts';
import { regex } from 'regex';
import { LINK_IN_TEXT, lineSpanOf, parseRef, symbolHits, symbolQuery, trimLink, withLineSpan } from '../../src/kernel/refs/refs.shared.ts';
import type { Walkthrough } from '../../src/slides/model.shared.ts';
import { lookupDeclarations } from './source/lookup';

export type SymbolResolver = { resolveSymbol: (name: string) => ReturnType<Provider['search']> };

/** Translate authored symbol links once; source checking itself knows nothing about rr: links or reviews. */
export async function prepareSymbols(repo: string, prov: Provider, refs: readonly string[]): Promise<Provider & SymbolResolver> {
  const names = [...new Set(refs.flatMap((ref) => { const r = parseRef(ref); return r?.type === 'sym' ? [r.name] : []; }))];
  if (!names.length) return { ...prov, resolveSymbol: (name) => symbolHits(prov.search(symbolQuery(name).word, prov.head, true, 500), name) };
  const batch = await lookupDeclarations({ repo, revision: prov.head, queries: names.map((name) => { const { word, ...rest } = symbolQuery(name); return { name: word, ...rest }; }) });
  if (batch.coverage.issues.length) console.error(`source symbol search fell back to Git: ${batch.coverage.issues.join('; ')}`);
  const found = new Map<string, ReturnType<Provider['search']>>();
  return { ...prov, resolveSymbol: (name) => {
    if (!found.has(name)) {
      const result = batch.results[names.indexOf(name)];
      const hits = result?.declarations.map((d) => ({ path: d.path, line: d.range.start.line + 1, text: d.signature, rev: batch.snapshot.revision, kind: 'definition' as const })) ?? [];
      // An AST miss/partial read cannot establish absence. Preserve the existing reference fallback too.
      found.set(name, hits.length && !batch.coverage.skippedFiles.length ? hits : symbolHits(prov.search(symbolQuery(name).word, prov.head, true, 500), name));
    }
    return found.get(name)!;
  } };
}

const LinkStatus = z.enum(['ok', 'new', 'moved', 'changed', 'broken']);
export type LinkStatus = z.infer<typeof LinkStatus>;
export const LinkResult = z.object({
  ref: z.string(), status: LinkStatus, why: z.string().optional(),
  where: z.array(z.string()).optional(), to: z.string().optional(),
});
export type LinkResult = z.infer<typeof LinkResult>;
/** ref -> fingerprint (a line-range hash, or 'definition' for a symbol): state.json `links`. */
export type Links = Record<string, string>;

const DRIFT = 5; // a block that moved further than this is reported for the agent to fix, not healed
const hash = (lines: string[], s: number, e: number) => crypto.createHash('sha1').update(lines.slice(s - 1, e).join('\n')).digest('hex').slice(0, 16);

/** Every distinct rr: link in the walkthrough, outside HTML comments (trailing sentence punctuation dropped). */
export const extractLinks = (html: string) => [...new Set((html.match(LINK_IN_TEXT) ?? []).map(trimLink))];
export const uncomment = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');


/**
 * Check every link in `html`, and in `extra` (walkthrough.json's prose and refs: tourText), against the code. `known` is the ref -> hash map from the last check
 * (state.json `links`); `tour` is the parsed walkthrough.json a `rr:tour` link must point into; the returned `links` is the new one (links no longer in the walkthrough drop out).
 * An array in `extra` checks only those refs; the full HTML and tour still resolve doc/tour targets.
 * status: ok | new (fingerprinted now) | moved (same code within +/-5 lines; `to` is the fixed link) |
 * changed (the code at those lines changed, or the symbol lost its definition) | broken (file, symbol or section is gone).
 */
export function checkLinks(html: string, prov: Pick<Provider, 'head' | 'base' | 'read' | 'search'> & Partial<SymbolResolver>, known: Links = {}, extra: string | readonly string[] = '', tour: Walkthrough | null = null) {
  const visible = uncomment(html);
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
  // An explicit ref list scopes validation, while the full HTML remains available to resolve rr:doc targets.
  const refs = typeof extra === 'string' ? extractLinks(visible + '\n' + uncomment(extra)) : [...new Set(extra)];
  for (const ref of refs) {
    const r = parseRef(ref);
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
      if (regex`\b id= ["']? ${r.id} ["'\s>]`.test(visible)) out(ref, 'ok');
      else out(ref, 'broken', 'no element with this id in the walkthrough');
      continue;
    }
    if (r.type === 'sym') {
      // definitions come first; only a symbol that had one is held to it (the search misses some forms)
      const hit = (prov.resolveSymbol ? prov.resolveSymbol(r.name) : symbolHits(prov.search(symbolQuery(r.name).word, prov.head, true, 500), r.name))[0];
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
    if (to) out(ref, 'moved', null, withLineSpan(ref, to, to + n));
    else out(ref, 'changed', now ? 'the code at these lines changed' : `past the end of the file (${lines.length} lines)`);
  }
  return { results, links };
}

export const problems = (results: LinkResult[]) => results.filter((x) => x.status === 'moved' || x.status === 'changed' || x.status === 'broken');

/** One line per problem, for the agent. */
export const report = (bad: LinkResult[]) =>
  bad.map((x) => `  ${x.status.padEnd(7)} ${x.ref}${x.to ? ' -> ' + lineSpanOf(x.to) : ''}${x.why ? `  (${x.why})` : ''}${x.where ? `  [guided walkthrough ${x.where.join(', ')}]` : ''}`).join('\n');

/** Rewrite moved links in one pass (so #L4->#L7 and #L7->#L10 can't chain) and move their fingerprints along. */
export function applyFixes(html: string, results: LinkResult[], links: Links) {
  const to = new Map(results.filter((x) => x.status === 'moved').map((x) => [x.ref, x.to!]));
  const moved = [...to].map(([from, dest]) => [dest, links[from]]);
  const next = { ...links };
  for (const from of to.keys()) delete next[from];
  for (const [dest, h] of moved) next[dest] = h;
  const fixed = html.replace(LINK_IN_TEXT, (m) => {
    const ref = trimLink(m);
    return to.has(ref) ? to.get(ref)! + m.slice(ref.length) : m;
  });
  return { html: fixed, links: next };
}
