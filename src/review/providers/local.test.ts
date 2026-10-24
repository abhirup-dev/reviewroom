import { afterEach, expect, test } from 'bun:test';
import { LocalProvider } from './local';
import { replaceGlobal, restoreGlobals } from '../../testing/globals';

afterEach(restoreGlobals);

test('local read treats only 404 as absent; patch falls back on any HTTP failure', async () => {
  const provider = new LocalProvider('/test-api');
  replaceGlobal('fetch', async () => new Response('', { status: 404 }));
  expect(await provider.read('a.ts', 'HEAD')).toBeNull();
  replaceGlobal('fetch', async () => new Response('', { status: 503 }));
  expect(provider.read('a.ts', 'HEAD')).rejects.toThrow('read a.ts@HEAD: 503');
  expect(await provider.patch({ base: 'base', head: 'head', label: 'all', key: 'all' }, false)).toBeNull();
});

test('JSON transport preserves server and GitHub errors with an HTTP fallback', async () => {
  const provider = new LocalProvider();
  for (const [body, message] of [[{ error: 'state moved aside' }, 'state moved aside'], [{ message: 'API limit' }, 'API limit']] as const) {
    replaceGlobal('fetch', async () => Response.json(body, { status: 500 }));
    expect(provider.meta()).rejects.toThrow(message);
  }
  replaceGlobal('fetch', async () => new Response('not JSON', { status: 503, statusText: 'Unavailable' }));
  expect(provider.meta()).rejects.toThrow('503 Unavailable');
});
