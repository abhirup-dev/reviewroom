import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildId } from './pwa.ts';

test('the build id follows a rebuild without a restart, and is absent while build-info.json is', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pwa-'));
  const f = path.join(dist, 'build-info.json');
  try {
    fs.writeFileSync(f, JSON.stringify({ id: 'first' }));
    expect(buildId(dist)).toBe('first');
    fs.writeFileSync(f, JSON.stringify({ id: 'rebuilt' }));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 1000)); // a rebuild within the same mtime tick still counts
    expect(buildId(dist)).toBe('rebuilt');
    fs.rmSync(f);
    expect(buildId(dist)).toBeUndefined();
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
