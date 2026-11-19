// startDetached owns the child it spawns until that child is ready: a stand-in entry plays the review server.
import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { startDetached } from './registry.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-registry-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// argv: <entry> start <dir> --foreground --repo <repo>: it notes its pid, and registers after `delay` ms (never if < 0)
const entry = (name: string, delay: number) => {
  const file = path.join(tmp, `${name}.js`);
  fs.writeFileSync(file, `const fs = require('fs'), path = require('path'); const dir = process.argv[3];
fs.writeFileSync(path.join(dir, 'child.pid'), String(process.pid));
if (${delay} >= 0) setTimeout(() => fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: process.pid, port: 1, url: 'http://127.0.0.1:1/', startedAt: '' })), ${delay});
setInterval(() => {}, 1000);`);
  return file;
};
const folder = (name: string) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  return dir;
};

test('ready means its own child registered: a server.json naming another live process is not it', async () => {
  const dir = folder('other');
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: process.pid, port: 2, url: 'http://127.0.0.1:2/', startedAt: '' }));
  const error = await startDetached(tmp, dir, [], entry('never', -1), 600).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ReviewroomError);
  expect(error).toHaveProperty('message', expect.stringContaining('server did not start'));
  expect(alive(+fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'))).toBe(false); // killed and reaped, not left behind
});

test('a slow start is waited for, and its record returned', async () => {
  const dir = folder('slow');
  const rec = await startDetached(tmp, dir, [], entry('slow', 700), 5000);
  const pid = +fs.readFileSync(path.join(dir, 'child.pid'), 'utf8');
  expect(rec).toMatchObject({ server: { pid }, started: true });
  process.kill(pid, 'SIGKILL');
});
