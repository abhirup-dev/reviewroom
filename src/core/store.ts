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

export function loadRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Per-review keys (`reviewroom:layout:<id>`, `reviewroom:draft:<id>:<thread>`) were once by title, which reviews
 *  sharing the hub's origin can share: move what an older build kept under `oldId` to `id`, never over newer data. */
export function rekeyStorage(oldId: string, id: string, store?: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>) {
  if (oldId === id) return;
  try {
    const s = store ?? localStorage;
    const keys = Array.from({ length: s.length }, (_, i) => s.key(i)!);
    const draft = `reviewroom:draft:${oldId}:`;
    for (const k of keys) {
      // shortcut: a title that starts with this one plus `:` also matches its drafts (rare); they move once, to this id
      const to = k === `reviewroom:layout:${oldId}` ? `reviewroom:layout:${id}` : k.startsWith(draft) ? `reviewroom:draft:${id}:${k.slice(draft.length)}` : null;
      if (!to) continue;
      if (s.getItem(to) == null) s.setItem(to, s.getItem(k)!);
      s.removeItem(k);
    }
  } catch {
    /* storage unavailable: nothing to move */
  }
}
