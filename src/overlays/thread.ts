// Thread view: used as the centred popup AND as a dockable panel ("thread:<id>").
// Markdown with live preview, rr: link chips/embeds, rounds, resolve, dock/undock.
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, keymap, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import { h, icon, relTime, copyText, backdropCloses } from '../core/dom';
import { loadRaw } from '../core/store';
import { renderMarkdown } from '../core/markdown';
import { formatRef, parseRef, refIcon } from '../core/refs';
import { anchorRef } from '../shared/refs';
import { keyLabel } from '../core/commands';
import type { Anchor, Thread } from '../core/types';
import { closePanel, definePanel, dockThread } from '../shell/layout';
import type { ReviewApp } from '../shell/app';
import { renderPreview } from '../elements';
import { popMenu } from '../shell/chrome';
import { createActor, fromPromise } from 'xstate';
import { threadMachine, type ThreadTarget } from '../flows/thread';

// shipped next to the bundle by scripts/build.ts; a page without it (the static demo) shows the picker's own error
const EMOJI_DATA = new URL('./emoji.json', import.meta.url).href;

export interface ThreadViewOpts {
  id?: string;
  anchor?: Anchor;
  quote?: string;
  /** New comment that can go either way: the send button ⌘↵ uses. */
  to?: 'agent' | 'github';
  docked?: boolean;
  onClose?: () => void;
  onDock?(id: string): void;
  onUndock?(id: string): void;
  /** Send the new comment; false: not sent, keep the text. */
  onCreate?(body: string, toGitHub: boolean): Promise<boolean | void>;
  /** Resolve from here: the host runs it, then lets the popup go. */
  onResolve?(): void;
}

// ------------------------------------------------------------------ composer
/** A send button; `off` greys it out and says why. */
export type SendButton = { label: string; title?: string; off?: string; main?: boolean; icon?: boolean; to?: 'agent' | 'github'; onSubmit(body: string): unknown };

// a link in the composer's text: `[label](rr:...)`, `![label](rr:...)` for an embed
const RR_LINK = /(!?)\[([^\]]*)\]\((rr:[^)\s]+)\)/g;

/** The markdown saved for a message: link labels lose their brackets, embeds get a line of their own. */
const composerMarkdown = (text: string, label: (ref: string) => string) =>
  text
    .replace(RR_LINK, (_, bang: string, lab: string, ref: string) => {
      const link = `[${(lab || label(ref)).replace(/[[\]]/g, '')}](${ref})`;
      return bang ? `\n!${link}\n` : link;
    })
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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

export function composer(app: ReviewApp, opts: { placeholder: string; buttons: SendButton[]; initial?: string; autofocus?: boolean; draftKey?: string; onCancel?(): void }) {
  const buttons = opts.buttons;
  const main = buttons.find((b) => b.main && !b.off) ?? buttons.find((b) => !b.off) ?? buttons[0];
  // The text is the markdown itself, with rr: links drawn as atomic chips: people see "request_builder.go:51-53",
  // never `[...](rr:code/...)`.
  const chips = new MatchDecorator({ regexp: RR_LINK, decoration: (m) => Decoration.replace({ widget: new Chip(m[3], m[2] || app.label(m[3]), !!m[1]) }) });
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
  const ed = h('div', { class: 'rr-composer__input' });
  const preview = h('div', { class: 'rr-composer__preview rr-prose', hidden: true });
  // unsent text survives a reload (localStorage, per thread or anchor)
  const keepDraft = (md: string) => {
    if (!opts.draftKey) return;
    try {
      if (md) localStorage.setItem(opts.draftKey, md);
      else localStorage.removeItem(opts.draftKey);
    } catch {
      /* private mode: drafts just don't persist */
    }
  };
  const serialize = () => composerMarkdown(view.state.doc.toString(), (r) => app.label(r));
  const insert = (t: string) => {
    view.focus();
    view.dispatch(view.state.replaceSelection(t), { scrollIntoView: true });
  };
  const insertRef = (ref: string, embed = false) => {
    const link = `[${app.label(ref).replace(/[[\]]/g, '')}](${ref})`;
    insert(embed ? `\n!${link}\n` : link + ' ');
  };

  let mode: 'write' | 'preview' = 'write';
  const tabW = h('button', { class: 'rr-tab is-on', type: 'button', onclick: () => setMode('write') }, 'Write');
  const tabP = h('button', { class: 'rr-tab', type: 'button', title: 'See the comment as it will appear', onclick: () => setMode('preview') }, 'Preview');
  const setMode = (m: typeof mode) => {
    mode = m;
    tabW.classList.toggle('is-on', m === 'write');
    tabP.classList.toggle('is-on', m === 'preview');
    ed.hidden = m === 'preview';
    preview.hidden = m === 'write';
    if (m === 'preview') preview.innerHTML = renderMarkdown(serialize() || '_Nothing to preview_');
    else view.focus();
  };
  const wrapSel = (before: string, after = before, placeholder = '') => {
    const { from, to } = view.state.selection.main;
    insert(before + (view.state.sliceDoc(from, to) || placeholder) + after);
  };
  const linkPicker = async (embed = false) => {
    const ref = await app.pickRef?.();
    if (ref) insertRef(ref, embed);
    else view.focus();
  };
  const emojiPicker = async () => {
    const btn = el.querySelector('[aria-label="Emoji"]') as HTMLElement;
    const { Picker } = await import('emoji-picker-element');
    const picker = new Picker({ dataSource: EMOJI_DATA });
    picker.classList.add(app.resolvedTheme(), 'rr-emoji-picker');
    const close = popMenu(btn, () => [picker]);
    picker.addEventListener('emoji-click', (e) => {
      close();
      if (e.detail.unicode) insert(e.detail.unicode);
    });
  };
  let busy = false;
  const submit = async (b: SendButton = main) => {
    if (b.off) return;
    const body = serialize();
    if (!body) return view.focus();
    if (busy) return;
    busy = true;
    // false (GitHub refused it, say): keep the text so nothing typed is lost
    const ok = await Promise.resolve(b.onSubmit(body)).finally(() => (busy = false));
    if (ok === false) return;
    keepDraft(''); // sending may have destroyed the view, and with it the listener that would clear the draft
    view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
    setMode('write');
  };
  const initial = opts.initial ?? (opts.draftKey ? loadRaw(opts.draftKey) : null) ?? '';
  const view = new EditorView({
    parent: ed,
    doc: initial,
    selection: { anchor: initial.length },
    extensions: [
      // Enter is a plain line break (no auto-indent); ⌘↵ sends
      keymap.of([{ key: 'Mod-Enter', run: () => (void submit(), true) }, { key: 'Enter', shift: insertNewline, run: insertNewline }, ...standardKeymap, ...historyKeymap]),
      history(),
      chipView,
      placeholder(opts.placeholder),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': opts.placeholder, spellcheck: 'true' }),
      EditorView.updateListener.of((u) => u.docChanged && keepDraft(serialize())),
      // "[[" opens the link picker
      EditorView.inputHandler.of((v, from, to, text) => {
        if (text !== '[' || v.state.sliceDoc(from - 1, from) !== '[') return false;
        v.dispatch({ changes: { from: from - 1, to } });
        void linkPicker();
        return true;
      }),
      EditorView.domEventHandlers({
        keydown: (e) => {
          if (e.key !== 'Escape') return false;
          e.stopPropagation();
          if (opts.onCancel) e.preventDefault(); // cancel the edit, not the dialog around it
          opts.onCancel?.();
          return true;
        },
        // pasted text arrives as plain text (CodeMirror reads text/plain); a bare rr: link becomes a chip
        paste: (e) => {
          const t = e.clipboardData?.getData('text/plain').trim() ?? '';
          if (!/^rr:\S+$/.test(t) || !parseRef(t)) return false;
          e.preventDefault();
          insertRef(t);
          return true;
        },
      }),
    ],
  });
  ed.addEventListener('click', (e) => {
    const c = (e.target as Element).closest('[data-ref]') as HTMLElement | null;
    if (c && (e.metaKey || e.ctrlKey)) void app.open(c.dataset.ref!);
  });

  const sel = app.selection;
  const tb = (label: string | Node, title: string, fn: () => void) => h('button', { class: 'rr-tool', title, 'aria-label': title, type: 'button', onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, label);
  const el = h(
    'div',
    { class: 'rr-composer' },
    h(
      'div',
      { class: 'rr-composer__bar' },
      tabW,
      tabP,
      h('span', { class: 'rr-toolbar__spacer' }),
      tb(h('strong', null, 'B'), 'Bold', () => wrapSel('**', '**', 'bold')),
      tb(h('em', null, 'I'), 'Italic', () => wrapSel('_', '_', 'italic')),
      tb(icon('code', 14), 'Inline code', () => wrapSel('`', '`', 'code')),
      tb('•', 'Bulleted list', () => insert('\n- ')),
      tb(icon('smile', 14), 'Emoji', () => emojiPicker()),
      tb(icon('link', 14), 'Link to a section, file, line, symbol or thread (or type [[)', () => linkPicker()),
      tb(icon('expand', 14), 'Embed a live preview of a section, code range or thread', () => linkPicker(true)),
      sel
        ? tb(icon('target', 14), 'Link what you have selected', () => insertRef(sel.kind === 'code' ? formatRef({ type: 'code', path: sel.path, rev: sel.side, start: sel.start, end: sel.end }) : anchorRef({ ...sel.anchor, quote: undefined })!))
        : null,
    ),
    ed,
    preview,
    h(
      'div',
      { class: 'rr-composer__foot' },
      h('span', { class: 'rr-muted' }, h('kbd', null, '[['), ' link · ', h('kbd', null, keyLabel('mod+enter')), buttons.length > 1 ? ' ' + main.label : ' send'),
      h('span', { class: 'rr-toolbar__spacer' }),
      // Cancel throws the draft away; Esc, the backdrop and the close button keep it
      opts.onCancel ? h('button', { class: 'rr-btn rr-btn--ghost', type: 'button', title: 'Discard this draft', onclick: () => (keepDraft(''), opts.onCancel!()) }, 'Cancel') : null,
      // aria-disabled, not disabled: a disabled button gets no hover, so its tooltip would never show
      ...buttons.map((b) => h('button', { class: 'rr-btn' + (b.to === 'agent' ? ' rr-btn--send rr-btn--agent' : b.to ? ' rr-btn--send' : b === main ? ' rr-btn--primary' : ''), type: 'button', title: b.off ?? b.title, 'aria-disabled': b.off ? 'true' : null, onclick: () => submit(b) }, b.icon ? icon('send', 12) : null, b.label)),
    ),
  );
  if (opts.autofocus) requestAnimationFrame(() => view.focus());
  return { el, focus: () => view.focus() };
}

// ------------------------------------------------------------------ anchor context
async function anchorContext(app: ReviewApp, a: Anchor, quote?: string): Promise<HTMLElement | null> {
  if (a.kind === 'general') return null;
  if (a.kind === 'doc' && a.quote) return h('blockquote', { class: 'rr-quote' }, a.quote.exact);
  const ref = anchorRef(a);
  if (!ref) return null;
  const body = await renderPreview(app, ref, { compact: true });
  return h('div', { class: 'rr-anchor-ctx' }, body, quote && a.kind === 'doc' && !body.textContent ? h('blockquote', { class: 'rr-quote' }, quote) : null);
}

// ------------------------------------------------------------------ the view
export function threadView(app: ReviewApp, o: ThreadViewOpts): { el: HTMLElement; dispose: () => void } {
  const root = h('div', { class: 'rr-thread' + (o.docked ? ' is-docked' : '') + (o.id ? '' : ' is-new') });
  let off: (() => void) | undefined;
  let lastCount = -1;
  // an editor keeps document listeners (and through them this DOM) until destroyed: drop the ones about to be replaced
  const drop = (n: Element) => n.querySelectorAll<HTMLElement>('.cm-editor').forEach((e) => EditorView.findFromDOM(e)?.destroy());

  const pinBtn = (ref: string) => {
    const set = (b: HTMLElement) => {
      const on = app.state.pins.includes(ref);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Unpin' : 'Pin';
    };
    const b = h('button', { class: 'rr-icon-btn', 'aria-label': 'Pin', onclick: () => (app.togglePin(ref), set(b), app.toast(app.state.pins.includes(ref) ? 'Pinned' : 'Unpinned')) }, icon('pin', 14));
    set(b);
    return b;
  };
  const header = (t: Thread | undefined, anchor: Anchor) => {
    const ref = anchorRef(anchor);
    const bare = ref && anchorRef({ ...anchor, quote: undefined } as Anchor);
    const r = ref ? parseRef(ref) : null;
    return h(
      'header',
      { class: 'rr-thread__head' },
      h(
        'button',
        { class: 'rr-chip rr-chip--anchor', title: ref ? 'Go to ' + app.label(ref) : 'A comment about the whole PR', disabled: !ref, onclick: () => ref && app.open(ref) },
        h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'),
        // the quote itself is shown below; the chip says where it is
        ref ? app.label(ref) : (t?.title ?? app.anchorLabel(anchor)),
      ),
      t?.status === 'resolved' ? h('span', { class: 'rr-pill rr-pill--ok', title: 'Still listed under Threads › Resolved' }, 'resolved') : null,
      t?.gh ? h('span', { class: 'rr-pill rr-pill--gh', title: 'This thread is on GitHub: replies post there, for everyone on the PR' }, 'GitHub') : null,
      t?.gh?.outdated ? h('span', { class: 'rr-pill', title: 'The code this was written on has changed since; the line shown is where it was' }, 'outdated') : null,
      h('span', { class: 'rr-toolbar__spacer' }),
      t?.gh ? h('a', { class: 'rr-icon-btn', href: t.gh.url, target: '_blank', rel: 'noopener', title: 'Open on GitHub', 'aria-label': 'Open on GitHub' }, icon('popout', 14)) : null,
      t && (!t.gh || (t.status === 'open' ? t.gh.canResolve : t.gh.canUnresolve))
        ? h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', title: t.status === 'open' ? 'Mark resolved: hides the highlight and margin chip' : 'Reopen this thread', onclick: () => resolve(t) }, icon(t.status === 'open' ? 'check' : 'round', 12), t.status === 'open' ? 'Resolve' : 'Reopen')
        : null,
      // a new comment: link or pin what it's about (the code range or section), from here rather than a toolbar over the page
      !t && ref ? h('button', { class: 'rr-icon-btn', title: 'Copy a link to this (paste it into any comment)', 'aria-label': 'Copy link', onclick: () => (copyText(bare!), app.toast(`Link to ${app.label(bare!)} copied`)) }, icon('link', 14)) : null,
      !t && ref ? pinBtn(bare!) : null,
      t ? h('button', { class: 'rr-icon-btn', title: 'Copy a link to this thread (paste it into any comment)', 'aria-label': 'Copy link to thread', onclick: () => (copyText(formatRef({ type: 'thread', id: t.id })), app.toast('Link to this thread copied')) }, icon('link', 14)) : null,
      t && !o.docked && o.onDock ? h('button', { class: 'rr-icon-btn', title: 'Dock as a panel', 'aria-label': 'Dock as a panel', onclick: () => o.onDock!(t.id) }, icon('dock', 14)) : null,
      t && o.docked && o.onUndock ? h('button', { class: 'rr-icon-btn', title: 'Open as popup', 'aria-label': 'Open as popup', onclick: () => o.onUndock!(t.id) }, icon('maximize', 14)) : null,
      o.onClose ? h('button', { class: 'rr-icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => o.onClose!() }, icon('close', 14)) : null,
    );
  };

  const resolve = (t: Thread) => (t.status === 'open' && o.onResolve ? o.onResolve() : app.setStatus(t.id, t.status === 'open' ? 'resolved' : 'open'));

  const messages = (t: Thread) => {
    const list = h('div', { class: 'rr-thread__msgs' });
    let round = 0;
    for (const m of t.messages) {
      if (m.round && m.round !== round) {
        round = m.round;
        list.append(h('div', { class: 'rr-round-sep' }, h('span', null, `Round ${round}`)));
      }
      const body = h('div', { class: 'rr-msg__body rr-prose', html: renderMarkdown(m.body) });
      // a link to another comment on this PR opens its thread here instead of on github.com
      body.addEventListener('click', (e) => {
        const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
        const id = a && !e.metaKey && !e.ctrlKey && app.githubThreadFor(a.href);
        if (id) {
          e.preventDefault();
          app.bus.emit('open-thread', { id });
        }
      });
      const actions = m.gh
        ? githubActions(m, body)
        : m.author === 'you' && m.round === app.state.round
          ? h(
              'div',
              { class: 'rr-msg__actions' },
              h('button', {
                class: 'rr-link-btn',
                onclick: () => {
                  if (!body.isConnected) return; // already editing
                  const c = composer(app, { placeholder: 'Edit comment', buttons: [{ label: 'Save', onSubmit: (b) => app.editMessage(t.id, m.id, b) }], initial: m.body, autofocus: true, onCancel: () => render() });
                  body.replaceWith(c.el);
                },
              }, 'edit'),
              h('button', {
                class: 'rr-link-btn',
                title: t.messages.length === 1 ? 'Delete this comment and its thread' : 'Delete this comment',
                onclick: (e: Event) => {
                  if (t.messages.length > 1) return app.deleteMessage(t.id, m.id);
                  // the only message: deleting it deletes the thread, so ask inline first
                  const bar = (e.currentTarget as HTMLElement).parentElement!;
                  bar.style.opacity = '1'; // actions show on hover only; keep the question up
                  bar.replaceChildren(
                    h('span', { class: 'rr-muted' }, 'Delete the whole thread?'),
                    h('button', { class: 'rr-link-btn', title: 'Delete this thread for good', onclick: () => (app.deleteMessage(t.id, m.id), o.onClose?.()) }, 'delete'),
                    h('button', { class: 'rr-link-btn', title: 'Keep the thread', onclick: () => render() }, 'keep'),
                  );
                },
              }, 'delete'),
            )
          : null;
      list.append(
        h(
          'article',
          { class: `rr-msg rr-msg--${m.author}` },
          m.gh?.avatar
            ? h('img', { class: 'rr-avatar rr-avatar--gh', src: m.gh.avatar + (m.gh.avatar.includes('?') ? '&' : '?') + 's=48', alt: '', loading: 'lazy' })
            : h('div', { class: 'rr-avatar' + (m.author === 'agent' ? ' rr-avatar--agent' : ''), 'aria-hidden': 'true' }, m.gh ? m.gh.login[0].toUpperCase() : m.author === 'agent' ? 'AI' : 'Y'),
          h(
            'div',
            { class: 'rr-msg__main' },
            h(
              'div',
              { class: 'rr-msg__meta' },
              h('strong', null, m.gh ? m.gh.login : m.author === 'agent' ? 'Agent' : 'You'),
              m.gh ? h('a', { class: 'rr-muted', href: m.gh.url, target: '_blank', rel: 'noopener', title: 'Open this comment on GitHub' }, relTime(m.at)) : h('span', { class: 'rr-muted' }, relTime(m.at)),
              m.gh?.pending ? h('span', { class: 'rr-pill rr-pill--draft', title: 'In your GitHub review: only you can see it until you submit the review' }, 'draft') : null,
              actions,
            ),
            body,
          ),
        ),
      );
    }
    return list;
  };

  // Your GitHub comments: edit in place; delete always asks, since a posted comment can't come back
  const githubActions = (m: Thread['messages'][number], body: HTMLElement) => {
    const t = app.thread(o.id!)!;
    const gh = m.gh!;
    if (!gh.canEdit && !gh.canDelete) return null;
    const bar = h('div', { class: 'rr-msg__actions' });
    const ask = () => {
      bar.style.opacity = '1';
      bar.replaceChildren(
        h('span', { class: 'rr-muted' }, gh.pending ? 'Delete this draft?' : 'Delete on GitHub for everyone?'),
        h('button', { class: 'rr-link-btn', onclick: () => app.deleteMessage(t.id, m.id) }, 'delete'),
        h('button', { class: 'rr-link-btn', onclick: () => render() }, 'keep'),
      );
    };
    bar.append(
      gh.canEdit
        ? h('button', { class: 'rr-link-btn', title: gh.pending ? 'Edit this draft' : 'Edit on GitHub', onclick: () => body.isConnected && body.replaceWith(composer(app, { placeholder: 'Edit comment', buttons: [{ label: 'Save', onSubmit: (b) => app.editMessage(t.id, m.id, b) }], initial: m.body, autofocus: true, onCancel: () => render() }).el) }, 'edit')
        : '',
      gh.canDelete ? h('button', { class: 'rr-link-btn', title: 'Delete this comment', onclick: ask }, 'delete') : '',
    );
    return bar;
  };

  const ctxHost = h('div', { class: 'rr-thread__ctx' });
  const render = () => {
    const t = o.id ? app.thread(o.id) : undefined;
    const anchor = t?.anchor ?? o.anchor ?? { kind: 'general' };
    if (o.id && !t) {
      drop(root);
      root.replaceChildren(header(undefined, anchor), h('div', { class: 'rr-empty' }, 'This thread was deleted.'));
      return;
    }
    const [placeholder, replyLabel] = t?.gh
      ? t.gh.conversation ? ['Comment on the PR on GitHub…', 'Comment on GitHub']
        // GitHub files any reply into the viewer's pending review while one is open
        : t.messages.some((m) => m.gh?.pending) || app.github?.pending ? ['Reply (a draft too, until you submit the review)…', 'Add to review'] : ['Reply on GitHub…', 'Reply on GitHub']
      : t ? ['Reply…', 'Reply']
      : ['Comment for the agent' + (app.commentTargets(anchor).length > 1 ? ', or on the PR…' : '…'), null];
    if (t?.gh && !t.gh.canReply) root.classList.add('is-readonly');
    const buttons = t
      ? [{ label: replyLabel!, icon: true, onSubmit: (body: string) => app.reply(t.id, body) }]
      : app.commentTargets(anchor).map((b) => ({ ...b, icon: true, main: o.to === b.to, onSubmit: (body: string) => o.onCreate?.(body, b.to === 'github') }));
    const c = composer(app, {
      placeholder,
      buttons,
      autofocus: true,
      // drafts keep today's keys: the review mode still picks the GitHub one
      draftKey: `reviewroom:draft:${app.meta.id}:${t ? t.id : (app.commentsToGitHub(anchor) ? 'gh:' : '') + JSON.stringify(anchor)}`,
      onCancel: o.onClose,
    });
    const msgs = t ? messages(t) : null;
    drop(root);
    root.replaceChildren(header(t, anchor), ctxHost, h('div', { class: 'rr-thread__scroll' }, msgs), c.el);
    if (t && t.messages.length !== lastCount) {
      const first = lastCount < 0;
      lastCount = t.messages.length;
      requestAnimationFrame(() => {
        const sc = root.querySelector('.rr-thread__scroll');
        // opening: start at the top so the whole conversation reads in order; new message: follow it
        sc?.scrollTo({ top: first ? 0 : sc.scrollHeight });
      });
    }
  };
  const anchor = (o.id ? app.thread(o.id)?.anchor : o.anchor) ?? { kind: 'general' as const };
  void anchorContext(app, anchor, o.quote).then((ctx) => ctx && ctxHost.replaceChildren(ctx));
  render();
  off = app.bus.on('state', () => {
    // don't clobber an in-progress draft: only re-render the message list
    if (!o.id) return; // composing a new thread: nothing else on screen depends on state
    const t = app.thread(o.id);
    if (!t) return render();
    const scroll = root.querySelector('.rr-thread__scroll');
    if (scroll) {
      drop(scroll);
      scroll.replaceChildren(messages(t));
    }
    root.querySelector('.rr-thread__head')?.replaceWith(header(t, t.anchor));
    if (t.messages.length !== lastCount) {
      lastCount = t.messages.length;
      scroll?.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    }
  });
  return { el: root, dispose: () => (off?.(), drop(root)) };
}

// ------------------------------------------------------------------ popup host
export function mountThreadPopup(app: ReviewApp) {
  /** the latest first-comment request */
  let sending: Promise<string | boolean> | null = null;
  const flow = createActor(
    threadMachine.provide({
      actions: {
        clearSelection: () => {
          app.selection = null;
          app.bus.emit('selection', null);
        },
      },
      actors: {
        create: fromPromise(({ input: { anchor, body, toGitHub } }) =>
          (sending = (async () => {
            const nt = app.createThread(anchor, body, 'you', toGitHub);
            if (!(nt instanceof Promise)) return nt?.id ?? false;
            const ok = await nt;
            if (ok) app.toast(anchor.kind === 'code' ? 'Added to your GitHub review — submit it from the header' : 'Posted on GitHub');
            return ok;
          })()),
        ),
        // a GitHub resolve that failed returns false: keep the popup up
        resolve: fromPromise(async ({ input }) => (await app.setStatus(input.id, 'resolved')) !== false),
      },
      delays: { leave: () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500) },
    }),
  );
  // closing (Esc, the backdrop, a button) returns focus to where it was: the dialog does that
  const box = h('dialog', { class: 'rr-modal', 'aria-label': 'Comment thread', onmousedown: backdropCloses, onclose: () => flow.send({ type: 'close' }) });
  document.body.append(box);
  const close = () => flow.send({ type: 'close' });
  let current: { el: HTMLElement; dispose: () => void } | null = null;
  let shown: ThreadTarget | null = null;
  // the composer keeps its text (and its saved draft) unless the comment went out, even if the popup has moved on
  const send = async (body: string, toGitHub: boolean) => {
    const before = sending;
    flow.send({ type: 'submit', body, toGitHub });
    // no new request: the popup wasn't composing, so nothing went out
    return sending && sending !== before ? (await sending) !== false : false;
  };
  flow.subscribe((s) => {
    box.classList.toggle('is-leaving', s.matches('leaving'));
    if (s.context.view === shown) return;
    current?.dispose();
    current = null;
    shown = s.context.view;
    if (!shown) return box.close();
    current = threadView(app, { ...shown, onClose: close, onDock: dock, onCreate: send, onResolve: () => flow.send({ type: 'resolve' }) });
    box.replaceChildren(current.el);
    if (!box.open) box.showModal();
  });
  // drag by the header to park it somewhere; it opens centred, then stays where it was put until reload
  let dx = 0, dy = 0;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target as Element).closest('.rr-thread__head') || (e.target as Element).closest('button, a, input')) return;
    e.preventDefault();
    const x0 = e.clientX - dx, y0 = e.clientY - dy;
    const r = box.getBoundingClientRect(), cx = r.left - dx, cy = r.top - dy;
    const move = (m: PointerEvent) => {
      // keep the header grabbable: at least 80px of it on screen
      dx = Math.min(Math.max(m.clientX - x0, 80 - cx - r.width), innerWidth - 80 - cx);
      dy = Math.min(Math.max(m.clientY - y0, -cy), innerHeight - 40 - cy);
      box.style.translate = `${dx}px ${dy}px`;
    };
    const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up));
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  const dock = (id: string) => {
    close();
    const t = app.thread(id)!;
    dockThread(app, id, t.title ?? app.anchorLabel(t.anchor));
  };
  flow.start();
  app.bus.on('open-thread', ({ id }) => (app.showPanel('thread:' + id) || flow.send({ type: 'open', id })));
  app.bus.on('compose-thread', ({ anchor, quote, to }) => flow.send({ type: 'compose', anchor, quote, to }));
}

definePanel({
  id: 'thread',
  title: 'Thread',
  icon: 'thread',
  onDemand: true,
  create: (app, params, panelId) => {
    const v = threadView(app, {
      id: params.id as string,
      docked: true,
      onUndock: (id) => {
        closePanel(app, panelId);
        app.bus.emit('open-thread', { id });
      },
    });
    return { element: h('div', { class: 'rr-thread-panel' }, v.el), dispose: v.dispose };
  },
});
