import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lostHub } from './hub.ts';

test('a hub leaves only when hub.json is gone or names another hub; an unreadable or half-written one proves nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-hub-owner-'));
  const before = process.env.REVIEWROOM_HOME;
  process.env.REVIEWROOM_HOME = home;
  const file = path.join(home, 'hub.json');
  try {
    expect(lostHub(1)).toBe(true); // gone
    fs.writeFileSync(file, JSON.stringify({ pid: 1 }));
    expect(lostHub(1)).toBe(false);
    expect(lostHub(2)).toBe(true); // taken over
    fs.writeFileSync(file, '{"pid":');
    expect(lostHub(2)).toBe(false); // half written
    fs.writeFileSync(file, JSON.stringify({ pid: 'x' }));
    expect(lostHub(2)).toBe(false); // not a record
    for (const pid of [0, -1, 1.5]) {
      fs.writeFileSync(file, JSON.stringify({ pid }));
      expect(lostHub(2)).toBe(false); // not a hub's pid
    }
    fs.writeFileSync(file, JSON.stringify({ pid: 3 }));
    fs.chmodSync(file, 0o000);
    if (process.getuid?.() !== 0) expect(lostHub(1)).toBe(false); // EACCES
  } finally {
    fs.chmodSync(file, 0o600);
    if (before === undefined) delete process.env.REVIEWROOM_HOME; else process.env.REVIEWROOM_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
