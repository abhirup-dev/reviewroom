import type { ReviewState } from '../state/model.shared';
import { loadJSON, saveLocal } from '../store';
import type { LastLayout, Layout, SavedLayouts } from '../layouts/layout.shared';
import { StoredState, type Op } from '../state/schema.shared';
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
    const v = loadJSON(LS_KEY(this.id));
    return StoredState.safeParse(v).success ? (v as ReviewState) : (this.seed ?? null); // a copy that breaks the schema starts over from the seed
  }
  // the only writer: store the whole document
  apply(_op: Op, next: ReviewState) {
    saveLocal(LS_KEY(this.id), next);
  }
  async layouts(): Promise<SavedLayouts> {
    const v = loadJSON(LAYOUTS_KEY) as SavedLayouts | null; // a corrupt entry reads as none
    return v?.layouts ? v : { layouts: {}, default: null };
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
    const v = loadJSON(`reviewroom:layout:${this.id}`) as LastLayout | null;
    return v?.dock ? v : null; // an older build kept the bare dock here
  }
  async saveLastLayout(layout: LastLayout) {
    saveLocal(`reviewroom:layout:${this.id}`, layout);
  }
}
const LAYOUTS_KEY = 'reviewroom:layouts';
