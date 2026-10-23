// Legacy parity: failed reads stay cached indefinitely, matching the pre-extraction app.
// Revisit with the retry/cache-invalidation contract; this is not a preferred failure policy.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createCodeService } from '../code-service';

afterEach(() => mock.restore());

test('caches failed and missing reads without retries', async () => {
  const error = new Error('unavailable');
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const read = mock(async (path: string) => {
    if (path === 'failed') throw error;
    return null;
  });
  const code = createCodeService({
    provider: () => ({ read }),
    range: () => ({ base: 'base', head: 'head', label: 'All changes', key: 'all' }),
    meta: () => ({ base: 'base', head: 'head' }),
    commits: () => [],
    files: () => [],
  });
  for (const path of ['failed', 'missing']) {
    const pending = code.read(path, 'head');
    expect(await pending).toBeNull();
    expect(code.read(path, 'head')).toBe(pending);
  }
  expect(read).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls).toEqual([[error]]);
});

