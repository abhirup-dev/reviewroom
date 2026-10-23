// Extraction parity: facade delegation, live getters and factory replacement.
// Consolidate only when the permanent public-contract suite covers these seams.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installDOM } from '../testing/dom';
import { createReviewServices } from '../services';
import { emptyState } from '../kernel/state/model.shared';

const dom = installDOM();
const { ReviewApp } = await import('../app');
const apps: InstanceType<typeof ReviewApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); });
afterAll(() => dom.restore());

function fixture(createServices = createReviewServices) {
  const app = new ReviewApp(document.createElement('div'), createServices);
  apps.push(app);
  const apply = mock(() => {});
  app.backend = {
    kind: 'browser', load: async () => null, apply,
    layouts: async () => ({ layouts: {}, default: null }),
    saveLayout: async () => true, setDefaultLayout: async () => true,
    lastLayout: async () => null, saveLastLayout: async () => {},
  };
  return { app, apply };
}

test('composed thread commands apply, notify and persist once through the public facade', () => {
  const { app, apply } = fixture();
  const changes = mock(() => {});
  app.bus.on('state', changes);
  const thread = app.createThread({ kind: 'general' }, 'First message');
  if (!thread || thread instanceof Promise) throw new Error('Local creation must be synchronous');
  expect(app.thread(thread.id)).toBe(thread);
  expect(app.services.threads.thread(thread.id)).toBe(thread);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
  void app.reply(thread.id, 'Second message');
  void app.setStatus(thread.id, 'resolved');
  expect(app.thread(thread.id)).toMatchObject({ status: 'resolved', messages: [{ body: 'First message' }, { body: 'Second message' }] });
  expect(changes).toHaveBeenCalledTimes(3);
  expect(apply).toHaveBeenCalledTimes(3);
});

test('services observe replaced state through live getters', () => {
  const { app, apply } = fixture();
  const changes = mock(() => {});
  app.bus.on('state', changes);
  app.state = { ...emptyState(), round: 7 };
  const thread = app.createThread({ kind: 'general' }, 'New round');
  if (!thread || thread instanceof Promise) throw new Error('Expected a local thread');
  expect(thread.messages[0].round).toBe(7);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
});

test('the composition factory can replace one capability without changing the shell', async () => {
  const read = mock(async (_path: string, _rev: string) => 'injected content');
  const { app } = fixture((deps) => {
    const services = createReviewServices(deps);
    return { ...services, code: { ...services.code, read } };
  });
  expect(await app.read('file.ts', 'head')).toBe('injected content');
  expect(read).toHaveBeenCalledWith('file.ts', 'head');
});
