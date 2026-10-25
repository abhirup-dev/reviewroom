import { expect, test } from 'bun:test';
import { hubAllows, LOCAL_ORIGIN } from './access.ts';
import { parseOrigin } from '../commands/hub.ts';

const pub = 'https://mac.tailnet.ts.net';
const req = (o: { host?: string; origin?: string; site?: string; method?: string; path?: string }) => ({ method: 'GET', path: '/', ...o });
const at = (host: string, extra: object = {}) => req({ host, ...extra });

test('loopback: as on a review server, with or without a public origin', () => {
  for (const p of [null, pub]) {
    expect(hubAllows(at('127.0.0.1:4847'), 4847, p)).toBe(true);
    expect(hubAllows(at('localhost:4847'), 4847, p)).toBe(true);
    expect(hubAllows(at('127.0.0.1:4848'), 4847, p)).toBe(false); // another port
    expect(hubAllows(at('evil.com'), 4847, p)).toBe(false); // DNS rebinding
    expect(hubAllows(at('127.0.0.1:4847', { path: '/api/sessions', method: 'POST', origin: 'https://evil.com' }), 4847, p)).toBe(false);
    expect(hubAllows(at('127.0.0.1:4847', { path: '/api/sessions', method: 'POST', origin: 'http://127.0.0.1:4847' }), 4847, p)).toBe(true);
  }
});

test('the public origin: its Host only when configured; same-site API, writes from it', () => {
  expect(hubAllows(at('mac.tailnet.ts.net'), 4847, null)).toBe(false);
  expect(hubAllows(at('mac.tailnet.ts.net'), 4847, pub)).toBe(true);
  expect(hubAllows(at('other.tailnet.ts.net'), 4847, pub)).toBe(false);
  const write = { path: '/r/0123456789ab/api/ops', method: 'POST' };
  expect(hubAllows(at('mac.tailnet.ts.net', { ...write, origin: pub, site: 'same-origin' }), 4847, pub)).toBe(true);
  expect(hubAllows(at('mac.tailnet.ts.net', write), 4847, pub)).toBe(true); // no Origin: not a browser form
  expect(hubAllows(at('mac.tailnet.ts.net', { ...write, origin: 'https://evil.com' }), 4847, pub)).toBe(false);
  expect(hubAllows(at('mac.tailnet.ts.net', { ...write, origin: pub, site: 'cross-site' }), 4847, pub)).toBe(false);
  // the proxy rewrites Origin, so proxied APIs are checked here, also on loopback
  expect(hubAllows(at('127.0.0.1:4847', { ...write, origin: 'https://evil.com' }), 4847, null)).toBe(false);
  expect(hubAllows(at('127.0.0.1:4847', { path: '/r/0123456789ab/api/state', site: 'cross-site' }), 4847, null)).toBe(false);
  expect(hubAllows(at('127.0.0.1:4847', { ...write, path: '/r/0123456789ab//api/ops', origin: 'https://evil.com' }), 4847, null)).toBe(false);
  // pages and assets are not API: a cross-site navigation may open them
  expect(hubAllows(at('mac.tailnet.ts.net', { path: '/r/0123456789ab/', site: 'cross-site' }), 4847, pub)).toBe(true);
});

test('the portless name on this Mac: its Host and Origin, no other .localhost', () => {
  const host = new URL(LOCAL_ORIGIN).host;
  const write = { path: '/r/0123456789ab/api/ops', method: 'POST', site: 'same-origin' };
  expect(hubAllows(at(host), 4847, null)).toBe(true);
  expect(hubAllows(at(host, { ...write, origin: LOCAL_ORIGIN }), 4847, pub)).toBe(true);
  expect(hubAllows(at(host, { ...write, origin: 'https://evil.com' }), 4847, null)).toBe(false);
  expect(hubAllows(at('evil.localhost:1355'), 4847, null)).toBe(false);
});

test('--public-origin takes an origin only', () => {
  expect(parseOrigin('https://mac.tailnet.ts.net/')).toBe(pub);
  expect(parseOrigin('https://mac.tailnet.ts.net:8443')).toBe('https://mac.tailnet.ts.net:8443');
  for (const bad of ['mac.tailnet.ts.net', 'https://mac.tailnet.ts.net/rr', 'ftp://x', 'https://u:p@x', 42, null]) expect(parseOrigin(bad)).toBeNull();
});
