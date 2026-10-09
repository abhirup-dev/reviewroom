// Syntax colours for small snippets (hover previews), via the highlighter @pierre/diffs already ships.
import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs';
import { h } from './dom';

const themes = { light: 'pierre-light', dark: 'pierre-dark' } as const;

/** One element per line, coloured for both themes (--shiki-light / --shiki-dark; picked in overlays.css).
 *  Null when the language is unknown or loading fails: callers keep plain text. */
export async function highlightLines(path: string, code: string): Promise<HTMLElement[] | null> {
  const lang = getFiletypeFromFileName(path);
  if (!lang || lang === 'text') return null;
  try {
    const hl = await getSharedHighlighter({ themes: [themes.light, themes.dark], langs: [lang] });
    const { tokens } = hl.codeToTokens(code, { lang, themes, defaultColor: false });
    return tokens.map((line) => h('span', null, ...line.map((t) => h('span', { style: Object.entries(t.htmlStyle ?? {}).map(([k, v]) => `${k}:${v}`).join(';') }, t.content))));
  } catch {
    return null;
  }
}
