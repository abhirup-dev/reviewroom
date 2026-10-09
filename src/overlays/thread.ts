// Thread view: used as the centred popup AND as a dockable panel ("thread:<id>").
// Markdown with live preview, rr: link chips/embeds, rounds, resolve, dock/undock.
import { h, icon, relTime, copyText } from '../core/dom';
import { renderMarkdown } from '../core/markdown';
import { formatRef, parseRef, refIcon } from '../core/refs';
import type { Anchor, Thread } from '../core/types';
import { definePanel } from '../shell/layout';
import type { ReviewApp } from '../shell/app';
import { renderPreview } from '../elements';

export interface ThreadViewOpts {
  id?: string;
  anchor?: Anchor;
  quote?: string;
  docked?: boolean;
  onClose?(): void;
  onDock?(id: string): void;
  onUndock?(id: string): void;
}

// ------------------------------------------------------------------ composer
export function composer(app: ReviewApp, opts: { placeholder: string; submitLabel: string; initial?: string; autofocus?: boolean; onSubmit(body: string): void; onCancel?(): void }) {
  const ta = h('textarea', { class: 'rr-composer__input', placeholder: opts.placeholder, rows: '3', 'aria-label': opts.placeholder }) as HTMLTextAreaElement;
  ta.value = opts.initial ?? '';
  const preview = h('div', { class: 'rr-composer__preview rr-prose', hidden: true });
  let mode: 'write' | 'preview' = 'write';
  const tabW = h('button', { class: 'rr-tab is-on', onclick: () => setMode('write') }, 'Write');
  const tabP = h('button', { class: 'rr-tab', onclick: () => setMode('preview') }, 'Preview');
  const setMode = (m: typeof mode) => {
    mode = m;
    tabW.classList.toggle('is-on', m === 'write');
    tabP.classList.toggle('is-on', m === 'preview');
    ta.hidden = m === 'preview';
    preview.hidden = m === 'write';
    if (m === 'preview') preview.innerHTML = renderMarkdown(ta.value || '_Nothing to preview_');
    else ta.focus();
  };
  const wrapSel = (before: string, after = before, placeholder = '') => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || placeholder;
    ta.setRangeText(before + sel + after, s, e, 'end');
    if (!value.slice(s, e)) ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    ta.focus();
    autosize();
  };
  const insert = (text: string) => {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus();
    autosize();
  };
  const linkPicker = async (embed = false) => {
    const ref = await (app as any).pickRef?.();
    if (ref) insert(embed ? `\n![](${ref})\n` : `[${app.label(ref)}](${ref})`);
  };
  const sel = app.selection;
  const tb = (label: string | Node, title: string, fn: () => void) => h('button', { class: 'rr-tool', title, 'aria-label': title, onclick: fn, type: 'button' }, label);
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(320, ta.scrollHeight + 2) + 'px';
  };
  ta.addEventListener('input', autosize);
  const submit = () => {
    const body = ta.value.trim();
    if (!body) return ta.focus();
    opts.onSubmit(body);
    ta.value = '';
    autosize();
    setMode('write');
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      opts.onCancel?.();
    } else if (e.key === '[' && ta.value.slice(ta.selectionStart - 1, ta.selectionStart) === '[') {
      e.preventDefault();
      ta.setRangeText('', ta.selectionStart - 1, ta.selectionStart, 'end');
      linkPicker();
    }
  });
  // Paste: a bare rr: link becomes a labelled chip link.
  ta.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain')?.trim();
    if (t && /^rr:\S+$/.test(t) && parseRef(t)) {
      e.preventDefault();
      insert(`[${app.label(t)}](${t})`);
    }
  });
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
      tb('`', 'Inline code', () => wrapSel('`', '`', 'code')),
      tb('```', 'Code block', () => wrapSel('\n```\n', '\n```\n', 'code')),
      tb('•', 'List', () => wrapSel('\n- ', '', 'item')),
      tb(icon('link', 14), 'Link to a section, file, line, symbol or thread  ( [[ )', () => linkPicker()),
      tb(icon('expand', 14), 'Embed a preview of a section, code range or thread', () => linkPicker(true)),
      sel ? tb(icon('target', 14), 'Link the current selection', () => {
        const ref = sel.kind === 'code' ? formatRef({ type: 'code', path: sel.path, rev: sel.side, start: sel.start, end: sel.end }) : app.anchorRef(sel.anchor)!;
        insert(`[${app.label(ref)}](${ref})`);
      }) : null,
    ),
    ta,
    preview,
    h(
      'div',
      { class: 'rr-composer__foot' },
      h('span', { class: 'rr-muted' }, 'Markdown · [[ to link · ⌘↵ to send'),
      h('span', { class: 'rr-toolbar__spacer' }),
      opts.onCancel ? h('button', { class: 'rr-btn rr-btn--ghost', type: 'button', onclick: () => opts.onCancel!() }, 'Cancel') : null,
      h('button', { class: 'rr-btn rr-btn--primary', type: 'button', onclick: submit }, opts.submitLabel),
    ),
  );
  if (opts.autofocus) requestAnimationFrame(() => ta.focus());
  requestAnimationFrame(autosize);
  return { el, focus: () => ta.focus() };
}

// ------------------------------------------------------------------ anchor context
async function anchorContext(app: ReviewApp, a: Anchor, quote?: string): Promise<HTMLElement | null> {
  if (a.kind === 'general') return null;
  if (a.kind === 'doc' && a.quote) return h('blockquote', { class: 'rr-quote' }, a.quote.exact);
  const ref = app.anchorRef(a);
  if (!ref) return null;
  const body = await renderPreview(app, ref, { compact: true });
  return h('div', { class: 'rr-anchor-ctx' }, body, quote && a.kind === 'doc' && !body.textContent ? h('blockquote', { class: 'rr-quote' }, quote) : null);
}

// ------------------------------------------------------------------ the view
export function threadView(app: ReviewApp, o: ThreadViewOpts): { el: HTMLElement; dispose(): void } {
  const root = h('div', { class: 'rr-thread' + (o.docked ? ' is-docked' : '') });
  let off: (() => void) | undefined;
  let lastCount = -1;

  const header = (t: Thread | undefined, anchor: Anchor) => {
    const ref = app.anchorRef(anchor);
    const r = ref ? parseRef(ref) : null;
    return h(
      'header',
      { class: 'rr-thread__head' },
      h(
        'button',
        { class: 'rr-chip rr-chip--anchor', title: ref ? 'Go to ' + ref : 'General comment', disabled: !ref, onclick: () => ref && app.open(ref) },
        h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '•'),
        app.anchorLabel(anchor),
      ),
      t ? h('span', { class: `rr-pill ${t.status === 'resolved' ? 'rr-pill--ok' : ''}` }, t.status) : h('span', { class: 'rr-pill rr-pill--accent' }, 'new thread'),
      h('span', { class: 'rr-toolbar__spacer' }),
      t
        ? h('button', { class: 'rr-btn rr-btn--small rr-btn--ghost', onclick: () => app.setStatus(t.id, t.status === 'open' ? 'resolved' : 'open') }, icon(t.status === 'open' ? 'check' : 'round', 12), t.status === 'open' ? 'Resolve' : 'Reopen')
        : null,
      t ? h('button', { class: 'rr-icon-btn', title: 'Copy link to thread', 'aria-label': 'Copy link to thread', onclick: () => (copyText(formatRef({ type: 'thread', id: t.id })), app.toast('Thread link copied')) }, icon('link', 14)) : null,
      t && !o.docked && o.onDock ? h('button', { class: 'rr-icon-btn', title: 'Dock as a panel', 'aria-label': 'Dock as a panel', onclick: () => o.onDock!(t.id) }, icon('dock', 14)) : null,
      t && o.docked && o.onUndock ? h('button', { class: 'rr-icon-btn', title: 'Open as popup', 'aria-label': 'Open as popup', onclick: () => o.onUndock!(t.id) }, icon('maximize', 14)) : null,
      o.onClose ? h('button', { class: 'rr-icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => o.onClose!() }, icon('close', 14)) : null,
    );
  };

  const messages = (t: Thread) => {
    const list = h('div', { class: 'rr-thread__msgs' });
    let round = 0;
    for (const m of t.messages) {
      if (m.round !== round) {
        round = m.round;
        list.append(h('div', { class: 'rr-round-sep' }, h('span', null, `Round ${round}`)));
      }
      const body = h('div', { class: 'rr-msg__body rr-prose', html: renderMarkdown(m.body) });
      const actions =
        m.author === 'you' && m.round === app.state.round
          ? h(
              'div',
              { class: 'rr-msg__actions' },
              h('button', {
                class: 'rr-link-btn',
                onclick: () => {
                  const c = composer(app, { placeholder: 'Edit comment', submitLabel: 'Save', initial: m.body, autofocus: true, onSubmit: (b) => app.editMessage(t.id, m.id, b), onCancel: () => render() });
                  body.replaceWith(c.el);
                },
              }, 'edit'),
              h('button', { class: 'rr-link-btn', onclick: () => app.deleteMessage(t.id, m.id) }, 'delete'),
            )
          : null;
      list.append(
        h(
          'article',
          { class: `rr-msg rr-msg--${m.author}` },
          h('div', { class: 'rr-avatar' + (m.author === 'agent' ? ' rr-avatar--agent' : ''), 'aria-hidden': 'true' }, m.author === 'agent' ? 'AI' : 'You'.slice(0, 2)),
          h('div', { class: 'rr-msg__main' }, h('div', { class: 'rr-msg__meta' }, h('strong', null, m.author === 'agent' ? 'agent' : 'you'), h('span', { class: 'rr-muted' }, relTime(m.at)), actions), body),
        ),
      );
    }
    return list;
  };

  const ctxHost = h('div', { class: 'rr-thread__ctx' });
  const render = () => {
    const t = o.id ? app.thread(o.id) : undefined;
    const anchor = t?.anchor ?? o.anchor ?? { kind: 'general' };
    if (o.id && !t) {
      root.replaceChildren(header(undefined, anchor), h('div', { class: 'rr-empty' }, 'This thread was deleted.'));
      return;
    }
    const c = composer(app, {
      placeholder: t ? 'Reply… (markdown, [[ to link)' : 'Leave a comment or ask the agent… (markdown, [[ to link)',
      submitLabel: t ? 'Reply' : 'Comment',
      autofocus: true,
      onSubmit: (body) => {
        if (t) app.reply(t.id, body);
        else {
          const nt = app.createThread(anchor, body);
          o.id = nt.id;
          render();
        }
      },
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
  anchorContext(app, anchor, o.quote).then((ctx) => ctx && ctxHost.replaceChildren(ctx));
  render();
  off = app.bus.on('state', () => {
    // don't clobber an in-progress draft: only re-render the message list
    const t = o.id ? app.thread(o.id) : undefined;
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
  let current: { el: HTMLElement; dispose(): void } | null = null;
  let lastFocus: Element | null = null;
  const scrim = h('div', { class: 'rr-scrim', hidden: true });
  const box = h('div', { class: 'rr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Comment thread' });
  scrim.append(box);
  document.body.append(scrim);
  const close = () => {
    current?.dispose();
    current = null;
    scrim.hidden = true;
    (lastFocus as HTMLElement | null)?.focus?.();
  };
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
  scrim.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  const dock = (id: string) => {
    close();
    const pid = 'thread:' + id;
    if (!app.dock.getPanel(pid)) {
      // dock beside the narrative (or stack with other docked threads)
      const other = app.dock.panels.find((p) => p.id.startsWith('thread:'));
      const near = other ?? app.dock.getPanel('narrative') ?? app.dock.activePanel;
      const t = app.thread(id)!;
      app.dock.addPanel({ id: pid, component: 'thread', title: app.anchorLabel(t.anchor), params: { id }, position: near ? { referencePanel: near.id, direction: other ? 'within' : 'right' } : undefined } as any);
      if (!other) app.dock.getPanel(pid)?.group.api.setSize({ width: 420 });
    }
    app.showPanel(pid);
  };
  const open = (o: ThreadViewOpts) => {
    if (o.id && app.dock.getPanel('thread:' + o.id)) return app.showPanel('thread:' + o.id);
    current?.dispose();
    lastFocus = document.activeElement;
    current = threadView(app, { ...o, onClose: close, onDock: dock });
    box.replaceChildren(current.el);
    scrim.hidden = false;
  };
  app.escapers.push(() => (scrim.hidden ? false : (close(), true)));
  app.bus.on('open-thread', ({ id }) => open({ id }));
  app.bus.on('compose-thread', ({ anchor, quote }) => open({ anchor, quote }));
  (app as any).dockThread = dock;
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
