// Lint step: the CSS and what produces it stay in step (rr-486 left this to review). Reports
//   - an rr- class a stylesheet styles that no script, page or example ever writes (a rule left behind);
//   - a --rr-* token set outside tokens.css (but the current surface, --rr-panel and --rr-panel-2, which a panel
//     redefines), read but never set, or set but never read;
//   - a --_name (a component's own variable) read but never set, or set but never read.
// A class or variable is "written" when its name appears in the source, or a template literal starts it (`rr-x--${...}`).
import fs from 'node:fs';
import { Glob } from 'bun';

const read = (pattern: string) => [...new Glob(pattern).scanSync()].map((f) => [f, fs.readFileSync(f, 'utf8')] as const);
const css = read('src/**/*.css');
const code = [...read('{src,cli,e2e}/**/*.ts'), ...read('{src,examples,skills}/**/*.{html,md,json}')]
  .filter(([f]) => !f.endsWith('.test.ts'))
  .map(([, s]) => s)
  .join('\n');
const allCss = css.map(([, s]) => s.replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
// a class name a template literal starts: `rr-status--${f.status}` writes every rr-status--*
const prefixes = [...code.matchAll(/([\w-]+)\$\{/g)].map((m) => m[1]).filter((p) => /^(rr-|--rr-|--_)[\w]+/.test(p)); // `rr-${x}` alone would write every class
const written = (name: string) => code.includes(name) || prefixes.some((p) => name.startsWith(p));

const problems: string[] = [];
const seen = new Set<string>();
for (const [file, text] of css) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')); // keep line numbers
  const lineOf = (index: number) => `${file}:${src.slice(0, index).split('\n').length}`;
  // a rule's selector: the text before its { (an at-rule's prelude has no rr- classes)
  for (const m of src.matchAll(/([^{};]+)\{/g)) {
    if (m[1].trim().startsWith('@')) continue;
    for (const [, cls] of m[1].matchAll(/\.(rr-[\w-]+)/g)) {
      if (seen.has(cls) || written(cls)) continue;
      seen.add(cls);
      problems.push(`${lineOf(m.index)}: .${cls} is styled but nothing writes it`);
    }
  }
  for (const m of src.matchAll(/(?<=[{;]\s*)(--rr-[\w-]+)\s*:/g)) {
    if (!/tokens(\.phone)?\.css$/.test(file) && !/^--rr-panel(-2)?$/.test(m[1])) problems.push(`${lineOf(m.index)}: ${m[1]} is set outside tokens.css (a component's own variable is --_name)`);
  }
}
const set = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const usedInCss = new Set([...allCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
for (const name of usedInCss) {
  if ((name.startsWith('--rr-') || name.startsWith('--_')) && !set.has(name) && !written(name + ':') && !new RegExp(`['"\`]${name}['"\`]`).test(code))
    problems.push(`${name} is read (var(${name})) but never set`);
}
for (const name of set) {
  if ((name.startsWith('--rr-') || name.startsWith('--_')) && !usedInCss.has(name) && !code.includes(name)) problems.push(`${name} is set but nothing reads it`);
}
if (problems.length) {
  console.error(`CSS out of step with its producers (scripts/css-usage.ts):\n${problems.join('\n')}`);
  process.exit(1);
}
