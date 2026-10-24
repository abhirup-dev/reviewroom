// Lint step: what the terminal and agents read (cli/, scripts/, *.shared.ts) is ASCII, and nowhere a
// look-alike character (minus sign U+2212, non-breaking or zero-width spaces): write those as \u escapes.
// The browser UI in src/ keeps its typography, and src/kernel/commands.ts its key glyphs.
import fs from 'node:fs';
import { Glob } from 'bun';

const LOOKALIKE = /[\u2212\u00a0\u200b-\u200d\ufeff]/;
const bad: string[] = [];
for (const file of new Glob('{cli,scripts,src}/**/*.{ts,css}').scanSync()) {
  const asciiOnly = /^(cli|scripts)\//.test(file) || file.endsWith('.shared.ts');
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (LOOKALIKE.test(line) || (asciiOnly && /[^\t\x20-\x7e]/.test(line))) bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
}
if (bad.length) {
  console.error(`non-ASCII where it should not be (see scripts/ascii.ts):\n${bad.join('\n')}`);
  process.exit(1);
}
