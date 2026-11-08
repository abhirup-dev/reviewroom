// Command palette (⌘K; a presentation's variant, such as a phone's full-screen search), click-away selection release,
// link hover previews.
import { single } from 'fuzzysort';
import { h, icon, debounce, placeNear, backdropCloses, onLongPress } from '../kernel/dom';
import { REF_ELEMENTS, refIcon } from '../kernel/refs/browser';
import { keyLabel } from '../kernel/commands';
import { plainExcerpt } from '../kernel/markdown';
import type { ReviewApp } from '../app';
import { renderPreview } from './previews';
import { defaultSide } from './files.shared';
import { formatRef, parseRef } from '../kernel/refs/refs.shared';

export interface PaletteItem {
  kind: 'command' | 'file' | 'section' | 'thread' | 'symbol' | 'text' | 'link';
  label: string;
  detail?: string;
  keys?: string[];
  ref?: string;
  /** a command's id: a recent pick runs it again */
  cmd?: string;
  score: number;
  run(): void;
}
type Item = PaletteItem;
type IconName = Parameters<typeof icon>[0];
/** Results under a label (none: the flat list), their icon in place of each kind's when given. */
export type PaletteGroup = [label: string, items: Item[], icon?: IconName];

/** What a variant reaches of the palette: its input, closing it, and painting it afresh (the selection back on the
 *  first result, the input focused). */
export interface PaletteHost {
  input: HTMLInputElement;
  close: () => void;
  refresh: () => void;
}

/** A presentation's palette (rr-486.12). Without one it is the desktop's ⌘K: the best matches in one flat list. A
 *  variant browses: outside pick and the typed modes (> # /) the palette also searches symbols as you type, and the
 *  variant lays out the results. */
export interface PaletteVariant {
  /** Above the list: the input inside the variant's own field, then anything between them. */
  top: HTMLElement[];
  placeholder: string;
  iconSize: number;
  /** Each paint: the results in groups while browsing; undefined for the flat list. */
  paint(all: Item[], q: string, browsing: boolean): PaletteGroup[] | undefined;
  /** A result was run (not picked as a link). */
  ran(it: Item): void;
  /** On every open; on close (and on dispose). */
  opened(): void;
  closed(): void;
}

const KIND_ICON: Record<Item['kind'], IconName> = { command: 'chevron', file: 'files', section: 'section', thread: 'thread', symbol: 'symbol', text: 'search', link: 'link' };

// ================================================================ palette
export function mountPalette(app: ReviewApp, variantFor?: (app: ReviewApp, host: PaletteHost) => PaletteVariant) {
  const input = h('input', { class: 'rr-palette__input', placeholder: '', 'aria-label': 'Command palette', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'rr-palette__list', role: 'listbox' });
  const hint = h('div', { class: 'rr-palette__hint' });
  let items: Item[] = [];
  let sel = 0;
  let pick: ((ref: string | null) => void) | null = null;
  let remote: Item[] = [];
  let reqId = 0;
  const variant = variantFor?.(app, { input, close: () => close(), refresh: () => { sel = 0; paint(); input.focus(); } });
  // Esc and the backdrop close it too, without a pick (a variant may add its own way out: the phone's Back)
  const box = h('dialog', { class: 'rr-palette', 'aria-label': 'Command palette', onmousedown: backdropCloses, onclose: () => close() }, ...(variant?.top ?? [input]), list, hint);
  document.body.append(box);

  const close = (result: string | null = null) => {
    const p = pick;
    pick = null;
    variant?.closed();
    box.close();
    p?.(result);
  };

  const sections = () =>
    app.doc
      ? [...app.doc.querySelectorAll('section[id], h2[id], h3[id], [data-rr-section][id], figure[id]')].map((s) => ({ id: s.id, title: app.docTitle(s.id) ?? s.id }))
      : [];

  const local = (q: string): Item[] => {
    const out: Item[] = [];
    const mode = q[0];
    const text = /^[>#/@]/.test(q) ? q.slice(1).trim() : q.trim();
    const add = (it: Omit<Item, 'score'>, hay: string) => {
      const s = text ? single(text, hay)?.score : 1; // 0..1, higher is better
      if (s !== undefined) out.push({ ...it, score: s });
    };
    if (parseRef(q)) {
      const ref = q.trim();
      out.push({ kind: 'link', label: 'Open ' + app.label(ref), ref, score: 999, run: () => app.open(ref) });
    }
    if (!pick && (mode === '>' || !/^[#/@]/.test(q)))
      for (const c of app.commands.all()) if (c.id !== 'palette') add({ kind: 'command', label: c.title, detail: c.group, keys: c.keys, cmd: c.id, run: c.run }, c.title + ' ' + (c.group ?? ''));
    if (mode === '>' && !pick) return out;
    if (!/^[#/]/.test(q)) {
      for (const f of app.files) {
        const ref = formatRef({ type: 'code', path: f.path, rev: 'head' });
        add({ kind: 'file', label: f.path.split('/').pop()!, detail: f.path, ref, run: () => app.bus.emit('reveal-code', { path: f.path, side: defaultSide(f) }) }, f.path);
      }
      for (const s of sections()) {
        const ref = formatRef({ type: 'doc', id: s.id });
        add({ kind: 'section', label: s.title, detail: 'Section', ref, run: () => app.bus.emit('reveal-doc', { id: s.id }) }, s.title + ' ' + s.id);
      }
      for (const t of app.services.threads.threads()) {
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
    const hits = await app.services.code.search(term, symbol).catch(() => []);
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
      };
    });
    paint();
  }, 160);

  /** Browsing a variant's results: outside pick and the typed modes (> # /). */
  const browsing = () => !!variant && !pick && !/^[>#/]/.test(input.value);
  let groups: PaletteGroup[] = [];

  const paint = () => {
    const q = input.value;
    const all = [...(/^[#/]/.test(q) || browsing() ? remote : []), ...local(q)].filter((i) => !pick || i.ref).sort((a, b) => b.score - a.score);
    groups = variant?.paint(all, q, browsing()) ?? [['', all.slice(0, 60)]];
    items = groups.flatMap(([, g]) => g);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let i = 0;
    list.replaceChildren(
      ...groups.flatMap(([label, g, groupIcon]) => [
        label ? h('div', { class: 'rr-palette__group' }, label) : null,
        ...g.map((it) => {
          const n = i++;
          return h(
            'div',
            { class: 'rr-palette__item' + (n === sel ? ' is-sel' : ''), role: 'option', 'aria-selected': String(n === sel), onmousemove: () => n !== sel && ((sel = n), paint()), onclick: () => choose(n) },
            h('span', { class: `rr-palette__kind rr-palette__kind--${it.kind}` }, icon(groupIcon ?? KIND_ICON[it.kind], variant?.iconSize ?? 12)),
            h('span', { class: 'rr-palette__label' }, it.label),
            it.detail ? h('span', { class: 'rr-palette__detail' }, it.detail) : null,
            it.keys?.length ? h('kbd', null, keyLabel(it.keys[0])) : null,
          );
        }),
      ].filter((x) => x !== null)),
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
    variant?.ran(it);
    it.run();
  };

  input.addEventListener('input', () => {
    sel = 0;
    if (/^[#/]/.test(input.value)) searchRemote(input.value);
    else if (browsing()) searchRemote('#' + input.value); // browsing finds symbols as you type
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      sel = Math.min(items.length - 1, sel + 1);
      paint();
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      sel = Math.max(0, sel - 1);
      paint();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      choose(sel);
      e.preventDefault();
    }
  });

  const open = (initial = '') => {
    remote = [];
    input.value = initial;
    input.placeholder = pick ? 'Link to a section, file, thread… (# symbols, / text)' : (variant?.placeholder ?? 'Jump to a file, section, thread or command…');
    if (!box.open) box.showModal();
    variant?.opened();
    paint();
    if (/^[#/]/.test(initial)) searchRemote(initial);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  app.openPalette = open;
  app.pickRef = () =>
    new Promise<string | null>((resolve) => {
      pick = resolve;
      open();
    });
  app.onDispose(() => { pick?.(null); variant?.closed(); box.remove(); });
  return { open };
}

// ================================================================ selection release
export function mountSelectionRelease(app: ReviewApp) {
  // a click anywhere else lets go of the selection, as Esc does; clicks on line numbers or the gutter + make
  // (or extend) a new one, and clicks inside popups and menus belong to them
  const keeps = (n: EventTarget) =>
    n instanceof Element && (n.matches('dialog, .rr-menu, [data-rr-keeps-selection]') || ['data-column-number', 'data-selected-line', 'data-utility-button', 'data-gutter-utility-slot'].some((a) => n.hasAttribute(a)));
  const release = (e: Event) => {
    if (e.composedPath().some(keeps)) return;
    // not removeAllRanges(): that would break starting a text selection in the walkthrough
    app.selection = null;
    app.bus.emit('selection', null);
  };
  // a finger lets go on a tap, not on touching down: that may start a scroll, which keeps the selection
  let touch = false;
  app.listen(document, 'pointerdown', (e) => (touch = e.pointerType === 'touch') || release(e), true);
  app.listen(document, 'click', (e) => touch && release(e), true);
}

// ================================================================ hover previews
export function mountHoverCards(app: ReviewApp) {
  const card = h('div', { class: 'rr-hovercard', popover: 'manual', role: 'dialog', 'aria-label': 'Preview' });
  document.body.append(card);
  let wrapped = false; // remembered across previews
  const hide = () => { card.hidePopover(); current = null; clearTimeout(timer); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let current: Element | null = null;
  app.onDispose(() => { clearTimeout(timer); clearTimeout(hideTimer); card.remove(); });
  const target = (e: Event) => (e.composedPath()[0] as Element)?.closest?.(REF_ELEMENTS);
  // touch: a tap navigates, a long press previews (the hover paths below stay mouse and pen only)
  app.onDispose(
    onLongPress((path) => {
      const t = (path[0] as Element)?.closest?.(REF_ELEMENTS);
      if (t) void show(t);
      return !!t;
    }),
  );
  app.listen(document, 'pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = target(e);
    if (card.contains(e.target as Node)) return clearTimeout(hideTimer);
    if (!t) return;
    if (t === current) return clearTimeout(hideTimer);
    clearTimeout(timer);
    timer = setTimeout(() => void show(t), 380);
  });
  const show = async (t: Element) => {
    clearTimeout(timer);
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
    const openBtn = h('button', { class: 'rr-icon-btn', title: 'Open', 'aria-label': 'Open', onclick: () => { hide(); void app.open(ref); } }, icon('popout', 14));
    card.replaceChildren(
      h('div', { class: 'rr-hovercard__head' }, h('span', { class: 'rr-chip__icon' }, refIcon(r)), h('span', { class: 'rr-hovercard__title' }, app.label(ref)), wrapBtn, openBtn),
      h('div', { class: 'rr-skeleton' }),
    );
    card.style.width = '';
    card.classList.toggle('is-wrapped', wrapped);
    // in the top layer, over any open modal; inside the link's dialog if it's in one (outside it, it'd be inert)
    const host = t.closest('dialog') ?? document.body;
    if (card.parentElement !== host) host.append(card);
    card.showPopover();
    place(t);
    const body = await renderPreview(app, ref, { compact: true });
    if (current !== t) return;
    card.lastElementChild!.replaceWith(h('div', { class: 'rr-hovercard__body' }, body));
    wrapBtn.hidden = !(body.matches('.rr-snippet') || body.querySelector('.rr-snippet'));
    place(t);
  };
  app.listen(document, 'pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const t = target(e);
    if (t) clearTimeout(timer);
    if (!t && !card.contains(e.target as Node)) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (card.matches(':hover') || current?.matches(':hover')) return;
      card.hidePopover();
      current = null;
    }, 220);
  });
  app.listen(document, 'mousedown', (e) => !card.contains(e.target as Node) && hide());
  // capture: Esc closes the card before the dialog it may sit over
  app.listen(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || !card.matches(':popover-open')) return;
    hide();
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  const place = (t: Element) => void placeNear(t, card, 'bottom-start', 8, 10);
}

