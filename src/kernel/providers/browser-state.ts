import type { ReviewState } from '../state/model.shared';
import { loadJSON, saveLocal } from '../store';
import { builtinLayouts, type LastLayout, type Layout, type LayoutScope, type LayoutsOf, type LayoutStore, type SavedLayouts } from '../layouts/layout.shared';
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
  private savedLayouts() {
    const v = loadJSON(LAYOUTS_KEY) as SavedLayouts | null; // a corrupt entry reads as none
    return v?.layouts ? v : { layouts: {}, default: null };
  }
  readonly layouts: LayoutStore = {
    get: async <S extends LayoutScope>(scope: S): Promise<LayoutsOf<S>> => {
      if (scope === 'shipped') return builtinLayouts as LayoutsOf<S>;
      if (scope === 'last') {
        const v = loadJSON(`reviewroom:layout:${this.id}`) as LastLayout | null;
        return (v?.dock ? v : null) as LayoutsOf<S>; // an older build kept the bare dock here
      }
      const all = this.savedLayouts();
      return (scope === 'saved' ? all.layouts : all.default) as LayoutsOf<S>;
    },
    put: async (scope: Exclude<LayoutScope, 'shipped'>, key: string | LastLayout | null, layout?: Layout | null) => {
      const id = key as string | null;
      if (scope === 'last') return saveLocal(`reviewroom:layout:${this.id}`, key), true;
      const all = this.savedLayouts();
      if (scope === 'default') return saveLocal(LAYOUTS_KEY, { ...all, default: id }), true;
      if (layout && ((id as string) in builtinLayouts || all.layouts[id!])) return false; // saving never replaces a layout
      if (layout) all.layouts[id!] = layout;
      else delete all.layouts[id!];
      if (!layout && all.default === id) all.default = null;
      saveLocal(LAYOUTS_KEY, all);
      return true;
    },
  };
}
const LAYOUTS_KEY = 'reviewroom:layouts';
