// Walkthrough panel: hosts the agent's freeform HTML (<rr-review>) untouched, and
// layers review tooling around it without rewriting it:
//  - every block (paragraph, list item, diagram, table, any [data-rr-block]) gets a
//    hover handle in the left gutter to comment on or link to it
//  - hold Alt (or toggle "Pick") to target ANY element, devtools-style
//  - select text to comment on a quote
//  - threads show as passive highlights + chips in a right-hand margin rail
// The same panel shows the PR's description (read-only, from GitHub) with the same commenting.
import { avatarUrl, h, icon, copyText, debounce, relTime, threadBadge } from '../kernel/dom';
import { PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import { cssPathWithin, formatRef, parseRef } from '../kernel/refs/browser';
import { linkedSymbol } from './symbols';
import { plainExcerpt } from '../kernel/markdown';
import type { Anchor, TextQuote, Thread } from '../kernel/state/model.shared';
import { definePanel, type PanelInstance } from '../kernel/dock';
import type { ReviewApp } from '../app';

const BLOCKS =
  'h1,h2,h3,h4,h5,h6,p,li,pre,table,figure,blockquote,img,svg,canvas,video,details,dl,[data-rr-block],rr-code,rr-embed,rr-callout,rr-flow,rr-checklist,.rr-block';

const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;
// one highlight registry for the page: each panel contributes its own ranges
const highlightRanges = new Map<string, Range[]>();

import { describeElement } from '../kernel/refs/describe';

export function anchorFor(doc: HTMLElement, el: Element): { target: string; path?: string } {
  if (el.id) return { target: el.id };
  const owner = el.parentElement?.closest('[id]');
  const root = owner && doc.contains(owner) ? owner : doc;
  return { target: root === doc ? '' : root.id, path: cssPathWithin(root, el) || undefined };
}

/** Locate a text quote within an element and return a DOM Range. */
export function rangeForQuote(root: Element, q: TextQuote): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = '';
  const starts: number[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    starts.push(text.length);
    nodes.push(n);
    text += n.data;
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  // whitespace-insensitive search: map normalised index back to raw index
  const map: number[] = [];
  let ntext = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]) && /\s$/.test(ntext)) continue;
    map.push(i);
    ntext += /\s/.test(text[i]) ? ' ' : text[i];
  }
  const exact = norm(q.exact);
  let at = -1;
  if (q.prefix) at = ntext.indexOf(norm(q.prefix) + exact);
  at = at >= 0 ? at + norm(q.prefix!).length : ntext.indexOf(exact);
  if (at < 0) return null;
  const s = map[at];
  const e = map[at + exact.length - 1] + 1;
  const locate = (pos: number) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > pos) i--;
    return [nodes[i], pos - starts[i]] as const;
  };
  const [sn, so] = locate(s);
  const [en, eo] = locate(e - 1);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, Math.min(en.data.length, eo + 1));
  return r;
}

class WalkthroughPanel implements PanelInstance {
  element: HTMLElement;
  private scroller: HTMLElement;
  private wrap: HTMLElement;
  private rail: HTMLElement;
  private handle: HTMLElement;
  private outline: HTMLElement;
  private banner: HTMLElement;
  private hoverBlock: Element | null = null;
  private picking = false;
  private offs: (() => void)[] = [];
  private ro: ResizeObserver;
  private current: HTMLElement;
  private historic: HTMLElement | null = null;
  /** Anchor target meaning this panel's root: '' (walkthrough) or PR_DESCRIPTION. */
  private rootId: string;
  private head: HTMLElement;

  constructor(
    private app: ReviewApp,
    private isDesc = false,
  ) {
    this.current = isDesc ? app.descDoc : app.doc!;
    this.rootId = isDesc ? PR_DESCRIPTION : '';
    this.head = h('div', { class: 'rr-description__head', hidden: !isDesc });
    this.rail = h('div', { class: 'rr-rail', 'aria-label': 'Comment threads' });
    this.outline = h('div', { class: 'rr-block-outline', hidden: true });
    this.handle = h(
      'div',
      { class: 'rr-block-handle', hidden: true },
      h('button', { class: 'rr-icon-btn', title: 'Comment on this whole block', 'data-keys': 'c', 'aria-label': 'Comment on this block', onclick: () => this.commentOnBlock() }, icon('thread', 14)),
      h('button', { class: 'rr-icon-btn', title: 'Copy a link to this block (paste it into any comment)', 'aria-label': 'Copy link to this block', onclick: () => this.linkBlock() }, icon('link', 14)),
      h('button', { class: 'rr-icon-btn', title: 'Pin to Contents for quick access', 'aria-label': 'Pin this block', onclick: () => this.pinBlock() }, icon('pin', 14)),
    );
    this.banner = h('div', { class: 'rr-banner', hidden: true });
    this.wrap = h('div', { class: 'rr-doc-wrap' }, this.head, this.current, this.rail, this.outline, this.handle);
    this.scroller = h('div', { class: 'rr-scroll rr-narrative-scroll' + (isDesc ? ' rr-description' : ''), 'data-rr-scope': isDesc ? null : 'narrative', tabindex: '-1' }, this.banner, this.wrap);
    this.element = h('div', { class: 'rr-narrative' }, this.scroller);

    this.wrap.addEventListener('pointermove', (e) => this.onMove(e));
    this.wrap.addEventListener('pointerleave', () => this.scheduleHide(200));
    this.handle.addEventListener('pointerleave', () => this.scheduleHide());
    this.wrap.addEventListener('click', (e) => this.onClick(e), true);
    this.wrap.addEventListener('mouseup', (e) => setTimeout(() => this.onMouseUp(e), 0));
    this.scroller.addEventListener('scroll', () => this.hoverBlock && this.hideHandle(), { passive: true });

    this.ro = new ResizeObserver(debounce(() => this.layoutRail(), 60));
    this.ro.observe(this.current);
    this.offs.push(
      app.bus.on('state', () => (this.renderHead(), this.decorate())),
      app.bus.on('reveal-doc', (t) => (t.id === PR_DESCRIPTION) === isDesc && this.reveal(t.id, t.path, t.threadId)),
      app.bus.on('picker', (on: boolean) => this.setPicking(on)),
    );
    if (!isDesc) {
      this.offs.push(app.bus.on('round-view', (n) => this.showRound(n)));
      this.setupSpy();
      void this.markSymbols(this.current);
    }
    queueMicrotask(() => (this.renderHead(), this.decorate()));
    this.current.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => this.layoutRail(), { once: true }));
  }

  private get doc() {
    return this.historic ?? this.current;
  }

  /** Description only: who wrote it, when, and a way to it on GitHub. */
  private renderHead() {
    const g = this.app.github;
    const d = g?.description;
    if (!this.isDesc || !d) return;
    this.head.replaceChildren(
      ...[
        d.avatar ? h('img', { class: 'rr-avatar rr-avatar--gh', src: avatarUrl(d.avatar, 48), alt: '', loading: 'lazy' }) : null,
        h('strong', null, d.login),
        h('span', { class: 'rr-muted' }, relTime(d.at)),
        g.url ? h('a', { class: 'rr-link-btn rr-description__open', href: g.url, target: '_blank', rel: 'noopener', title: 'Open this PR on GitHub (the description is edited there)' }, 'Open on GitHub') : null,
      ].filter((x): x is HTMLElement => !!x),
    );
  }

  /** Links whose text names the symbol declared at their target get data-rr-symbol=<kind> (styled in content.css). */
  private async markSymbols(doc: HTMLElement) {
    const links = doc.querySelectorAll<HTMLAnchorElement>('a[href^="rr:code/"], a[href^="rr:file/"], a[href^="rr:sym/"]');
    await Promise.all(
      [...links].map(async (a) => {
        const r = parseRef(a.getAttribute('href')!);
        let target: string | string[] | undefined;
        if (r?.type === 'sym') target = (await this.app.searchSymbol(r.name).catch(() => [])).find((x) => x.kind === 'definition')?.text;
        else if ((r?.type === 'code' || r?.type === 'file') && r.start)
          target = (await this.app.read(r.path, this.app.revOf(r.rev)))?.split('\n').slice(r.start - 1, Math.max(r.end ?? r.start, r.start + 8));
        const kind = target && linkedSymbol(a.textContent ?? '', target);
        if (kind) a.dataset.rrSymbol = kind;
      }),
    );
  }

  // ------------------------------------------------------------ scroll spy / reveal
  private setupSpy() {
    // active section = the last top-level section whose top has crossed 25% of the viewport
    const run = () => {
      const secs = [...this.doc.querySelectorAll('section[id], [data-rr-section][id]')].filter((s) => !s.parentElement?.closest('section[id]'));
      const line = this.scroller.getBoundingClientRect().top + this.scroller.clientHeight * 0.25;
      let cur = secs[0]?.id;
      for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s.id;
      if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) cur = secs[secs.length - 1]?.id ?? cur;
      if (cur && cur !== this.activeId) {
        this.activeId = cur;
        this.app.bus.emit('active-section', cur);
      }
    };
    if (!this.spyBound) {
      this.spyBound = true;
      this.scroller.addEventListener('scroll', () => requestAnimationFrame(run), { passive: true });
    }
    requestAnimationFrame(run);
  }
  private activeId = '';
  private spyBound = false;

  private reveal(id: string, path?: string, threadId?: string) {
    if (this.historic) void this.showRound(0);
    this.app.showPanel(this.isDesc ? 'description' : 'narrative');
    const el = this.app.docElement(id, path);
    if (!el) return this.app.toast(this.isDesc ? 'That part of the PR description is gone' : `“${id}” is not in the narrative`, 'error');
    if (el instanceof HTMLDetailsElement) el.open = true;
    el.closest('details')?.setAttribute('open', '');
    const top = el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    this.scroller.scrollTo({ top: Math.max(0, top - 56) }); // instant: the flash below shows where you landed
    (el as HTMLElement).animate?.([{ backgroundColor: 'var(--rr-flash)' }, { backgroundColor: 'transparent' }], { duration: 1600, easing: 'ease-out' });
    if (threadId) this.focusChip(threadId);
  }

  // ------------------------------------------------------------ block handle / picker
  private blockAt(target: EventTarget | null): Element | null {
    if (!(target instanceof Element) || !this.doc.contains(target) || target === this.doc) return null;
    if (this.picking) return target;
    let el: Element | null = target.closest(BLOCKS);
    // prefer the outer figure/svg for diagram internals
    const svgRoot = target.closest('svg');
    if (svgRoot) el = svgRoot.closest('figure,[data-rr-block]') ?? svgRoot;
    return el && this.doc.contains(el) ? el : null;
  }

  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private onMove(e: PointerEvent) {
    const t = e.target as Element;
    if (t.closest('.rr-block-handle')) return clearTimeout(this.hideTimer);
    if (t.closest('.rr-rail')) return this.scheduleHide();
    this.picking = this.pickToggle || e.altKey;
    this.wrap.classList.toggle('is-picking', this.picking);
    // Moving from a block towards its handle crosses the gutter (and sometimes a
    // neighbouring block's edge): keep the current block while the pointer is in
    // that corridor so the handle stays reachable.
    if (this.hoverBlock && !this.picking) {
      const r = this.hoverBlock.getBoundingClientRect();
      const h = this.handle.getBoundingClientRect();
      if (e.clientX <= r.left + 24 && e.clientX >= h.left - 8 && e.clientY >= r.top - 10 && e.clientY <= Math.max(r.bottom, h.bottom) + 10) return clearTimeout(this.hideTimer);
    }
    const el = this.blockAt(t);
    if (!el) return this.scheduleHide();
    clearTimeout(this.hideTimer);
    if (el === this.hoverBlock) return;
    this.showFor(el);
  }

  private showFor(el: Element) {
    this.hoverBlock = el;
    const wr = this.wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    Object.assign(this.outline.style, { top: r.top - wr.top - 3 + 'px', left: r.left - wr.left - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 6 + 'px' });
    this.outline.hidden = false;
    this.outline.dataset.label = this.picking ? describeElement(el) : '';
    // sit flush against the block's left edge (outline included) so there is no dead gap to cross
    this.handle.hidden = false;
    const hw = this.handle.offsetWidth || 34;
    Object.assign(this.handle.style, { top: r.top - wr.top - 3 + 'px', left: Math.max(2, r.left - wr.left - 6 - hw) + 'px' });
  }

  private pickToggle = false;
  private setPicking(on: boolean) {
    this.pickToggle = on;
    this.wrap.classList.toggle('is-picking', on);
  }

  private scheduleHide(ms = 320) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.handle.matches(':hover')) return;
      this.hideHandle();
    }, ms);
  }

  private hideHandle() {
    clearTimeout(this.hideTimer);
    this.hoverBlock = null;
    this.outline.hidden = true;
    this.handle.hidden = true;
  }

  private anchorOf(el: Element) {
    const a = anchorFor(this.current, el);
    return { ...a, target: a.target || this.rootId };
  }
  private blockAnchor(el: Element): Anchor {
    return { kind: 'doc', ...this.anchorOf(el) };
  }
  private commentOnBlock(el = this.hoverBlock) {
    if (!el || this.historic) return;
    this.app.compose(this.blockAnchor(el), plainExcerpt(el.textContent || '', 140));
    this.hideHandle();
  }
  private linkBlock(el = this.hoverBlock) {
    if (!el) return;
    const a = this.anchorOf(el);
    const ref = formatRef({ type: 'doc', id: a.target, path: a.path });
    void copyText(ref);
    this.app.toast(`Link to ${this.app.label(ref)} copied — paste it into any comment`);
  }
  private pinBlock(el = this.hoverBlock) {
    if (!el) return;
    const a = this.anchorOf(el);
    const ref = formatRef({ type: 'doc', id: a.target, path: a.path });
    this.app.togglePin(ref);
    this.app.toast(`${this.app.label(ref)} pinned to Contents`);
  }

  private onClick(e: MouseEvent) {
    const t = e.target as Element;
    // description: a link to a comment on this PR opens its thread here
    const gh = this.isDesc && !e.metaKey && !e.ctrlKey && this.app.githubThreadFor(t.closest<HTMLAnchorElement>('a[href]')?.href ?? '');
    if (gh) return e.preventDefault(), this.app.bus.emit('open-thread', { id: gh });
    const link = t.closest('a[href^="rr:"], rr-ref');
    if (link) {
      e.preventDefault();
      void this.app.open(link.getAttribute('href') ?? link.getAttribute('ref')!);
      return;
    }
    if (this.picking && this.doc.contains(t) && !t.closest('.rr-block-handle')) {
      e.preventDefault();
      e.stopPropagation();
      this.commentOnBlock(t);
      if (this.pickToggle) this.app.bus.emit('picker', false);
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (this.historic) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.current.contains(range.commonAncestorContainer)) return;
    const exact = sel.toString().trim();
    if (exact.length < 2) return;
    let container: Node | null = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentElement;
    const block = (container as Element).closest(BLOCKS) ?? (container as Element);
    const found = block.id ? block : block.closest('[id]');
    const owner = found && this.current.contains(found) ? found : this.current; // not the dock's wrapper around the review
    const ownerText = owner.textContent || '';
    const idx = ownerText.indexOf(range.toString());
    const quote: TextQuote = {
      exact,
      prefix: idx > 0 ? ownerText.slice(Math.max(0, idx - 32), idx) : undefined,
      suffix: idx >= 0 ? ownerText.slice(idx + range.toString().length, idx + range.toString().length + 32) : undefined,
    };
    const a = { target: owner === this.current ? this.rootId : owner.id };
    this.app.selection = { kind: 'doc', anchor: { kind: 'doc', ...a, quote }, x: e.clientX, y: e.clientY, label: exact };
    this.app.bus.emit('selection', this.app.selection);
  }

  // ------------------------------------------------------------ threads: highlights + rail
  private docThreads(): Thread[] {
    return this.app.state.threads.filter((t) => t.anchor.kind === 'doc' && (t.anchor.target === PR_DESCRIPTION) === this.isDesc);
  }

  private decorate() {
    this.current.querySelectorAll('[data-rr-anchored]').forEach((el) => el.removeAttribute('data-rr-anchored'));
    const ranges: Range[] = [];
    for (const t of this.docThreads()) {
      if (t.status === 'resolved') continue;
      const a = t.anchor as Extract<Anchor, { kind: 'doc' }>;
      const el = this.app.docElement(a.target, a.path);
      if (!el) continue;
      if (a.quote && supportsHighlights) {
        const r = rangeForQuote(el, a.quote);
        if (r) ranges.push(r);
        else el.setAttribute('data-rr-anchored', '');
      } else el.setAttribute('data-rr-anchored', '');
    }
    if (supportsHighlights) {
      highlightRanges.set(this.rootId, ranges);
      CSS.highlights.set('rr-thread', new Highlight(...[...highlightRanges.values()].flat()));
    }
    this.layoutRail();
  }

  private chipY = new Map<string, number>();
  private layoutRail() {
    const wr = this.wrap.getBoundingClientRect();
    const items: { t: Thread; y: number }[] = [];
    for (const t of this.docThreads()) {
      const a = t.anchor as Extract<Anchor, { kind: 'doc' }>;
      const el = this.app.docElement(a.target, a.path);
      if (!el || this.historic) continue;
      let top = el.getBoundingClientRect().top;
      if (a.quote) {
        const r = rangeForQuote(el, a.quote);
        if (r) top = r.getBoundingClientRect().top;
      }
      items.push({ t, y: top - wr.top });
    }
    items.sort((a, b) => a.y - b.y);
    let floor = -Infinity;
    const chips: HTMLElement[] = [];
    for (const { t, y } of items) {
      const top = Math.max(y, floor + 6);
      const chip = this.chip(t);
      chip.style.top = top + 'px';
      chips.push(chip);
      floor = top + 30;
      this.chipY.set(t.id, top);
    }
    this.rail.replaceChildren(...chips);
    this.wrap.classList.toggle('has-threads', chips.length > 0);
  }

  private chip(t: Thread): HTMLElement {
    const last = t.messages[t.messages.length - 1];
    const el = h(
      'button',
      {
        class: 'rr-rail-chip' + (t.status === 'resolved' ? ' is-resolved' : '') + (this.app.unreadAgent(t) ? ' has-agent' : ''),
        'data-thread': t.id,
        title: plainExcerpt(t.messages[0]?.body ?? '', 200),
        onclick: () => this.app.bus.emit('open-thread', { id: t.id }),
        onpointerenter: () => this.hot(t, true),
        onpointerleave: () => this.hot(t, false),
      },
      threadBadge(t, this.app.unreadAgent(t)),
      h('span', { class: 'rr-rail-chip__text' }, plainExcerpt(t.messages[0]?.body ?? '', 46)),
      last?.author === 'agent' ? h('span', { class: 'rr-dot', title: 'Agent replied' }) : null,
    );
    return el;
  }

  private hot(t: Thread, on: boolean) {
    const a = t.anchor as Extract<Anchor, { kind: 'doc' }>;
    const el = this.app.docElement(a.target, a.path);
    if (!el) return;
    if (a.quote && supportsHighlights) {
      const r = rangeForQuote(el, a.quote);
      if (on && r) CSS.highlights.set('rr-thread-hot', new Highlight(r));
      else CSS.highlights.delete('rr-thread-hot');
    } else el.toggleAttribute('data-rr-hot', on);
  }

  private focusChip(id: string) {
    const chip = this.rail.querySelector(`[data-thread="${id}"]`) as HTMLElement | null;
    chip?.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500 });
  }

  // ------------------------------------------------------------ rounds
  private async showRound(n: number) {
    if (!n || n === this.app.state.round) {
      if (this.historic) {
        this.historic.replaceWith(this.current);
        this.historic = null;
      }
      this.banner.hidden = true;
      this.app.viewRound = this.app.state.round;
      this.setupSpy();
      this.layoutRail();
      return;
    }
    const html = await this.app.backend.snapshot?.(n);
    if (!html) return this.app.toast(`No snapshot for round ${n}`, 'error');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const review = parsed.querySelector('rr-review');
    if (!review) return this.app.toast(`Couldn't load round ${n}`, 'error');
    const el = document.importNode(review, true) as HTMLElement;
    el.querySelectorAll('script').forEach((s) => s.remove());
    el.classList.add('is-historic');
    void this.markSymbols(el);
    (this.historic ?? this.current).replaceWith(el);
    this.historic = el;
    this.app.viewRound = n;
    this.banner.replaceChildren(
      icon('round', 14),
      h('span', null, `As of round ${n} · read-only`),
      h('button', { class: 'rr-btn rr-btn--small', onclick: () => this.app.bus.emit('round-view', 0) }, 'Back to current'),
    );
    this.banner.hidden = false;
    this.setupSpy();
    this.rail.replaceChildren();
  }

  onShow() {
    this.layoutRail();
  }
  dispose() {
    this.offs.forEach((f) => f());
    this.ro.disconnect();
    highlightRanges.delete(this.rootId);
    // keep the author's DOM alive so the panel can be reopened
    this.current.remove();
  }
}

definePanel({ id: 'narrative', title: 'Review', icon: 'doc', create: (app) => new WalkthroughPanel(app) });
definePanel({ id: 'description', title: 'Description', icon: 'doc', create: (app) => new WalkthroughPanel(app, true) });
