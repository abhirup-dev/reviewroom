// Markdown for comments and agent replies.
//   [label](rr:code/pkg/x.go#L45-54)   -> inline chip (<rr-ref>)
//   ![caption](rr:doc/request-path)    -> mini preview embed (<rr-embed>)
//   a line that is only `rr:...`          -> embed
// Everything is sanitised: thread bodies come from files anyone can edit.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const md = new Marked({ gfm: true, breaks: false });

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

md.use({
  renderer: {
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      if (token.href.startsWith('rr:')) return `<rr-ref ref="${esc(token.href)}">${text}</rr-ref>`;
      return `<a href="${esc(token.href)}" target="_blank" rel="noopener">${text}</a>`;
    },
    image(token) {
      if (token.href.startsWith('rr:')) return `<rr-embed ref="${esc(token.href)}" caption="${esc(token.text || '')}"></rr-embed>`;
      return `<img src="${esc(token.href)}" alt="${esc(token.text || '')}">`;
    },
  },
});

const BARE_EMBED = /^\s*(rr:[^\s]+)\s*$/gm;

export function renderMarkdown(src: string): string {
  const pre = src.replace(BARE_EMBED, (_m, ref) => `![](${ref})`);
  const html = md.parse(pre, { async: false });
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['rr-ref', 'rr-embed'],
    ADD_ATTR: ['ref', 'caption', 'target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|rr):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^rr-/, attributeNameCheck: /^(ref|caption)$/, allowCustomizedBuiltInElements: false },
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
