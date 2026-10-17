import { expect, test } from 'bun:test';
import { applyFixes, checkLinks, problems, type LinkResult } from './links.ts';
import type { SearchHit } from '../../src/core/types.ts';
import type { Walkthrough } from '../../src/shared/walkthrough.ts';
import { fixTour, locate, tourText } from './walkthrough.ts';

const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const prov = (files: Record<string, string>) => ({ head: 'h', base: 'b', read: (_rev: string, p: string) => files[p] ?? null, search: (q: unknown) => (q === 'Build' ? [{ kind: 'definition' } as SearchHit] : []) });
const html = (...refs: string[]) => `<!-- e.g. <a href="rr:code/path#L10-20"> --><rr-review><section id="intro">${refs.map((r) => `<a href="${r}">x</a>`).join(' ')}</section></rr-review>`;
const status = (results: LinkResult[]) => Object.fromEntries(results.map((x) => [x.ref, x.status]));

test('code shifted <=5 lines is moved and fixable; further or edited is changed', () => {
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
  const refsOnly = { head: 'h', base: 'b', read: () => null, search: () => [{ kind: 'reference' } as SearchHit] };
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

test('walkthrough.json: step refs and prose links are checked decoded, located, and fixed in the JSON', () => {
  const w = { version: 1, title: 'T', chapters: [{ id: 'why', title: 'W', lead: '<a href="rr:doc/intro">i</a><!-- <a href="rr:code/old.go#L1"> -->', steps: [{ id: 's1', text: '<p>See rr:code/a.go#L4-6.</p>', ref: 'rr:code/a.go#L4-6' }, { id: 's2', text: 'y', ref: 'rr:doc/nope' }] }] };
  const json = JSON.stringify(w, null, 2).replace(/\//g, '\\/') + '\n'; // escaped slashes are still the same links
  const { links } = checkLinks(html(), prov({ 'a.go': body.join('\n') }), {}, tourText(JSON.parse(json)));
  expect(Object.keys(links)).toEqual(['rr:code/a.go#L4-6']);
  const after = prov({ 'a.go': ['new', 'new', ...body].join('\n') });
  const { results } = checkLinks(html(), after, links, tourText(w as Walkthrough));
  expect(locate(problems(results), w as Walkthrough).map((x) => [x.ref, x.status, x.where])).toEqual([
    ['rr:code/a.go#L4-6', 'moved', ['why/s1']],
    ['rr:doc/nope', 'broken', ['why/s2']],
  ]);
  const fixed = fixTour(json, results, links);
  expect(JSON.parse(fixed).chapters[0].steps[0]).toEqual({ id: 's1', text: '<p>See rr:code/a.go#L6-8.</p>', ref: 'rr:code/a.go#L6-8' });
  expect(fixed).toBe(JSON.stringify(JSON.parse(fixed), null, 2) + '\n');
});
