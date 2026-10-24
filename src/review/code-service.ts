import type { ChangedFile, Commit, DiffRange, ReviewMeta, SearchHit } from '../kernel/state/model.shared';
import type { CodeProvider } from '../kernel/providers/contracts';
import type { Ref } from '../kernel/refs/refs.shared';
import type { Anchor } from '../kernel/state/schema.shared';
import { homeRange, showsOn, type StackSides } from '../kernel/anchors';

interface CodeServiceDeps {
  provider: () => Pick<CodeProvider, 'read' | 'search'>;
  range: () => DiffRange;
  meta: () => Pick<ReviewMeta, 'base' | 'head' | 'stack'>;
  commits: () => readonly Pick<Commit, 'sha' | 'short' | 'subject' | 'parent' | 'pr'>[];
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

  /** The ranges offered, and every range a thread can be made on: all changes (the whole stack), then in a stack each
   *  PR's layer before its commits (a thread on a layer's last commit is at the layer's lines too, and goes home to it). */
  function ranges(): DiffRange[] {
    const meta = deps.meta();
    const commit = (c: ReturnType<CodeServiceDeps['commits']>[number]): DiffRange => ({ base: c.parent ?? c.sha + '^', head: c.sha, label: `${c.short} · ${c.subject}`, key: c.sha, pr: c.pr });
    const stack = meta.stack;
    if (!stack) return [{ base: meta.base, head: meta.head, label: 'All changes', key: 'all' }, ...deps.commits().map(commit)];
    return [
      { base: meta.base, head: meta.head, label: `Whole stack · ${stack.length} PRs`, key: 'all' },
      ...stack.flatMap((p) => [prRange(p.number)!, ...deps.commits().filter((c) => c.pr === p.number).map(commit)]),
    ];
  }

  /** A stack PR's layer: from the head of the PR below to its own. */
  function prRange(n: number): DiffRange | undefined {
    const p = deps.meta().stack?.find((x) => x.number === n);
    return p && { base: p.base, head: p.head, label: `#${p.number} · ${p.title}`, key: `pr-${p.number}`, pr: p.number };
  }

  /** In a stack, a plain code or file link inside a `data-pr` element means that PR's layer, as `reviewroom check` reads it. */
  function inLayer(r: Ref, from?: Element | null): Ref {
    const n = deps.meta().stack && from?.closest('[data-pr]')?.getAttribute('data-pr');
    return n && (r.type === 'code' || r.type === 'file') && !r.pr && /^(base|head)$/.test(r.rev) ? { ...r, pr: +n } : r;
  }

  /** A code or file ref's revision: with @pr:<n>, that side of the PR's layer (undefined: no such PR in the stack). */
  function refRev(r: { rev: string; pr?: number }) {
    if (!r.pr) return revOf(r.rev);
    const l = prRange(r.pr);
    return l && revFor(r.rev === 'base' ? 'base' : 'head', l);
  }

  function stackSides(): StackSides {
    const meta = deps.meta();
    return meta.stack && { layers: meta.stack, all: meta };
  }

  /** Whether a code thread is drawn on the active range (or `range`): see src/kernel/anchors.ts. */
  function codeShows(a: Anchor, range: Pick<DiffRange, 'base' | 'head'> = deps.range()) {
    return a.kind === 'code' && showsOn(a, range, ranges(), stackSides());
  }

  /** The range a code thread was made on, while it exists. */
  function homeOf(a: Anchor) {
    return a.kind === 'code' ? homeRange(a, ranges(), stackSides()) : undefined;
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

  return { revFor, revOf, read, ranges, prRange, inLayer, refRev, codeShows, homeOf, search };
}

export type CodeService = ReturnType<typeof createCodeService>;
