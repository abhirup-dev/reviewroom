import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirForEdit } from './config.ts';

test('dirForEdit: --dir works without a repo; `needs` refuses a dir without that file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-config-'));
  try {
    fs.writeFileSync(path.join(dir, REPORT_FILE), '');
    expect(dirForEdit(null, dir, REPORT_FILE)).toBe(dir);
    expect(() => dirForEdit(null, dir, WALKTHROUGH_FILE)).toThrow(`no ${WALKTHROUGH_FILE} in ${dir}`);
    expect(() => dirForEdit(null, undefined)).toThrow('not inside a git repository (use --dir)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
