// Tiny DOM helpers. No framework on purpose: author content is plain HTML and
// every shell part is a plain element you can restyle or replace.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

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

export function append(el: Node, children: Child[]) {
  for (const c of children.flat(Infinity as 1) as Child[]) {
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
  files: P('M4 2.5h5l3 3v8H4z M9 2.5v3h3'),
  code: P('M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4'),
  doc: P('M4 2.5h8v11H4zM6 5.5h4M6 8h4M6 10.5h2.5'),
  ci: P('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM6.8 5.6v4.8L10.4 8z'),
  thread: P('M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z'),
  search: P('M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14'),
  sun: P('M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1'),
  moon: P('M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z'),
  layout: P('M2.5 3h11v10h-11zM7 3v10M7 8h6.5'),
  link: P('M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'),
  plus: P('M8 3v10M3 8h10'),
  close: P('M4 4l8 8M12 4l-8 8'),
  check: P('M3 8.5 6.5 12 13 4.5'),
  chevron: P('M6 4l4 4-4 4'),
  chevronDown: P('M4 6l4 4 4-4'),
  dock: P('M2.5 3h11v10h-11zM9.5 3v10'),
  popout: P('M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4'),
  pin: P('M10 2.5 13.5 6 11 7.5 9 11.5 4.5 7 8.5 5zM6.5 9.5 3 13'),
  send: P('M2.5 8 13.5 3 10 13.5 7.5 9z'),
  filter: P('M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z'),
  eye: P('M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  split: P('M2.5 3h11v10h-11zM8 3v10'),
  unified: P('M2.5 3h11v10h-11zM2.5 8h11'),
  wrap: P('M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H9M10.5 10.5 9 12l1.5 1.5M2.5 12H6'),
  expand: P('M8 2v4M6 4l2-2 2 2M8 14v-4M6 12l2 2 2-2M3 8h10'),
  arrowUp: P('M8 13V3M4 7l4-4 4 4'),
  arrowDown: P('M8 3v10M4 9l4 4 4-4'),
  dots: '<circle cx="4" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/>',
  round: P('M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3'),
  bolt: P('M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z'),
  target: P('M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  symbol: P('M5.5 2.5C4 2.5 4 4 4 5.5S3.5 8 2.5 8c1 0 1.5 1 1.5 2.5s0 3 1.5 3M10.5 2.5c1.5 0 1.5 1.5 1.5 3s.5 2.5 1.5 2.5c-1 0-1.5 1-1.5 2.5s0 3-1.5 3'),
  maximize: P('M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'),
};

export const icon = (name: keyof typeof icons, size = 16) => svg(icons[name], size);

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
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

export function fuzzyScore(q: string, s: string): number {
  if (!q) return 1;
  q = q.toLowerCase();
  const t = s.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || /[\/._\s-]/.test(t[idx - 1]) ? 50 : 0);
  let qi = 0, score = 0, last = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 3 : 1;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}
