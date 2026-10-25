import { describe, expect, test } from 'bun:test';
import { rekeyStorage } from './store';

const mem = (init: Record<string, string>) => {
  const m = new Map(Object.entries(init));
  const store = {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return { m, store };
};

describe('rekeyStorage', () => {
  test("moves a review's title-keyed layout and drafts to its id, leaving others alone", () => {
    const { m, store } = mem({
      'reviewroom:layout:o/r#Fix': 'L',
      'reviewroom:draft:o/r#Fix:t1': 'd1',
      'reviewroom:draft:o/r#Fix:{"kind":"general"}': 'd2',
      'reviewroom:draft:o/r#Other:t1': 'x',
      'reviewroom:prefs': 'p',
    });
    rekeyStorage('o/r#Fix', 'abc123', store);
    expect(Object.fromEntries(m)).toEqual({
      'reviewroom:layout:abc123': 'L',
      'reviewroom:draft:abc123:t1': 'd1',
      'reviewroom:draft:abc123:{"kind":"general"}': 'd2',
      'reviewroom:draft:o/r#Other:t1': 'x',
      'reviewroom:prefs': 'p',
    });
  });

  test('never overwrites what is already under the id, and is a no-op when the ids match', () => {
    const { m, store } = mem({ 'reviewroom:draft:T:t1': 'old', 'reviewroom:draft:id:t1': 'new' });
    rekeyStorage('T', 'T', store);
    expect(m.size).toBe(2);
    rekeyStorage('T', 'id', store);
    expect(Object.fromEntries(m)).toEqual({ 'reviewroom:draft:id:t1': 'new' });
  });
});
