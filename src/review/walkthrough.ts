// Walkthrough panel: hosts the agent's freeform HTML (<rr-review>) untouched, and
// layers review tooling around it without rewriting it:
//  - every block (paragraph, list item, diagram, table, any [data-rr-block]) gets a
//    plus in either gutter, sharing the right rail with existing threads
//  - hold Alt (or toggle "Pick") to target ANY element, devtools-style
//  - select text to comment on a quote
//  - threads show as passive highlights + chips in a right-hand margin rail
// The same panel shows the PR's description (read-only, from GitHub) with the same commenting.
import { avatarUrl, h, icon, copyText, debounce, relTime, threadBadge } from '../kernel/dom';
import { PR_DESCRIPTION, parseRef } from '../kernel/refs/refs.shared';
import { linkedSymbol } from './symbols';
import { plainExcerpt } from '../kernel/markdown';
import { WALKTHROUGH_BLOCKS as BLOCKS, resolveWalkthroughBlock } from './walkthrough-blocks';
import { WalkthroughTools } from './walkthrough-tools';
import type { Thread } from '../kernel/state/model.shared';

type DocThread = Thread & { anchor: Extract<Anchor, { kind: 'doc' }> };
import { definePanel, type PanelInstance } from '../kernel/dock';
import type { ReviewApp } from '../app';

const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;
// one highlight registry for the page: each panel contributes its own ranges
const highlightRanges = new Map<string, AbstractRange[]>();

import type { Anchor, TextQuote } from '../kernel/state/schema.shared';

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
  private tools: WalkthroughTools;
  private banner: HTMLElement;
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
    this.banner = h('div', { class: 'rr-banner', hidden: true });
    this.wrap = h('div', { class: 'rr-doc-wrap' }, this.head, this.current, this.rail);
    this.scroller = h('div', { class: 'rr-scroll rr-narrative-scroll' + (isDesc ? ' rr-description' : ''), 'data-rr-scope': isDesc ? null : 'narrative', tabindex: '-1' }, this.banner, this.wrap);
    this.element = h('div', { class: 'rr-narrative' }, this.scroller);
    // what the presentation adds (the phone's Contents button, walkthrough.phone.ts); not on the description
    if (!isDesc) extension?.(app, this.element);

    this.tools = new WalkthroughTools(this.wrap, this.scroller, this.rail, {
      doc: () => this.doc,
      readOnly: () => !!this.historic,
      resolve: (el) => resolveWalkthroughBlock(this.doc, this.rootId, el),
      label: (reference) => app.label(reference),
      comment: (block) => app.compose(block.anchor, block.excerpt),
      copy: (block) => {
        void copyText(block.reference);
        app.toast(`Link to ${app.label(block.reference)} copied - paste it into any comment`);
      },
      pinned: (block) => app.state.pins.includes(block.pinReference),
      pin: (block) => {
        app.togglePin(block.pinReference);
        app.toast(`${app.label(block.pinReference)} ${app.state.pins.includes(block.pinReference) ? 'pinned to' : 'unpinned from'} Contents`);
      },
      picked: () => app.bus.emit('picker', false),
      isPicking: () => app.root.classList.contains('is-picking'),
    });
    app.listen(window, 'resize', () => this.tools.dismiss());
    app.listen(window, 'keyup', (e) => { if (e.key === 'Alt') this.tools.releaseAlt(); });
    app.listen(window, 'blur', () => this.tools.releaseAlt());
    this.wrap.addEventListener('click', (e) => this.onClick(e));
    this.wrap.addEventListener('mouseup', (e) => setTimeout(() => this.onMouseUp(e), 0));
    // a touch selection ends with no mouseup: offer the comment once its handles settle, under the selection
    const touchSel = debounce(() => {
      const sel = document.getSelection();
      if (!matchMedia('(pointer: coarse)').matches || !sel?.rangeCount) return;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      this.onMouseUp({ clientX: r.left + r.width / 2, clientY: r.bottom } as MouseEvent);
    }, 400);
    app.listen(document, 'selectionchange', () => {
      touchSel();
      if (!document.getSelection()?.isCollapsed) this.tools.dismiss();
    });

    this.ro = new ResizeObserver(debounce(() => { this.tools.dismiss(); this.layoutRail(); }, 60));
    this.ro.observe(this.current);
    this.offs.push(
      app.bus.on('state', () => { this.renderHead(); this.decorate(); }),
      app.bus.on('reveal-doc', (t) => (t.id === PR_DESCRIPTION) === isDesc && this.reveal(t.id, t.path, t.threadId)),
      app.bus.on('picker', (on: boolean) => this.tools.setPicking(on)),
      app.bus.on('compose-thread', () => this.tools.dismiss()),
      app.bus.on('open-thread', () => this.tools.dismiss()),
    );
    if (!isDesc) {
      this.offs.push(app.bus.on('round-view', (n) => this.showRound(n)));
      this.setupSpy();
      void this.markSymbols(this.current);
    }
    queueMicrotask(() => { this.renderHead(); this.decorate(); });
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
          target = (await this.app.services.code.read(r.path, this.app.services.code.revOf(r.rev)))?.split('\n').slice(r.start - 1, Math.max(r.end ?? r.start, r.start + 8));
        const kind = target && linkedSymbol(a.textContent ?? '', target);
        if (kind) a.dataset.rrSymbol = kind;
      }),
    );
  }

  // ------------------------------------------------------------ scroll spy / reveal
  private setupSpy() {
    // what the reader is in: the last top-level section whose top has crossed 25% of the viewport, then inside it the
    // last sub-section, h3 or h4 to have crossed it (at the very end, the last one on screen): Contents follows the leaf
    const run = () => {
      const secs = [...this.doc.querySelectorAll('section[id], [data-rr-section][id]')].filter((s) => !s.parentElement?.closest('section[id]'));
      const box = this.scroller.getBoundingClientRect();
      const atEnd = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4;
      const line = atEnd ? box.bottom : box.top + this.scroller.clientHeight * 0.25;
      let sec = secs[0];
      for (const s of secs) if (atEnd || s.getBoundingClientRect().top <= line) sec = s;
      let cur = sec?.id;
      for (const sub of sec?.querySelectorAll(':scope section[id], :scope h3[id], :scope h4[id]') ?? []) if (sub.getBoundingClientRect().top <= line) cur = sub.id;
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

  private onClick(e: MouseEvent) {
    const t = e.target as Element;
    // description: a link to a comment on this PR opens its thread here
    const gh = this.isDesc && !e.metaKey && !e.ctrlKey && this.app.services.threads.githubThreadFor(t.closest<HTMLAnchorElement>('a[href]')?.href ?? '');
    if (gh) { e.preventDefault(); return this.app.bus.emit('open-thread', { id: gh }); }
    const link = t.closest('a[href^="rr:"], rr-ref');
    if (link) {
      e.preventDefault();
      void this.app.open(link.getAttribute('href') ?? link.getAttribute('ref')!);
      return;
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
  private docThreads(): DocThread[] {
    return this.app.state.threads.filter((t): t is DocThread => t.anchor.kind === 'doc' && (t.anchor.target === PR_DESCRIPTION) === this.isDesc);
  }

  /** A thread's element and, for a quote, the text it marks in it; null when the element is gone. */
  private locate(t: DocThread) {
    const el = this.app.docElement(t.anchor.target, t.anchor.path);
    return el && { el, range: t.anchor.quote ? rangeForQuote(el, t.anchor.quote) : null };
  }

  private decorate() {
    this.current.querySelectorAll('[data-rr-anchored]').forEach((el) => el.removeAttribute('data-rr-anchored'));
    // what's pinned to Contents carries a pin beside it (content.css), so pinned reads apart from unpinned
    this.current.querySelectorAll('[data-rr-pinned]').forEach((el) => el.removeAttribute('data-rr-pinned'));
    for (const pin of this.app.state.pins) {
      const r = parseRef(pin);
      const el = r?.type === 'doc' ? this.app.docElement(r.id, r.path) : null;
      if (el && this.current.contains(el)) el.setAttribute('data-rr-pinned', '');
    }
    const ranges: Range[] = [];
    for (const t of this.docThreads()) {
      if (t.status === 'resolved') continue;
      const at = this.locate(t);
      if (!at) continue;
      if (at.range && supportsHighlights) ranges.push(at.range);
      else at.el.setAttribute('data-rr-anchored', ''); // no quote, a quote no longer found, or no Highlight API
    }
    if (supportsHighlights) {
      // Docking reparents the document: live Ranges collapse when an ancestor is removed. Keep node endpoints.
      highlightRanges.set(this.rootId, ranges.map((range) => new StaticRange(range)));
      CSS.highlights.set('rr-thread', new Highlight(...[...highlightRanges.values()].flat()));
    }
    this.layoutRail();
  }

  private layoutRail() {
    const wr = this.wrap.getBoundingClientRect();
    const items: { t: DocThread; y: number }[] = [];
    for (const t of this.docThreads()) {
      const at = this.historic ? null : this.locate(t);
      if (!at) continue;
      items.push({ t, y: (at.range ?? at.el).getBoundingClientRect().top - wr.top });
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
    }
    this.rail.replaceChildren(...chips);
    this.wrap.classList.toggle('has-threads', chips.length > 0);
  }

  private chip(t: DocThread): HTMLElement {
    const last = t.messages[t.messages.length - 1];
    const el = h(
      'button',
      {
        class: 'rr-rail-chip' + (t.status === 'resolved' ? ' is-resolved' : '') + (this.app.services.threads.unreadAgent(t) ? ' has-agent' : ''),
        'data-thread': t.id,
        title: plainExcerpt(t.messages[0]?.body ?? '', 200),
        onclick: () => this.app.bus.emit('open-thread', { id: t.id }),
        onpointerenter: () => this.hot(t, true),
        onpointerleave: () => this.hot(t, false),
      },
      threadBadge(t, this.app.services.threads.unreadAgent(t)),
      h('span', { class: 'rr-rail-chip__text' }, plainExcerpt(t.messages[0]?.body ?? '', 46)),
      last?.author === 'agent' ? h('span', { class: 'rr-dot', title: 'Agent replied' }) : null,
    );
    return el;
  }

  private hot(t: DocThread, on: boolean) {
    const at = this.locate(t);
    if (!at) return;
    if (t.anchor.quote && supportsHighlights) {
      if (on && at.range) CSS.highlights.set('rr-thread-hot', new Highlight(at.range));
      else CSS.highlights.delete('rr-thread-hot');
    } else at.el.toggleAttribute('data-rr-hot', on);
  }

  private focusChip(id: string) {
    const chip = this.rail.querySelector(`[data-thread="${id}"]`) as HTMLElement | null;
    chip?.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500 });
  }

  // ------------------------------------------------------------ rounds
  private async showRound(n: number) {
    this.tools.dismiss();
    if (this.app.selection?.kind === 'doc') {
      this.app.selection = null;
      this.app.bus.emit('selection', null);
    }
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
    this.tools.dispose();
    this.offs.forEach((f) => f());
    this.ro.disconnect();
    highlightRanges.delete(this.rootId);
    // keep the author's DOM alive so the panel can be reopened
    this.current.remove();
  }
}

/** What a presentation adds to the walkthrough panel (never the description). Composition sets it before panels mount. */
export type WalkthroughExtension = (app: ReviewApp, panel: HTMLElement) => void;
let extension: WalkthroughExtension | undefined;
export function registerWalkthroughExtension(next: WalkthroughExtension | undefined) {
  extension = next;
}

definePanel({ id: 'narrative', title: 'Review', icon: 'doc', create: (app) => new WalkthroughPanel(app) });
definePanel({ id: 'description', title: 'Description', icon: 'doc', create: (app) => new WalkthroughPanel(app, true) });
