import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './fixture';
import { lookupDeclarations } from '../cli/lib/source/lookup';

const { repo, dir, d, cli, git } = setup();

test('declaration lookup batches languages, qualifies before limits and preserves snapshot/fallback behaviour', async () => {
  const files = {
    '.gitattributes': 'symbols.ts export-ignore\n',
    'README.md': '# DoesNotExist\n',
    'symbols.go': 'package symbols\ntype Worker struct{}\nfunc (w *Worker) Process() {}\nvar First, Second = 1, 2\n',
    'symbols.py': 'class Worker:\n def process(self): pass\n',
    'symbols.ts': Array.from({ length: 505 }, (_, n) => `class Other${n} { run() {} }`).join('\n') + '\nclass Target {\n run() {}\n}\n',
    'supported.rs': 'struct Fallback {}\n',
    'unsupported.custom': 'class Legacy {}\n',
    'unicode.ts': 'const prefix = "😀"; function Café() {}\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
  await git('add', '.');
  await git('commit', '-qm', 'source checker fixture');
  const head = (await git('rev-parse', 'HEAD')).stdout.toString().trim();
  const result = await lookupDeclarations({ repo, revision: head, queries: [
    { name: 'Process', owner: 'Worker' }, { name: 'process', owner: 'Worker' }, { name: 'run', owner: 'Target' }, { name: 'Second' }, { name: 'Fallback', path: 'supported.rs' }, { name: 'Legacy', path: 'unsupported.custom' }, { name: 'Café' }, { name: 'DoesNotExist' },
  ] });
  expect(result.coverage.issues).toEqual([]);
  expect(result.results.map((r) => r.status)).toEqual(['unverified', 'found', 'found', 'unverified', 'found', 'unverified', 'found', 'unverified']);
  expect(result.results.map((r) => r.declarations.length)).toEqual([0, 1, 1, 0, 1, 0, 1, 0]);
  const method = result.results[2].declarations[0];
  expect(method).toMatchObject({ path: 'symbols.ts', evidence: 'syntax', owners: ['Target'], range: { start: { line: 506, character: 1 } } });
  expect(method.range.end.line).toBeGreaterThanOrEqual(method.range.start.line);
  expect(result.coverage.unverifiedFiles).toContain('unsupported.custom');
  expect(result.results[6].declarations[0].range.start.character).toBe(files['unicode.ts'].indexOf('function'));
  const refs = ['Worker.Process', 'symbols.py:process', 'Target.run', 'Second', 'supported.rs:Fallback', 'unsupported.custom:Legacy'];
  fs.writeFileSync(path.join(dir, 'review.html'), `<rr-app><rr-review>${refs.map((r) => `<a href="rr:sym/${r}">${r}</a>`).join('')}</rr-review></rr-app>`);
  const checked = await cli(['check', '--json', ...d]);
  expect([checked.code, JSON.parse(checked.stdout).links]).toEqual([0, []]);
  expect(checked.stderr).not.toContain('fell back');
  // A dirty checkout must not replace the committed revision's definitions.
  fs.writeFileSync(path.join(repo, 'symbols.go'), 'package symbols\n// Worker Process Second\n');
  expect((await cli(['check', '--json', ...d])).code).toBe(0);
  const config = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  fs.writeFileSync(config, JSON.stringify({ ...cfg, head: 'worktree' }));
  fs.writeFileSync(path.join(repo, 'untracked.py'), 'class NewlyAdded: pass\n');
  fs.appendFileSync(path.join(dir, 'review.html'), '<a href="rr:sym/NewlyAdded">new</a><a href="rr:sym/ActuallyMissing">missing</a>');
  const changed = await cli(['check', '--json', ...d]);
  const links = JSON.parse(changed.stdout).links;
  expect(changed.code).toBe(1);
  expect(links).toContainEqual(expect.objectContaining({ ref: 'rr:sym/Worker.Process', status: 'changed' }));
  expect(links).toContainEqual(expect.objectContaining({ ref: 'rr:sym/ActuallyMissing', status: 'broken' }));
  expect(links.some((l: { ref: string }) => l.ref === 'rr:sym/NewlyAdded')).toBe(false);
});
