import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistantStore } from './assistant-store';

test('a review restores message ids and quote metadata, privately, without sharing another review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-store-'));
  try {
    const store = assistantStore(dir, 'repo');
    const quote = { ref: 'rr:code/a.ts@abc#L2', text: 'x', label: 'a.ts:2', messageId: '' };
    store.saved.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'why?' }], metadata: { custom: { quote } } }];
    store.write();
    const restored = assistantStore(dir, 'repo');
    expect(restored.saved.messages).toEqual(store.saved.messages);
    expect(fs.statSync(path.join(dir, 'assistant.json')).mode & 0o777).toBe(0o600);
    expect(assistantStore(path.join(dir, 'another-review'), 'repo').saved.messages).toEqual([]);
    expect(() => assistantStore(dir, 'different-repo')).toThrow('another repository');
    fs.writeFileSync(path.join(dir, 'assistant.json'), '{broken');
    expect(() => assistantStore(dir, 'repo')).toThrow();
    expect(fs.readFileSync(path.join(dir, 'assistant.json'), 'utf8')).toBe('{broken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
