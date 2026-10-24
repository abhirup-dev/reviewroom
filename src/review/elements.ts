// Author-facing custom elements. All optional: plain HTML works, these just save
// the agent from rebuilding common review widgets. Light DOM throughout so the
// author's own CSS can style them.
//
//   <rr-ref ref="rr:code/pkg/x.go#L45-54"></rr-ref>             inline jump chip, labelled automatically when empty (hover = preview)
//   <rr-embed ref="rr:doc/request-path"></rr-embed>              mini preview card of anything linkable
//   <rr-code ref="rr:code/pkg/x.go@head#L40-60"></rr-code>        highlighted snippet pulled live from the repo
//   <rr-code lang="sql">SELECT ...</rr-code>                        highlighted inline snippet
//   <rr-flow><rr-node ref="..." state="new">habit.RecentEvents</rr-node>...</rr-flow>   left->right flow, clickable nodes
//   <rr-callout kind="risk" title="Latency">...</rr-callout>       info | note | risk | question | ok
//   <rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  reviewer sign-off, persisted
import { File as PierreFile } from '@pierre/diffs';
import { h, icon } from '../kernel/dom';
import { refIcon, refLabel } from '../kernel/refs/browser';
import { renderMarkdown } from '../kernel/markdown';
import type { ReviewApp } from '../app';
import { codeOptions, range, renderPreview } from './previews';
import { parseRef } from '../kernel/refs/refs.shared';

let APP: ReviewApp | null = null;
const waiters: ((a: ReviewApp) => void)[] = [];
export function provideApp(app: ReviewApp) {
  APP = app;
  app.onDispose(() => { if (APP === app) APP = null; });
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
    if (!this.textContent?.trim() && r) withApp((app) => (this.textContent = app.label(ref)));
    if (r) this.prepend(h('span', { class: 'rr-chip__icon', 'aria-hidden': 'true' }, refIcon(r)));
    this.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      withApp((app) => app.open(ref));
    });
    this.addEventListener('keydown', (e) => e.key === 'Enter' && this.click());
  }
}

class RREmbed extends HTMLElement {
  private off?: () => void;
  private follow?: (app: ReviewApp) => void;
  connectedCallback() {
    // a thread card follows its thread: GitHub threads arrive after the page does, and replies keep coming
    withApp((app) => this.follow?.(app));
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    this.dataset.src = '';
    const ref = this.getAttribute('ref') || '';
    const r = parseRef(ref);
    const caption = this.getAttribute('caption');
    // embeds inside embeds (a slide whose text embeds itself, a section embedding a slide that shows it) stop at a
    // link: the content can come from a PR
    let depth = 0;
    for (let p = this.parentElement?.closest('rr-embed'); p; p = p.parentElement?.closest('rr-embed')) depth++;
    if (depth >= 2) {
      this.replaceChildren(h('a', { href: ref }, caption || ref));
      withApp((app) => !caption && (this.firstElementChild!.textContent = app.label(ref)));
      return;
    }
    const body = h('div', { class: 'rr-embed__body' }, h('div', { class: 'rr-skeleton' }));
    const head = h(
      'button',
      { class: 'rr-embed__head', title: 'Open the original', onclick: () => withApp((a) => a.open(ref)) },
      h('span', { class: 'rr-chip__icon' }, r ? refIcon(r) : '?'),
      h('span', { class: 'rr-embed__title' }, caption || ''),
      h('span', { class: 'rr-embed__open', 'aria-hidden': 'true' }, icon('popout', 14)),
    );
    this.replaceChildren(head, body);
    this.classList.add('rr-embed');
    const paint = async (app: ReviewApp) => {
      if (!caption && r) head.querySelector('.rr-embed__title')!.textContent = app.label(ref);
      body.replaceChildren(await renderPreview(app, ref));
    };
    if (r?.type === 'thread') this.follow = (app) => (this.off?.(), (this.off = app.bus.on('state', () => paint(app))));
    withApp((app) => (paint(app), this.follow?.(app)));
  }
  disconnectedCallback() {
    this.off?.();
    this.off = undefined;
  }
}

// ------------------------------------------------------------------ rr-code
class RRCode extends HTMLElement {
  private file?: InstanceType<typeof PierreFile>;
  private gen = 0;
  connectedCallback() {
    if (this.dataset.ready) return; // re-attached (panel reopened or moved)
    this.dataset.ready = '1';
    const ref = this.getAttribute('ref');
    const inline = this.textContent || '';
    const lang = this.getAttribute('lang') || undefined;
    const title = this.getAttribute('title');
    this.dataset.src = inline;
    this.replaceChildren();
    this.classList.add('rr-code');
    const gen = ++this.gen;
    withApp(async (app) => {
      if (gen !== this.gen) return; // left the page before the app was ready (boot detaches the walkthrough)
      let contents = inline.replace(/^\n/, '').replace(/\s+$/, '');
      let name = `snippet.${lang || 'txt'}`;
      let headLabel = title || lang || '';
      let renderRange;
      const r = ref ? parseRef(ref) : null;
      if (r && (r.type === 'code' || r.type === 'file')) {
        contents = (await app.services.code.read(r.path, app.services.code.revOf(r.rev))) ?? '';
        if (gen !== this.gen) return; // left the page while reading
        name = r.path;
        // the whole file, drawn from start to end with its real line numbers
        if (r.start) renderRange = range(r.start, r.end ?? contents.split('\n').length);
        headLabel = (title ? title + ' · ' : '') + refLabel(r);
      }
      const head = h(
        'div',
        { class: 'rr-code__head' },
        h('span', null, headLabel),
        ref ? h('button', { class: 'rr-icon-btn', title: 'Open in the code panel', 'aria-label': 'Open in the code panel', onclick: () => app.open(ref) }, icon('popout', 14)) : null,
      );
      const body = h('div', { class: 'rr-code__body' });
      this.append(head, body);
      this.file = new PierreFile(codeOptions('--rr-panel-2'));
      this.file.render({ file: { name, contents, lang }, containerWrapper: body, renderRange });
    });
  }
  disconnectedCallback() {
    // moved (a panel dragged) is back by the next microtask; gone for good, release pierre and start over if re-added
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.gen++;
      this.file?.cleanUp();
      this.file = undefined;
      this.replaceChildren(this.dataset.src ?? '');
      delete this.dataset.ready;
    });
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
    if (state) this.append(h('span', { class: 'rr-node__badge', title: { new: 'Added in this PR', changed: 'Changed in this PR', removed: 'Removed in this PR', baseline: 'Already existed before this PR' }[state] ?? state }, state));
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
  private bus?: ReviewApp['bus'];
  private repaint?: () => void;
  connectedCallback() {
    if (this.dataset.ready) return this.listen(); // re-attached (panel reopened or moved)
    this.dataset.ready = '1';
    const id = this.id || (this.textContent || '').trim().slice(0, 40);
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
      this.bus = app.bus;
      this.repaint = () => paint(app);
      this.listen();
      btn.addEventListener('click', () => {
        const cur = app.state.checks?.[id] ?? authored;
        const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
        app.apply({ op: 'setCheck', id, value: next });
      });
    });
  }
  private listen() {
    if (!this.bus || !this.repaint || this.off) return;
    this.repaint(); // catch up on changes made while detached
    this.off = this.bus.on('state', this.repaint);
  }
  disconnectedCallback() {
    this.off?.();
    this.off = undefined;
  }
}

// ------------------------------------------------------------------ rr-mermaid
class RRMermaid extends HTMLElement {
  private generation = 0;
  private mounted?: Awaited<ReturnType<typeof import('./markdown/diagram').mountDiagram>>;
  constructor() {
    super();
    // a `click N "rr:…"` statement opens the code like any rr: link
    this.addEventListener('click', (e) => {
      const ref = (e.target instanceof Element ? e.target.closest('a') : null)?.getAttribute('href');
      if (!ref?.startsWith('rr:')) return;
      e.preventDefault();
      e.stopPropagation();
      withApp((a) => a.open(ref));
    });
  }
  connectedCallback() {
    if (this.mounted) return;
    const generation = ++this.generation;
    const source = (this.dataset.src ?? this.textContent ?? '').trim(); // indented authoring leaves a blank last line some types reject
    this.dataset.src = source;
    const diagram = h('div', { class: 'rr-mermaid__diagram', role: 'img', 'aria-label': 'Mermaid diagram', 'aria-busy': 'true' });
    const status = h('div', { class: 'rr-muted', role: 'status' }, 'Rendering diagram…');
    diagram.append(status);
    this.replaceChildren(diagram, h('details', { class: 'rr-mermaid__source' }, h('summary', null, 'Diagram source'), h('pre', null, h('code', null, source))));
    void import('./markdown/diagram').then(async ({ mountDiagram }) => {
      if (generation !== this.generation || !this.isConnected) return;
      const mounted = await mountDiagram(diagram, source);
      if (generation !== this.generation || !this.isConnected) { mounted.destroy(); return; }
      this.mounted = mounted;
      diagram.setAttribute('aria-busy', 'false');
      if (mounted.error) this.failed(mounted.error); // Pele draws its own error message in place of the diagram
      this.dispatchEvent(new Event('rr-mermaid:ready', { bubbles: true })); // the guided walkthrough lights its nodes
    }).catch((e) => {
      if (generation !== this.generation) return;
      this.failed(e);
      diagram.replaceChildren(h('div', { class: 'rr-muted', role: 'status' }, 'Diagram could not be rendered. Expand Diagram source to inspect it.'));
      diagram.setAttribute('aria-busy', 'false');
    });
  }
  /** A console error, so `reviewroom shot` and `slide-lint` report the broken diagram (the reviewer sees it broken too). */
  private failed(e: unknown) {
    console.error(`rr-mermaid${this.id ? '#' + this.id : ''}: the diagram could not be rendered: ${e instanceof Error ? e.message : String(e)}`);
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.generation++;
      this.mounted?.destroy();
      this.mounted = undefined;
    });
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
  def('rr-mermaid', RRMermaid);
}
