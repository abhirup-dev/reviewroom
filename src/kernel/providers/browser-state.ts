import type { Op, ReviewState } from '../state/model.shared';
import { loadRaw, saveLocal } from '../store';
import type { LastLayout, Layout, SavedLayouts } from '../layouts/layout.shared';
import { StoredState } from '../state/schema.shared';
import type { StateBackend } from './contracts';

const LS_KEY = (id: string) => `reviewroom:state:${id}`;

export class BrowserState implements StateBackend {
  readonly kind = 'browser';
  /** `tour`: the text of the page's #rr-walkthrough script (the static demo embeds one) */
  constructor(private id: string, private seed?: ReviewState, private tour?: string) {}
  async walkthrough(): Promise<unknown> {
    return this.tour ?? null;
  }
  async load() {
    try {
      const raw = localStorage.getItem(LS_KEY(this.id));
      const v: unknown = raw && JSON.parse(raw);
      if (StoredState.safeParse(v).success) return v as ReviewState; // a copy that breaks the schema starts over from the seed
    } catch {
      /* ignore */
    }
    return this.seed ?? null;
  }
  // the only writer: store the whole document
  apply(_op: Op, next: ReviewState) {
    try {
      localStorage.setItem(LS_KEY(this.id), JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  async layouts(): Promise<SavedLayouts> {
    const v = JSON.parse(loadRaw(LAYOUTS_KEY) ?? 'null');
    return v?.layouts ? (v as SavedLayouts) : { layouts: {}, default: null };
  }
  async saveLayout(id: string, layout: Layout | null) {
    const all = await this.layouts();
    if (layout && all.layouts[id]) return false;
    if (layout) all.layouts[id] = layout;
    else delete all.layouts[id];
    if (!layout && all.default === id) all.default = null;
    saveLocal(LAYOUTS_KEY, all);
    return true;
  }
  async setDefaultLayout(id: string | null) {
    saveLocal(LAYOUTS_KEY, { ...(await this.layouts()), default: id });
    return true;
  }
  async lastLayout() {
    const v = JSON.parse(loadRaw(`reviewroom:layout:${this.id}`) ?? 'null');
    return v?.dock ? (v as LastLayout) : null; // an older build kept the bare dock here
  }
  async saveLastLayout(layout: LastLayout) {
    saveLocal(`reviewroom:layout:${this.id}`, layout);
  }
}
const LAYOUTS_KEY = 'reviewroom:layouts';
