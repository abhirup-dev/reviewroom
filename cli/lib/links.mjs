// Stale-link check for the rr: links in review.html. A link with a line range is fingerprinted (a hash
// of the lines it points at) the first time it is seen, a symbol link by having a definition; later
// checks compare against the current code.
// Used by the server (on start and whenever review.html changes) and by `reviewroom check`.
import crypto from 'node:crypto';

const DRIFT = 5; // a block that moved further than this is reported for the agent to fix, not healed
const LINK = /rr:(?:code|file|sym|doc)\/[^\s"'<>`)]+/g;
const LINES = /#L(\d+)(?:-L?(\d+))?$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hash = (lines, s, e) => crypto.createHash('sha1').update(lines.slice(s - 1, e).join('\n')).digest('hex').slice(0, 16);

/** Every distinct rr: link in the narrative, outside HTML comments (trailing sentence punctuation dropped). */
export const extractLinks = (html) => [...new Set((html.match(LINK) ?? []).map((l) => l.replace(/[.,;:]+$/, '')))];
const uncomment = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

function parse(ref) {
  const [, type, raw] = ref.match(/^rr:(\w+)\/(.*)$/);
  if (type === 'sym') return { type, name: decodeURIComponent(raw) };
  if (type === 'doc') return { type, id: decodeURIComponent(raw.split('/')[0]) };
  let rest = raw, start, end;
  const m = rest.match(LINES);
  if (m) (start = +m[1]), (end = +(m[2] || m[1])), (rest = rest.slice(0, m.index));
  let rev = 'head';
  const at = rest.lastIndexOf('@');
  if (at > 0) (rev = rest.slice(at + 1)), (rest = rest.slice(0, at));
  return { type, path: decodeURI(rest), rev, start, end };
}

/**
 * Check every link in `html` against the code. `known` is the ref → hash map from the last check
 * (state.json `links`); the returned `links` is the new one (links no longer in the narrative drop out).
 * status: ok | new (fingerprinted now) | moved (same code within ±5 lines; `to` is the fixed link) |
 * changed (the code at those lines changed, or the symbol lost its definition) | broken (file, symbol or section is gone).
 */
export function checkLinks(html, prov, known = {}) {
  html = uncomment(html);
  const results = [], links = {}, files = new Map();
  const read = (rev, p) => {
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
  const out = (ref, status, why, to) => results.push({ ref, status, ...(why && { why }), ...(to && { to }) });
  for (const ref of extractLinks(html)) {
    let r;
    try {
      r = parse(ref);
    } catch {
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
    const now = r.end <= lines.length ? hash(lines, r.start, r.end) : null;
    const prev = known[ref];
    if (!prev) {
      if (now) (links[ref] = now), out(ref, 'new');
      else out(ref, 'broken', `past the end of the file (${lines.length} lines)`);
      continue;
    }
    links[ref] = prev; // keep the original fingerprint until the link is fixed or accepted
    if (now === prev) {
      out(ref, 'ok');
      continue;
    }
    const n = r.end - r.start;
    let to;
    for (let d = 1; d <= DRIFT && !to; d++) to = [r.start + d, r.start - d].find((s) => s >= 1 && s + n <= lines.length && hash(lines, s, s + n) === prev);
    if (to) out(ref, 'moved', null, ref.replace(LINES, n ? `#L${to}-${to + n}` : `#L${to}`));
    else out(ref, 'changed', now ? 'the code at these lines changed' : `past the end of the file (${lines.length} lines)`);
  }
  return { results, links };
}

export const problems = (results) => results.filter((x) => x.status === 'moved' || x.status === 'changed' || x.status === 'broken');

/** One line per problem, for the agent. */
export const report = (bad) => bad.map((x) => `  ${x.status.padEnd(7)} ${x.ref}${x.to ? ' → ' + x.to.match(LINES)[0] : ''}${x.why ? `  (${x.why})` : ''}`).join('\n');

/** Rewrite moved links in one pass (so #L4→#L7 and #L7→#L10 can't chain) and move their fingerprints along. */
export function applyFixes(html, results, links) {
  const to = new Map(results.filter((x) => x.status === 'moved').map((x) => [x.ref, x.to]));
  const moved = [...to].map(([from, dest]) => [dest, links[from]]);
  links = { ...links };
  for (const from of to.keys()) delete links[from];
  for (const [dest, h] of moved) links[dest] = h;
  html = html.replace(LINK, (m) => {
    const ref = m.replace(/[.,;:]+$/, '');
    return to.has(ref) ? to.get(ref) + m.slice(ref.length) : m;
  });
  return { html, links };
}
