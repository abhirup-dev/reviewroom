import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ChangedFile, Commit, ReviewMeta, SearchHit } from '../kernel/state/model.shared';
import type { CodeProvider } from '../kernel/providers/contracts';
import { createCodeService } from './code-service';

function fixture() {
  const data = {
    provider: { read: mock(async (_path: string, _rev: string): Promise<string | null> => null) } as Pick<CodeProvider, 'read' | 'search'>,
    range: { base: 'base-1', head: 'head-1', label: 'Current', key: 'current' },
    meta: { base: 'root', head: 'tip' } as Pick<ReviewMeta, 'base' | 'head'>,
    commits: [] as Commit[],
    files: [] as Pick<ChangedFile, 'path' | 'status'>[],
  };
  const code = createCodeService({
    provider: () => data.provider,
    range: () => data.range,
    meta: () => data.meta,
    commits: () => data.commits,
    files: () => data.files,
  });
  return { data, code };
}

afterEach(() => mock.restore());

describe('code access', () => {
  test('shares in-flight reads and caches by revision and path', async () => {
    const { data, code } = fixture();
    let finish!: (text: string) => void;
    const read = mock(() => new Promise<string>((resolve) => { finish = resolve; }));
    data.provider = { read };
    const pending = code.read('a.ts', 'one');
    expect(code.read('a.ts', 'one')).toBe(pending);
    expect(read).toHaveBeenCalledTimes(1);
    finish('contents');
    expect(await pending).toBe('contents');
    expect(code.read('a.ts', 'one')).toBe(pending);

    const nextRead = mock(async (_path: string, _rev: string) => 'other');
    data.provider = { read: nextRead };
    expect(await code.read('a.ts', 'two')).toBe('other');
    expect(await code.read('b.ts', 'one')).toBe('other');
    expect(await code.read('a.ts', 'one')).toBe('contents');
    expect(nextRead.mock.calls).toEqual([['a.ts', 'two'], ['b.ts', 'one']]);
  });

  test('resolves aliases from live ranges while keeping explicit revisions', () => {
    const { data, code } = fixture();
    expect(code.revFor('base')).toBe('base-1');
    expect(code.revOf('head')).toBe('head-1');
    data.range = { ...data.range, base: 'base-2', head: 'head-2' };
    expect(code.revOf('base')).toBe('base-2');
    expect(code.revFor('head')).toBe('head-2');
    expect(code.revFor('base', { ...data.range, base: 'explicit' })).toBe('explicit');
    expect(code.revOf('abc123')).toBe('abc123');
  });

  test('builds all-changes and per-commit ranges from live metadata', () => {
    const { data, code } = fixture();
    expect(code.ranges()).toEqual([{ base: 'root', head: 'tip', label: 'All changes', key: 'all' }]);
    data.meta = { base: 'new-root', head: 'new-tip' };
    data.commits = [
      { sha: 'second', short: 'sec', subject: 'Second' },
      { sha: 'first', short: 'fir', subject: 'First' },
    ];
    expect(code.ranges()).toEqual([
      { base: 'new-root', head: 'new-tip', label: 'All changes', key: 'all' },
      { base: 'second^', head: 'second', label: 'sec · Second', key: 'second' },
      { base: 'first^', head: 'first', label: 'fir · First', key: 'first' },
    ]);
  });
});

describe('code search', () => {
  test('uses provider search with its receiver, live head, and the provider limit', async () => {
    const { data, code } = fixture();
    const hits: SearchHit[] = [{ path: 'outside.ts', line: 3, text: 'needle', rev: 'head-2' }];
    const read = mock(async () => 'needle');
    const search = mock(async function (this: Pick<CodeProvider, 'read' | 'search'>, _q: string, _opts: unknown) {
      expect(this).toBe(data.provider);
      return hits;
    });
    data.provider = { read, search };
    data.range = { ...data.range, head: 'head-2' };
    expect(await code.search('needle', true)).toBe(hits);
    expect(search).toHaveBeenCalledWith('needle', { rev: 'head-2', symbol: true, limit: 60 });
    search.mockResolvedValue([]);
    expect(await code.search('needle')).toEqual([]);
    expect(search).toHaveBeenLastCalledWith('needle', { rev: 'head-2', symbol: false, limit: 60 });
    expect(read).not.toHaveBeenCalled();
  });

  test.each([false, true])('scans changed files when provider search throws: %s', async (throws) => {
    const { data, code } = fixture();
    const error = new Error('search unavailable');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const read = mock(async (path: string, _rev: string) => path === 'a.ts' ? '  needle();\nconst needle = 1;\nneedles();' : null);
    data.provider = { read, ...(throws ? { search: async () => { throw error; } } : {}) };
    data.files = [{ path: 'a.ts', status: 'modified' }, { path: 'deleted.ts', status: 'deleted' }, { path: 'missing.ts', status: 'added' }];
    expect(await code.search('needle', true)).toEqual([
      { path: 'a.ts', line: 2, text: 'const needle = 1;', rev: 'head-1', kind: 'definition' },
      { path: 'a.ts', line: 1, text: 'needle();', rev: 'head-1', kind: 'reference' },
    ]);
    expect(read.mock.calls).toEqual([['a.ts', 'head-1'], ['missing.ts', 'head-1']]);
    expect((await code.search('needle')).map((hit) => hit.line)).toEqual([2, 1, 3]);
    expect(read).toHaveBeenCalledTimes(2);
    if (throws) expect(warn).toHaveBeenCalledWith('provider search failed, falling back to changed files', error);
    else expect(warn).not.toHaveBeenCalled();
  });

  test('escapes symbol metacharacters and recognizes Go receiver definitions', async () => {
    const { data, code } = fixture();
    data.provider = { read: async () => 'func (r Receiver) a.b() {}\na.b();\naXb();' };
    data.files = [{ path: 'a.go', status: 'modified' }];
    expect((await code.search('a.b', true)).map(({ line, kind }) => ({ line, kind }))).toEqual([
      { line: 1, kind: 'definition' }, { line: 2, kind: 'reference' },
    ]);
  });

  test('limits fallback results after ranking definitions and reads live files at head', async () => {
    const { data, code } = fixture();
    const read = mock(async (path: string) => path === 'refs.ts' ? Array(81).fill('needle();').join('\n') : 'class needle {}');
    data.provider = { read };
    data.files = [{ path: 'refs.ts', status: 'added' }, { path: 'def.ts', status: 'added' }];
    const hits = await code.search('needle');
    expect(hits).toHaveLength(80);
    expect(hits[0]).toMatchObject({ path: 'def.ts', kind: 'definition' });
    expect(hits.at(-1)).toMatchObject({ path: 'refs.ts', line: 79 });
    data.range = { ...data.range, head: 'next' };
    data.files = [{ path: 'other.ts', status: 'renamed' }];
    expect(await code.search('needle')).toEqual([{ path: 'other.ts', line: 1, text: 'class needle {}', rev: 'next', kind: 'definition' }]);
    expect(read).toHaveBeenLastCalledWith('other.ts', 'next');
  });
});
