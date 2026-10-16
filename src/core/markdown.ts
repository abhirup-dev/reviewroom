// Markdown for comments and agent replies.
//   [label](rr:code/pkg/x.go#L45-54)   -> inline chip (<rr-ref>)
//   ![caption](rr:doc/request-path)    -> mini preview embed (<rr-embed>)
//   a line that is only `rr:...`          -> embed
// Everything is sanitised: thread bodies come from files anyone can edit.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const md = new Marked();

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
