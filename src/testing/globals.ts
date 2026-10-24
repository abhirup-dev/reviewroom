// Replacing a global (fetch, EventSource, addEventListener) for one test, and putting it back: call
// restoreGlobals() in afterEach. Cleanups run in reverse order of registration.

const restore: (() => void)[] = [];

/** Run `cleanup` at restoreGlobals(), before the globals replaced earlier are put back. */
export const afterThisTest = (cleanup: () => void) => void restore.push(cleanup);

/** Set globalThis[key] until restoreGlobals(). */
export function replaceGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
}

export function restoreGlobals() {
  for (const reset of restore.splice(0).reverse()) reset();
}
