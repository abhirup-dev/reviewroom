import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import { dirForEdit } from './config.ts';

test('opening a review migrates legacy reports and snapshots once, preserving current reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-migrate-report-'));
  try {
    expect(REPORT_FILE).toBe('report.html');
    for (const folder of [dir, path.join(dir, 'rounds', '1'), path.join(dir, 'rounds', '2')]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'review.html'), 'legacy');
    }
    const current = path.join(dir, 'rounds', '2', REPORT_FILE);
    fs.writeFileSync(current, 'current');
    expect(dirForEdit(null, dir, REPORT_FILE)).toBe(dir);
    expect(dirForEdit(null, dir, REPORT_FILE)).toBe(dir);
    for (const folder of [dir, path.join(dir, 'rounds', '1')]) {
      expect(fs.readFileSync(path.join(folder, REPORT_FILE), 'utf8')).toBe('legacy');
      expect(fs.existsSync(path.join(folder, 'review.html'))).toBe(false);
    }
    expect(fs.readFileSync(current, 'utf8')).toBe('current');
    expect(fs.readFileSync(path.join(dir, 'rounds', '2', 'review.html'), 'utf8')).toBe('legacy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
