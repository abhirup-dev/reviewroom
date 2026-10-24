// Human names for things in the walkthrough, so the UI never shows ids, CSS paths or rr: strings.

const KIND: Record<string, string> = {
  P: 'Paragraph', LI: 'List item', UL: 'List', OL: 'List', DL: 'List', TABLE: 'Table', TR: 'Table row', TD: 'Table cell', TH: 'Table header',
  FIGURE: 'Figure', FIGCAPTION: 'Caption', PRE: 'Code block', CODE: 'Code', IMG: 'Image', SVG: 'Diagram', CANVAS: 'Chart', VIDEO: 'Video',
  BLOCKQUOTE: 'Quote', DETAILS: 'Details', SUMMARY: 'Summary', H1: 'Title', H2: 'Heading', H3: 'Heading', H4: 'Heading', SECTION: 'Section',
  'RR-FLOW': 'Flow diagram', 'RR-NODE': 'Flow step', 'RR-CHECKLIST': 'Checklist', 'RR-CHECK': 'Checklist item', 'RR-CALLOUT': 'Callout',
  'RR-CODE': 'Code snippet', 'RR-EMBED': 'Preview', 'RR-REF': 'Link', BUTTON: 'Button', INPUT: 'Control', LABEL: 'Label', A: 'Link',
};

/** Find a walkthrough element by anchor id (+ optional css path below it). */
export function findDocElement(doc: HTMLElement, id: string, path?: string): Element | null {
  let base: Element | null = id ? doc.querySelector(`#${CSS.escape(id)}`) : doc;
  if (!base) return null;
  if (path) {
    try {
      base = base.querySelector(`:scope>${path}`) ?? base;
    } catch {
      /* bad path: fall back to the id */
    }
  }
  return base;
}

const clip = (s: string, n: number) => {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function headingOf(el: Element): string | null {
  const hd = el.matches('h1,h2,h3,h4') ? el : el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
  return hd?.textContent ? clip(hd.textContent, 60) : null;
}

/** e.g. "Proto & storage", "Table in Proto & storage", "Callout: Silent degradation". */
export function describeElement(el: Element): string {
  const own = el.getAttribute('data-title') || el.getAttribute('aria-label');
  const head = el.matches('section, [data-rr-section], h1, h2, h3, h4') ? headingOf(el) : null;
  if (head) return head;
  const tag = el.tagName.toUpperCase();
  let kind = own || KIND[tag] || (el.hasAttribute('data-rr-block') ? 'Widget' : 'Block');
  const t = el.getAttribute('title');
  if (!own && t && /^RR-(CALLOUT|CODE)$/.test(tag)) kind += `: ${clip(t, 40)}`;
  const sec = el.parentElement?.closest('section');
  const secName = sec ? headingOf(sec) : null;
  return secName ? `${kind} in “${secName}”` : kind;
}
