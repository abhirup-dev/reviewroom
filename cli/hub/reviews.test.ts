import { afterAll, expect, test } from 'bun:test';
import path from 'node:path';
import { addPr, clonePath, generate, serialized } from './reviews.ts';

test('Add rejects invalid PR URLs before attempting a clone', async () => {
  for (const bad of [
    '', 'acme/demo#7', 'http://github.com/acme/demo/pull/7', 'https://gitlab.com/acme/demo/pull/7',
    'https://github.com/acme/../pull/7', 'https://github.com/acme/demo/issues/7', 'https://github.com/acme/demo/pull/0',
    'https://github.com/acme/de%2Fmo/pull/7', 'https://user@github.com/acme/demo/pull/7',
  ]) {
    expect(await addPr(bad)).toMatchObject({ ok: false, error: expect.stringContaining('GitHub pull request URL') });
  }
});

test('a clone path stays inside <home>/repos', () => {
  expect(clonePath('acme', 'demo').endsWith(path.join('repos', 'acme', 'demo'))).toBe(true);
  expect(clonePath('ACME', 'Demo')).toBe(clonePath('acme', 'demo')); // one clone, and one queue key, whatever the case
  for (const [o, r] of [['..', 'x'], ['acme', '..'], ['acme', '../../etc'], ['', '']]) expect(() => clonePath(o, r)).toThrow();
});

// a review server's api/meta and api/generate, as Play meets them right after starting one; null: never answers
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));
function stub(meta: object, answers: ([number, object] | null)[]) {
  const calls: string[] = [];
  const s = Bun.serve({ port: 0, fetch: (req) => {
    const p = new URL(req.url).pathname;
    calls.push(`${req.method} ${p}`);
    if (p === '/api/meta') return Response.json(meta);
    const a = answers.shift();
    return a ? Response.json(a[1], { status: a[0] }) : new Promise<Response>(() => {});
  } });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}/`, calls };
}

test.each<[string, object, ([number, object] | null)[], object, number]>([
  ['waits out a server still starting', { generate: true }, [[409, { code: 'starting' }], [409, { code: 'starting' }], [200, { started: true }]], { ok: true, started: true }, 4],
  ['reports a refusal', { generate: true }, [[503, { code: 'assistant_unavailable', error: 'Claude executable not found' }]], { ok: false, code: 'assistant_unavailable', error: 'Claude executable not found' }, 2],
  ['never asks where the assistant is off', {}, [], { ok: false, code: 'assistant_off' }, 1],
  ['is bounded: a POST that never answers is an error, not a held lock', { generate: true }, [null], { ok: false, code: null, error: expect.stringContaining('The review did not answer') }, 2],
])('Play\'s generate %s', async (...[, meta, answers, result, calls]) => {
  const s = stub(meta, answers);
  expect(await generate(s, 300)).toMatchObject(result);
  expect(s.calls).toHaveLength(calls);
});

test('serialized: one key runs one at a time, in order, and a failure releases it; other keys run alongside', async () => {
  const log: string[] = [];
  const step = (name: string, ms: number, fail = false) => async () => {
    log.push(`${name}+`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}-`);
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([serialized('/r/a', step('a1', 30, true)), serialized('/r/a', step('a2', 5)), serialized('/r/b', step('b1', 5))]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  expect(log).toEqual(['a1+', 'b1+', 'b1-', 'a1-', 'a2+', 'a2-']);
});
