import { expect, test } from 'bun:test';
import { LocalProvider } from './local';
import { fixture } from '../../testing/fixture';


test('local read treats only 404 as absent; patch falls back on any HTTP failure', async () => {
  using t = fixture();
  const provider = new LocalProvider('/test-api');
  t.global('fetch', async () => new Response('', { status: 404 }));
  expect(await provider.read('a.ts', 'HEAD')).toBeNull();
  t.global('fetch', async () => new Response('', { status: 503 }));
  expect(provider.read('a.ts', 'HEAD')).rejects.toThrow('read a.ts@HEAD: 503');
  expect(await provider.patch({ base: 'base', head: 'head', label: 'all', key: 'all' }, false)).toBeNull();
});

test('JSON transport preserves server and GitHub errors with an HTTP fallback', async () => {
  using t = fixture();
  const provider = new LocalProvider();
  for (const [body, message] of [[{ error: 'state moved aside' }, 'state moved aside'], [{ message: 'API limit' }, 'API limit']] as const) {
    t.global('fetch', async () => Response.json(body, { status: 500 }));
    expect(provider.meta()).rejects.toThrow(message);
  }
  t.global('fetch', async () => new Response('not JSON', { status: 503, statusText: 'Unavailable' }));
  expect(provider.meta()).rejects.toThrow('503 Unavailable');
});
