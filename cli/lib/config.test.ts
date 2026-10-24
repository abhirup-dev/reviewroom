import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirForEdit } from './config.ts';

test('dirForEdit: --dir works without a repo; `needs` refuses a dir without that file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-config-'));
  try {
    fs.writeFileSync(path.join(dir, 'review.html'), '');
    expect(dirForEdit(null, dir, 'review.html')).toBe(dir);
    expect(() => dirForEdit(null, dir, 'walkthrough.json')).toThrow(`no walkthrough.json in ${dir}`);
    expect(() => dirForEdit(null, undefined)).toThrow('not inside a git repository (use --dir)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
