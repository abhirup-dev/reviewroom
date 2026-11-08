// The composer's editor: CodeMirror 6 with rr: links drawn as atomic chips. Its own chunk, loaded when the first
// composer opens (view.ts), so no device pays for CodeMirror at boot.
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, keymap, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import { h } from '../kernel/dom';
import { refIcon } from '../kernel/refs/browser';
import { parseRef } from '../kernel/refs/refs.shared';

class Chip extends WidgetType {
  constructor(
    readonly ref: string,
    readonly label: string,
    readonly embed: boolean,
  ) {
    super();
  }
  eq(o: Chip) {
    return o.ref === this.ref && o.label === this.label && o.embed === this.embed;
  }
  toDOM() {
    const r = parseRef(this.ref);
    return h('span', { class: 'rr-chip rr-chip--token' + (this.embed ? ' is-embed' : ''), 'data-ref': this.ref, title: this.embed ? 'Shows a live preview of this in the comment' : 'Link: opens this when clicked' }, r ? refIcon(r) : null, this.embed ? h('span', { class: 'rr-chip__kind' }, 'preview') : null, this.label);
  }
}

/** What the composer asks of its editor. */
export interface Editor {
  text(): string;
  /** Replace the selection (or `placeholder` wrapped in before/after when nothing is selected). */
  wrap(before: string, after?: string, placeholder?: string): void;
  insert(text: string): void;
  clear(): void;
  focus(): void;
  /** Keep the caret in view (the sheet around it got shorter). */
  revealCaret(): void;
  destroy(): void;
}

export function createEditor(
  parent: HTMLElement,
  o: {
    initial: string;
    /** where the caret starts (default: the end) */
    caret?: number;
    placeholder: string;
    linkPattern: RegExp;
    label(ref: string): string;
    onChange(): void;
    onSubmit(): void;
    onLinkPicker(): void;
    onPasteRef(ref: string): boolean;
    onEscape(e: KeyboardEvent): void;
  },
): Editor {
  // The text is the markdown itself, with rr: links drawn as atomic chips: people see "request_builder.go:51-53",
  // never `[...](rr:code/...)`.
  const chips = new MatchDecorator({ regexp: o.linkPattern, decoration: (m) => Decoration.replace({ widget: new Chip(m[3], m[2] || o.label(m[3]), !!m[1]) }) });
  const chipView = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) {
        this.decorations = chips.createDeco(v);
      }
      update(u: ViewUpdate) {
        this.decorations = chips.updateDeco(u, this.decorations);
      }
    },
    { decorations: (p) => p.decorations, provide: (p) => EditorView.atomicRanges.of((v) => v.plugin(p)?.decorations ?? Decoration.none) },
  );
  const view = new EditorView({
    parent,
    doc: o.initial,
    selection: { anchor: Math.min(o.caret ?? o.initial.length, o.initial.length) },
    extensions: [
      // Enter is a plain line break (no auto-indent); ⌘↵ sends
      keymap.of([{ key: 'Mod-Enter', run: () => { o.onSubmit(); return true; } }, { key: 'Enter', shift: insertNewline, run: insertNewline }, ...standardKeymap, ...historyKeymap]),
      history(),
      chipView,
      placeholder(o.placeholder),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': o.placeholder, spellcheck: 'true' }),
      EditorView.updateListener.of((u) => u.docChanged && o.onChange()),
      // "[[" opens the link picker
      EditorView.inputHandler.of((v, from, to, text) => {
        if (text !== '[' || v.state.sliceDoc(from - 1, from) !== '[') return false;
        v.dispatch({ changes: { from: from - 1, to } });
        o.onLinkPicker();
        return true;
      }),
      EditorView.domEventHandlers({
        keydown: (e) => {
          if (e.key !== 'Escape') return false;
          o.onEscape(e);
          return true;
        },
        // pasted text arrives as plain text (CodeMirror reads text/plain); a bare rr: link becomes a chip
        paste: (e) => {
          const t = e.clipboardData?.getData('text/plain').trim() ?? '';
          if (!/^rr:\S+$/.test(t) || !parseRef(t) || !o.onPasteRef(t)) return false;
          e.preventDefault();
          return true;
        },
      }),
    ],
  });
  const insert = (t: string) => {
    view.focus();
    view.dispatch(view.state.replaceSelection(t), { scrollIntoView: true });
  };
  return {
    text: () => view.state.doc.toString(),
    insert,
    wrap: (before, after = before, ph = '') => {
      const { from, to } = view.state.selection.main;
      insert(before + (view.state.sliceDoc(from, to) || ph) + after);
    },
    clear: () => view.dispatch({ changes: { from: 0, to: view.state.doc.length } }),
    focus: () => view.focus(),
    revealCaret: () => view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) }),
    destroy: () => view.destroy(),
  };
}
