import { decodeHTML, decodeHTMLAttribute, escapeAttribute } from 'entities';
import { LINK_IN_TEXT, formatRef, parseRef, trimLink } from '../../src/kernel/refs/refs.shared.ts';
import { CommitSha, WalkthroughBundle } from '../../src/slides/bundle.shared.ts';
import { stepRefs, type Walkthrough } from '../../src/slides/model.shared.ts';
import type { ChangedFile } from '../../src/kernel/state/model.shared.ts';
import { fail } from './args.ts';
import type { Provider } from './git.ts';
import type { SymbolResolver } from './links.ts';

/** Rewrite only actionable prose refs. Keep the narration and the labels of links that leave the walkthrough. */
function rewriteProse(html: string, resolve: (ref: string) => string | undefined) {
  const diagramRefs = (source: string) => source.replace(LINK_IN_TEXT, (raw) => {
    const ref = trimLink(raw);
    return (resolve(ref) ?? '') + raw.slice(ref.length);
  });
  let chipHasText = false;
  let diagramText = '';
  let readDiagramText = false;
  return new HTMLRewriter()
    .on('a[href], rr-ref[ref], rr-embed[ref], rr-code[ref]', {
      element(el) {
        const attr = el.tagName === 'a' ? 'href' : 'ref';
        const value = decodeHTMLAttribute(el.getAttribute(attr)!);
        const ref = resolve(value);
        if (ref) el.setAttribute(attr, escapeAttribute(ref));
        else if (el.tagName === 'rr-code') el.removeAttribute(attr);
        else {
          // An empty rr-ref/rr-embed normally gets its label from the workbench.
          const target = parseRef(value);
          if (target?.type === 'doc' && el.tagName === 'rr-embed') el.setInnerContent(decodeHTMLAttribute(el.getAttribute('caption') ?? '') || 'Report section');
          chipHasText = false;
          if (target?.type === 'doc' && el.tagName === 'rr-ref') el.onEndTag((tag) => {
            // A chip with authored text keeps it. Empty chips use a readable report-section label.
            if (!chipHasText) tag.before('Report section');
          });
          el.removeAndKeepContent();
        }
      },
    })
    .on('rr-ref', { text(chunk) { chipHasText ||= !!chunk.text.trim(); } })
    .on('rr-mermaid', {
      element(el) {
        const source = el.getAttribute('data-src');
        readDiagramText = source === null;
        if (source !== null) el.setAttribute('data-src', escapeAttribute(diagramRefs(decodeHTMLAttribute(source))));
      },
      text(chunk) {
        if (!readDiagramText) return;
        diagramText += chunk.text;
        if (chunk.lastInTextNode) {
          chunk.replace(diagramRefs(decodeHTML(diagramText)));
          diagramText = '';
        } else chunk.remove();
      },
    })
    .transform(html);
}

type BundleProvider = Pick<Provider, 'meta' | 'base' | 'head' | 'files' | 'read'> & SymbolResolver;

export function buildWalkthroughBundle(walkthrough: Walkthrough, provider: BundleProvider, commit: (rev: string) => string | null, exportedAt: string) {
  const { base, head } = provider;
  if (!CommitSha.safeParse(base).success || !CommitSha.safeParse(head).success)
    fail('walkthrough export requires committed base and head revisions');
  const { repo, number: pr, title, author, baseLabel, headLabel } = provider.meta();
  const changed = provider.files(base, head);
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const byOldPath = new Map(changed.flatMap((f) => f.prevPath ? [[f.prevPath, f] as const] : []));
  const files = new Set<ChangedFile>();
  const reads = new Map<string, string | null>();
  const read = (rev: string, path: string) => {
    const key = `${rev}:${path}`;
    if (!reads.has(key)) reads.set(key, provider.read(rev, path));
    return reads.get(key);
  };
  const revisions = new Map<string, string | null>([['base', base], ['head', head]]);
  const links = new Map<string, string | undefined>();
  const resolve = (ref: string) => {
    if (links.has(ref)) return links.get(ref);
    const result = rewrite(ref);
    links.set(ref, result);
    return result;
  };
  function sourceTarget(ref: string) {
    const target = parseRef(ref);
    if (target?.type !== 'sym') return target;
    const hit = provider.resolveSymbol(target.name)[0];
    return hit ? { type: 'code' as const, path: hit.path, rev: 'head', start: hit.line, end: hit.line } : null;
  }
  function rewrite(ref: string) {
    const target = sourceTarget(ref);
    if (target?.type === 'tour') return ref;
    if (target?.type !== 'code' && target?.type !== 'file') return;
    const { path, rev } = target;
    if (!revisions.has(rev)) revisions.set(rev, commit(rev));
    const sha = revisions.get(rev);
    if (!sha) return;
    const file = (sha === base ? byOldPath.get(path) : undefined) ?? byPath.get(path);
    // A code link can name a renamed file by the new path on the base side.
    const previous = file?.prevPath ?? path;
    const lookupPath = sha === base ? previous : path;
    if (read(sha, lookupPath) == null) return;
    if (file) files.add(file);
    read(base, previous);
    read(head, file?.path ?? path);
    const type = target.type === 'code' && file && (sha === base || sha === head) ? 'code' : 'file';
    return formatRef({ ...target, path: type === 'code' ? file!.path : lookupPath, rev: sha, type });
  }
  const chapters = walkthrough.chapters.map((chapter) => ({
    ...chapter,
    ...(chapter.lead !== undefined && { lead: rewriteProse(chapter.lead, resolve) }),
    steps: chapter.steps.map(({ ref: authored, text, ...step }) => {
      const refs = stepRefs({ ref: authored }).flatMap((ref) => resolve(ref) ?? []);
      const ref = refs.length ? (Array.isArray(authored) ? refs : refs[0]) : undefined;
      return { ...step, text: rewriteProse(text, resolve), ref };
    }),
  }));
  return WalkthroughBundle.parse({
    version: 1, walkthrough: { ...walkthrough, chapters },
    source: { repo, pr, title, author, base, head, baseLabel, headLabel, exportedAt },
    files: [...files],
    contents: Object.fromEntries([...reads].filter((entry): entry is [string, string] => entry[1] !== null)),
  });
}

/** Escape every opening angle bracket so data can never terminate its script element. */
export const bundleJson = (bundle: WalkthroughBundle) => JSON.stringify(bundle).replace(/</g, '\\u003c');
