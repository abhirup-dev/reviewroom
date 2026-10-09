// Author-facing custom elements. All optional: plain HTML works, these just save
// the agent from rebuilding common review widgets. Light DOM throughout so the
// author's own CSS can style them.
//
//   <rr-ref ref="rr:code/pkg/x.go#L45-54">Build()</rr-ref>      inline jump chip (hover = preview)
//   <rr-embed ref="rr:doc/request-path"></rr-embed>              mini preview card of anything linkable
//   <rr-code ref="rr:code/pkg/x.go@head#L40-60"></rr-code>        highlighted snippet pulled live from the repo
//   <rr-code lang="sql">SELECT …</rr-code>                        highlighted inline snippet
//   <rr-flow><rr-node ref="…" state="new">habit.RecentEvents</rr-node>…</rr-flow>   left→right flow, clickable nodes
//   <rr-callout kind="risk" title="Latency">…</rr-callout>       info | note | risk | question | ok
//   <rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  reviewer sign-off, persisted
import { File as PierreFile } from '@pierre/diffs';
import { h, icon } from '../core/dom';
import { parseRef, refIcon, refLabel, type Ref } from '../core/refs';
import { plainExcerpt, renderMarkdown } from '../core/markdown';
import type { ReviewApp } from '../shell/app';
import { findDocElement } from '../panels/narrative';
import { PIERRE_CSS } from '../panels/code';

let APP: ReviewApp | null = null;
const waiters: ((a: ReviewApp) => void)[] = [];
export function provideApp(app: ReviewApp) {
  APP = app;
  waiters.splice(0).forEach((w) => w(app));
}
const withApp = (fn: (a: ReviewApp) => void) => (APP ? fn(APP) : waiters.push(fn));

// ------------------------------------------------------------------ rr-ref
class RRRef extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    const ref = this.getAttribute('ref') || '';
    const r = parseRef(ref);
    this.setAttribute('role', 'link');
    this.tabIndex = 0;
    this.classList.add('rr-chip');
    if (r) this.dataset.kind = r.type;
    if (!this.textContent?.trim() && r) withApp((app) => (this.textContent = refLabel(r, app.docTitle)));
    if (r) this.prepend(h('span', { class: 'rr-chip__icon', 'aria-hidden': 'true' }, refIcon(r)));
    this.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      withApp((app) => app.open(ref));
    });
    this.addEventListener('keydown', (e) => e.key === 'Enter' && this.click());
  }
}

// ------------------------------------------------------------------ snippets
async function snippet(app: ReviewApp, r: Extract<Ref, { type: 'code' | 'file' }>, context = 2, highlight = true): Promise<HTMLElement> {
  const rev = r.rev === 'base' ? app.range.base : r.rev === 'head' ? app.range.head : r.rev;
  const text = await app.read(r.path, rev);
  if (text === null) return h('div', { class: 'rr-empty' }, `${r.path} not found at ${r.rev}`);
  const lines = text.split('\n');
  const s = Math.max(1, (r.start ?? 1) - (r.start ? context : 0));
  const e = Math.min(lines.length, r.end ? r.end + context : Math.min(lines.length, s + 24));
  const pre = h('pre', { class: 'rr-snippet' });
  for (let i = s; i <= e; i++) {
    const on = highlight && r.start && i >= r.start && i <= (r.end ?? r.start);
    pre.append(h('span', { class: 'rr-snippet__line' + (on ? ' is-target' : '') }, h('span', { class: 'rr-snippet__ln' }, String(i)), h('span', { class: 'rr-snippet__code' }, lines[i - 1] || ' ')));
  }
  return pre;
}

export async function renderPreview(app: ReviewApp, ref: string, opts: { compact?: boolean } = {}): Promise<HTMLElement> {
  const r = parseRef(ref);
  if (!r) return h('div', { class: 'rr-empty' }, 'Bad link ' + ref);
  switch (r.type) {
    case 'doc': {
      const el = app.doc && findDocElement(app.doc, r.id, r.path);
      if (!el) return h('div', { class: 'rr-empty' }, `§ ${r.id} not found`);
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      clone.removeAttribute('id');
      clone.querySelectorAll('script').forEach((n) => n.remove());
      // widgets that render into shadow DOM don't survive cloneNode: re-run them from source
      clone.querySelectorAll('rr-code, rr-embed').forEach((n) => {
        const el = n as HTMLElement;
        if (el.dataset.src === undefined) return;
        delete el.dataset.ready;
        el.replaceChildren(el.dataset.src);
      });
      if (clone.matches('rr-code, rr-embed') && clone.dataset.src !== undefined) {
        delete clone.dataset.ready;
        clone.replaceChildren(clone.dataset.src);
      }
      return h('div', { class: 'rr-embed__doc rr-prose' }, clone);
    }
    case 'code':
    case 'file':
      return snippet(app, r, opts.compact ? 1 : 2);
    case 'sym': {
      const hits = await app.search(r.name, true);
      const d = hits.find((x) => x.kind === 'definition') ?? hits[0];
      if (!d) return h('div', { class: 'rr-empty' }, `No definition of ${r.name}`);
      return h('div', null, h('div', { class: 'rr-embed__sub' }, `${d.path}:${d.line}`), await snippet(app, { type: 'file', path: d.path, rev: d.rev, start: d.line, end: d.line }, 3));
    }
    case 'thread': {
      const t = app.thread(r.id);
      if (!t) return h('div', { class: 'rr-empty' }, 'Thread not found');
      return h(
        'div',
        { class: 'rr-embed__thread' },
        ...t.messages.slice(-2).map((m) => h('div', { class: 'rr-embed__msg' }, h('strong', null, m.author === 'agent' ? 'agent' : 'you'), ' ', plainExcerpt(m.body, 160))),
      );
    }
    case 'round':
      return h('div', null, `Round ${r.n}`);
  }
}

class RREmbed extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    this.dataset.src = '';
    const ref = this.getAttribute('ref') || '';
    const r = parseRef(ref);
    const caption = this.getAttribute('caption');
    const body = h('div', { class: 'rr-embed__body' }, h('div', { class: 'rr-skeleton' }));
    const head = h(
      'button',
      { class: 'rr-embed__head', title: 'Open', onclick: () => withApp((a) => a.open(ref)) },
      h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '?'),
      h('span', { class: 'rr-embed__title' }, caption || ''),
      h('span', { class: 'rr-embed__open' }, 'open', icon('chevron', 12)),
    );
    this.replaceChildren(head, body);
    this.classList.add('rr-embed');
    withApp(async (app) => {
      if (!caption && r) head.querySelector('.rr-embed__title')!.textContent = refLabel(r, app.docTitle);
      body.replaceChildren(await renderPreview(app, ref));
    });
  }
}

// ------------------------------------------------------------------ rr-code
class RRCode extends HTMLElement {
  private inst?: PierreFile;
  private off?: () => void;
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    const ref = this.getAttribute('ref');
    const inline = this.textContent || '';
    const lang = this.getAttribute('lang') || undefined;
    const title = this.getAttribute('title');
    this.dataset.src = inline;
    this.replaceChildren();
    this.classList.add('rr-code');
    withApp(async (app) => {
      let contents = inline.replace(/^\n/, '').replace(/\s+$/, '');
      let name = `snippet.${lang || 'txt'}`;
      let headLabel = title || lang || '';
      let ranged = false;
      const r = ref ? parseRef(ref) : null;
      if (r && (r.type === 'code' || r.type === 'file')) {
        const rev = r.rev === 'base' ? app.range.base : r.rev === 'head' ? app.range.head : r.rev;
        const text = (await app.read(r.path, rev)) ?? '';
        const lines = text.split('\n');
        contents = lines.slice((r.start ?? 1) - 1, r.end ?? lines.length).join('\n');
        name = r.path;
        ranged = !!r.start;
        headLabel = (title ? title + ' · ' : '') + refLabel(r);
      }
      const head = h(
        'div',
        { class: 'rr-code__head' },
        h('span', null, headLabel),
        ref ? h('button', { class: 'rr-link-btn', onclick: () => app.open(ref) }, 'open in diff', icon('chevron', 12)) : null,
      );
      const body = h('div', { class: 'rr-code__body' });
      this.append(head, body);
      this.inst = new PierreFile({ theme: { dark: 'pierre-dark', light: 'pierre-light' }, themeType: app.resolvedTheme(), disableFileHeader: true, overflow: 'scroll', disableLineNumbers: ranged, unsafeCSS: PIERRE_CSS.replace(/var\(--rr-panel\)/g, 'var(--rr-panel-2)') });
      this.inst.render({ file: { name, contents, lang: lang as any }, containerWrapper: body });
      this.off = app.bus.on('theme', (t) => this.inst?.setThemeType(t));
    });
  }
  disconnectedCallback() {
    this.off?.();
  }
}

// ------------------------------------------------------------------ rr-flow
class RRFlow extends HTMLElement {
  connectedCallback() {
    this.classList.add('rr-flow');
    this.setAttribute('role', 'list');
  }
}
class RRNode extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    this.setAttribute('role', 'listitem');
    const ref = this.getAttribute('ref');
    const state = this.getAttribute('state');
    if (state && state !== 'same') this.append(h('span', { class: 'rr-node__badge' }, state));
    if (ref) {
      this.tabIndex = 0;
      this.classList.add('is-link');
      this.addEventListener('click', () => withApp((a) => a.open(ref)));
      this.addEventListener('keydown', (e) => e.key === 'Enter' && withApp((a) => a.open(ref)));
    }
  }
}

// ------------------------------------------------------------------ rr-callout
class RRCallout extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    const kind = this.getAttribute('kind') || 'note';
    const title = this.getAttribute('title');
    this.classList.add('rr-callout', `rr-callout--${kind}`);
    this.prepend(h('div', { class: 'rr-callout__label' }, title || kind));
  }
}

// ------------------------------------------------------------------ rr-checklist
const CYCLE = ['todo', 'pass', 'fail'] as const;
class RRCheck extends HTMLElement {
  private off?: () => void;
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    const id = this.id || this.getAttribute('key') || (this.textContent || '').trim().slice(0, 40);
    const authored = (this.getAttribute('state') as (typeof CYCLE)[number]) || 'todo';
    const btn = h('button', { class: 'rr-check__box', 'aria-label': 'Change sign-off state' });
    this.prepend(btn);
    const paint = (app: ReviewApp) => {
      const st = app.state.checks?.[id] ?? authored;
      this.dataset.state = st;
      btn.replaceChildren(st === 'pass' ? icon('check', 12) : st === 'fail' ? icon('close', 12) : '');
      btn.title = { todo: 'Not checked', pass: 'Signed off', fail: 'Needs work' }[st];
    };
    withApp((app) => {
      paint(app);
      this.off = app.bus.on('state', () => paint(app));
      btn.addEventListener('click', () => {
        const cur = app.state.checks?.[id] ?? authored;
        const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
        app.update((s) => (s.checks = { ...(s.checks ?? {}), [id]: next }));
      });
    });
  }
  disconnectedCallback() {
    this.off?.();
  }
}

// ------------------------------------------------------------------ rr-markdown (author convenience)
class RRMarkdown extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    this.innerHTML = renderMarkdown(this.textContent || '');
    this.classList.add('rr-prose');
  }
}

export function defineElements() {
  const def = (n: string, c: CustomElementConstructor) => customElements.get(n) || customElements.define(n, c);
  def('rr-ref', RRRef);
  def('rr-embed', RREmbed);
  def('rr-code', RRCode);
  def('rr-flow', RRFlow);
  def('rr-node', RRNode);
  def('rr-callout', RRCallout);
  def('rr-check', RRCheck);
  def('rr-markdown', RRMarkdown);
}
