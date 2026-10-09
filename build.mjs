// Build: one ESM entry (with code-split chunks for shiki languages) + one CSS file.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const cssFiles = ['dockview-base', 'tokens', 'shell', 'panels', 'overlays', 'content', 'dockview'];

// dockview ships its stylesheet inside the UMD bundle; lift it out so it can be themed.
{
  const line = readFileSync('node_modules/dockview-core/dist/dockview-core.js', 'utf8').split('\n').find((l) => l.includes('s.textContent = ".dv-'));
  if (line) writeFileSync('src/styles/dockview-base.css', JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1)));
}
// Fonts ship with the tool (latin, variable) so typography never depends on the network.
// [family, package, file, style]
const fonts = [
  ['Inter', 'inter', 'inter-latin-opsz-normal.woff2', 'normal'],
  ['Inter', 'inter', 'inter-latin-opsz-italic.woff2', 'italic'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-normal.woff2', 'normal'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-italic.woff2', 'italic'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2', 'normal'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-italic.woff2', 'italic'],
];
mkdirSync('dist/fonts', { recursive: true });
for (const [, pkg, file] of fonts) copyFileSync(`node_modules/@fontsource-variable/${pkg}/files/${file}`, `dist/fonts/${file}`);
// __RR_FONTS__ is resolved at runtime against the script's own URL (see injectCSS in src/index.ts)
const fontFaces = (base) =>
  fonts.map(([family, , file, style]) => `@font-face{font-family:'${family}';font-style:${style};font-weight:100 900;font-display:swap;src:url(${base}/${file}) format('woff2');}`).join('\n');

function buildCss() {
  const css = cssFiles.map((f) => `/* ${f}.css */\n` + readFileSync(`src/styles/${f}.css`, 'utf8')).join('\n');
  writeFileSync('dist/readingroom.css', fontFaces('./fonts') + '\n' + css);
  return fontFaces('__RR_FONTS__') + '\n' + css;
}

const cssPlugin = {
  name: 'rr-css',
  setup(build) {
    build.onResolve({ filter: /^virtual:rr-css$/ }, () => ({ path: 'rr-css', namespace: 'rr' }));
    build.onLoad({ filter: /.*/, namespace: 'rr' }, () => ({
      contents: `export default ${JSON.stringify(buildCss())};`,
      loader: 'js',
      watchFiles: cssFiles.map((f) => `src/styles/${f}.css`),
    }));
  },
};

const opts = {
  entryPoints: { readingroom: 'src/index.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  legalComments: 'none',
  plugins: [cssPlugin],
  logLevel: 'warning',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
