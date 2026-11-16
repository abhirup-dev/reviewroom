import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProgress, artifactHash, progressLines, readProgress, recordArtifact } from './progress.ts';

test('writers deduplicate bytes and validation retains the bytes checked, not a later edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
  try {
    appendProgress(dir, { artifact: 'review', event: 'requested' });
    const file = path.join(dir, 'review.html');
    fs.writeFileSync(file, '<rr-app><rr-review><section id="summary"><section id="nested"></section></section></rr-review></rr-app>');
    recordArtifact(dir, 'review', 'written');
    recordArtifact(dir, 'review', 'written');
    expect(progressLines(dir)).toHaveLength(2);
    expect(readProgress(dir).review).toMatchObject({ state: 'written', sections: 1 });
    const checked = artifactHash(dir, 'review');
    fs.appendFileSync(file, 'changed while checking');
    recordArtifact(dir, 'review', 'validated', {}, checked);
    expect(readProgress(dir).review.state).toBe('written');
    recordArtifact(dir, 'review', 'validated');
    expect(readProgress(dir).review.state).toBe('validated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
