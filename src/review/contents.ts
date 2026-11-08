// Walkthrough contents, description headings, and pins.
import { h, icon, threadCounts } from '../kernel/dom';
import { cssPathWithin } from '../kernel/refs/browser';
import { PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import { openCentered } from './focus';
import { definePanel, type PanelInstance } from '../kernel/dock';
import type { ReviewApp } from '../app';

// ======================================================================= Contents
/** A Contents entry: a click scrolls to the element `at`, a double-click opens it big. */
const tocItem = (app: ReviewApp, at: { id: string; path?: string }, title: string, attrs: Record<string, string>, ...extra: (Node | null)[]) =>
  h('button', { ...attrs, onclick: () => app.bus.emit('reveal-doc', at), ondblclick: () => openCentered(app, { type: 'doc', ...at }) }, h('span', { class: 'rr-toc-item__title' }, title), ...extra);

class TocPanel implements PanelInstance {
  element: HTMLElement;
  private body: HTMLElement;
  private offs: (() => void)[] = [];
  private active = '';
  constructor(private app: ReviewApp) {
    this.body = h('div', { class: 'rr-scroll rr-toc' });
    this.element = h('div', { class: 'rr-side' }, this.body);
    const r = () => this.render();
    this.offs.push(
      app.bus.on('state', r),
      app.bus.on('prefs', r),
      app.bus.on('active-section', (id) => {
        this.active = id;
        this.mark();
      }),
    );
    this.render();
  }

  private render() {
    const app = this.app;
    const doc = app.doc;
    if (!doc) return;
    const items: HTMLElement[] = [];
    const sections = doc.querySelectorAll('section[id], [data-rr-section][id]');
    const threadsIn = (el: Element) =>
      app.state.threads.filter((t) => {
        if (t.anchor.kind !== 'doc' || t.status !== 'open') return false;
        const a = t.anchor;
        const target = a.target ? doc.querySelector(`#${CSS.escape(a.target)}`) : null;
        return target ? el === target || el.contains(target) : false;
      });
    sections.forEach((s) => {
      if (s.parentElement?.closest('section[id]')) return; // nested handled below
      const title = app.docTitle(s.id) ?? s.id;
      const round = s.getAttribute('data-round');
      const n = threadsIn(s);
      items.push(
        tocItem(
          app,
          { id: s.id },
          title,
          { class: 'rr-toc-item', 'data-id': s.id, 'data-trail': s.id, title: `Jump to “${title}” (double-click to open it big)`, 'data-keys': 'n,p' },
          round && round !== '1' ? h('span', { class: 'rr-round-badge', title: `Added or changed in round ${round}` }, 'R' + round) : null,
          ...threadCounts(n, 'in this section'),
        ),
      );
      // sub-sections and h3s one level in, h4s a level further, each with its trail: the ids from the section down to it
      let parent = '';
      s.querySelectorAll(':scope section[id], :scope h3[id], :scope h4[id]').forEach((sub) => {
        const deep = sub.tagName === 'H4';
        if (!deep) parent = sub.id;
        const trail = [s.id, deep && parent ? parent : '', sub.id].filter(Boolean).join(' ');
        items.push(tocItem(app, { id: sub.id }, app.docTitle(sub.id) ?? sub.id, { class: 'rr-toc-item rr-toc-item--sub' + (deep ? ' rr-toc-item--deep' : ''), 'data-id': sub.id, 'data-trail': trail }));
      });
    });
    if (!items.length) items.push(h('div', { class: 'rr-empty' }, 'This review has no sections.'));
    // the PR description's own headings (its ids are stripped, so they are addressed by path)
    const heads = [...app.descDoc.querySelectorAll('h1, h2, h3, h4')].map((el) => {
      const at = { id: PR_DESCRIPTION, path: cssPathWithin(app.descDoc, el) };
      const title = el.textContent?.trim() || 'Heading';
      return tocItem(app, at, title, { class: 'rr-toc-item' + (/^H[34]$/.test(el.tagName) ? ' rr-toc-item--sub' : ''), title: `Jump to “${title}” in the PR description (double-click to open it big)` });
    });
    const pins = app.state.pins;
    this.body.replaceChildren(
      ...([
      // pinned first, at the top without a heading: what the reviewer chose to keep at hand
      ...pins.map((ref) => {
        return h(
          'div',
          { class: 'rr-toc-item rr-toc-item--pin' },
          // unpins on a double-click (one stray click shouldn't), or Enter/Space from the keyboard (detail 0)
          h('button', { class: 'rr-pin-btn', 'aria-label': 'Unpin', title: 'Double-click to unpin', onclick: (e: MouseEvent) => e.detail === 0 && app.togglePin(ref), ondblclick: () => app.togglePin(ref) }, icon('pin', 12)),
          h('button', { class: 'rr-toc-item__title', title: 'Open (double-click to open it big)', onclick: () => app.open(ref), ondblclick: () => openCentered(app, ref) }, app.label(ref)),
        );
      }),
      heads.length ? h('div', { class: 'rr-group-label' }, 'Description') : null,
      ...heads,
      h('div', { class: 'rr-group-label' }, 'Walkthrough'),
      ...items,
      ].filter(Boolean) as HTMLElement[]),
    );
    this.mark();
  }

  /** Where the reader is: the leaf underlined, it and the headings above it bold, and the guides of its section (and of
   *  its h3, for an h4) firmer (toc.css). */
  private mark() {
    const rows = [...this.body.querySelectorAll<HTMLElement>('.rr-toc-item[data-trail]')];
    const trail = rows.find((r) => r.dataset.id === this.active)?.dataset.trail?.split(' ') ?? [];
    for (const r of rows) {
      const t = r.dataset.trail!.split(' ');
      r.classList.toggle('is-active', r.dataset.id === this.active);
      r.classList.toggle('is-trail', trail.includes(r.dataset.id!));
      r.classList.toggle('is-in', t.length > 1 && t[0] === trail[0]);
      r.classList.toggle('is-in-deep', t.length > 2 && t[1] === trail[1]);
    }
  }
  dispose() {
    this.offs.forEach((f) => f());
  }
}

definePanel({ id: 'toc', title: 'Contents', icon: 'toc', create: (app) => new TocPanel(app) });
