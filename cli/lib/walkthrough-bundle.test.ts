import { expect, test } from 'bun:test';
import { buildWalkthroughBundle, bundleJson } from './walkthrough-bundle.ts';
import type { ChangedFile } from '../../src/kernel/state/model.shared.ts';

const base = '1'.repeat(40), head = '2'.repeat(40), old = '3'.repeat(40);
const stamp = '2026-11-19T00:00:00.000Z';
const modified = (path: string): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 1 });

test('resolves code, symbols, renamed files, historical links and Mermaid nodes to whole blobs', () => {
  const files: ChangedFile[] = [
    modified('main.go'), { ...modified('renamed.go'), prevPath: 'old.go', status: 'renamed' }, modified('unseen.go'),
  ];
  const source = new Map([
    [`${base}:main.go`, 'before\nwhole file'], [`${head}:main.go`, 'after\n</script>'],
    [`${base}:old.go`, 'renamed before'], [`${head}:renamed.go`, 'renamed after'],
    [`${base}:diagram.go`, 'diagram before'], [`${head}:diagram.go`, 'diagram after'], [`${old}:diagram.go`, 'historical'],
    [`${head}:unseen.go`, 'never included'], [`${head}:amp&copy;.go`, 'path with an entity-like name'],
  ]);
  const provider = {
    base, head,
    meta: () => ({ title: 'Review', base, head, number: 7 }),
    files: () => files,
    read: (rev: string, path: string) => source.get(`${rev}:${path}`) ?? null,
    resolveSymbol: () => [{ path: 'main.go', rev: head, line: 2, kind: 'definition' as const, text: 'whole file' }],
  };
  const bundle = buildWalkthroughBundle({
    version: 1,
    title: 'Walkthrough',
    chapters: [{
      id: 'first', title: 'First',
      lead: '<rr-mermaid>flowchart TD\n A[Example]\n click A "rr:file/diagram.go@older"</rr-mermaid>',
      steps: [{
        id: 'start',
        text: '<a href="rr:doc/details"><strong>Finding</strong></a><rr-ref ref="rr:doc/more">More</rr-ref><rr-ref ref="rr:doc/empty"></rr-ref><a href="https://example.com">Website</a><a href="rr:tour/first/start">Here</a><rr-code ref="rr:file/amp&amp;copy;.go@head"></rr-code>',
        ref: ['rr:sym/Main', 'rr:code/old.go@base#L1', 'rr:doc/details', 'rr:file/missing.go@head'],
      }],
    }],
  }, provider, (rev) => rev === 'older' ? old : null, stamp);
  expect(bundle.source).toEqual({ title: 'Review', base, head, pr: 7, exportedAt: stamp });
  expect(bundle.files).toEqual(files.slice(0, 2));
  expect(Object.keys(bundle.contents).sort()).toEqual([...source.keys()].filter((key) => !key.endsWith('unseen.go')).sort());
  expect(bundle.contents[`${head}:main.go`]).toBe('after\n</script>');
  const [chapter] = bundle.walkthrough.chapters;
  expect(chapter.lead).toContain(`click A "rr:file/diagram.go@${old}"`);
  expect(chapter.steps[0].ref).toEqual([`rr:code/main.go@${head}#L2`, `rr:code/renamed.go@${base}#L1`]);
  expect(chapter.steps[0].text).toBe(`<strong>Finding</strong>MoreReport sectionWebsite<a href="rr:tour/first/start">Here</a><rr-code ref="rr:file/amp&amp;copy;.go@${head}"></rr-code>`);
  const json = bundleJson(bundle);
  expect(json).not.toContain('<');
  expect(JSON.parse(json)).toEqual(bundle);
});
