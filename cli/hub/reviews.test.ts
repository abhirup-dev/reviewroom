import { afterAll, expect, test } from 'bun:test';
import { generate, generationState, parsePrUrl } from './reviews.ts';
import type { ArtifactProgress } from '../../src/kernel/state/progress.shared.ts';

test('a PR URL: GitHub only, and no name that leaves repos/<owner>/', () => {
  expect(parsePrUrl('https://github.com/acme/demo/pull/7')).toEqual({ owner: 'acme', repo: 'demo', number: 7 });
  expect(parsePrUrl(' https://github.com/acme/demo.js/pull/12/files?x#y ')).toEqual({ owner: 'acme', repo: 'demo.js', number: 12 });
  for (const bad of ['', 'acme/demo#7', 'http://github.com/acme/demo/pull/7', 'https://gitlab.com/acme/demo/pull/7', 'https://github.com/acme/../pull/7', 'https://github.com/acme/demo/issues/7', 'https://github.com/a/b/pull/x'])
    expect(parsePrUrl(bad)).toBeNull();
});

test('generation state from the progress log: ready only with both documents validated', () => {
  const a = (state: ArtifactProgress['state']): ArtifactProgress => ({ state });
  expect(generationState({ walkthrough: a('idle'), report: a('idle') })).toBe('idle');
  expect(generationState({ walkthrough: a('validated'), report: a('writing') })).toBe('generating');
  expect(generationState({ walkthrough: a('validated'), report: a('stopped') })).toBe('stopped');
  expect(generationState({ walkthrough: a('validated'), report: a('validated') })).toBe('ready');
  expect(generationState({ walkthrough: a('validated'), report: a('idle') })).toBe('idle');
});

// a review server's api/meta and api/generate, as Play meets them right after starting one
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));
function stub(meta: object, answers: [number, object][]) {
  const calls: string[] = [];
  const s = Bun.serve({ port: 0, fetch: (req) => {
    const p = new URL(req.url).pathname;
    calls.push(`${req.method} ${p}`);
    if (p === '/api/meta') return Response.json(meta);
    const [status, body] = answers.shift() ?? [500, {}];
    return Response.json(body, { status });
  } });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}/`, calls };
}

test('Play\'s generate: waits out a server still starting, then reports what api/generate said', async () => {
  const ok = stub({ generate: true }, [[409, { code: 'starting' }], [409, { code: 'starting' }], [200, { started: true }]]);
  expect(await generate(ok)).toEqual({ ok: true, started: true });
  expect(ok.calls).toEqual(['GET /api/meta', 'POST /api/generate', 'POST /api/generate', 'POST /api/generate']);
  const refused = stub({ generate: true }, [[503, { code: 'assistant_unavailable', error: 'Claude executable not found' }]]);
  expect(await generate(refused)).toEqual({ ok: false, code: 'assistant_unavailable', error: 'Claude executable not found' });
  const off = stub({}, []);
  expect(await generate(off)).toMatchObject({ ok: false, code: 'assistant_off' });
  expect(off.calls).toEqual(['GET /api/meta']); // never asked: generation isn't available there
});
