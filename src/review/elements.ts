// Author-facing custom elements. All optional: plain HTML works, these just save
// the agent from rebuilding common review widgets. Light DOM throughout so the
// author's own CSS can style them.
//
//   <rr-ref ref="rr:code/pkg/x.go#L45-54"></rr-ref>             inline jump chip, labelled automatically when empty (hover = preview)
//   <rr-embed ref="rr:doc/request-path"></rr-embed>              mini preview card of anything linkable
//   <rr-code ref="rr:code/pkg/x.go@head#L40-60"></rr-code>        highlighted snippet pulled live from the repo
//   <rr-code lang="sql">SELECT ...</rr-code>                        highlighted inline snippet
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
const previewFailed = (el: HTMLElement, error: unknown) => console.error(`${el.localName}: the preview could not be rendered: ${error instanceof Error ? error.message : String(error)}`);

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
    this.setAttribute('aria-busy', 'true');
    let pending = 0;
    const paint = async (app: ReviewApp) => {
      pending++;
      this.setAttribute('aria-busy', 'true');
      try {
        if (!caption && r) head.querySelector('.rr-embed__title')!.textContent = app.label(ref);
        body.replaceChildren(await renderPreview(app, ref));
      } catch (e) {
        previewFailed(this, e); // report before readiness clears; the audit must not miss a deferred rejection event
      } finally {
        if (--pending === 0) this.setAttribute('aria-busy', 'false');
      }
    };
    if (r?.type === 'thread') this.follow = (app) => { this.off?.(); this.off = app.bus.on('state', () => paint(app)); };
    withApp((app) => { void paint(app); this.follow?.(app); });
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
    this.setAttribute('aria-busy', 'true');
    withApp(async (app) => {
      try {
        if (gen !== this.gen) return; // left the page before the app was ready (boot detaches the walkthrough)
        let contents = inline.replace(/^\n/, '').replace(/\s+$/, '');
        let name = `snippet.${lang || 'txt'}`;
        let headLabel = title || lang || '';
        let renderRange: ReturnType<typeof range> | undefined;
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
        await new Promise<void>((resolve) => {
          this.file = new PierreFile({ ...codeOptions(), onPostRender: (_node, _file, phase) => { if (phase !== 'unmount') resolve(); } });
          this.file.render({ file: { name, contents, lang }, containerWrapper: body, renderRange });
        });
      } catch (e) {
        if (gen === this.gen) previewFailed(this, e);
      } finally {
        if (gen === this.gen) this.setAttribute('aria-busy', 'false');
      }
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
/** A linked node's label gets a drawn underline per line (diagrams.css styles it like a link's in the text): SVG text
 *  takes no underline colour or thickness. A label not laid out (in a closed <details>) has no box and goes without. */
function underlineLinks(diagram: HTMLElement) {
  for (const text of diagram.querySelectorAll<SVGTextElement>('svg a > text.pele-label')) {
    const lines = text.querySelectorAll<SVGTSpanElement>('tspan');
    for (const line of lines.length ? lines : [text]) {
      const box = line.getBBox();
      if (!box.width) continue;
      const rule = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      rule.classList.add('rr-mermaid__underline');
      for (const [k, v] of Object.entries({ x1: box.x, x2: box.x + box.width, y1: box.y + box.height, y2: box.y + box.height })) rule.setAttribute(k, String(v));
      text.after(rule);
    }
  }
}

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
    const sourceView = h('details', { class: 'rr-mermaid__source' }, h('summary', null, 'Diagram source'), h('pre', null, h('code', null, source)));
    const max = this.hasAttribute('data-max');
    // the walkthrough's diagrams (not the guided walkthrough's) open full screen, for one too big to read in the column
    const expand = !max && this.closest('rr-review') && h('button', { class: 'rr-icon-btn rr-mermaid__expand', title: 'Expand diagram', 'aria-label': 'Expand diagram', onclick: () => maximizeDiagram(this, source) }, icon('maximize', 16));
    this.replaceChildren(diagram, expand ? h('div', { class: 'rr-mermaid__foot' }, sourceView, expand) : sourceView);
    void import('./markdown/diagram').then(async ({ mountDiagram }) => {
      if (generation !== this.generation || !this.isConnected) return;
      // every render, redraws for a new width too (they replace the nodes): the guided walkthrough relights them
      // where the presentation asks (a phone), the walkthrough's diagrams keep their layout, fit to the width, and zoom:
      // a phone-wide layout wraps every label
      const natural = max || !!this.closest('[data-rr-diagram-fit="width"] rr-review');
      const mounted = await mountDiagram(diagram, source, () => { underlineLinks(diagram); this.dispatchEvent(new Event('rr-mermaid:ready', { bubbles: true })); }, natural, max);
      if (generation !== this.generation || !this.isConnected) { mounted.destroy(); return; }
      this.mounted = mounted;
      diagram.setAttribute('aria-busy', 'false');
      if (mounted.error) this.failed(mounted.error); // Pele draws its own error message in place of the diagram
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
  /** Audit at the current width without waiting for Pele's ResizeObserver -> animation-frame redraw. */
  refreshForAudit() {
    this.mounted?.refresh();
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

/** Ready diagrams may have moved from the player's hidden preload stash to its visible narration. */
export function refreshDiagrams(root: HTMLElement) {
  for (const el of root.querySelectorAll('rr-mermaid')) if (el instanceof RRMermaid) el.refreshForAudit();
}

/** The diagram alone in a full-screen dialog, at its own layout, zoomable. Escape, Close or (phone) Back closes it; so does
 *  following one of its rr: links, which then opens the code. */
function maximizeDiagram(from: HTMLElement, source: string) {
  const copy = h('rr-mermaid', { class: from.className, 'data-max': '', 'data-src': source });
  const box = h(
    'dialog',
    { class: 'rr-modal rr-mermaid-max', 'aria-label': 'Diagram', onclose: () => box.remove() },
    h('header', { class: 'rr-thread__head' }, h('strong', null, 'Diagram'), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Close', title: 'Close', onclick: () => box.close() }, icon('close', 16))),
    h('div', { class: 'rr-mermaid-max__body' }, copy),
  );
  box.addEventListener('click', (e) => e.target instanceof Element && e.target.closest('a[href^="rr:"]') && box.close(), true);
  document.body.append(box);
  box.showModal();
  box.focus(); // the dialog, not its Close button: no ring on open
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
  def('rr-callout', RRCallout);
  def('rr-check', RRCheck);
  def('rr-markdown', RRMarkdown);
  def('rr-mermaid', RRMermaid);
}
