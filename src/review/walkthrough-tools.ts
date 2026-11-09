// Input and overlay lifecycle only. The panel supplies reference/action capabilities, not its application object.
import { h, icon } from '../kernel/dom';
import { menuItem, menuLabel, popMenu } from '../kernel/menus';
import { describeElement } from '../kernel/refs/describe';
import { WALKTHROUGH_BLOCKS, walkthroughBlock, type WalkthroughBlock } from './walkthrough-blocks';

interface Capabilities {
  doc(): HTMLElement;
  readOnly(): boolean;
  resolve(el: Element): WalkthroughBlock;
  label(reference: string): string;
  comment: (block: WalkthroughBlock) => void;
  copy: (block: WalkthroughBlock) => void;
  pin: (block: WalkthroughBlock) => void;
  pinned(block: WalkthroughBlock): boolean;
  isPicking(): boolean;
  stopPicking(): void;
  alt(on: boolean): void;
}

export class WalkthroughTools {
  private handle = h('button', {
    class: 'rr-icon-btn rr-block-handle', hidden: true, title: 'Block actions',
    'aria-label': 'Block actions', 'aria-haspopup': 'menu', onclick: () => this.openMenu(),
  }, icon('plus', 14));
  private outline = h('div', { class: 'rr-block-outline', hidden: true });
  private hovered: Element | null = null;
  private side: 'left' | 'right' = 'left';
  private closeMenu?: () => void;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private dwellTimer?: ReturnType<typeof setTimeout>;
  private dwell?: { block: Element; side: 'left' | 'right'; y: number };
  private offs: (() => void)[] = [];

  constructor(private wrap: HTMLElement, private scroller: HTMLElement, private rail: HTMLElement, private caps: Capabilities) {
    wrap.append(this.outline, this.handle);
    this.listen(wrap, 'pointermove', (e) => this.move(e as PointerEvent));
    this.listen(wrap, 'pointerleave', () => { this.cancelDwell(); this.scheduleHide(); });
    this.listen(wrap, 'contextmenu', (e) => this.context(e as MouseEvent));
    this.listen(wrap, 'click', (e) => this.click(e as PointerEvent), true);
    this.listen(scroller, 'keydown', (e) => this.key(e as KeyboardEvent));
    this.listen(scroller, 'scroll', () => this.dismiss());
    this.listen(this.handle, 'focus', () => clearTimeout(this.hideTimer));
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture);
    this.offs.push(() => target.removeEventListener(type, listener, capture));
  }

  private selected() {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed;
  }

  private move(e: PointerEvent) {
    if (e.pointerType === 'touch' || this.closeMenu || this.selected()) return;
    if (e.buttons) { this.cancelDwell(); this.hide(); return; }
    if ((e.target as Element).closest('.rr-block-handle')) return clearTimeout(this.hideTimer);
    this.caps.alt(e.altKey);
    if (this.caps.isPicking()) {
      const el = walkthroughBlock(this.caps.doc(), e.target, true);
      if (el) this.show(el, 'left', e.clientY);
      else this.hide();
      return;
    }
    const dr = this.caps.doc().getBoundingClientRect();
    if (e.clientX >= dr.left && e.clientX <= dr.right) {
      const el = walkthroughBlock(this.caps.doc(), e.target);
      if (el) this.scheduleDwell(el, e.clientX < (dr.left + dr.right) / 2 ? 'left' : 'right', e.clientY);
      else this.cancelDwell();
      if (el !== this.hovered) this.scheduleHide();
      return;
    }
    this.cancelDwell();
    if ((e.target as Element).closest('.rr-rail-chip')) return this.hide();
    const side = e.clientX < dr.left ? 'left' : 'right';
    const el = this.blockAtY(e.clientY);
    if (el) this.show(el, side, e.clientY);
    else this.scheduleHide();
  }

  private scheduleDwell(block: Element, side: 'left' | 'right', y: number) {
    if (this.dwell?.block === block) { Object.assign(this.dwell, { side, y }); return; }
    this.cancelDwell();
    const pending = this.dwell = { block, side, y };
    this.dwellTimer = setTimeout(() => {
      if (!block.isConnected || this.closeMenu || this.selected()) return;
      this.show(block, pending.side, pending.y);
      // An existing thread owns the right slot; discovery can use the free left margin instead.
      if (this.handle.hidden) this.show(block, 'left', pending.y);
    }, 500);
  }

  private cancelDwell() {
    clearTimeout(this.dwellTimer);
    this.dwell = undefined;
  }

  private blockAtY(y: number) {
    const doc = this.caps.doc();
    const r = doc.getBoundingClientRect();
    const projected = walkthroughBlock(doc, document.elementFromPoint?.(r.left + r.width / 2, y));
    if (projected) return projected;
    let found: Element | null = null;
    let height = Infinity;
    for (const candidate of doc.querySelectorAll(WALKTHROUGH_BLOCKS)) {
      const el = walkthroughBlock(doc, candidate);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && y >= r.top && y <= r.bottom && r.height < height) {
        found = el;
        height = r.height;
      }
    }
    return found;
  }

  private show(el: Element, side: 'left' | 'right', pointerY: number) {
    clearTimeout(this.hideTimer);
    const wr = this.wrap.getBoundingClientRect();
    const dr = this.caps.doc().getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    const size = this.handle.offsetWidth || parseFloat(getComputedStyle(this.handle).width) || 28;
    const chip = this.rail.querySelector<HTMLElement>('.rr-rail-chip');
    const x = side === 'left' ? Math.max(wr.left + 2, dr.left - size - 6)
      : Math.min(wr.right - size - 2, chip?.getBoundingClientRect().left ?? dr.right + 6);
    // A tall block's affordance stays near the hand, inside the visible part of that block.
    const y = Math.max(view.top + 2, r.top, Math.min(pointerY - size / 2, r.bottom - size, view.bottom - size - 2));
    const occupied = side === 'right' && [...this.rail.children].some((node) => {
      const c = node.getBoundingClientRect();
      return x < c.right && x + size > c.left && y < c.bottom && y + size > c.top;
    });
    if (occupied && !this.caps.isPicking()) return this.hide();
    this.hovered = el;
    this.side = side;
    this.handle.hidden = this.caps.isPicking();
    Object.assign(this.handle.style, { top: y - wr.top + 'px', left: x - wr.left + 'px' });
    this.handle.setAttribute('aria-label', `Actions for ${describeElement(el)}`);
    if (this.caps.isPicking()) this.paintOutline(el);
    this.outline.hidden = !this.caps.isPicking();
  }

  private paintOutline(el: Element) {
    const wr = this.wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    Object.assign(this.outline.style, { top: r.top - wr.top - 3 + 'px', left: r.left - wr.left - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 6 + 'px' });
    this.outline.classList.toggle('is-right', this.side === 'right');
    this.outline.dataset.label = this.caps.isPicking() ? describeElement(el) : '';
  }

  private openMenu(point?: { x: number; y: number }) {
    const el = this.hovered;
    if (!el || this.closeMenu) return;
    const block = this.caps.resolve(el);
    const readOnly = this.caps.readOnly();
    const invoke = (action: (block: WalkthroughBlock) => void) => () => { this.dismiss(); action(block); };
    this.paintOutline(el);
    this.outline.hidden = false;
    const closeMenu = popMenu(this.handle, () => [
      menuLabel(this.caps.label(block.reference)),
      readOnly ? null : menuItem('Add comment', invoke(this.caps.comment), { icon: 'thread' }),
      menuItem('Copy block reference', invoke(this.caps.copy), { icon: 'link' }),
      !point ? menuItem(this.caps.pinned(block) ? 'Unpin from Contents' : 'Pin to Contents', invoke(this.caps.pin), { icon: 'pin' }) : null,
    ], { point, returnFocus: this.scroller, onClose: () => {
      if (closeMenu !== this.closeMenu) return;
      this.closeMenu = undefined;
      this.hide();
    } });
    this.closeMenu = closeMenu;
  }

  private contextBlock(target: EventTarget | null) {
    if (this.selected() || !(target instanceof Element) || target.closest('a,button,input,textarea,select,img,video,audio,[contenteditable],rr-ref,.rr-rail')) return null;
    return walkthroughBlock(this.caps.doc(), target);
  }

  private context(e: MouseEvent) {
    const el = this.contextBlock(e.target);
    if (!el) return;
    e.preventDefault();
    this.caps.stopPicking();
    this.hovered = el;
    this.side = 'left';
    this.openMenu({ x: e.clientX, y: e.clientY });
  }

  private click(e: PointerEvent) {
    if (!(e.target instanceof Element) || e.target.closest('a,rr-ref,.rr-block-handle,.rr-rail')) return;
    if (this.caps.isPicking() && !this.caps.readOnly()) {
      const el = walkthroughBlock(this.caps.doc(), e.target, true);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      this.caps.comment(this.caps.resolve(el));
    } else if (e.pointerType === 'touch' && !this.selected() && !e.target.closest('button,input,textarea,select')) {
      const dr = this.caps.doc().getBoundingClientRect();
      const el = walkthroughBlock(this.caps.doc(), e.target) ?? this.blockAtY(e.clientY);
      if (el) this.show(el, e.clientX > dr.right ? 'right' : 'left', e.clientY);
    }
  }

  private key(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { this.dismiss(); return; }
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    if (this.selected()) return;
    const el = e.target === this.handle ? this.hovered : e.target === this.scroller
      ? this.blockAtY(this.scroller.getBoundingClientRect().top + 40) ?? this.caps.doc().querySelector(WALKTHROUGH_BLOCKS)
      : this.contextBlock(e.target);
    if (!el) return;
    e.preventDefault();
    this.caps.stopPicking();
    this.show(el, 'left', el.getBoundingClientRect().top);
    this.openMenu();
  }

  private scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.closeMenu && !this.handle.matches(':hover') && document.activeElement !== this.handle) this.hide();
    }, 200);
  }

  private hide() {
    clearTimeout(this.hideTimer);
    this.hovered = null;
    this.handle.hidden = true;
    this.outline.hidden = true;
  }

  dismiss() {
    this.cancelDwell();
    const close = this.closeMenu;
    this.closeMenu = undefined;
    close?.();
    this.hide();
  }

  dispose() {
    this.dismiss();
    this.offs.forEach((off) => off());
    this.outline.remove();
    this.handle.remove();
  }
}
