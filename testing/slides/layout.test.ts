// The demo walkthrough is the slide layout's test bed: each slide stands for one case, named here with how its code must
// draw at a laptop's size. A new case: a slide in examples/uploads/walkthrough.json (its code from
// examples/make-demo-repo.sh, its link's fingerprint in state.json), then a row here.
import { expect, test } from 'bun:test';
import { withPage, withServer } from '../../cli/lib/render.ts';
import { slideCases } from './cases.ts';
import { browser, setupSlides } from './fixture.ts';

const { repo, dir } = setupSlides();

/** Per file on the slide: its view (`file`: one the PR left alone), wrap or clip, whole or folded to its hunks, and
 *  whether its focus is `centred` in its pane (the slide's change, or its lines when the change is taller than the
 *  pane; blank room past a file's ends when it needs it), else `off`. */
const cases: Record<string, { is: string; code: string[] }> = {
  'why/s1': { is: 'old-side lines with changes inside them, under a diagram', code: ['unified clip whole centred'] },
  'why/s2': { is: 'a file the PR left alone', code: ['file clip whole centred'] },
  'bucket/s1': { is: 'long prose; lines at the end of a file added whole (taller than the pane)', code: ['unified clip whole centred'] },
  'bucket/s2': { is: 'a two-for-two replacement stays unified', code: ['unified clip whole centred'] },
  'enforce/s1': { is: 'lines inside one change block: the rule marks them', code: ['unified clip whole centred'] },
  'enforce/s2': { is: 'two files stacked, each whole', code: ['unified clip whole centred', 'unified clip whole centred'] },
  'enforce/s3': { is: 'four files stacked, folded to their hunks (a tiny file has none to fold)', code: ['unified clip whole centred', 'split clip folded centred', 'unified clip folded centred', 'unified clip folded centred'] },
  'types/s1': { is: 'a heavy block in the middle of a large file', code: ['unified clip whole centred'] },
  'types/s2': { is: "lines at a long file's top", code: ['unified clip whole centred'] },
  'disk/s1': { is: 'six lines removed for one: split, clipped', code: ['split clip whole centred'] },
  'disk/s2': { is: 'a compact change with a long line: split and wrapped', code: ['split wrap whole centred'] },
  'errors/s1': { is: 'super short prose, a one-line change in a tiny file', code: ['unified clip whole centred'] },
  'errors/s2': { is: 'super short prose, lines of a tiny file', code: ['unified clip whole centred'] },
  'risks/s1': { is: 'one finding, one line of a short config', code: ['unified clip whole centred'] },
  'risks/s2': { is: 'one finding, a one-line change in a short file', code: ['unified clip whole centred'] },
};

// what each file on the slide shows, read from the page: the panel's fitted view, Pierre's overflow and folds, and the
// rows of the slide's focus (its lines, and its changes: the rows the fade's rule leaves lit, code.ts litCSS)
const probe = `[...document.querySelectorAll('.rr-tour__layer:not(.is-leaving) .rr-code-scroll')].map((sc) => {
  const sr = sc.querySelector('diffs-container')?.shadowRoot, b = sc.getBoundingClientRect();
  const lit = [...(sr?.querySelectorAll('style') ?? [])].map((s) => s.textContent.match(/(:is\\(.*\\))\\{opacity:1\\}/)?.[1]).find(Boolean);
  const rows = [...(sr?.querySelectorAll('[data-line]') ?? [])];
  const focus = rows.filter((r) => r.hasAttribute('data-selected-line') || (lit && r.matches(lit)));
  const gap = (xs) => (xs.length ? [Math.min(...xs.map((r) => r.getBoundingClientRect().top)) - b.top, b.bottom - Math.max(...xs.map((r) => r.getBoundingClientRect().bottom))] : [0, 0]);
  const own = focus.filter((r) => r.hasAttribute('data-selected-line'));
  // the change when it fits the pane (then all of it shows), else the slide's own lines (placement.ts)
  const [above, below] = gap(gap(focus).some((g) => g < 0) ? own : focus);
  const at = Math.abs(above - below) <= 12 ? 'centred' : 'off';
  return [sc.closest('.rr-code-panel').dataset.diffStyle ?? 'file', sr?.querySelector('pre')?.getAttribute('data-overflow') === 'wrap' ? 'wrap' : 'clip', sr?.querySelector('[data-separator]') ? 'folded' : 'whole', at].join(' ');
})`;

test('every demo slide is a named layout case', () => {
  expect(slideCases.demo.tour.chapters.flatMap((c) => c.steps.map((s) => `${c.id}/${s.id}`))).toEqual(Object.keys(cases));
});

test.skipIf(!browser)('each layout case draws as named', async () => {
  const drawn = await withServer(repo, dir, (url) =>
    withPage(url, { width: 1440, height: 900 }, async (page) => {
      const out: Record<string, { is: string; code: string[] }> = {};
      for (const [id, c] of Object.entries(cases)) {
        const [chapter, step] = id.split('/');
        await page.audit(chapter, step, 'light');
        out[id] = { is: c.is, code: await page.evaluate<string[]>(probe) };
      }
      return out;
    }),
  );
  expect(drawn).toEqual(cases);
}, 90_000);
