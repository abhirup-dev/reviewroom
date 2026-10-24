import type { ChangedFile, Commit, DiffRange, Rev } from '../../kernel/state/model.shared';
import type { CodeProvider } from '../../kernel/providers/contracts';
import { json } from '../../kernel/providers/fetch';

// File contents come from raw.githubusercontent.com (not the REST API), so a
// review costs ~2 API calls (compare + commits) regardless of PR size.

/** The fields of GitHub's compare response that are read here. */
type Compare = {
  commits: { sha: string; commit: { message: string; author: { name?: string; date?: string } | null } }[];
  files: { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }[];
};

export class GitHubProvider implements CodeProvider {
  readonly name = 'github';
  private cmp?: Compare;
  constructor(private repo: string, private base: string, private head: string, private token?: string) {}
  private gh(path: string): Promise<Compare> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(`https://api.github.com/repos/${this.repo}${path}`, { headers }).then(json);
  }
  private async compare() {
    return (this.cmp ??= await this.gh(`/compare/${encodeURIComponent(this.base)}...${encodeURIComponent(this.head)}`));
  }
  async meta() {
    return { repo: this.repo };
  }
  async commits(): Promise<Commit[]> {
    const c = await this.compare();
    return c.commits.map((x) => ({ sha: x.sha, short: x.sha.slice(0, 7), subject: x.commit.message.split('\n')[0], author: x.commit.author?.name, date: x.commit.author?.date }));
  }
  private compareFor(range: DiffRange) {
    return range.base === this.base && range.head === this.head ? this.compare() : this.gh(`/compare/${range.base}...${range.head}`);
  }
  async files(range: DiffRange): Promise<ChangedFile[]> {
    const c = await this.compareFor(range);
    const st: Record<string, ChangedFile['status']> = { added: 'added', removed: 'deleted', renamed: 'renamed', modified: 'modified', changed: 'modified' };
    return c.files.map((f) => ({ path: f.filename, prevPath: f.previous_filename, status: st[f.status] ?? 'modified', additions: f.additions, deletions: f.deletions }));
  }
  async read(path: string, rev: Rev) {
    const r = await fetch(`https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(rev)}/${path}`);
    return r.ok ? r.text() : null;
  }
  /** From the compare response's per-file hunks: no request beyond the one files() made. GitHub leaves out big and binary files' hunks; those are read. */
  async patch(range: DiffRange, ws: boolean) {
    if (ws) return null; // GitHub's hunks can't ignore whitespace
    return (await this.compareFor(range)).files
      .filter((f) => f.patch)
      .map((f) => {
        const old = f.previous_filename ?? f.filename;
        return `diff --git a/${old} b/${f.filename}\n--- ${f.status === 'added' ? '/dev/null' : 'a/' + old}\n+++ ${f.status === 'removed' ? '/dev/null' : 'b/' + f.filename}\n${f.patch}\n`;
      })
      .join('');
  }
}

