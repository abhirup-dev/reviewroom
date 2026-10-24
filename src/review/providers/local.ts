import type { DiffRange, Rev } from '../../kernel/state/model.shared';
import type { CodeProvider } from '../../kernel/providers/contracts';
import { json } from '../../kernel/providers/fetch';

export class LocalProvider implements CodeProvider {
  readonly name = 'local';
  constructor(private api = 'api') {}
  meta() {
    return fetch(`${this.api}/meta`).then(json);
  }
  commits() {
    return fetch(`${this.api}/commits`).then(json);
  }
  files(range: DiffRange) {
    return fetch(`${this.api}/files?base=${encodeURIComponent(range.base)}&head=${encodeURIComponent(range.head)}`).then(json);
  }
  async read(path: string, rev: Rev) {
    const r = await fetch(`${this.api}/read?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`read ${path}@${rev}: ${r.status}`);
    return r.text();
  }
  async patch(range: DiffRange, ws: boolean) {
    const r = await fetch(`${this.api}/patch?base=${encodeURIComponent(range.base)}&head=${encodeURIComponent(range.head)}${ws ? '&ws=1' : ''}`);
    return r.ok ? r.text() : null;
  }
  search(q: string, o: { rev: Rev; symbol?: boolean; limit?: number }) {
    const p = new URLSearchParams({ q, rev: o.rev, symbol: o.symbol ? '1' : '', limit: String(o.limit ?? 50) });
    return fetch(`${this.api}/search?${p}`).then(json);
  }
  tree(rev: Rev) {
    return fetch(`${this.api}/tree?rev=${encodeURIComponent(rev)}`).then(json);
  }
  static async detect(api = 'api'): Promise<LocalProvider | null> {
    try {
      const r = await fetch(`${api}/meta`, { headers: { accept: 'application/json' } });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return new LocalProvider(api);
    } catch {
      /* no server */
    }
    return null;
  }
}

