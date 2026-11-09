import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PKG } from '../paths';
import type { Declaration } from './model';
import type { SourceFile } from './snapshot';

const execute = promisify(execFile);
const Point = z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() });
const Entry = z.object({
  name: z.string(), astKind: z.string(), signature: z.string().default(''),
  range: z.object({ start: Point, end: Point, byteOffset: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) }),
  get members() { return z.array(Entry).optional(); },
});
const Outline = z.array(z.object({ path: z.string(), language: z.string(), items: z.array(Entry) }));

/** One upstream outline invocation for every language/name. No application-owned language extraction rules. */
export async function declarations(root: string, files: SourceFile[], names: string[]): Promise<{ declarations: Declaration[]; unverified: string[] }> {
  if (!files.length) return { declarations: [], unverified: [] };
  const pkg = path.dirname(Bun.resolveSync('@ast-grep/cli/package.json', PKG));
  const binary = path.join(pkg, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  const { stdout } = await execute(binary, ['outline', '.', '--items', 'structure', '--view', 'expanded', '--json=compact',
    '--config', path.join(PKG, 'cli/lib/source/outline.yml'),
    ...['hidden', 'dot', 'vcs', 'global', 'exclude'].flatMap((kind) => ['--no-ignore', kind])],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  const outlines = Outline.parse(JSON.parse(stdout)), words = new Set(names), out: Declaration[] = [];
  const byPath = new Map(files.map((f) => [f.absolute, f.path])), outlined = new Set<string>();
  for (const file of outlines) {
    if (file.language === 'Markdown') continue; // Prose headings are document anchors, not source declarations.
    const absolute = path.resolve(root, file.path), p = byPath.get(absolute);
    if (!p) throw new Error('outline returned a file outside its snapshot');
    outlined.add(p);
    let source: Buffer | undefined;
    const position = (line: number, offset: number) => {
      source ??= fs.readFileSync(absolute);
      const start = offset ? source.lastIndexOf(10, offset - 1) + 1 : 0;
      return { line, character: source.subarray(start, offset).toString('utf8').length };
    };
    const visit = (entry: z.infer<typeof Entry>, owners: string[]) => {
      if (words.has(entry.name)) out.push({
        name: entry.name, path: p, language: file.language, kind: entry.astKind, owners, signature: entry.signature, evidence: 'syntax',
        range: { start: position(entry.range.start.line, entry.range.byteOffset.start), end: position(entry.range.end.line, entry.range.byteOffset.end) },
      });
      for (const member of entry.members ?? []) visit(member, [...owners, entry.name]);
    };
    for (const entry of file.items) visit(entry, []);
  }
  // Absent output may mean unsupported language or no outlined declarations; do not guess which.
  return { declarations: out, unverified: files.filter((f) => !outlined.has(f.path)).map((f) => f.path) };
}
