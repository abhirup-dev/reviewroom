// Extraction wiring: services see the app's live state, and boot can replace one capability.
// Consolidate only when the permanent public-contract suite covers these seams.
import { afterAll, expect, mock, test } from 'bun:test';
import { fixture, type Fixture } from '../testing/fixture';
import { build } from '../testing/build';
import { memoryBackend } from '../testing/mount-review';
import { createReviewServices } from '../services';
import { installDOM } from '../testing/dom';

// the app's modules touch the DOM as they load
const dom = installDOM();
const { ReviewApp } = await import('../app');
afterAll(() => dom.restore());

function reviewApp(t: Fixture, createServices = createReviewServices) {
  const app = new ReviewApp(document.createElement('div'), createServices);
  t.defer(() => app.dispose());
  const storage = memoryBackend();
  app.backend = storage.backend;
  return { app, writes: storage.writes };
}

test('services observe replaced state through live getters', () => {
  using t = fixture();
  const { app, writes } = reviewApp(t);
  const changes = mock(() => {});
  app.bus.on('state', changes);
  app.state = build.state({ round: 7 });
  const thread = app.services.threads.createThread({ kind: 'general' }, 'New round');
  if (!thread || thread instanceof Promise) throw new Error('Expected a local thread');
  expect(thread.messages[0].round).toBe(7);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(1);
});

test('the composition factory can replace one capability without changing the shell', async () => {
  using t = fixture();
  const read = mock(async (_path: string, _rev: string) => 'injected content');
  const { app } = reviewApp(t, (deps) => {
    const services = createReviewServices(deps);
    return { ...services, code: { ...services.code, read } };
  });
  expect(await app.services.code.read('file.ts', 'head')).toBe('injected content');
  expect(read).toHaveBeenCalledWith('file.ts', 'head');
});
