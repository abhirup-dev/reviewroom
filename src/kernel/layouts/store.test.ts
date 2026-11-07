import { describe, expect, test } from 'bun:test';
import { BrowserState } from '../providers/browser-state';
import { ServerState } from '../providers/server-state';
import { fixture, type Fixture } from '../../testing/fixture';
import type { LastLayout } from './layout.shared';

// The layout store over both backends: the browser's localStorage, and the server's routes (cli/lib/server.ts, which
// e2e/api.test.ts checks for real) answered from memory here.
function browser(t: Fixture) {
  const store = new Map<string, string>();
  t.global('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return { store, layouts: new BrowserState('r').layouts };
}
function server(t: Fixture) {
  const files: Record<string, unknown> = {};
  let def: string | null = null;
  let last: unknown = null;
  const ok = () => Response.json({ ok: true });
  t.global('fetch', async (url: string, init?: RequestInit) => {
    const route = url.replace('/test-api/', '');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (route === 'layout') return init?.method === 'PUT' ? ((last = body), ok()) : Response.json(last);
    if (route === 'layouts') return Response.json({ layouts: files, default: def });
    if (route === 'default-layout') return (def = body.layout), ok();
    const id = route.slice('layouts/'.length);
    if (init?.method === 'DELETE') return delete files[id], def === id && (def = null), ok();
    if (id === 'reading' || files[id]) return Response.json({ error: 'taken' }, { status: 409 });
    return (files[id] = body), ok();
  });
  t.global('addEventListener', () => {});
  t.global('removeEventListener', () => {});
  const backend = new ServerState('/test-api');
  t.defer(() => backend.dispose());
  return { layouts: backend.layouts };
}
const layout = { title: 'Mine', root: { tabs: ['code'] } };
const last = { dock: { grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} }, offered: ['ci'], layout: 'reading' } as LastLayout;

describe.each([['browser', browser], ['server', server]] as const)('%s layout store', (_, make) => {
  test('nothing saved reads as empty; the shipped layouts are always there', async () => {
    using t = fixture();
    const { layouts } = make(t);
    expect(await layouts.get('saved')).toEqual({});
    expect(await layouts.get('default')).toBeNull();
    expect(await layouts.get('last')).toBeNull();
    expect(Object.keys(await layouts.get('shipped'))).toContain('reading');
  });

  test('saved layouts keep their rules: a taken name (shipped or saved) is refused, deleting the default clears it', async () => {
    using t = fixture();
    const { layouts } = make(t);
    expect(await layouts.put('saved', 'reading', layout)).toBe(false);
    expect(await layouts.put('saved', 'mine', layout)).toBe(true);
    expect(await layouts.put('saved', 'mine', layout)).toBe(false);
    expect(await layouts.put('default', 'mine')).toBe(true);
    expect([await layouts.get('saved'), await layouts.get('default')]).toEqual([{ mine: layout }, 'mine']);
    expect(await layouts.put('default', null)).toBe(true);
    expect(await layouts.get('default')).toBeNull();
    await layouts.put('default', 'mine');
    expect(await layouts.put('saved', 'mine', null)).toBe(true);
    expect([await layouts.get('saved'), await layouts.get('default')]).toEqual([{}, null]);
  });

  test('the last layout round-trips', async () => {
    using t = fixture();
    const { layouts } = make(t);
    expect(await layouts.put('last', last)).toBe(true);
    expect(await layouts.get('last')).toEqual(last);
  });
});

test('a corrupt browser entry reads as nothing saved, and saving over it works', async () => {
  using t = fixture();
  const { store, layouts } = browser(t);
  for (const key of ['reviewroom:layouts', 'reviewroom:layout:r']) store.set(key, '{not json');
  expect(await layouts.get('saved')).toEqual({});
  expect(await layouts.get('last')).toBeNull();
  expect(await layouts.put('saved', 'mine', layout)).toBe(true);
  expect(await layouts.get('saved')).toEqual({ mine: layout });
});
