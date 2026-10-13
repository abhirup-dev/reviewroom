import { expect, test } from 'bun:test';
import { applyFixes, checkLinks, problems } from './links.mjs';

const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const prov = (files) => ({ head: 'h', base: 'b', read: (_rev, p) => files[p] ?? null, search: (q) => (q === 'Build' ? [{ kind: 'definition' }] : []) });
const html = (...refs) => `<!-- e.g. <a href="rr:code/path#L10-20"> --><rr-review><section id="intro">${refs.map((r) => `<a href="${r}">x</a>`).join(' ')}</section></rr-review>`;
const status = (results) => Object.fromEntries(results.map((x) => [x.ref, x.status]));

test('first sighting fingerprints; unchanged code stays ok', () => {
  const p = prov({ 'a.go': body.join('\n') });
  const page = html('rr:code/a.go#L4-6', 'rr:code/a.go#L4');
  const first = checkLinks(page, p);
  expect(status(first.results)).toEqual({ 'rr:code/a.go#L4-6': 'new', 'rr:code/a.go#L4': 'new' });
  const again = checkLinks(page, p, first.links);
  expect(problems(again.results)).toEqual([]);
  expect(again.links).toEqual(first.links);
});

test('code shifted ≤5 lines is moved and fixable; further or edited is changed', () => {
  const { links } = checkLinks(html('rr:code/a.go#L4-6', 'rr:code/a.go#L4', 'rr:code/a.go#L20-21'), prov({ 'a.go': body.join('\n') }));
  // 3 lines inserted above line 1; line 20 edited
  const shifted = ['n1', 'n2', 'n3', ...body];
  shifted[22] = 'line 20 edited';
  const page = html('rr:code/a.go#L4-6', 'rr:code/a.go#L4', 'rr:code/a.go#L20-21');
  const { results } = checkLinks(page, prov({ 'a.go': shifted.join('\n') }), links);
  expect(status(results)).toEqual({ 'rr:code/a.go#L4-6': 'moved', 'rr:code/a.go#L4': 'moved', 'rr:code/a.go#L20-21': 'changed' });
  const { html: fixed } = applyFixes(page, results, links);
  expect(fixed).toContain('rr:code/a.go#L7-9"');
  expect(fixed).toContain('rr:code/a.go#L7"');
  expect(fixed).toContain('rr:code/a.go#L20-21"');
  // 6 lines down is past the heal window
  const far = checkLinks(html('rr:code/a.go#L4-6'), prov({ 'a.go': [...Array(6).fill('x'), ...body].join('\n') }), links);
  expect(far.results[0].status).toBe('changed');
});

test('broken files, symbols and sections; links that left the narrative drop out', () => {
  const p = prov({ 'a.go': body.join('\n') });
  const { results, links } = checkLinks(html('rr:code/gone.go#L1', 'rr:code/a.go#L29-40', 'rr:sym/Build', 'rr:sym/Nope', 'rr:doc/intro', 'rr:doc/missing', 'rr:file/a.go@abc'), p, { 'rr:code/old.go#L1': 'deadbeef' });
  expect(status(results)).toEqual({
    'rr:code/gone.go#L1': 'broken',
    'rr:code/a.go#L29-40': 'broken',
    'rr:sym/Build': 'new',
    'rr:sym/Nope': 'broken',
    'rr:doc/intro': 'ok',
    'rr:doc/missing': 'broken',
    'rr:file/a.go@abc': 'ok',
  });
  expect(links).toEqual({ 'rr:sym/Build': 'definition' });
});

test('a symbol that loses its definition but keeps references is changed', () => {
  const page = html('rr:sym/Build');
  const { links } = checkLinks(page, prov({}));
  const refsOnly = { head: 'h', base: 'b', read: () => null, search: () => [{ kind: 'reference' }] };
  expect(checkLinks(page, refsOnly, links).results[0].status).toBe('changed');
  expect(checkLinks(page, refsOnly).results[0].status).toBe('ok'); // never had one: not held to it
});

test('--fix moves each link once, even when one lands where another was', () => {
  for (const order of [['rr:code/a.go#L4', 'rr:code/a.go#L7'], ['rr:code/a.go#L7', 'rr:code/a.go#L4']]) {
    const page = html(...order);
    const { links } = checkLinks(page, prov({ 'a.go': body.join('\n') }));
    const after = prov({ 'a.go': ['n1', 'n2', 'n3', ...body].join('\n') });
    const { results, links: moved } = checkLinks(page, after, links);
    const fixed = applyFixes(page, results, moved);
    expect(fixed.html).toContain('rr:code/a.go#L7"');
    expect(fixed.html).toContain('rr:code/a.go#L10"');
    expect(problems(checkLinks(fixed.html, after, fixed.links).results)).toEqual([]);
  }
});
