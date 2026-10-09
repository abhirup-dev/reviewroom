// Build: one ESM entry (with code-split chunks for shiki languages) + one CSS file.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const cssFiles = ['dockview-base', 'tokens', 'shell', 'panels', 'overlays', 'content', 'dockview'];

// dockview ships its stylesheet inside the UMD bundle; lift it out so it can be themed.
{
  const line = readFileSync('node_modules/dockview-core/dist/dockview-core.js', 'utf8').split('\n').find((l) => l.includes('s.textContent = ".dv-'));
  if (line) writeFileSync('src/styles/dockview-base.css', JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1)));
}
function buildCss() {
  const css = cssFiles.map((f) => `/* ${f}.css */\n` + readFileSync(`src/styles/${f}.css`, 'utf8')).join('\n');
  writeFileSync('dist/readingroom.css', css);
  return css;
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
