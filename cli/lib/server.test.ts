import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { listen } from './server.ts';

test('listen falls back to the next port when the first is taken', () => {
  const app = new Hono();
  using taken = listen(app, 41000); // listen itself skips busy ports; away from the smoke test's 4900-4990
  using s = listen(app, taken.port!);
  expect(s.port).not.toBe(taken.port);
});
