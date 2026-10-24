// Architecture checks use a TypeScript syntax tree and resolved paths, before type erasure.
import { Glob } from 'bun';
import { moduleImports } from './features-imports';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const files = [...new Glob('src/**/*.ts').scanSync({ cwd: root })].filter((f) => !/\.(test|d)\.ts$/.test(f));
const dependencies = new Map<string, string[]>();
const errors: string[] = [];
const layer = (file: string) => file.split('/')[1];
const allowed: Record<string, string[]> = {
  kernel: ['kernel'],
  review: ['kernel', 'review'],
  threads: ['kernel', 'review', 'threads'],
  slides: ['kernel', 'review', 'slides'],
  hub: ['kernel', 'hub'],
};

const lines = new Map<string, number>();
/** A file's relative imports, resolved to repo paths (unresolved ones are errors). */
function* localImports(file: string) {
  const source = readFileSync(resolve(root, file), 'utf8');
  lines.set(file, source.split('\n').length);
  for (const entry of moduleImports(file, source)) {
    // The build injects this one virtual stylesheet.
    if (!entry.path.startsWith('.') || entry.path.endsWith('.css')) continue;
    try { yield { ...entry, target: relative(root, Bun.resolveSync(entry.path, dirname(resolve(root, file)))) }; }
    catch { errors.push(`${file}: unresolved ${entry.path}`); }
  }
}

for (const file of files) {
  const imports: string[] = [];
  for (const { target, typeOnly } of localImports(file)) {
    if (!target.startsWith('src/')) continue;
    if (target.endsWith('.ts') && !typeOnly) imports.push(target);
    const owners = allowed[layer(file)];
    const permittedType = typeOnly && (target === 'src/app.ts' || target.endsWith('.shared.ts'));
    if (owners && !permittedType && !owners.includes(layer(target))) errors.push(`${file} imports higher/sibling layer ${target}`);
    if (file.endsWith('.shared.ts') && target.endsWith('.ts') && !target.endsWith('.shared.ts')) errors.push(`${file}: shared code imports browser code ${target}`);
  }
  dependencies.set(file, imports);
}

const active = new Set<string>();
const visited = new Set<string>();
function visit(file: string, path: string[]) {
  if (active.has(file)) { errors.push(`Runtime cycle: ${[...path.slice(path.indexOf(file)), file].join(' -> ')}`); return; }
  if (visited.has(file)) return;
  active.add(file);
  for (const next of dependencies.get(file) ?? []) visit(next, [...path, file]);
  active.delete(file);
  visited.add(file);
}
for (const file of files) visit(file, []);

// The CLI may consume shared models, never browser modules or state-machine implementations.
for (const file of new Glob('cli/**/*.ts').scanSync({ cwd: root }))
  for (const { target } of localImports(file))
    if (target.startsWith('src/') && !target.endsWith('.shared.ts')) errors.push(`${file}: CLI imports non-shared module ${target}`);

const totals = new Map<string, number>();
for (const file of files) {
  const owner = allowed[layer(file)] ? layer(file) : 'composition';
  totals.set(owner, (totals.get(owner) ?? 0) + lines.get(file)!);
}
console.log('Source lines by owner:', Object.fromEntries(totals));
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('Feature boundaries and runtime import graph: OK');
