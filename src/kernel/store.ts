// A minimal typed event emitter + persisted preference helpers.

type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Handler<never>>>();
  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  clear() { this.map.clear(); }
  emit<K extends keyof Events>(type: K, payload: Events[K]) {
    this.map.get(type)?.forEach((fn) => {
      try {
        (fn as Handler<Events[K]>)(payload); // the set for `type` only holds handlers of its payload
      } catch (e) {
        console.error('[reviewroom]', type, e);
      }
    });
  }
}

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota: preferences just won't persist */
  }
}

/** A stored JSON value as it was written, or null when absent, unreadable or corrupt (callers check its shape). */
export function loadJSON(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

export function loadRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
