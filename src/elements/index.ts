// Author-facing custom elements. All optional: plain HTML works, these just save
// the agent from rebuilding common review widgets. Light DOM throughout so the
// author's own CSS can style them.
//
//   <rr-ref ref="rr:code/pkg/x.go#L45-54">Build()</rr-ref>      inline jump chip (hover = preview)
//   <rr-embed ref="rr:doc/request-path"></rr-embed>              mini preview card of anything linkable
//   <rr-code ref="rr:code/pkg/x.go@head#L40-60"></rr-code>        highlighted snippet pulled live from the repo
//   <rr-code lang="sql">SELECT ...</rr-code>                        highlighted inline snippet
//   <rr-flow><rr-node ref="..." state="new">habit.RecentEvents</rr-node>...</rr-flow>   left->right flow, clickable nodes
//   <rr-callout kind="risk" title="Latency">...</rr-callout>       info | note | risk | question | ok
//   <rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  reviewer sign-off, persisted
import { FileDiff, File as PierreFile, parseDiffFromFile } from '@pierre/diffs';
import { h, icon } from '../core/dom';
import { parseRef, refIcon, refLabel, type Ref } from '../core/refs';
import { plainExcerpt, renderMarkdown, sanitizeProse } from '../core/markdown';
import { stepRefs } from '../shared/walkthrough';
import type { ReviewApp } from '../shell/app';
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

// ------------------------------------------------------------------ snippets
/** @pierre/diffs options for code in the review: our colours on `surface`, light/dark following the page. */
function codeOptions(surface = '--rr-panel') {
  return {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: 'system' as const,
    disableFileHeader: true,
    overflow: 'scroll' as const,
    // inherit the page's color-scheme (tokens.css) so pierre's light-dark() colours follow the review theme; --rr-wrap: hover card's wrap toggle
    unsafeCSS: PIERRE_CSS.replace(/var\(--rr-panel\)/g, `var(${surface})`) + ':host{color-scheme:inherit}[data-line]{white-space:var(--rr-wrap,pre);word-break:break-word}',
  };
}
// pierre holds every instance in a static resize map until cleanUp(): release the previews that have left the page
const live = new Map<HTMLElement, [{ cleanUp(): void }, number]>();
const track = (box: HTMLElement, inst: { cleanUp(): void }) => {
  for (const [b, [i, t]] of live) {
    if (b.isConnected || Date.now() - t < 5000) continue;
    i.cleanUp();
    live.delete(b);
  }
  live.set(box, [inst, Date.now()]);
};
const range = (start: number, end: number) => ({ startingLine: start - 1, totalLines: end - start + 1, bufferBefore: 0, bufferAfter: 0 });

async function snippet(app: ReviewApp, r: Extract<Ref, { type: 'code' | 'file' }>, context = 2, opts: { endAt?: number } = {}): Promise<HTMLElement> {
  const rev = app.revOf(r.rev);
  const text = await app.read(r.path, rev);
  if (text === null) return h('div', { class: 'rr-empty' }, `${r.path.split('/').pop()} isn't in this version`);
  const box = h('div', { class: 'rr-snippet' });
  // a changed file without lines: its hunks
  const diff = !r.start && r.type === 'code' && r.rev === 'head' ? await changedDiff(app, r.path, text) : null;
  if (diff?.hunks.length) {
    const fd = new FileDiff({ ...codeOptions(), diffStyle: 'unified', hunkSeparators: 'simple' });
    fd.render({ fileDiff: diff, containerWrapper: box });
    track(box, fd);
    return box;
  }
  const lines = text.split('\n').length;
  const file = new PierreFile(codeOptions());
  const [s, e] = r.start ? [Math.max(1, r.start - context), Math.min(lines, (opts.endAt ?? r.end ?? r.start) + context)] : [1, Math.min(lines, 25)];
  file.render({ file: { name: r.path, contents: text }, containerWrapper: box, renderRange: range(s, e) });
  track(box, file);
  if (r.start) file.setSelectedLines({ start: r.start, end: r.end ?? r.start }, { notify: false });
  return box;
}

/** The diff of a changed file against the base. */
async function changedDiff(app: ReviewApp, path: string, head: string) {
  const f = app.files.find((x) => x.path === path);
  if (!f || (f.status !== 'modified' && f.status !== 'renamed')) return null;
  const base = await app.read(f.prevPath ?? path, app.revFor('base'));
  if (base === null) return null;
  return parseDiffFromFile({ name: f.prevPath ?? path, contents: base }, { name: path, contents: head });
}

// shortcut: bracket/indent heuristic, not a parser (braces in strings can end it early); swap for a provider symbol range if that lands.
/** Last line of the declaration starting at `start`: to its closing bracket, or through its indented body. */
function declEnd(lines: string[], start: number, max = 40): number {
  const last = Math.min(lines.length, start + max - 1);
  const indent = (s: string) => s.length - s.trimStart().length;
  let depth = 0;
  let opened = false;
  for (let i = start; i <= last; i++) {
    for (const c of lines[i - 1]) {
      if (c === '{' || c === '(' || c === '[') {
        depth++;
        opened = true;
      } else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (i === start && depth <= 0) break; // one-liner or indent-scoped (Python, YAML): fall through
    if (opened && depth <= 0) return i;
  }
  let end = start;
  for (let i = start + 1; i <= last; i++) {
    if (!lines[i - 1].trim()) continue;
    if (indent(lines[i - 1]) <= indent(lines[start - 1])) break;
    end = i;
  }
  return end;
}

export async function renderPreview(app: ReviewApp, ref: string, opts: { compact?: boolean } = {}): Promise<HTMLElement> {
  const r = parseRef(ref);
  if (!r) return h('div', { class: 'rr-empty' }, 'This link is broken');
  switch (r.type) {
    case 'doc': {
      const el = app.docElement(r.id, r.path);
      if (!el) return h('div', { class: 'rr-empty' }, 'This part of the review no longer exists');
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
      const text = await app.read(d.path, d.rev);
      const endAt = text === null ? d.line : declEnd(text.split('\n'), d.line);
      return h('div', null, h('div', { class: 'rr-embed__sub' }, `${d.path}:${d.line}`), await snippet(app, { type: 'file', path: d.path, rev: d.rev, start: d.line, end: d.line }, 1, { endAt }));
    }
    case 'thread': {
      const t = app.thread(r.id);
      if (!t) return h('div', { class: 'rr-empty' }, 'Thread not found');
      return h(
        'div',
        { class: 'rr-embed__thread' },
        // GitHub comments are a colleague's (or yours): their login and avatar, not "you"
        ...t.messages.slice(-2).map((m) =>
          h(
            'div',
            { class: 'rr-embed__msg' },
            m.gh?.avatar ? h('img', { class: 'rr-embed__avatar', src: m.gh.avatar + (m.gh.avatar.includes('?') ? '&' : '?') + 's=32', alt: '', loading: 'lazy' }) : null,
            h('strong', null, m.gh ? m.gh.login : m.author === 'agent' ? 'agent' : 'you'),
            ' ',
            plainExcerpt(m.body, 160),
          ),
        ),
      );
    }
    case 'round':
      return h('div', null, `Round ${r.n}`);
    case 'tour':
      return slide(app, r, opts);
  }
}

/** A walkthrough step as a card: where it is, its text, its code (compact: the links only), and a way to play the
 *  walkthrough from it. A narrative section that expands on a step embeds it like this. */
async function slide(app: ReviewApp, r: Extract<Ref, { type: 'tour' }>, opts: { compact?: boolean }) {
  // the page may not have loaded walkthrough.json yet
  const loaded = app.walkthrough ?? (await app.backend.walkthrough?.().catch(() => null));
  const w = loaded && 'version' in loaded ? loaded : null;
  const ch = w?.chapters.find((c) => c.id === r.chapter);
  const i = ch?.steps.findIndex((s) => s.id === r.step) ?? -1;
  if (!ch || i < 0) return h('div', { class: 'rr-empty' }, 'This guided walkthrough slide no longer exists');
  const step = ch.steps[i];
  const text = h('div', { class: 'rr-prose rr-slide__text' });
  text.innerHTML = sanitizeProse(step.text); // a walkthrough can come from a PR
  const refs = stepRefs(step);
  const code = opts.compact
    ? refs.length ? [h('div', { class: 'rr-slide__refs' }, ...refs.map((x) => h('span', { class: 'rr-slide__ref' }, refIcon(parseRef(x)!), app.label(x))))] : []
    : await Promise.all(refs.map((x) => renderPreview(app, x, { compact: true })));
  const title = 'Play the guided walkthrough from this slide';
  const play = h('button', {
    class: 'rr-icon-btn',
    title,
    'aria-label': title,
    onclick: (e: MouseEvent) => {
      // from inside a thread popup: the player opens under the page, not behind the modal
      (e.currentTarget as Element).closest('dialog')?.close();
      app.bus.emit('walkthrough-open', { chapter: r.chapter, step: r.step });
    },
  }, icon('play', 14));
  // the play button sits on top: an embed shows a preview's first lines only
  return h('div', { class: 'rr-slide' }, h('div', { class: 'rr-slide__where' }, h('span', null, `${ch.title} · slide ${i + 1} of ${ch.steps.length}`), play), text, ...code);
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
        contents = (await app.read(r.path, app.revOf(r.rev))) ?? '';
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
    if (state && state !== 'same') this.append(h('span', { class: 'rr-node__badge', title: { new: 'Added in this PR', changed: 'Changed in this PR', removed: 'Removed in this PR', baseline: 'Already existed before this PR' }[state] ?? state }, state));
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
