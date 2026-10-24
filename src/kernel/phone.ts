// Phone shell: the same panels as the dock, grouped into four areas along the bottom (Read, Code, Threads, Files).
// An area with several pages has tabs along its top and pages side by side in a horizontal scroll-snap pager: a
// sideways swipe follows the finger and snaps (native scrolling, so vertical scroll, text selection and long press
// keep working). On-demand panels (a thread, a code pop-out) open as a full-screen sheet over them with a back
// button. The dock.ts facade (useSurface) sends every panel request here when this shell is mounted, so the rest of
// the app doesn't know. What depends on features (which pages apply, the open thread count) comes in as options.
import { h, icon, onDrag } from './dom';
import type { AppEvents, ReviewApp } from '../app';
import { panelDefs, type PanelInstance, type PanelSurface } from './dock';
import { wantsPhone } from './device';
import { createActor, type ActorRefFrom } from 'xstate';
import { areaOf, front, peeking, shellMachine, type AreaId } from './shell.machine';
import { rising, type codeSheetMachine } from './codesheet.machine';
import { gestureMachine } from './gesture.machine';
import { onBack, watchBack } from './history';

type CodeTarget = AppEvents['reveal-code'];
export interface PhoneOptions {
  /** Whether a page applies to this review (no Last round, no CI: left out). */
  available(id: string): boolean;
  /** Open threads the Threads list shows by default: the Threads area's badge. */
  openThreads(): number;
}

/** A phone (see device.ts). Picked once at boot: the shell (and the prefs) never swap under the reviewer. */
let picked: boolean | undefined;
export const isPhone = () => (picked ??= wantsPhone());

type Open = { id: string; title: string; params?: Record<string, unknown>; host: HTMLElement; inst: PanelInstance };
type Page = { id: string; title: string; params?: Record<string, unknown> };
type Area = { id: AreaId; el: HTMLElement; strip: HTMLElement; ind: HTMLElement; pager: HTMLElement; pages: Page[]; sig: string };

const AREAS: { id: AreaId; title: string; icon: Parameters<typeof icon>[0] }[] = [
  { id: 'read', title: 'Read', icon: 'book' },
  { id: 'code', title: 'Code', icon: 'code' },
  { id: 'threads', title: 'Threads', icon: 'thread' },
  { id: 'files', title: 'Files', icon: 'files' },
];
/** reviewroom's own panels; any other (an agent's) is a page of Read, as it joins the narrative's tabs in the dock */
const OWN = ['narrative', 'description', 'recap', 'code', 'threads', 'files', 'toc', 'ci', 'thread', 'slot'];

/** Close a dialog as Esc would (its cancel handlers run), where the browser can. */
const dismiss = (d: HTMLDialogElement & { requestClose?(): void }) => (d.requestClose ? d.requestClose() : d.close());

export class PhoneShell implements PanelSurface {
  private open = new Map<string, Open>();
  private sheetIds = new Set<string>(); // mounted on-demand panels
  private areas = new Map<AreaId, Area>();
  private shell = createActor(shellMachine);
  private code!: ActorRefFrom<typeof codeSheetMachine>;
  private stage = h('div', { class: 'rr-phone-stage' });
  private nav = h('nav', { class: 'rr-phone-nav', 'aria-label': 'Areas' });
  private comment = h('button', { class: 'rr-btn rr-btn--primary rr-phone-comment', hidden: true, 'data-rr-keeps-selection': true });
  /** where the latest code link that peeks goes: once the peek is the Code area, it lands there again */
  private peekAt?: CodeTarget;
  private peekTitle = h('span', { class: 'rr-phone-peek-title' });
  private peekLines = h('span', { class: 'rr-phone-peek-lines' });
  /** history entries (see onBack) for the machine's stack, by key */
  private backs = new Map<number, () => void>();
  private dialogs = new Map<number, HTMLDialogElement>();

  constructor(
    private app: ReviewApp,
    host: HTMLElement,
    private opts: PhoneOptions,
  ) {
    host.classList.add('rr-phone');
    watchBack(app);
    this.shell.start();
    this.code = this.shell.getSnapshot().children.code as ActorRefFrom<typeof codeSheetMachine>;
    this.shell.subscribe(() => this.render());
    this.code.subscribe(() => this.render());
    app.onDispose(() => this.shell.stop());
    this.watchDialogs();
    // no c key on a phone: a selection (text in the narrative, lines in code) gets a button instead
    const comment = this.comment;
    comment.onclick = () => (app.commands.run('comment.selection'), (comment.hidden = true));
    comment.append(icon('chat', 14), 'Comment');
    app.bus.on('selection', (s) => this.shell.send({ type: 'selection', on: !!s }));
    // before the code panel hears it (it mounts below): lines to show from elsewhere peek, a whole file opens the area
    app.bus.on('reveal-code', (t) => {
      this.shell.send({ type: 'reveal', lines: !t.panel && !!t.start });
      if (!this.ctx().peekNext) return;
      this.peekAt = t;
      this.peekTitle.textContent = t.path.split('/').pop()!;
      this.peekLines.textContent = `${t.start}${t.end && t.end !== t.start ? '–' + t.end : ''}`;
    });
    for (const a of AREAS) {
      const strip = h('div', { class: 'rr-phone-toptabs', role: 'tablist' });
      const ind = h('span', { class: 'rr-phone-toptabs__ind', 'aria-hidden': 'true' });
      const pager = h('div', { class: 'rr-phone-pager' });
      const area: Area = { id: a.id, el: h('section', { class: 'rr-phone-area', 'data-area': a.id, 'aria-label': a.title }, strip, pager), strip, ind, pager, pages: [], sig: '' };
      // the page under the finger once the pager settles (a swipe, or a tap on a tab scrolling it); the indicator follows
      pager.addEventListener('scroll', () => (this.settle(area), this.slide(area)), { passive: true });
      this.areas.set(a.id, area);
      this.stage.append(area.el);
    }
    this.peekHead(this.areas.get('code')!.el);
    // a resized pager (rotation, the URL bar) keeps the page it was on
    const resized = new ResizeObserver(() => this.areas.forEach((a) => (this.scrollTo(a, this.ctx().page[a.id], 'instant'), this.slide(a))));
    resized.observe(this.stage);
    app.onDispose(() => resized.disconnect());
    host.append(this.stage, comment, this.nav);
    app.bus.on('state', () => this.paintBar());
    app.bus.on('prefs', () => this.paintNav());
    this.paintBar();
    this.show('narrative');
    app.escapers.push(() => (peeking(this.ctx()) || this.ctx().sheets.length ? (this.shell.send({ type: 'escape' }), true) : false));
  }

  private ctx = () => this.shell.getSnapshot().context;

  /** Every open dialog (the menu, search, a thread) is a layer Back closes. */
  private watchDialogs() {
    const ids = new Map<HTMLDialogElement, number>();
    let n = 0;
    const dialogs = new MutationObserver((ms) => {
      for (const { target: d } of ms) {
        if (!(d instanceof HTMLDialogElement)) continue;
        if (d.open && !ids.has(d)) {
          ids.set(d, ++n);
          this.dialogs.set(n, d);
          this.shell.send({ type: 'dialog', id: n, open: true });
        } else if (!d.open && ids.has(d)) {
          const id = ids.get(d)!;
          ids.delete(d);
          this.dialogs.delete(id);
          this.shell.send({ type: 'dialog', id, open: false });
        }
      }
    });
    dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    this.app.onDispose(() => dialogs.disconnect());
  }

  /** The peek's handle: drag it up past 70% of the screen for the Code area, down to close; or its two buttons. */
  private peekHead(code: HTMLElement) {
    const expand = h('button', { class: 'rr-icon-btn', 'aria-label': 'Open in Code', title: 'Open in the Code area', onclick: () => this.code.send({ type: 'expand' }) }, icon('maximize', 20));
    const close = h('button', { class: 'rr-icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.code.send({ type: 'close' }) }, icon('close', 20));
    const head = h(
      'div',
      { class: 'rr-phone-peek-head', title: 'Drag up to open in the Code area, down to close' },
      h('span', { class: 'rr-phone-peek-grip', 'aria-hidden': 'true' }),
      h('div', { class: 'rr-phone-peek-row' }, this.peekTitle, this.peekLines, h('span', { class: 'rr-toolbar__spacer' }), expand, close),
    );
    // the sheet follows once the touch goes up or down (gestureMachine), not sideways
    const touch = createActor(gestureMachine).start();
    this.app.onDispose(() => touch.stop());
    const vertical = () => touch.getSnapshot().matches('vertical');
    onDrag(head, {
      start: (e) => touch.send({ type: 'start', x: e.clientX, y: e.clientY }),
      move: (_, dy, e) => {
        const was = vertical();
        touch.send({ type: 'move', x: e.clientX, y: e.clientY });
        if (!vertical()) return;
        if (!was) this.code.send({ type: 'start', from: code.offsetHeight, max: this.stage.clientHeight });
        this.code.send({ type: 'move', dy });
      },
      end: (_, dy) => {
        if (vertical()) this.code.send({ type: 'end', dy });
        touch.send({ type: 'cancel' });
      },
    });
    code.prepend(head);
  }

  /** Each area's pages, in order; those that don't apply (no Last round, no CI) are left out. */
  private pagesOf(id: AreaId): Page[] {
    const pages: Page[] =
      id === 'read'
        ? [
            { id: 'narrative', title: 'Review' },
            { id: 'description', title: 'Description' },
            { id: 'recap', title: 'Last round' },
            ...panelDefs()
              .filter((d) => !d.onDemand && !OWN.includes(d.id))
              .map((d) => ({ id: d.id, title: d.title })),
          ]
        : id === 'code'
          ? [{ id: 'code', title: 'Code' }]
          : id === 'threads'
            ? [
                { id: 'threads', title: 'Open', params: { filter: 'open' } },
                { id: 'threads:resolved', title: 'Resolved', params: { filter: 'resolved' } },
                { id: 'thread:gh_conversation', title: 'PR conversation', params: { id: 'gh_conversation' } },
              ]
            : [
                { id: 'files', title: 'Files' },
                { id: 'toc', title: 'Contents' },
                { id: 'ci', title: 'CI' },
              ];
    return pages.filter((p) => this.opts.available(p.id));
  }

  /** The areas' pages, again whenever the PR's own panels or Last round may have come or gone (only what changed). */
  paintBar() {
    for (const area of this.areas.values()) {
      const pages = this.pagesOf(area.id);
      const sig = pages.map((p) => p.id).join();
      if (sig === area.sig) continue;
      area.sig = sig;
      // every page mounts up front, as a layout's panels do in the dock: panels listen for navigation (a link opening code)
      for (const p of area.pages) if (!pages.some((x) => x.id === p.id)) this.drop(p.id);
      area.pages = pages;
      area.pager.replaceChildren(...pages.flatMap((p) => this.mount(p.id, p.params, p.title)?.host ?? []));
      area.strip.hidden = pages.length < 2;
      area.strip.replaceChildren(
        ...pages.map((p) =>
          h('button', { class: 'rr-phone-toptab', role: 'tab', 'data-id': p.id, onclick: () => this.scrollTo(area, p.id, 'smooth') }, h('span', null, p.title)),
        ),
        area.ind,
      );
      this.shell.send({ type: 'pages', area: area.id, ids: pages.map((p) => p.id) });
      requestAnimationFrame(() => (this.scrollTo(area, this.ctx().page[area.id], 'instant'), this.slide(area)));
      this.paintTabs(area);
    }
    this.paintNav();
  }

  private navArea = '';
  private paintNav() {
    const open = this.opts.openThreads();
    const current = this.ctx().area;
    // the indicator grows from the centre when the area changes (not on every repaint)
    const moved = this.navArea !== current;
    this.navArea = current;
    this.nav.replaceChildren(
      ...AREAS.map((a) => {
        const b = h('button', { class: 'rr-phone-tab' + (moved && a.id === current ? ' is-new' : ''), 'data-area': a.id, 'aria-current': String(a.id === current), title: a.title });
        const pill = h('span', { class: 'rr-phone-tab__pill' }, icon(a.icon, 24));
        b.append(pill, h('span', { class: 'rr-phone-tab__label' }, a.title));
        if (a.id === 'threads' && open) pill.append(h('span', { class: 'rr-badge rr-phone-tab__badge', title: `${open} open thread${open > 1 ? 's' : ''}` }, String(open)));
        b.onclick = () => this.shell.send({ type: 'nav', area: a.id });
        return b;
      }),
    );
  }

  private paintTabs(area: Area) {
    const page = this.ctx().page[area.id];
    area.strip.querySelectorAll<HTMLElement>('.rr-phone-toptab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === page)));
  }

  /** The tab indicator under the page the pager shows, between two labels mid-swipe (width and place blended). */
  private slide(area: Area) {
    const tabs = [...area.strip.querySelectorAll<HTMLElement>('.rr-phone-toptab > span')];
    const w = area.pager.clientWidth;
    if (!tabs.length || !w) return;
    const f = Math.max(0, Math.min(tabs.length - 1, area.pager.scrollLeft / w));
    const [a, b] = [tabs[Math.floor(f)], tabs[Math.ceil(f)]];
    const t = f - Math.floor(f);
    const [left, right] = [a.offsetLeft, b.offsetLeft]; // the strip is their offsetParent
    area.ind.style.transform = `translateX(${left + (right - left) * t}px)`;
    area.ind.style.width = `${a.offsetWidth + (b.offsetWidth - a.offsetWidth) * t}px`;
  }

  private scrollTo(area: Area, page: string, behavior: ScrollBehavior) {
    const i = area.pages.findIndex((p) => p.id === page);
    if (i >= 0) area.pager.scrollTo({ left: i * area.pager.clientWidth, behavior });
  }

  /** Which page the pager shows (the one most on screen). */
  private settle(area: Area) {
    const w = area.pager.clientWidth;
    const p = w ? area.pages[Math.round(area.pager.scrollLeft / w)] : undefined;
    if (p && p.id !== this.ctx().page[area.id]) this.shell.send({ type: 'page', area: area.id, id: p.id });
  }

  private shown(id: string) {
    const o = this.open.get(id);
    if (o) requestAnimationFrame(() => o.inst.onShow?.());
  }

  private mount(id: string, params?: Record<string, unknown>, title?: string) {
    let o = this.open.get(id);
    if (o) return o;
    const def = panelDefs().find((d) => d.id === id.split(':')[0]);
    if (!def) return undefined;
    const sheet = !title; // a thread, a code pop-out
    const host = h('div', { class: 'rr-panel-host ' + (sheet ? 'rr-phone-panel is-sheet' : 'rr-phone-page'), 'data-rr-kind': def.id, role: sheet ? null : 'tabpanel', hidden: sheet });
    title ??= def.title + (id.includes(':') && !def.onDemand ? ' ' + id.split(':')[1] : '');
    if (sheet) {
      const back = h('button', { class: 'rr-icon-btn', 'aria-label': 'Back', title: 'Back (Esc)', onclick: () => this.close(id) });
      back.append(icon('chevron', 16));
      host.append(h('header', { class: 'rr-phone-sheet-head' }, back, h('span', { class: 'rr-phone-sheet-title' }, title)));
    }
    const inst = def.create(this.app, params ?? {}, id);
    host.append(inst.element);
    if (sheet) {
      this.stage.append(host);
      this.sheetIds.add(id);
    }
    o = { id, title, params, host, inst };
    this.open.set(id, o);
    return o;
  }

  private drop(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    o.inst.dispose?.();
    o.host.remove();
    this.open.delete(id);
    this.sheetIds.delete(id);
  }

  has = (id: string) => this.open.has(id);
  find = (match: (id: string, params: Record<string, unknown> | undefined) => boolean) => [...this.open.values()].find((o) => match(o.id, o.params))?.id;

  setTitle(id: string, title: string) {
    const o = this.open.get(id);
    const t = o?.host.querySelector('.rr-phone-sheet-title');
    if (!o || !t) return; // a page keeps its tab's name
    o.title = title;
    t.textContent = title;
  }

  /** Open (if needed) and bring to the front; false if there's no such panel. */
  show(id: string, params?: Record<string, unknown>) {
    const area = areaOf(this.ctx(), id);
    if (!area && !this.mount(id, params)) return false;
    const was = area && this.ctx().page[area];
    this.shell.send({ type: 'show', id });
    if (area && was !== id) this.scrollTo(this.areas.get(area)!, id, 'instant');
    return true;
  }

  /** Pages stay mounted (like a dock tab you switch away from); sheets are thrown away. */
  close(id: string) {
    this.shell.send({ type: 'close', id });
  }

  /** The panel in front: the peeked code, the newest sheet, else the area's page. */
  front = () => front(this.ctx());

  private shownKey = '';
  private wasFull = false;
  private render() {
    const c = this.ctx();
    const sheet = this.code.getSnapshot();
    const code = this.areas.get('code')!.el;
    const full = sheet.matches('full');
    if (full && !this.wasFull) {
      // the peek became the Code area: it keeps rising from where it was (the expressive spring, phone.css), and its
      // lines land again for the taller view once the area is the Code area
      code.style.setProperty('--rr-from', `${code.offsetTop}px`);
      code.classList.remove('is-landing');
      void code.offsetWidth;
      code.classList.add('is-landing');
      const at = this.peekAt;
      if (at) queueMicrotask(() => this.app.bus.emit('reveal-code', at));
    }
    this.wasFull = full;
    const dragging = sheet.matches({ open: 'dragging' });
    code.classList.toggle('is-peek', sheet.matches('open'));
    code.classList.toggle('is-dragging', dragging);
    code.classList.toggle('is-rising', dragging && rising(sheet.context)); // the scrim, only up there
    if (dragging) code.style.setProperty('--rr-peek-h', `${sheet.context.height}px`);
    else code.style.removeProperty('--rr-peek-h');
    for (const a of this.areas.values()) {
      a.el.classList.toggle('is-current', a.id === c.area);
      this.paintTabs(a);
    }
    if (this.navArea !== c.area) this.paintNav();
    const top = front(c);
    for (const id of this.sheetIds) {
      if (!c.sheets.includes(id)) this.drop(id);
      else this.open.get(id)!.host.hidden = id !== top;
    }
    this.comment.hidden = c.selectedIn !== top || !top;
    // a panel coming to the front catches up (onShow)
    const key = `${peeking(c) ? 'peek' : c.sheets.length ? 'sheet' : c.area}:${top}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.shown(top);
    }
    this.syncHistory();
  }

  /** Each entry of the machine's stack gets a history entry (onBack), and gives it back once gone; removals first. */
  private syncing = false;
  private syncHistory() {
    if (this.syncing) return;
    this.syncing = true;
    queueMicrotask(() => {
      this.syncing = false;
      const stack = this.ctx().stack;
      for (const [key, drop] of this.backs) {
        if (stack.some((e) => e.key === key)) continue;
        this.backs.delete(key);
        drop();
      }
      for (const e of stack)
        if (!this.backs.has(e.key))
          this.backs.set(
            e.key,
            onBack(() => {
              const d = e.kind === 'dialog' && this.dialogs.get(e.id);
              if (d) dismiss(d);
              this.shell.send({ type: 'back', key: e.key });
            }),
          );
    });
  }
}
