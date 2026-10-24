import { JSDOM } from 'jsdom';

// Custom-element constructors belong to one Window. Reuse the realm between mounts,
// but restore host globals so these fixtures can run beside other DOM test suites.
// Another test may already have imported the element classes (e.g. the composer).
// Their HTMLElement base must stay paired with that realm's customElements registry.
const w = typeof window === 'undefined'
  ? new JSDOM('', { url: 'http://localhost/', pretendToBeVisual: true }).window
  : window as unknown as JSDOM['window'];

export function installDOM() {
  const values = {
    window: w, Window: w.Window, document: w.document, navigator: w.navigator,
    localStorage: w.localStorage, sessionStorage: w.sessionStorage,
    customElements: w.customElements, HTMLElement: w.HTMLElement, Element: w.Element,
    HTMLDetailsElement: w.HTMLDetailsElement, Node: w.Node, NodeFilter: w.NodeFilter,
    MutationObserver: w.MutationObserver, DOMParser: w.DOMParser,
    getComputedStyle: w.getComputedStyle,
    // Layout is exercised by the browser suite; JSDOM only mounts DOM behavior.
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    CSS: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') },
  };
  const previous = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, values);
  w.document.body.replaceChildren();
  w.localStorage.clear();
  w.sessionStorage.clear();
  return {
    window: w,
    restore() {
      w.document.body.replaceChildren();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
