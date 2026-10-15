import { expect, test } from 'bun:test';
import http from 'node:http';
import { listen } from './server.ts';

test('listen reports the port it fell back to when the first is taken', async () => {
  const taken = http.createServer();
  const p = await listen(taken, 4990);
  const s = http.createServer();
  expect(await listen(s, p)).toBe(s.address().port);
  expect(s.address().port).not.toBe(p);
  taken.close();
  s.close();
});
