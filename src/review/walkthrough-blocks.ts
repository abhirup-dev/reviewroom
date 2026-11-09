import { cssPathWithin } from '../kernel/refs/browser';
import { formatRef } from '../kernel/refs/refs.shared';
import type { Anchor } from '../kernel/state/schema.shared';
import { plainExcerpt } from '../kernel/markdown';

export const WALKTHROUGH_BLOCKS =
  'h1,h2,h3,h4,h5,h6,p,li,pre,table,figure,blockquote,img,svg,canvas,video,details,dl,[data-rr-block],rr-code,rr-embed,rr-callout,rr-mermaid,rr-checklist,.rr-block';

export function walkthroughBlock(doc: HTMLElement, target: EventTarget | null, precise = false): Element | null {
  if (!(target instanceof Element) || !doc.contains(target) || target === doc) return null;
  if (precise) return target;
  const svg = target.closest('svg');
  const el = svg ? svg.closest('figure,[data-rr-block],rr-mermaid') ?? svg : target.closest(WALKTHROUGH_BLOCKS);
  return el && doc.contains(el) ? el : null;
}

function anchorFor(doc: HTMLElement, el: Element) {
  if (el.id) return { target: el.id };
  const owner = el.parentElement?.closest('[id]');
  const root = owner && doc.contains(owner) ? owner : doc;
  return { target: root === doc ? '' : root.id, path: cssPathWithin(root, el) || undefined };
}

export interface WalkthroughBlock {
  anchor: Extract<Anchor, { kind: 'doc' }>;
  reference: string;
  pinReference: string;
  excerpt: string;
}

/** Resolve once at activation. Every entry point uses the same stable reference and pin semantics. */
export function resolveWalkthroughBlock(doc: HTMLElement, rootId: string, el: Element): WalkthroughBlock {
  const at = anchorFor(doc, el);
  const anchor = { kind: 'doc' as const, ...at, target: at.target || rootId };
  const reference = formatRef({ type: 'doc', id: anchor.target, path: anchor.path });
  const section = el.parentElement;
  const sectionHeading = /^H[1-6]$/.test(el.tagName) && section?.matches('section[id]') && section.firstElementChild === el;
  return {
    anchor, reference,
    pinReference: sectionHeading && section ? formatRef({ type: 'doc', id: section.id }) : reference,
    excerpt: plainExcerpt(el.textContent || '', 140),
  };
}
