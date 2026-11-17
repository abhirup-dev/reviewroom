import { expect, test } from 'bun:test';
import { assistantRoutes } from './assistant.ts';

test('the assistant takes only new messages: the native session cannot branch', async () => {
  const { app } = assistantRoutes({ repo: '.', dir: '.', cfg: { base: 'main', head: 'HEAD' } });
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'regenerate-message', messages: [] }) });
  expect(res.status).toBe(400);
});
