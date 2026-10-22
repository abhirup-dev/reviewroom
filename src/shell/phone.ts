// Phone shell: the same panels as the dock, one at a time. Layout panels are tabs along the bottom; on-demand
// panels (a thread, a code pop-out) open as a full-screen sheet over them with a back button. The layout.ts
// facade sends every panel request here when this shell is mounted, so the rest of the app doesn't know.
import { h, icon } from '../core/dom';
import type { ReviewApp } from './app';
import { panelDefs, type PanelInstance } from './layout';
import { wantsPhone } from './device';

/** A phone (see device.ts). Picked once at boot: the shell (and the prefs) never swap under the reviewer. */
let picked: boolean | undefined;
export const isPhone = () => (picked ??= wantsPhone());

type Open = { id: string; title: string; params?: Record<string, unknown>; host: HTMLElement; inst: PanelInstance };

export class PhoneShell {
  private open = new Map<string, Open>();
  private sheets: string[] = []; // on-demand panels, newest last
  private tab = '';
  private stage = h('div', { class: 'rr-phone-stage' });
  private bar = h('nav', { class: 'rr-phone-tabs' });

  constructor(
    private app: ReviewApp,
    host: HTMLElement,
    private available: (id: string) => boolean,
  ) {
    host.classList.add('rr-phone');
    // no c key on a phone: a selection (text in the narrative, lines in code) gets a button instead
    const comment = h('button', { class: 'rr-btn rr-btn--primary rr-phone-comment', hidden: true, onclick: () => (app.commands.run('comment.selection'), (comment.hidden = true)) });
    comment.append(icon('thread', 14), 'Comment');
    app.bus.on('selection', (s) => (comment.hidden = !s));
    host.append(this.stage, comment, this.bar);
    this.paintBar();
    this.show('narrative');
    app.escapers.push(() => (this.sheets.length ? (this.close(this.sheets.at(-1)!), true) : false));
  }

  /** The tabs: every layout panel the review has, reviewroom's in reading order, then any an agent added. */
  private tabs() {
    const order = ['narrative', 'toc', 'code', 'files', 'threads', 'description', 'ci'];
    return panelDefs()
      .filter((d) => !d.onDemand && this.available(d.id))
      .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  }

  /** The tab bar, again whenever the PR's own panels may have arrived. */
  paintBar() {
    // every tab mounts up front, as a layout's panels do in the dock: panels listen for navigation (a link opening code)
    for (const d of this.tabs()) this.mount(d.id);
    this.bar.replaceChildren(
      ...this.tabs().map((d) => {
        const b = h('button', { class: 'rr-phone-tab', 'data-id': d.id, 'aria-current': String(d.id === this.tab), title: d.title });
        b.append(icon(d.icon ?? 'doc', 18), h('span', null, d.title));
        b.onclick = () => (this.sheets.forEach((s) => this.close(s)), this.show(d.id));
        return b;
      }),
    );
  }

  private mount(id: string, params?: Record<string, unknown>) {
    let o = this.open.get(id);
    if (o) return o;
    const def = panelDefs().find((d) => d.id === id.split(':')[0]);
    if (!def) return undefined;
    const sheet = !this.tabs().some((d) => d.id === id); // a thread, a code pop-out, Threads from last round
    const host = h('div', { class: 'rr-panel-host rr-phone-panel' + (sheet ? ' is-sheet' : ''), 'data-rr-kind': def.id, hidden: true });
    const title = def.title + (id.includes(':') && !def.onDemand ? ' ' + id.split(':')[1] : '');
    if (sheet) {
      const back = h('button', { class: 'rr-icon-btn', 'aria-label': 'Back', title: 'Back (Esc)', onclick: () => this.close(id) });
      back.append(icon('chevron', 16));
      host.append(h('header', { class: 'rr-phone-sheet-head' }, back, h('span', { class: 'rr-phone-sheet-title' }, title)));
    }
    const inst = def.create(this.app, params ?? {}, id);
    host.append(inst.element);
    this.stage.append(host);
    o = { id, title, params, host, inst };
    this.open.set(id, o);
    return o;
  }

  has = (id: string) => this.open.has(id);
  find = (match: (id: string, params: Record<string, unknown> | undefined) => boolean) => [...this.open.values()].find((o) => match(o.id, o.params))?.id;

  setTitle(id: string, title: string) {
    const o = this.open.get(id);
    if (!o) return;
    o.title = title;
    const t = o.host.querySelector('.rr-phone-sheet-title');
    if (t) t.textContent = title;
  }

  /** Open (if needed) and bring to the front; false if there's no such panel. */
  show(id: string, params?: Record<string, unknown>) {
    const o = this.mount(id, params);
    if (!o) return false;
    if (o.host.classList.contains('is-sheet')) this.sheets = [...this.sheets.filter((s) => s !== id), id];
    else this.tab = id;
    this.paint();
    return true;
  }

  close(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    this.sheets = this.sheets.filter((s) => s !== id);
    // tab panels stay mounted (like a dock tab you switch away from); sheets are thrown away
    if (o.host.classList.contains('is-sheet')) {
      o.inst.dispose?.();
      o.host.remove();
      this.open.delete(id);
    }
    this.paint();
  }

  private paint() {
    const front = this.sheets.at(-1) ?? this.tab;
    for (const o of this.open.values()) {
      const shown = o.id === front || (o.id === this.tab && !!this.sheets.length); // the tab stays under a sheet
      const was = !o.host.hidden;
      o.host.hidden = !shown;
      if (shown && !was) requestAnimationFrame(() => o.inst.onShow?.());
    }
    this.bar.querySelectorAll('.rr-phone-tab').forEach((b) => b.setAttribute('aria-current', String((b as HTMLElement).dataset.id === this.tab)));
  }
}
