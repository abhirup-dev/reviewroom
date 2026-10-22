// Phone shell: the same panels as the dock, grouped into four areas along the bottom (Read, Code, Threads, Files).
// An area with several pages has tabs along its top and pages side by side in a horizontal scroll-snap pager: a
// sideways swipe follows the finger and snaps (native scrolling, so vertical scroll, text selection and long press
// keep working). On-demand panels (a thread, a code pop-out) open as a full-screen sheet over them with a back
// button. The layout.ts facade sends every panel request here when this shell is mounted, so the rest of the app
// doesn't know.
import { h, icon } from '../core/dom';
import type { ReviewApp } from './app';
import { panelDefs, type PanelInstance } from './layout';
import { wantsPhone } from './device';

/** A phone (see device.ts). Picked once at boot: the shell (and the prefs) never swap under the reviewer. */
let picked: boolean | undefined;
export const isPhone = () => (picked ??= wantsPhone());

type Open = { id: string; title: string; params?: Record<string, unknown>; host: HTMLElement; inst: PanelInstance };
type Page = { id: string; title: string; params?: Record<string, unknown> };
type AreaId = 'read' | 'code' | 'threads' | 'files';
type Area = { id: AreaId; el: HTMLElement; strip: HTMLElement; pager: HTMLElement; pages: Page[]; sig: string; page: string };

const AREAS: { id: AreaId; title: string; icon: Parameters<typeof icon>[0] }[] = [
  { id: 'read', title: 'Read', icon: 'doc' },
  { id: 'code', title: 'Code', icon: 'code' },
  { id: 'threads', title: 'Threads', icon: 'thread' },
  { id: 'files', title: 'Files', icon: 'files' },
];
/** reviewroom's own panels; any other (an agent's) is a page of Read, as it joins the narrative's tabs in the dock */
const OWN = ['narrative', 'description', 'recap', 'code', 'threads', 'files', 'toc', 'ci', 'thread', 'slot'];

export class PhoneShell {
  private open = new Map<string, Open>();
  private sheets: string[] = []; // on-demand panels, newest last
  private areas = new Map<AreaId, Area>();
  private area: AreaId = 'read';
  private stage = h('div', { class: 'rr-phone-stage' });
  private nav = h('nav', { class: 'rr-phone-nav', 'aria-label': 'Areas' });
  private comment = h('button', { class: 'rr-btn rr-btn--primary rr-phone-comment', hidden: true });
  /** the panel in front when the selection was made: Comment shows only while that panel is */
  private selectedIn = '';

  constructor(
    private app: ReviewApp,
    host: HTMLElement,
    private available: (id: string) => boolean,
  ) {
    host.classList.add('rr-phone');
    // no c key on a phone: a selection (text in the narrative, lines in code) gets a button instead
    const comment = this.comment;
    comment.onclick = () => (app.commands.run('comment.selection'), (comment.hidden = true));
    comment.append(icon('thread', 14), 'Comment');
    app.bus.on('selection', (s) => ((this.selectedIn = s ? this.front() : ''), this.paint()));
    for (const a of AREAS) {
      const strip = h('div', { class: 'rr-phone-toptabs', role: 'tablist' });
      const pager = h('div', { class: 'rr-phone-pager' });
      const area: Area = { id: a.id, el: h('section', { class: 'rr-phone-area', 'data-area': a.id, 'aria-label': a.title }, strip, pager), strip, pager, pages: [], sig: '', page: '' };
      // the page under the finger once the pager settles (a swipe, or a tap on a tab scrolling it)
      pager.addEventListener('scroll', () => this.settle(area), { passive: true });
      this.areas.set(a.id, area);
      this.stage.append(area.el);
    }
    // a resized pager (rotation, the URL bar) keeps the page it was on
    new ResizeObserver(() => this.areas.forEach((a) => this.scrollTo(a, a.page, 'instant'))).observe(this.stage);
    host.append(this.stage, comment, this.nav);
    app.bus.on('state', () => this.paintBar());
    app.bus.on('prefs', () => this.paintNav());
    this.paintBar();
    this.show('narrative');
    app.escapers.push(() => (this.sheets.length ? (this.close(this.sheets.at(-1)!), true) : false));
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
    return pages.filter((p) => this.available(p.id));
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
          h('button', { class: 'rr-phone-toptab', role: 'tab', 'data-id': p.id, onclick: () => this.scrollTo(area, p.id, 'smooth') }, p.title),
        ),
      );
      if (!pages.some((p) => p.id === area.page)) area.page = pages[0]?.id ?? '';
      requestAnimationFrame(() => this.scrollTo(area, area.page, 'instant'));
      this.paintTabs(area);
    }
    this.paintNav();
  }

  private paintNav() {
    const open = this.app.openThreadCount();
    this.nav.replaceChildren(
      ...AREAS.map((a) => {
        const b = h('button', { class: 'rr-phone-tab', 'data-area': a.id, 'aria-current': String(a.id === this.area), title: a.title });
        b.append(icon(a.icon, 18), h('span', null, a.title));
        if (a.id === 'threads' && open) b.append(h('span', { class: 'rr-badge rr-phone-tab__badge', title: `${open} open thread${open > 1 ? 's' : ''}` }, String(open)));
        b.onclick = () => (this.sheets.forEach((s) => this.close(s)), this.setArea(a.id));
        return b;
      }),
    );
  }

  private paintTabs(area: Area) {
    area.strip.querySelectorAll<HTMLElement>('.rr-phone-toptab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === area.page)));
  }

  private scrollTo(area: Area, page: string, behavior: ScrollBehavior) {
    const i = area.pages.findIndex((p) => p.id === page);
    if (i >= 0) area.pager.scrollTo({ left: i * area.pager.clientWidth, behavior });
  }

  /** Which page the pager shows (the one most on screen); a new one is shown (onShow) and its tab marked. */
  private settle(area: Area) {
    const w = area.pager.clientWidth;
    const p = w ? area.pages[Math.round(area.pager.scrollLeft / w)] : undefined;
    if (!p || p.id === area.page) return;
    area.page = p.id;
    this.paintTabs(area);
    this.shown(p.id);
  }

  private shown(id: string) {
    const o = this.open.get(id);
    if (o) requestAnimationFrame(() => o.inst.onShow?.());
  }

  private setArea(id: AreaId) {
    const was = this.area;
    this.area = id;
    for (const a of this.areas.values()) a.el.classList.toggle('is-current', a.id === id);
    this.paintNav();
    if (was !== id) this.shown(this.areas.get(id)!.page);
    this.paint();
  }

  private areaOf(id: string) {
    return [...this.areas.values()].find((a) => a.pages.some((p) => p.id === id));
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
    if (sheet) this.stage.append(host);
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
    const area = this.areaOf(id);
    if (area) {
      this.sheets.forEach((s) => this.close(s));
      this.setArea(area.id);
      if (area.page !== id) {
        area.page = id;
        this.paintTabs(area);
        this.scrollTo(area, id, 'instant');
        this.shown(id);
      }
      return true;
    }
    if (!this.mount(id, params)) return false;
    this.sheets = [...this.sheets.filter((s) => s !== id), id];
    this.paint();
    return true;
  }

  close(id: string) {
    if (!this.sheets.includes(id)) return; // pages stay mounted (like a dock tab you switch away from); sheets are thrown away
    this.sheets = this.sheets.filter((s) => s !== id);
    this.drop(id);
    this.paint();
  }

  private front = () => this.sheets.at(-1) ?? this.areas.get(this.area)!.page;

  private paint() {
    const front = this.front();
    this.comment.hidden = this.selectedIn !== front || !front;
    for (const id of this.sheets) {
      const o = this.open.get(id)!;
      const shown = id === front;
      if (shown && o.host.hidden) this.shown(id);
      o.host.hidden = !shown;
    }
  }
}
