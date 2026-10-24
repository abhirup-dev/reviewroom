// One test's setup, undone in reverse order when the scope ends: `using t = fixture();`.
// Underneath are the same pieces tests used before (installDOM, mountReview, memoryBackend).
import { installDOM } from './dom';
import { memoryBackend, mountReview } from './mount-review';

export function fixture() {
  const cleanups: (() => unknown)[] = [];
  /** Undo something when the scope ends (after everything set up after it is undone). */
  const defer = (cleanup: () => unknown) => void cleanups.push(cleanup);
  return {
    defer,
    /** Set globalThis[key] (fetch, EventSource, localStorage...) until the scope ends. */
    global(key: string, value: unknown) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      defer(() => (descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key)));
    },
    /** The shared JSDOM realm as the page globals. */
    dom() {
      const dom = installDOM();
      defer(() => dom.restore());
      return dom;
    },
    /** mountReview: author elements and a ReviewApp over `html`, with an in-memory backend. */
    async mount(html = '', storage = memoryBackend()) {
      const mounted = await mountReview(html, storage);
      defer(() => mounted.dispose());
      return mounted;
    },
    /** Stop `actor` (from createActor) when the scope ends. */
    actor<A extends { stop(): unknown }>(actor: A) {
      defer(() => actor.stop());
      return actor;
    },
    [Symbol.dispose]() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;
