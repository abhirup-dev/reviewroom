import type { ChangedFile, Commit, DiffRange, ReviewMeta, SearchHit } from '../kernel/state/model.shared';
import type { CodeProvider } from '../kernel/providers/contracts';

interface CodeServiceDeps {
  provider: () => Pick<CodeProvider, 'read' | 'search'>;
  range: () => DiffRange;
  meta: () => Pick<ReviewMeta, 'base' | 'head'>;
  commits: () => readonly Pick<Commit, 'sha' | 'short' | 'subject'>[];
  files: () => readonly Pick<ChangedFile, 'path' | 'status'>[];
}

/** Code access for one review. Getters keep data live; reads stay cached by revision and path. */
export function createCodeService(deps: CodeServiceDeps) {
  const cache = new Map<string, Promise<string | null>>();

  function revFor(side: 'base' | 'head', range = deps.range()) {
    return side === 'base' ? range.base : range.head;
  }

  /** A ref's rev ('base' | 'head' | sha) as a concrete revision. */
  function revOf(rev: string) {
    return rev === 'base' || rev === 'head' ? revFor(rev) : rev;
  }

  function read(path: string, rev: string): Promise<string | null> {
    const key = rev + ':' + path;
    let p = cache.get(key);
    if (!p) {
      p = deps.provider().read(path, rev).catch((e) => {
        console.warn(e);
        return null;
      });
      cache.set(key, p);
    }
    return p;
  }

  function ranges(): DiffRange[] {
    const meta = deps.meta();
    const all: DiffRange = { base: meta.base, head: meta.head, label: 'All changes', key: 'all' };
    return [all, ...deps.commits().map((c) => ({ base: c.sha + '^', head: c.sha, label: `${c.short} · ${c.subject}`, key: c.sha }))];
  }

  async function search(q: string, symbol = false): Promise<SearchHit[]> {
    const rev = deps.range().head;
    const provider = deps.provider();
    if (provider.search) {
      try {
        return await provider.search(q, { rev, symbol, limit: 60 });
      } catch (e) {
        console.warn('provider search failed, falling back to changed files', e);
      }
    }
    // Fallback: scan changed files at head.
    const hits: SearchHit[] = [];
    const def = new RegExp(`\\b(func|type|class|def|interface|const|let|var|struct|enum|message|service)\\s+(\\([^)]*\\)\\s*)?${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (const f of deps.files()) {
      if (f.status === 'deleted') continue;
      const text = await read(f.path, rev);
      text?.split('\n').forEach((line, i) => {
        if (!line.includes(q)) return;
        const isDef = def.test(line);
        if (symbol && !isDef && !new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line)) return;
        hits.push({ path: f.path, line: i + 1, text: line.trim(), rev, kind: isDef ? 'definition' : 'reference' });
      });
    }
    return hits.sort((a, b) => (a.kind === 'definition' ? -1 : 0) - (b.kind === 'definition' ? -1 : 0)).slice(0, 80);
  }

  return { revFor, revOf, read, ranges, search };
}

export type CodeService = ReturnType<typeof createCodeService>;
