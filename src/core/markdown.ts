// Markdown for comments and agent replies.
//   [label](rr:code/pkg/x.go#L45-54)   -> inline chip (<rr-ref>)
//   ![caption](rr:doc/request-path)    -> mini preview embed (<rr-embed>)
//   a line that is only `rr:...`          -> embed
//   :shortcode:                           -> emoji (GitHub's)
// Everything is sanitised: thread bodies come from files anyone can edit.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { markedEmoji } from 'marked-emoji';
import { githubEmoji } from './emoji' with { type: 'macro' };

const md = new Marked(markedEmoji({ emojis: githubEmoji(), renderer: (t) => t.emoji })); // :tada: as on GitHub

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

md.use({
  extensions: [
    {
      name: 'rrEmbed',
      level: 'block',
      start: (src) => src.match(/^ {0,3}rr:/m)?.index,
      tokenizer(src) {
        const m = /^ {0,3}(rr:\S+)[ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'rrEmbed', raw: m[0], ref: m[1] };
      },
      renderer: (t) => `<rr-embed ref="${esc(t.ref)}"></rr-embed>\n`,
    },
  ],
  // anything that isn't an rr: link falls through (false) to marked's own renderer
  renderer: {
    link(token) {
      return token.href.startsWith('rr:') && `<rr-ref ref="${esc(token.href)}">${this.parser.parseInline(token.tokens)}</rr-ref>`;
    },
    image(token) {
      return token.href.startsWith('rr:') && `<rr-embed ref="${esc(token.href)}" caption="${esc(token.text)}"></rr-embed>`;
    },
  },
});

// links leave the review page; rr: links stay in it
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && !n.getAttribute('href')?.startsWith('rr:')) {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener');
  }
});

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.parse(src, { async: false }), {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|rr):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    // only the two elements markdown emits: a body from GitHub must not plant working <rr-check>s and the like
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^rr-(ref|embed)$/, attributeNameCheck: /^(ref|caption)$/, allowCustomizedBuiltInElements: false },
  });
}

/** Author HTML from outside this machine (a walkthrough pulled from a PR): display-only. Text formatting, links
 *  (http(s) or rr:) and the narrative's own elements stay; no styles, forms, media or remote loads, not <rr-check>
 *  (it changes review state) nor <rr-markdown> (its markdown sanitizer lets images through). */
export function sanitizeProse(html: string): string {
  return DOMPurify.sanitize(html, {
    // body: the parse root DOMPurify wraps the fragment in
    ALLOWED_TAGS: ['body', 'p', 'br', 'hr', 'span', 'div', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'code', 'kbd', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'],
    // listed here (not only as a custom element's) so `ref` is URL-checked too
    ALLOWED_ATTR: ['href', 'ref', 'title', 'class'],
    // other allowed attributes are checked as URLs: plain words for these, only http(s)/rr: for href and ref
    ADD_URI_SAFE_ATTR: ['caption', 'kind', 'lang', 'state', 'direction'],
    ALLOWED_URI_REGEXP: /^(?:https?|rr):/i,
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^rr-(ref|embed|code|flow|node|callout)$/, attributeNameCheck: /^(ref|caption|kind|lang|state|title|direction)$/, allowCustomizedBuiltInElements: false },
  });
}

/** What `sanitizeProse` takes out of `html`: `<script>`, `onclick on <a>`, … (once each). */
export function proseRemoved(html: string): string[] {
  sanitizeProse(html);
  return [...new Set(DOMPurify.removed.map((r) => ('element' in r ? `<${r.element.nodeName.toLowerCase()}>` : `${r.attribute?.name} on <${r.from.nodeName.toLowerCase()}>`)))];
}

export function plainExcerpt(src: string, n = 90): string {
  const s = src
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/(\*\*|__|`|^#+\s*|^>\s*)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
