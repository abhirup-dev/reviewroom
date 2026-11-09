import { expect, test } from 'bun:test';
import type { Walkthrough } from '../../src/slides/model.shared.ts';
import { selectSlides, selectionLinks } from './slide-selection.ts';

const w: Walkthrough = {
  version: 1, title: 'Selection', chapters: [
    { id: 'before', title: 'Before', lead: '<a href="rr:doc/intro">Intro</a>', steps: [
      { id: 's1', text: '<a href="rr:sym/Unrelated">Other prose</a>', ref: 'rr:code/a.go#L1-40' },
      { id: 's2', text: '<a href="rr:code/b.go#L2">Detail</a><!-- rr:sym/Comment -->' },
    ] },
    { id: 'after', title: 'After', lead: '<a href="rr:doc/after">After</a>', steps: [
      { id: 's1', text: '<p>Inherits from the previous chapter.</p>' },
      { id: 's2', text: '<p>Own target.</p>', ref: ['rr:code/c.go#L1', 'rr:code/d.go#L2'] },
    ] },
  ],
};

test('selectors use stable ids; order, titles and repeated local step ids do not change identity', () => {
  expect(selectSlides(w, {}).slides).toHaveLength(4);
  expect(selectSlides(w, { chapter: 'after' })).toEqual({ scope: { kind: 'chapter', chapter: 'after' }, slides: [{ chapter: 'after', step: 's1' }, { chapter: 'after', step: 's2' }], total: 4 });
  const picked = selectSlides(w, { slide: 'after/s1' });
  expect(picked.scope).toEqual({ kind: 'slide', chapter: 'after', step: 's1' });
  expect(selectSlides({ ...w, chapters: [...w.chapters].reverse().map((c) => ({ ...c, title: 'Renamed' })) }, { slide: 'after/s1' })).toEqual(picked);
  expect(selectSlides(w, { slide: 'rr:tour/after/s1' })).toEqual(picked);
});

test('conflicting, unknown or malformed selectors fail rather than falling back to all slides', () => {
  expect(() => selectSlides(w, { chapter: 'after', slide: 'after/s1' })).toThrow('mutually exclusive');
  expect(() => selectSlides(w, { chapter: 'After' })).toThrow('chapters: before, after');
  for (const slide of ['s1', 'after', 'after/s1/extra', 'after/missing', '1/1', 'rr:doc/after']) expect(() => selectSlides(w, { slide })).toThrow('slides: before/s1');
});

test('link scope includes the selected lead and effective code, but not unrelated prose or comments', () => {
  const links = selectionLinks(w, selectSlides(w, { slide: 'before/s2' }));
  expect(Object.fromEntries(links)).toEqual({
    'rr:doc/intro': ['before'], 'rr:code/b.go#L2': ['before/s2'], 'rr:code/a.go#L1-40': ['before/s2'],
  });
});

test('cross-chapter inheritance is resolved from the complete document and attributed to selected consumers', () => {
  const links = selectionLinks(w, selectSlides(w, { chapter: 'after' }));
  expect(Object.fromEntries(links)).toEqual({
    'rr:doc/after': ['after'], 'rr:code/a.go#L1-40': ['after/s1'], 'rr:code/c.go#L1': ['after/s2'], 'rr:code/d.go#L2': ['after/s2'],
  });
});
