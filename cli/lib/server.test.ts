import { expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { listen } from './server.ts';

test('listen reports the port it fell back to when the first is taken', async () => {
  const taken = http.createServer();
  const p = await listen(taken, 0); // a free port from the OS, so the test never collides with a real server
  const s = http.createServer();
  const port = () => (s.address() as AddressInfo).port;
  expect(await listen(s, p)).toBe(port());
  expect(port()).not.toBe(p);
  taken.close();
  s.close();
});
