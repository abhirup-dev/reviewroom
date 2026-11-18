import { REPORT_FILE } from '../../src/kernel/state/files.shared.ts';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProgress, artifactHash, progressLines, readProgress, recordArtifact } from './progress.ts';

test('writers deduplicate bytes and validation retains the bytes checked, not a later edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
  try {
    appendProgress(dir, { artifact: 'report', event: 'requested', by: 'agent' });
    const file = path.join(dir, REPORT_FILE);
    fs.writeFileSync(file, '<rr-app><rr-review><section id="summary"><section id="nested"></section></section></rr-review></rr-app>');
    recordArtifact(dir, 'report', 'written');
    recordArtifact(dir, 'report', 'written');
    expect(progressLines(dir)).toHaveLength(2);
    expect(readProgress(dir).report).toMatchObject({ state: 'writing' });
    const checked = artifactHash(dir, 'report');
    fs.appendFileSync(file, 'changed while checking');
    recordArtifact(dir, 'report', 'validated', {}, checked);
    expect(readProgress(dir).report.state).toBe('writing');
    recordArtifact(dir, 'report', 'validated');
    expect(readProgress(dir).report.state).toBe('validated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
