import type { Op, ReviewState } from '../kernel/state/model.shared';
import type { StateBackend } from '../kernel/providers/contracts';
import { applyOp } from '../kernel/state/ops.shared';
import { emptyState } from '../kernel/state/model.shared';
import { installDOM } from './dom';

/** An independent persisted copy: detect a divergent optimistic state using the real reducer. */
export function memoryBackend(seed = emptyState()) {
  let state = structuredClone(seed);
  const writes: { op: Op; next: ReviewState }[] = [];
  const backend: StateBackend = {
    kind: 'browser',
    load: async () => structuredClone(state),
    apply(op, next) {
      state = applyOp(state, op);
      writes.push({ op: structuredClone(op), next: structuredClone(next) });
    },
    layouts: async () => ({ layouts: {}, default: null }),
    saveLayout: async () => true,
    setDefaultLayout: async () => true,
    lastLayout: async () => null,
    saveLastLayout: async () => {},
  };
  return { backend, writes, persisted: () => structuredClone(state) };
}

/** Mount actual author elements and optionally the real walkthrough panel, without a dock or full boot. */
export async function mountReview(html: string, storage = memoryBackend()) {
  const dom = installDOM();
  try {
    const [{ ReviewApp }, { StaticProvider }, elements, { panelDef }] = await Promise.all([
      import('../app'), import('../review/providers/static'), import('../review/elements'), import('../kernel/dock'),
    ]);
    await import('../review/walkthrough');
    const root = document.createElement('rr-app');
    const doc = document.createElement('rr-review');
    // Parse detached: provide the current app before custom-element connection callbacks.
    doc.innerHTML = html;
    const app = new ReviewApp(root);
    app.doc = doc;
    app.meta = { id: 'integration', title: 'Integration review', base: 'base', head: 'head' };
    app.range = { base: 'base', head: 'head', key: 'all', label: 'All changes' };
    app.provider = new StaticProvider({ meta: app.meta, files: [{ path: 'src/change.ts', status: 'modified', additions: 1, deletions: 1 }], contents: { 'head:src/change.ts': 'export const changed = true;' } });
    app.backend = storage.backend;
    app.state = (await storage.backend.load()) ?? emptyState();
    app.viewRound = app.state.round;
    app.files = await app.provider.files(app.range);
    elements.provideApp(app);
    elements.defineElements();
    root.append(doc);
    document.body.append(root);
    return {
      app, doc, root, storage, window: dom.window,
      mountWalkthroughPanel() {
        const panel = panelDef('narrative')!.create(app, {}, 'narrative');
        root.append(panel.element);
        app.onDispose(() => panel.dispose?.());
        return panel;
      },
      dispose() {
        app.dispose();
        root.remove();
        dom.restore();
      },
    };
  } catch (error) {
    dom.restore();
    throw error;
  }
}
