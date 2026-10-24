import type { ChangedFile, Commit, DiffRange, ReviewMeta, Rev } from '../../kernel/state/model.shared';
import type { CodeProvider } from '../../kernel/providers/contracts';

// <script type="application/json" id="rr-fixture">{ meta, commits, files, contents: { "<rev>:<path>": "..." } }</script>

export interface Fixture {
  meta: Partial<ReviewMeta>;
  commits?: Commit[];
  files: ChangedFile[] | Record<string, ChangedFile[]>; // keyed by "base..head" when per-commit file lists are provided
  contents: Record<string, string>;
}

export class StaticProvider implements CodeProvider {
  readonly name = 'static';
  constructor(private fx: Fixture) {}
  async meta() {
    return this.fx.meta;
  }
  async commits() {
    return this.fx.commits ?? [];
  }
  async files(range: DiffRange) {
    if (Array.isArray(this.fx.files)) return this.fx.files;
    return this.fx.files[`${range.base}..${range.head}`] ?? this.fx.files['all'] ?? [];
  }
  async read(path: string, rev: Rev) {
    return this.fx.contents[`${rev}:${path}`] ?? null;
  }
  async tree(rev: Rev) {
    return Object.keys(this.fx.contents)
      .filter((k) => k.startsWith(rev + ':'))
      .map((k) => k.slice(rev.length + 1));
  }
}

