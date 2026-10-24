// Waiting in tests: no DOM, no startup side effects, so unit and e2e tests can both import it.

/** Let queued timers and promise callbacks run (`ms` later, if given). */
export const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until fn returns something truthy (throwing counts as not yet); past `timeout` ms, throw. */
export async function until<T>(fn: () => T | Promise<T>, { timeout = 5000, every = 10 } = {}): Promise<NonNullable<T>> {
  for (const end = Date.now() + timeout; ; await tick(every)) {
    const v = await Promise.resolve().then(fn).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`until: timed out after ${timeout} ms`);
  }
}
