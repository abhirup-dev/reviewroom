// Command palette (⌘K), selection toolbar, link hover previews, toasts.
import { h, icon, copyText, debounce, fuzzyScore } from '../core/dom';
import { formatRef, parseRef, refIcon } from '../core/refs';
import { keyLabel } from '../core/commands';
import { plainExcerpt } from '../core/markdown';
import type { ReviewApp } from '../shell/app';
import { renderPreview } from '../elements';

interface Item {
  kind: 'command' | 'file' | 'section' | 'thread' | 'symbol' | 'text' | 'link';
  label: string;
  detail?: string;
  keys?: string[];
  ref?: string;
  score: number;
  run(): void;
}

const KIND_ICON: Record<Item['kind'], Parameters<typeof icon>[0]> = { command: 'chevron', file: 'files', section: 'doc', thread: 'thread', symbol: 'symbol', text: 'search', link: 'link' };

// ================================================================ palette
export function mountPalette(app: ReviewApp) {
  const input = h('input', { class: 'rr-palette__input', placeholder: '', 'aria-label': 'Command palette', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const list = h('div', { class: 'rr-palette__list', role: 'listbox' });
  const hint = h('div', { class: 'rr-palette__hint' });
  const box = h('div', { class: 'rr-palette', role: 'dialog', 'aria-label': 'Command palette' }, input, list, hint);
  const scrim = h('div', { class: 'rr-scrim rr-scrim--top', hidden: true }, box);
  document.body.append(scrim);
  let items: Item[] = [];
  let sel = 0;
  let pick: ((ref: string | null) => void) | null = null;
  let remote: Item[] = [];
  let reqId = 0;

  const close = (result: string | null = null) => {
    scrim.hidden = true;
    if (pick) {
      const p = pick;
      pick = null;
      p(result);
    }
  };
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());

  const sections = () =>
    app.doc
      ? [...app.doc.querySelectorAll('section[id], h2[id], h3[id], [data-rr-section][id], figure[id]')].map((s) => ({ id: s.id, title: app.docTitle(s.id) ?? s.id }))
      : [];

  const local = (q: string): Item[] => {
    const out: Item[] = [];
    const mode = q[0];
    const text = /^[>#/@]/.test(q) ? q.slice(1).trim() : q.trim();
    const add = (it: Omit<Item, 'score'>, hay: string) => {
      const s = fuzzyScore(text, hay);
      if (s >= 0) out.push({ ...it, score: s });
    };
    if (/^rr:/.test(q.trim()) && parseRef(q.trim())) {
      const ref = q.trim();
      out.push({ kind: 'link', label: 'Open ' + app.label(ref), ref, score: 999, run: () => app.open(ref) });
    }
    if (!pick && (mode === '>' || !/^[#/@]/.test(q)))
      for (const c of app.commands.all()) if (c.id !== 'palette') add({ kind: 'command', label: c.title, detail: c.group, keys: c.keys, run: c.run }, c.title + ' ' + (c.group ?? ''));
    if (mode === '>' && !pick) return out;
    if (!/^[#/]/.test(q)) {
      for (const f of app.files) {
        const ref = formatRef({ type: 'code', path: f.path, rev: 'head' });
        add({ kind: 'file', label: f.path.split('/').pop()!, detail: f.path, ref, run: () => app.bus.emit('reveal-code', { path: f.path, side: f.status === 'deleted' ? 'base' : 'head' }) }, f.path);
      }
      for (const s of sections()) {
        const ref = formatRef({ type: 'doc', id: s.id });
        add({ kind: 'section', label: s.title, detail: 'Section', ref, run: () => app.bus.emit('reveal-doc', { id: s.id }) }, s.title + ' ' + s.id);
      }
      for (const t of app.state.threads) {
        const ref = formatRef({ type: 'thread', id: t.id });
        add({ kind: 'thread', label: plainExcerpt(t.messages[0]?.body ?? '', 70), detail: app.anchorLabel(t.anchor), ref, run: () => app.bus.emit('open-thread', { id: t.id }) }, t.messages.map((m) => m.body).join(' '));
      }
    }
    return out;
  };

  const searchRemote = debounce(async (q: string) => {
    const id = ++reqId;
    const symbol = q.startsWith('#');
    const term = q.slice(1).trim();
    if (term.length < 2) {
      remote = [];
      return paint();
    }
    hint.textContent = 'Searching…';
    const hits = await app.search(term, symbol).catch(() => []);
    if (id !== reqId) return;
    remote = hits.slice(0, 40).map((hit, i) => {
      const inDiff = app.files.some((f) => f.path === hit.path);
      return {
        kind: symbol ? 'symbol' : 'text',
        label: hit.text.slice(0, 120),
        detail: `${hit.path}:${hit.line}${hit.kind === 'definition' ? ' · definition' : ''}${inDiff ? '' : ' · outside diff'}`,
        ref: symbol && hit.kind === 'definition' ? formatRef({ type: 'sym', name: term }) : formatRef({ type: inDiff ? 'code' : 'file', path: hit.path, rev: 'head', start: hit.line }),
        score: 100 - i,
        run: () => app.bus.emit('reveal-code', { path: hit.path, side: 'head', start: hit.line, end: hit.line, view: inDiff ? 'diff' : 'file' }),
      } as Item;
    });
    paint();
  }, 160);

  const paint = () => {
    const q = input.value;
    items = [...(/^[#/]/.test(q) ? remote : []), ...local(q)].filter((i) => !pick || i.ref).sort((a, b) => b.score - a.score).slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...items.map((it, i) =>
        h(
          'div',
          { class: 'rr-palette__item' + (i === sel ? ' is-sel' : ''), role: 'option', 'aria-selected': String(i === sel), onmousemove: () => i !== sel && ((sel = i), paint()), onclick: () => choose(i) },
          h('span', { class: `rr-palette__kind rr-palette__kind--${it.kind}` }, icon(KIND_ICON[it.kind], 12)),
          h('span', { class: 'rr-palette__label' }, it.label),
          it.detail ? h('span', { class: 'rr-palette__detail' }, it.detail) : null,
          it.keys?.length ? h('kbd', null, keyLabel(it.keys[0])) : null,
        ),
      ),
    );
    if (!items.length) list.append(h('div', { class: 'rr-empty' }, /^[#/]/.test(q) && q.length < 3 ? 'Type to search the repo…' : 'No matches'));
    list.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
    hint.replaceChildren(
      ...(pick
        ? [h('span', null, 'Pick something to link · '), h('kbd', null, '#'), ' symbol ', h('kbd', null, '/'), ' text']
        : [h('kbd', null, '>'), ' commands  ', h('kbd', null, '#'), ' symbols  ', h('kbd', null, '/'), ' search code']),
    );
  };

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (pick) return close(it.ref ?? null);
    close();
    it.run();
  };

  input.addEventListener('input', () => {
    sel = 0;
    if (/^[#/]/.test(input.value)) searchRemote(input.value);
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) (sel = Math.min(items.length - 1, sel + 1)), paint(), e.preventDefault();
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) (sel = Math.max(0, sel - 1)), paint(), e.preventDefault();
    else if (e.key === 'Enter') (choose(sel), e.preventDefault());
    else if (e.key === 'Escape') (close(), e.preventDefault(), e.stopPropagation());
  });

  const open = (initial = '') => {
    remote = [];
    input.value = initial;
    input.placeholder = pick ? 'Link to a section, file, thread… (# symbols, / text)' : 'Jump to a file, section, thread or command…';
    scrim.hidden = false;
    paint();
    if (/^[#/]/.test(initial)) searchRemote(initial);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  app.escapers.push(() => (scrim.hidden ? false : (close(), true)));
  (app as any).openPalette = open;
  (app as any).pickRef = () =>
    new Promise<string | null>((resolve) => {
      pick = resolve;
      open();
    });
  return { open };
}

// ================================================================ selection toolbar
export function mountSelectionToolbar(app: ReviewApp) {
  const bar = h('div', { class: 'rr-seltool', role: 'toolbar', 'aria-label': 'Selection actions', hidden: true });
  document.body.append(bar);
  const hide = () => (bar.hidden = true);
  app.bus.on('selection', (s) => {
    if (!s) return hide();
    const ref = s.kind === 'code' ? formatRef({ type: 'code', path: s.path, rev: s.side, start: s.start, end: s.end }) : app.anchorRef({ ...s.anchor, quote: undefined } as any)!;
    const anchor = s.kind === 'code' ? ({ kind: 'code', path: s.path, rev: s.side, start: s.start, end: s.end } as const) : s.anchor;
    const label = s.kind === 'code' ? `${s.path.split('/').pop()}:${s.start}${s.end !== s.start ? '–' + s.end : ''}` : `“${plainExcerpt(s.label, 30)}”`;
    bar.replaceChildren(
      h('span', { class: 'rr-seltool__label' }, label),
      h('button', { class: 'rr-btn rr-btn--small rr-btn--primary', onclick: () => (hide(), app.compose(anchor as any, s.kind === 'doc' ? s.label : undefined)) }, icon('thread', 12), 'Comment'),
      h('button', { class: 'rr-icon-btn', title: 'Copy a link to this (paste it into any comment)', 'aria-label': 'Copy link', onclick: () => (copyText(ref), app.toast(`Link to ${label} copied`), hide()) }, icon('link', 14)),
      h('button', { class: 'rr-icon-btn', title: 'Pin', 'aria-label': 'Pin', onclick: () => (app.togglePin(ref), app.toast('Pinned'), hide()) }, icon('pin', 14)),
    );
    bar.hidden = false;
    const r = bar.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, s.x - r.width / 2));
    const y = s.y - r.height - 14 < 8 ? s.y + 18 : s.y - r.height - 14;
    Object.assign(bar.style, { left: x + 'px', top: y + 'px' });
  });
  document.addEventListener('mousedown', (e) => !bar.contains(e.target as Node) && hide(), true);
  app.escapers.push(() => (bar.hidden ? false : (hide(), true)));
  document.addEventListener('scroll', hide, true);
}

// ================================================================ hover previews
export function mountHoverCards(app: ReviewApp) {
  const card = h('div', { class: 'rr-hovercard', hidden: true, role: 'dialog', 'aria-label': 'Preview' });
  document.body.append(card);
  let wrapped = false; // remembered across previews
  const hide = () => ((card.hidden = true), (current = null), clearTimeout(timer));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let current: Element | null = null;
  const target = (e: Event) => (e.composedPath()[0] as Element)?.closest?.('rr-ref, a[href^="rr:"], rr-node[ref]');
  document.addEventListener('pointerover', (e) => {
    const t = target(e);
    if (card.contains(e.target as Node)) return clearTimeout(hideTimer);
    if (!t) return;
    if (t === current) return clearTimeout(hideTimer);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      current = t;
      const ref = t.getAttribute('ref') || t.getAttribute('href')!;
      const r = parseRef(ref);
      if (!r) return;
      const wrapBtn = h('button', { class: 'rr-icon-btn', title: 'Wrap long lines', 'aria-label': 'Wrap long lines', 'aria-pressed': String(wrapped), hidden: true }, icon('wrap', 14));
      wrapBtn.onclick = () => {
        wrapped = !wrapped;
        card.style.width = card.offsetWidth + 'px'; // keep the size; only the lines reflow
        card.classList.toggle('is-wrapped', wrapped);
        wrapBtn.setAttribute('aria-pressed', String(wrapped));
        place(t);
      };
      const openBtn = h('button', { class: 'rr-icon-btn', title: 'Open', 'aria-label': 'Open', onclick: () => (hide(), app.open(ref)) }, icon('popout', 14));
      card.replaceChildren(
        h('div', { class: 'rr-hovercard__head' }, h('span', { class: 'rr-chip__icon' }, refIcon(r)), h('span', { class: 'rr-hovercard__title' }, app.label(ref)), wrapBtn, openBtn),
        h('div', { class: 'rr-skeleton' }),
      );
      card.style.width = '';
      card.classList.toggle('is-wrapped', wrapped);
      card.hidden = false;
      place(t);
      const body = await renderPreview(app, ref, { compact: true });
      if (current !== t) return;
      card.lastElementChild!.replaceWith(h('div', { class: 'rr-hovercard__body' }, body));
      wrapBtn.hidden = !(body.matches('.rr-snippet') || body.querySelector('.rr-snippet'));
      place(t);
    }, 380);
  });
  document.addEventListener('pointerout', (e) => {
    const t = target(e);
    if (t) clearTimeout(timer);
    if (!t && !card.contains(e.target as Node)) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (card.matches(':hover') || current?.matches(':hover')) return;
      card.hidden = true;
      current = null;
    }, 220);
  });
  document.addEventListener('mousedown', (e) => !card.contains(e.target as Node) && hide());
  app.escapers.push(() => (card.hidden ? false : (hide(), true)));
  function place(t: Element) {
    const r = t.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const below = r.bottom + c.height + 12 < window.innerHeight;
    Object.assign(card.style, {
      left: Math.min(window.innerWidth - c.width - 10, Math.max(10, r.left)) + 'px',
      top: (below ? r.bottom + 8 : Math.max(10, r.top - c.height - 8)) + 'px',
    });
  }
}

// ================================================================ toasts
export function mountToasts(app: ReviewApp) {
  const host = h('div', { class: 'rr-toasts', 'aria-live': 'polite' });
  document.body.append(host);
  app.bus.on('toast', ({ text, kind }) => {
    const t = h('div', { class: 'rr-toast' + (kind === 'error' ? ' rr-toast--error' : '') }, text);
    host.append(t);
    setTimeout(() => t.classList.add('is-out'), 2600);
    setTimeout(() => t.remove(), 3000);
  });
}
