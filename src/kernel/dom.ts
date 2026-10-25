// Tiny DOM helpers. No framework on purpose: author content is plain HTML and
// every shell part is a plain element you can restyle or replace.
import { computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom';
import { CLAWD, CLAWD_RESOLVED } from './clawd';

type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** One choice of a segmented control: `on` is the one chosen; `keys` its shortcut hint. */
export type Segment = { label: Child; title?: string; on: boolean; onclick: () => void; keys?: string; disabled?: boolean };
/** A segmented control (`.rr-seg`): a group of buttons, one of them on. */
export const seg = (segments: Segment[], attrs?: Attrs) =>
  h('div', { class: 'rr-seg', role: 'group', ...attrs }, ...segments.map(({ label, on, keys, ...b }) => h('button', { ...b, class: on ? 'is-on' : '', 'data-keys': keys, 'aria-pressed': String(on) }, label)));

export function append(el: Node, children: Child[]) {
  for (const c of children.flat(Infinity as 1)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const svg = (d: string, size = 16) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  s.classList.add('rr-icon');
  return s;
};

// 16px stroke icons, drawn for this UI (no icon font, no emoji).
const P = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
export const icons = {
  toc: P('M3 4h10M3 8h7M3 12h9'),
  menu: P('M2.5 4.5h11M2.5 8h11M2.5 11.5h11'),
  back: P('M13 8H3M7 4 3 8l4 4'),
  home: P('M2.5 7.5 8 3l5.5 4.5M4 6.5v7h8v-7'),
  book: P('M8 4.5c-1.5-1.3-3.5-1.8-5.5-1.5v9.5c2-.3 4 .2 5.5 1.5 1.5-1.3 3.5-1.8 5.5-1.5V3c-2-.3-4 .2-5.5 1.5zM8 4.5V14'),
  theme: P('M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 2.5v11'),
  info: P('M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.5M8 5.2v.1'),
  history: P('M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5V5H5M8 5.5V8l2 1.5'),
  section: P('M4 3h8M4 6.5h8M4 10h5'),
  files: P('M4 2.5h5l3 3v8H4z M9 2.5v3h3'),
  code: P('M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4'),
  doc: P('M4 2.5h8v11H4zM6 5.5h4M6 8h4M6 10.5h2.5'),
  ci: P('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM6.8 5.6v4.8L10.4 8z'),
  thread: P('M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z'),
  // the phone's comment: a rounded speech bubble with a tail, three dots inside
  chat: P('M5 3h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 11 11H8l-3 2.5V11a2.5 2.5 0 0 1-2.5-2.5v-3A2.5 2.5 0 0 1 5 3z') + '<circle cx="5.5" cy="7" r=".8" fill="currentColor"/><circle cx="8" cy="7" r=".8" fill="currentColor"/><circle cx="10.5" cy="7" r=".8" fill="currentColor"/>',
  search: P('M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14'),
  sun: P('M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1'),
  moon: P('M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z'),
  layout: P('M2.5 3h11v10h-11zM7 3v10M7 8h6.5'),
  link: P('M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'),
  close: P('M4 4l8 8M12 4l-8 8'),
  check: P('M3 8.5 6.5 12 13 4.5'),
  chevron: P('M6 4l4 4-4 4'),
  chevronDown: P('M4 6l4 4 4-4'),
  dock: P('M2.5 3h11v10h-11zM9.5 3v10'),
  popout: P('M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4'),
  pin: P('M10 2.5 13.5 6 11 7.5 9 11.5 4.5 7 8.5 5zM6.5 9.5 3 13'),
  send: P('M2.5 8 13.5 3 10 13.5 7.5 9zM7.5 9 13.5 3'),
  filter: P('M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z'),
  eye: P('M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  split: P('M2.5 3h11v10h-11zM8 3v10'),
  unified: P('M2.5 3h11v10h-11zM2.5 8h11'),
  wrap: P('M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H9M10.5 10.5 9 12l1.5 1.5M2.5 12H6'),
  expand: P('M8 2v4M6 4l2-2 2 2M8 14v-4M6 12l2 2 2-2M3 8h10'),
  arrowUp: P('M8 13V3M4 7l4-4 4 4'),
  arrowDown: P('M8 3v10M4 9l4 4 4-4'),
  dots: '<circle cx="4" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/>',
  play: P('M5 3.5v9l7.5-4.5z'),
  pause: P('M5.5 3.5v9M10.5 3.5v9'),
  round: P('M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3'),
  smile: P('M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM5.5 9.5c1.2 1.4 3.8 1.4 5 0M6 6.2v.1M10 6.2v.1'),
  undo: P('M5.5 3 2.5 6l3 3M3 6h6.5a3.5 3.5 0 0 1 0 7H7'),
  bolt: P('M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z'),
  target: P('M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  symbol: P('M5.5 2.5C4 2.5 4 4 4 5.5S3.5 8 2.5 8c1 0 1.5 1 1.5 2.5s0 3 1.5 3M10.5 2.5c1.5 0 1.5 1.5 1.5 3s.5 2.5 1.5 2.5c-1 0-1.5 1-1.5 2.5s0 3-1.5 3'),
  // GitHub's mark (octicons, MIT): a thread on the PR
  github:
    '<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>',
  install: P('M8 2.5v7M5 6.5l3 3 3-3M3 11v2.5h10V11'),
  share: P('M8 9.5V2M5.5 4.5 8 2l2.5 2.5M5.5 7H3.5v6.5h9V7h-2'),
  maximize: P('M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'),
};

export const icon = (name: keyof typeof icons, size = 16) => svg(icons[name], size);

const clawd = (resolved: boolean, size: number) => h('img', { class: 'rr-clawd', src: resolved ? CLAWD_RESOLVED : CLAWD, width: size, height: size, alt: '' });

/** A thread's marker: GitHub's mark (on the PR) or Clawd (with the agent), its message count in a corner pill; greyed out once resolved. */
export function threadBadge(t: { gh?: { conversation?: boolean }; status: string; messages: { gh?: { login: string; avatar?: string } }[] }, agentReplied = false) {
  const resolved = t.status === 'resolved';
  // a GitHub thread shows who started it; the PR conversation (everyone's) keeps GitHub's mark
  const starter = t.gh && !t.gh.conversation ? t.messages[0]?.gh : undefined;
  return h(
    'span',
    { class: 'rr-tbadge ' + (t.gh ? 'is-gh' : 'is-agent') + (resolved ? ' is-resolved' : agentReplied ? ' has-agent' : '') },
    starter?.avatar
      ? h('img', { class: 'rr-tbadge__avatar', src: avatarUrl(starter.avatar, 40), alt: '', title: starter.login, loading: 'lazy' })
      : t.gh ? icon('github', 16) : clawd(resolved, 18),
    h('span', { class: 'rr-tbadge__n' }, String(t.messages.length)),
  );
}

/** `1 file`, `3 files`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Open-thread counts for a file or section, one chip per kind (on GitHub / with the agent). */
export function threadCounts(ts: { gh?: unknown }[], where: string) {
  const gh = ts.filter((t) => t.gh).length;
  const agent = ts.length - gh;
  return [
    gh ? h('span', { class: 'rr-count-chip is-gh', title: `${plural(gh, 'open GitHub thread')} ${where}` }, icon('github', 11), String(gh)) : null,
    agent ? h('span', { class: 'rr-count-chip', title: `${plural(agent, 'open thread')} with the agent ${where}` }, clawd(false, 12), String(agent)) : null,
  ];
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** A GitHub avatar URL asking for a `px`-wide image. */
export const avatarUrl = (url: string, px: number) => url + (url.includes('?') ? '&' : '?') + 's=' + px;

/** How long a touch holds still to be a long press. */
const LONG_PRESS_MS = 450;

/** Touch has no hover: a finger held still LONG_PRESS_MS stands in for it. `fn` gets the press's composed path and returns
 *  true if it used the press; then the browser's own long-press menu and any click that follows are swallowed.
 *  Returns what removes its listeners. */
export function onLongPress(fn: (path: EventTarget[]) => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let x = 0;
  let y = 0;
  let used = false;
  const cancel = () => clearTimeout(timer);
  const swallow = (e: Event) => used && (e.preventDefault(), e.stopPropagation(), e.type === 'click' && (used = false));
  const down = (e: PointerEvent) => {
    cancel();
    used = false;
    if (e.pointerType !== 'touch') return;
    ({ clientX: x, clientY: y } = e);
    const path = e.composedPath();
    timer = setTimeout(() => (used = fn(path)), LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => Math.hypot(e.clientX - x, e.clientY - y) > 10 && cancel();
  const on: [string, EventListener][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ...['pointerup', 'pointercancel', 'scroll'].map((t) => [t, cancel] as [string, EventListener]),
    ...['contextmenu', 'mousedown', 'click'].map((t) => [t, swallow] as [string, EventListener]),
  ];
  for (const [t, f] of on) document.addEventListener(t, f, true);
  return () => {
    cancel();
    for (const [t, f] of on) document.removeEventListener(t, f, true);
  };
}

/** A finger (or mouse) dragging `el`, a handle: `move` and `end` get how far it went from where it started. Presses on
 *  a button inside it stay clicks. */
export function onDrag(el: HTMLElement, on: { start?(e: PointerEvent): void; move(dx: number, dy: number, e: PointerEvent): void; end?(dx: number, dy: number, e: PointerEvent): void }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    const { clientX: x, clientY: y } = e;
    el.setPointerCapture(e.pointerId);
    on.start?.(e);
    const move = (m: PointerEvent) => on.move(m.clientX - x, m.clientY - y, m);
    const up = (u: PointerEvent) => {
      for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]] as const) el.removeEventListener(t, f as EventListener);
      on.end?.(u.clientX - x, u.clientY - y, u);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

const rtf = new Intl.RelativeTimeFormat(undefined, { style: 'narrow', numeric: 'auto' });
/** "just now", "5m ago", "3h ago", "yesterday", "4d ago"; a date after a week. */
export function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.floor(s / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

const placing = new WeakMap<HTMLElement, number>();
/** Put a position:fixed overlay `gap` px from `ref`, on the other side if it doesn't fit, `pad` px inside the viewport.
 *  If neither side fits it stays on `placement`'s side, shifted as far as it must. The latest call per overlay wins. */
export function placeNear(ref: Element, el: HTMLElement, placement: Placement, gap: number, pad: number) {
  const id = (placing.get(el) ?? 0) + 1;
  placing.set(el, id);
  const middleware = [offset(gap), flip({ padding: pad, fallbackStrategy: 'initialPlacement' }), shift({ padding: pad, crossAxis: true })];
  return computePosition(ref, el, { strategy: 'fixed', placement, middleware }).then(({ x, y }) => {
    if (placing.get(el) === id) Object.assign(el.style, { left: x + 'px', top: y + 'px' });
  });
}

/** mousedown on a modal <dialog>: a press on its backdrop (the dialog itself, not its content) closes it,
 *  leaving focus where the dialog returned it. */
export function backdropCloses(e: MouseEvent) {
  if (e.target !== e.currentTarget) return;
  e.preventDefault();
  (e.currentTarget as HTMLDialogElement).close();
}
