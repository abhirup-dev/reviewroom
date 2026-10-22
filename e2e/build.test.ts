// The build id and the service worker's precache list (scripts/build.ts).
import { expect, test } from 'bun:test';
import fs from 'node:fs';

const dist = new URL('../dist/', import.meta.url).pathname;
const id = () => JSON.parse(fs.readFileSync(dist + 'build-info.json', 'utf8')).id;

test('the worker carries the build id and precaches only files that exist', () => {
  const sw = fs.readFileSync(dist + 'sw.js', 'utf8');
  expect(id()).toMatch(/^[0-9a-f]{12}$/);
  expect(sw).toContain(id());
  const list: string[] = JSON.parse(sw.match(/\["\/_rr\/[^\]]*\]/)![0]);
  expect(list).toContain('/_rr/reviewroom.js');
  for (const p of list) expect(fs.existsSync(dist + p.slice('/_rr/'.length))).toBe(true);
});

test('rebuilding the same source gives the same id', () => {
  const before = id();
  // as `bun run build` does: from the package root (chunk hashes follow the cwd) and without bun test's NODE_ENV=test
  const { NODE_ENV: _, ...env } = process.env;
  expect(Bun.spawnSync(['bun', 'scripts/build.ts'], { cwd: new URL('..', import.meta.url).pathname, env }).exitCode).toBe(0);
  expect(id()).toBe(before);
});
