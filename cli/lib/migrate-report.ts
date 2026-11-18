import fs from 'node:fs';
import path from 'node:path';
import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';

/** Rename legacy reports, including round snapshots, without overwriting a current report. */
export function migrateReport(dir: string): string {
  const rounds = path.join(dir, 'rounds');
  const dirs = [dir, ...(fs.existsSync(rounds) ? fs.readdirSync(rounds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => path.join(rounds, entry.name)) : [])];
  for (const folder of dirs) {
    const old = path.join(folder, 'review.html');
    const file = path.join(folder, REPORT_FILE);
    if (fs.existsSync(old) && !fs.existsSync(file)) fs.renameSync(old, file);
  }
  return dir;
}
