// Thread view: used as the centred popup AND as a dockable panel ("thread:<id>").
// Markdown with live preview, rr: link chips/embeds, rounds, resolve, dock/undock.
import { h, icon, relTime, copyText } from '../core/dom';
import { loadRaw } from '../core/store';
import { renderMarkdown } from '../core/markdown';
import { formatRef, parseRef, refIcon } from '../core/refs';
import { anchorRef } from '../shared/refs';
import { keyLabel } from '../core/commands';
import type { Anchor, Thread } from '../core/types';
import { definePanel } from '../shell/layout';
import type { ReviewApp } from '../shell/app';
import { renderPreview } from '../elements';
import { popMenu } from '../shell/chrome';

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
}

// ------------------------------------------------------------------ composer
/** A send button; `off` greys it out and says why. */
export type SendButton = { label: string; title?: string; off?: string; main?: boolean; icon?: boolean; to?: 'agent' | 'github'; onSubmit(body: string): unknown };

export function composer(app: ReviewApp, opts: { placeholder: string; buttons: SendButton[]; initial?: string; autofocus?: boolean; draftKey?: string; onCancel?(): void }) {
  const buttons = opts.buttons;
  const main = buttons.find((b) => b.main && !b.off) ?? buttons.find((b) => !b.off) ?? buttons[0];
  // A plain contenteditable where links are atomic chips. People see "request_builder.go:51-53",
  // never `[...](rr:code/...)`; the markdown with rr: links exists only in what gets saved for the agent.
  const ed = h('div', { class: 'rr-composer__input', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': opts.placeholder, 'data-placeholder': opts.placeholder, spellcheck: 'true' });
  const preview = h('div', { class: 'rr-composer__preview rr-prose', hidden: true });
  let saved: Range | null = null;
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
  const remember = () => {
    const sel = document.getSelection();
    if (sel?.rangeCount && ed.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
    keepDraft(serialize());
  };
  const restore = () => {
    ed.focus();
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    if (saved && ed.contains(saved.startContainer)) sel.addRange(saved);
    else {
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.addRange(r);
    }
  };
  const chip = (ref: string, label: string, embed = false) => {
    const r = parseRef(ref);
    return h('span', { class: 'rr-chip rr-chip--token' + (embed ? ' is-embed' : ''), contenteditable: 'false', 'data-ref': ref, 'data-label': label, 'data-embed': embed ? '1' : undefined, title: embed ? 'Shows a live preview of this in the comment' : 'Link: opens this when clicked' }, r ? refIcon(r) : null, embed ? h('span', { class: 'rr-chip__kind' }, 'preview') : null, label);
  };
  const serialize = (): string => {
    let out = '';
    const walk = (n: Node, top: boolean) => {
      if (n.nodeType === 3) out += (n as Text).data.replace(/\u00a0/g, ' ');
      else if (n instanceof HTMLElement) {
        if (n.dataset.ref) {
          const lab = (n.dataset.label || '').replace(/[[\]]/g, '');
          out += n.dataset.embed ? `\n![${lab}](${n.dataset.ref})\n` : `[${lab}](${n.dataset.ref})`;
          return;
        }
        if (n.tagName === 'BR') return void (out += '\n');
        const block = !top && /^(DIV|P)$/.test(n.tagName);
        if (block && out && !out.endsWith('\n')) out += '\n';
        n.childNodes.forEach((c) => walk(c, false));
      }
    };
    ed.childNodes.forEach((c) => walk(c, false));
    return out.replace(/\n{3,}/g, '\n\n').trim();
  };
  const load = (md: string) => {
    ed.replaceChildren();
    const re = /(!?)\[([^\]]*)\]\((rr:[^)\s]+)\)/g;
    let last = 0;
    const text = (t: string) => t.split('\n').forEach((line, i) => (i && ed.append(h('br')), line && ed.append(line)));
    for (const m of md.matchAll(re)) {
      text(md.slice(last, m.index));
      ed.append(chip(m[3], m[2] || app.label(m[3]), !!m[1]));
      last = m.index + m[0].length;
    }
    text(md.slice(last));
  };
  const insertNodes = (...nodes: Node[]) => {
    restore();
    const sel = document.getSelection()!;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.append(n));
    const lastNode = frag.lastChild!;
    r.insertNode(frag);
    r.setStartAfter(lastNode);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    remember();
  };
  const insertRef = (ref: string, embed = false) => insertNodes(...(embed ? [h('br')] : []), chip(ref, app.label(ref), embed), document.createTextNode('\u00a0'));
  const insertText = (t: string) => {
    restore();
    document.execCommand('insertText', false, t);
    remember();
  };
  const initial = opts.initial ?? (opts.draftKey ? loadRaw(opts.draftKey) : null);
  if (initial) load(initial);

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
    else restore();
  };
  const wrapSel = (before: string, after = before, placeholder = '') => {
    restore();
    const sel = document.getSelection()!.toString() || placeholder;
    document.execCommand('insertText', false, before + sel + after);
    remember();
  };
  const linkPicker = async (embed = false) => {
    remember();
    const ref = await app.pickRef?.();
    if (ref) insertRef(ref, embed);
    else restore();
  };
  const emojiPicker = async () => {
    remember();
    const btn = el.querySelector('[aria-label="Emoji"]') as HTMLElement;
    const { Picker } = await import('emoji-picker-element');
    const picker = new Picker({ dataSource: EMOJI_DATA });
    picker.classList.add(app.resolvedTheme(), 'rr-emoji-picker');
    const close = popMenu(btn, () => [picker]);
    picker.addEventListener('emoji-click', (e) => {
      close();
      if (e.detail.unicode) insertText(e.detail.unicode);
    });
  };
  let busy = false;
  const submit = async (b: SendButton = main) => {
    if (b.off) return;
    const body = serialize();
    if (!body) return ed.focus();
    if (busy) return;
    busy = true;
    // false (GitHub refused it, say): keep the text so nothing typed is lost
    const ok = await Promise.resolve(b.onSubmit(body)).finally(() => (busy = false));
    if (ok === false) return;
    ed.replaceChildren();
    keepDraft('');
    saved = null;
    setMode('write');
  };
  ed.addEventListener('keyup', remember);
  ed.addEventListener('mouseup', remember);
  ed.addEventListener('blur', remember);
  ed.addEventListener('input', () => {
    if (!ed.textContent && !ed.querySelector('[data-ref]')) ed.replaceChildren(); // keep :empty placeholder working
    remember();
    // "[[" opens the link picker
    const sel = document.getSelection();
    const node = sel?.anchorNode;
    if (node?.nodeType === 3 && (node as Text).data.slice(0, sel!.anchorOffset).endsWith('[[')) {
      const t = node as Text;
      t.deleteData(sel!.anchorOffset - 2, 2);
      void linkPicker();
    }
  });
  ed.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      opts.onCancel?.();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    }
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData('text/plain') ?? '';
    if (/^rr:\S+$/.test(t.trim()) && parseRef(t.trim())) insertRef(t.trim());
    else insertText(t);
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
      tb('•', 'Bulleted list', () => insertText('\n- ')),
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
      opts.onCancel ? h('button', { class: 'rr-btn rr-btn--ghost', type: 'button', onclick: () => opts.onCancel!() }, 'Cancel') : null,
      // aria-disabled, not disabled: a disabled button gets no hover, so its tooltip would never show
      ...buttons.map((b) => h('button', { class: 'rr-btn' + (b.to === 'agent' ? ' rr-btn--send rr-btn--agent' : b.to ? ' rr-btn--send' : b === main ? ' rr-btn--primary' : ''), type: 'button', title: b.off ?? b.title, 'aria-disabled': b.off ? 'true' : null, onclick: () => submit(b) }, b.icon ? icon('send', 12) : null, b.label)),
    ),
  );
  if (opts.autofocus) requestAnimationFrame(() => restore());
  return { el, focus: () => restore() };
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

  const resolve = async (t: Thread) => {
    const resolving = t.status === 'open';
    // a GitHub resolve that failed returns false: keep the popup up
    if ((await app.setStatus(t.id, resolving ? 'resolved' : 'open')) === false || !resolving || o.docked || !o.onClose) return;
    const scrim = root.closest('.rr-scrim');
    scrim?.classList.add('is-leaving');
    setTimeout(() => scrim?.classList.contains('is-leaving') && o.onClose!(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500);
  };

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
                    h('button', { class: 'rr-link-btn', title: 'Delete this thread for good', onclick: () => app.deleteMessage(t.id, m.id) }, 'delete'),
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
        ? h('button', { class: 'rr-link-btn', title: gh.pending ? 'Edit this draft' : 'Edit on GitHub', onclick: () => body.replaceWith(composer(app, { placeholder: 'Edit comment', buttons: [{ label: 'Save', onSubmit: (b) => app.editMessage(t.id, m.id, b) }], initial: m.body, autofocus: true, onCancel: () => render() }).el) }, 'edit')
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
    const create = async (body: string, gh: boolean) => {
      const nt = app.createThread(anchor, body, 'you', gh);
      if (nt instanceof Promise) {
        const ok = await nt;
        if (ok) {
          app.toast(anchor.kind === 'code' ? 'Added to your GitHub review — submit it from the header' : 'Posted on GitHub');
          o.onClose?.();
        }
        return ok;
      }
      if (!nt) return false;
      o.id = nt.id;
      render();
    };
    const buttons = t
      ? [{ label: replyLabel!, icon: true, onSubmit: (body: string) => app.reply(t.id, body) }]
      : app.commentTargets(anchor).map((b) => ({ ...b, icon: true, main: o.to === b.to, onSubmit: (body: string) => create(body, b.to === 'github') }));
    const c = composer(app, {
      placeholder,
      buttons,
      autofocus: true,
      // drafts keep today's keys: the review mode still picks the GitHub one
      draftKey: `reviewroom:draft:${app.meta.id}:${t ? t.id : (app.commentsToGitHub(anchor) ? 'gh:' : '') + JSON.stringify(anchor)}`,
      onCancel: o.onClose,
    });
    const msgs = t ? messages(t) : null;
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
    if (scroll) scroll.replaceChildren(messages(t));
    root.querySelector('.rr-thread__head')?.replaceWith(header(t, t.anchor));
    if (t.messages.length !== lastCount) {
      lastCount = t.messages.length;
      scroll?.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    }
  });
  return { el: root, dispose: () => off?.() };
}

// ------------------------------------------------------------------ popup host
export function mountThreadPopup(app: ReviewApp) {
  let current: { el: HTMLElement; dispose: () => void } | null = null;
  let lastFocus: Element | null = null;
  let composing = false;
  const scrim = h('div', { class: 'rr-scrim', hidden: true });
  const box = h('div', { class: 'rr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Comment thread' });
  scrim.append(box);
  document.body.append(scrim);
  const close = () => {
    current?.dispose();
    current = null;
    scrim.hidden = true;
    scrim.classList.remove('is-leaving');
    (lastFocus as HTMLElement | null)?.focus?.();
    // the lines a new comment was for stop being highlighted once it's sent or dropped
    if (composing) {
      app.selection = null;
      app.bus.emit('selection', null);
    }
  };
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
  scrim.addEventListener('keydown', (e) => e.key === 'Escape' && close());
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
    const pid = 'thread:' + id;
    if (!app.dock.getPanel(pid)) {
      // dock beside the narrative (or stack with other docked threads)
      const other = app.dock.panels.find((p) => p.id.startsWith('thread:'));
      const near = other ?? app.dock.getPanel('narrative') ?? app.dock.activePanel;
      const t = app.thread(id)!;
      app.dock.addPanel({ id: pid, component: 'thread', title: t.title ?? app.anchorLabel(t.anchor), params: { id }, position: near ? { referencePanel: near.id, direction: other ? 'within' : 'right' } : undefined });
      if (!other) app.dock.getPanel(pid)?.group.api.setSize({ width: 420 });
    }
    app.showPanel(pid);
  };
  const open = (o: ThreadViewOpts) => {
    if (o.id && app.dock.getPanel('thread:' + o.id)) return app.showPanel('thread:' + o.id);
    current?.dispose();
    scrim.classList.remove('is-leaving'); // opened again while fading out
    lastFocus = document.activeElement;
    composing = !o.id;
    current = threadView(app, { ...o, onClose: close, onDock: dock });
    box.replaceChildren(current.el);
    scrim.hidden = false;
  };
  app.escapers.push(() => (scrim.hidden ? false : (close(), true)));
  app.bus.on('open-thread', ({ id }) => open({ id }));
  app.bus.on('compose-thread', ({ anchor, quote, to }) => open({ anchor, quote, to }));
  return { open, close };
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
        app.dock.getPanel(panelId)?.api.close();
        app.bus.emit('open-thread', { id });
      },
    });
    return { element: h('div', { class: 'rr-thread-panel' }, v.el), dispose: v.dispose };
  },
});
