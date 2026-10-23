import { afterAll, afterEach, expect, test } from 'bun:test';
import { installDOM } from '../../testing/dom';
import { memoryBackend } from '../../testing/mount-review';
import type { LastLayout } from './layout.shared';

// The layout client against a real dockview in JSDOM. Panels are stand-ins under reviewroom's ids: what's under test
// is where they go, not what they draw.
const dom = installDOM();
const { ReviewApp } = await import('../../app');
const dock = await import('../dock');
const L = await import('./layout');

const OWN = ['narrative', 'code', 'files', 'toc', 'threads', 'ci', 'description'];
const real = [...OWN, 'agent-chart', 'pin'].map((id) => dock.panelDef(id));
const stub = (id: string, extra = {}) => dock.definePanel({ id, title: id, create: () => ({ element: document.createElement('div') }), ...extra });
for (const id of OWN) stub(id);
stub('agent-chart'); // an agent's own panel: no layout names it
stub('pin', { onDemand: true });
afterAll(() => {
  for (const d of real) if (d) dock.definePanel(d);
  dom.restore();
});

let app: InstanceType<typeof ReviewApp> | undefined;
afterEach(() => { app?.dispose(); app = undefined; });

type Opts = { saved?: LastLayout | null; layoutAttr?: string; availability?: { ids: string[]; isAvailable(id: string): boolean } };
function mount(o: Opts = {}) {
  app?.dispose();
  const root = document.createElement('rr-app');
  if (o.layoutAttr) root.setAttribute('layout', o.layoutAttr);
  document.body.append(root);
  app = new ReviewApp(root);
  const lastSaved: LastLayout[] = [];
  app.backend = { ...memoryBackend().backend, saveLastLayout: async (l) => void lastSaved.push(l) };
  const toasts: string[] = [];
  app.bus.on('toast', (t) => toasts.push(`${t.kind}: ${t.text}`));
  const host = document.createElement('div');
  root.append(host);
  L.mountDock(app, host, o.saved ?? null, { panelAvailability: o.availability });
  return { app, toasts, lastSaved };
}
type Tree = string | Tree[];
const tree = (n: { type: string; data: unknown }): Tree => (n.type === 'leaf' ? (n.data as { views: string[] }).views.join(',') : (n.data as typeof n[]).map(tree));
/** The docked panels as the grid nests them (rows and columns alternate), tab stacks joined by commas. */
const docked = (a = app!) => tree((a.dock.toJSON().grid as unknown as { root: { type: string; data: unknown } }).root);
const floating = (a = app!) => (a.dock.toJSON().floatingGroups ?? []).map((f) => f.data!.views.join(','));
// dockview reports layout changes asynchronously; the save machine reads the dock 250 ms after the last one
const settled = () => new Promise((r) => setTimeout(r, 300));

const READING = [['toc', 'files,threads,ci'], ['description', 'narrative,agent-chart'], 'code'];
const CODE_FOCUS = ['files,toc', 'code', ['description', 'narrative,agent-chart', 'threads,ci']];

test('a review starts in its default layout, else its layout attribute, else Reading', async () => {
  expect(docked(mount().app)).toEqual(READING);
  expect(docked(mount({ layoutAttr: 'code-focus' }).app)).toEqual(CODE_FOCUS);
  expect(docked(mount({ layoutAttr: 'nope' }).app)).toEqual(READING);
  const a = mount().app;
  a.layouts.desk = { title: 'Desk', root: { tabs: ['code'] } };
  a.defaultLayout = 'desk';
  L.resetLayout(a);
  // the default comes first; a layout without the walkthrough still builds, an agent's panel at the dock's edge
  expect(docked(a)).toEqual(['agent-chart', 'code']);
});

test('applyLayout builds the named layout; on-demand panels stay out', () => {
  const { app } = mount();
  expect(L.applyLayout(app, 'nope')).toBe(false);
  expect(L.applyLayout(app, 'code-focus')).toBe(true);
  expect(docked(app)).toEqual(CODE_FOCUS);
  expect(app.dock.getPanel('pin')).toBeUndefined();
  expect(app.dock.activePanel?.id).toBe('narrative');
});

test('undo goes back through layout changes, and brings back the layout they were built from', async () => {
  const { app, lastSaved } = mount();
  expect(L.canUndoLayout(app)).toBe(false);
  L.applyLayout(app, 'code-focus');
  await settled();
  expect(L.canUndoLayout(app)).toBe(true);
  expect(lastSaved.at(-1)?.layout).toBe('code-focus');
  L.undoLayout(app);
  expect(docked(app)).toEqual(READING);
  expect(L.canUndoLayout(app)).toBe(false);
  await settled();
  expect(lastSaved.at(-1)?.layout).toBe('reading');
  // a closed panel comes back where Reading (the layout undone to) puts it, not where Code focus did
  dock.closePanel(app, 'files');
  L.ensurePanel(app, 'files');
  expect(docked(app)).toEqual([['toc', 'threads,ci,files'], ['description', 'narrative,agent-chart'], 'code']);
});

test('a saved dock comes back as it was, with its layout; a broken one falls back to the starting layout', () => {
  const first = mount().app;
  L.applyLayout(first, 'code-focus');
  dock.closePanel(first, 'toc');
  const saved: LastLayout = { dock: first.dock.toJSON(), offered: [], layout: 'code-focus' };
  const { app } = mount({ saved });
  expect(docked(app)).toEqual(['files', 'code', ['description', 'narrative,agent-chart', 'threads,ci']]);
  dock.closePanel(app, 'code');
  L.ensurePanel(app, 'code'); // where the restored layout puts it
  expect(docked(app)[1]).toBe('code');
  expect(docked(mount({ saved: { dock: { grid: 'garbage' }, offered: [], layout: 'code-focus' } as unknown as LastLayout }).app)).toEqual(READING);
});

test('saving a layout: a usable new name is stored and becomes a command; anything else is refused with a reason', async () => {
  const { app, toasts } = mount();
  expect(await L.saveLayout(app, '???')).toBe(false);
  expect(await L.saveLayout(app, 'Reading')).toBe(false);
  expect(toasts).toEqual(['error: Name it with some letters or digits', 'error: “Reading” is taken: pick another name']);
  expect(await L.saveLayout(app, 'My Desk')).toBe(true);
  expect(app.layouts['my-desk'].title).toBe('My Desk');
  expect(toasts.at(-1)).toBe('info: Saved layout “My Desk”');
  expect(app.commands.all().some((c) => c.id === 'layout.my-desk')).toBe(true);
  expect(Object.keys(L.layouts(app)).at(-1)).toBe('my-desk');
  L.applyLayout(app, 'my-desk');
  expect(docked(app)).toEqual(READING);
  app.backend.saveLayout = async () => false;
  expect(await L.saveLayout(app, 'Other')).toBe(false);
  expect(toasts.at(-1)).toBe('error: Could not save the layout');
  app.dock.clear();
  expect(await L.saveLayout(app, 'Empty')).toBe(false);
  expect(toasts.at(-1)).toBe('error: Nothing to save: no panels are open');
});

test('the default layout: set when saving as default, cleared when forgotten or deleted', async () => {
  const { app, toasts } = mount();
  expect(await L.saveLayout(app, 'Desk', true)).toBe(true);
  expect(app.defaultLayout).toBe('desk');
  expect(await L.setDefaultLayout(app, null)).toBe(true);
  expect([app.defaultLayout, toasts.at(-1)]).toEqual([null, 'info: No default layout: new reviews start from their built-in layout']);
  await L.setDefaultLayout(app, 'desk');
  await L.deleteLayout(app, 'desk');
  expect([app.layouts.desk, app.defaultLayout, toasts.at(-1)]).toEqual([undefined, null, 'info: Deleted layout “Desk”']);
  app.backend.setDefaultLayout = async () => false;
  expect(await L.setDefaultLayout(app, null)).toBe(false);
  expect(toasts.at(-1)).toBe('error: Could not change the default layout');
});

test('a conditional panel waits for its provider, is offered once where the layout puts it, and is no undo step', async () => {
  let ready = false;
  const { app } = mount({ availability: { ids: ['ci'], isAvailable: () => ready } });
  expect(app.dock.getPanel('ci')).toBeUndefined();
  L.offerAvailablePanels(app);
  expect(app.dock.getPanel('ci')).toBeUndefined();
  ready = true;
  L.offerAvailablePanels(app);
  expect(docked(app)).toEqual(READING);
  await settled();
  expect(L.canUndoLayout(app)).toBe(false);
  dock.closePanel(app, 'ci');
  L.offerAvailablePanels(app); // closed by the reviewer: not offered again
  expect(app.dock.getPanel('ci')).toBeUndefined();
});

test('floating a panel leaves a stand-in in its place; putting it back returns it there', () => {
  const { app } = mount();
  dock.floatInPlace(app, 'files');
  expect([docked(app)[0], floating(app)]).toEqual([['toc', 'slot:files,threads,ci'], ['files']]);
  dock.putBack(app, 'files');
  expect([docked(app), floating(app)]).toEqual([READING, []]);
});

test('a passing panel floated over the layout is not saved as the layout, nor into a new one', async () => {
  const { app, lastSaved } = mount();
  L.passingPanels(app).add('code');
  dock.floatInPlace(app, 'code');
  await settled();
  expect(lastSaved).toEqual([]);
  expect(await L.saveLayout(app, 'Desk')).toBe(true);
  expect(JSON.stringify(app.layouts.desk.root)).not.toContain('slot:');
  expect(JSON.stringify(app.layouts.desk.root)).toContain('code');
});
