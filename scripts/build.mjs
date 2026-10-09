// Client build with Bun: dist/readingroom.js (+ lazy chunks, mostly syntax grammars), dist/readingroom.css,
// dist/fonts/. `bun scripts/build.mjs --watch` rebuilds on change. build-demo.mjs reuses clientBuild().
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, watch } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const at = (p) => root + p;

const styles = ['tokens', 'shell', 'panels', 'overlays', 'content', 'dockview'];

// dockview only ships its stylesheet inside its UMD bundle; lift it out so it can be themed (and ordered first).
function dockviewCss() {
  const line = readFileSync(at('node_modules/dockview-core/dist/dockview-core.js'), 'utf8').split('\n').find((l) => l.includes('s.textContent = ".dv-'));
  if (!line) throw new Error('dockview stylesheet not found in dockview-core.js: the extraction in scripts/build.mjs needs updating');
  return JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1));
}

// Fonts ship with the tool (latin, variable) so typography never depends on the network.
// [family, package, file, style]
export const fonts = [
  ['Inter', 'inter', 'inter-latin-opsz-normal.woff2', 'normal'],
  ['Inter', 'inter', 'inter-latin-opsz-italic.woff2', 'italic'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-normal.woff2', 'normal'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-italic.woff2', 'italic'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2', 'normal'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-italic.woff2', 'italic'],
];
export const fontFile = (pkg, file) => at(`node_modules/@fontsource-variable/${pkg}/files/${file}`);
const fontFaces = (src) =>
  fonts.map(([family, pkg, file, style]) => `@font-face{font-family:'${family}';font-style:${style};font-weight:100 900;font-display:swap;src:url(${src(pkg, file)}) format('woff2');}`).join('\n');

/** All client CSS. `fontSrc(pkg, file)` says where each font is served from. */
export const clientCss = (fontSrc) => [fontFaces(fontSrc), dockviewCss(), ...styles.map((f) => `/* ${f}.css */\n` + readFileSync(at(`src/styles/${f}.css`), 'utf8'))].join('\n');

const virtual = (name, contents) => ({
  name,
  setup(b) {
    b.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: name, namespace: 'rr' }));
    b.onLoad({ filter: /.*/, namespace: 'rr' }, () => ({ contents, loader: 'js' }));
  },
});

/** Bundle the client. The CSS is inlined into the JS (virtual:rr-css) and injected at boot. */
export function clientBuild({ css, plugins = [], ...opts }) {
  return Bun.build({
    entrypoints: [at('src/index.ts')],
    format: 'esm',
    target: 'browser',
    minify: true,
    plugins: [virtual('virtual:rr-css', `export default ${JSON.stringify(css)};`), ...plugins],
    ...opts,
  });
}

async function build() {
  const t = performance.now();
  rmSync(at('dist'), { recursive: true, force: true });
  mkdirSync(at('dist/fonts'), { recursive: true });
  for (const [, pkg, file] of fonts) copyFileSync(fontFile(pkg, file), at(`dist/fonts/${file}`));
  writeFileSync(at('dist/readingroom.css'), clientCss((_, file) => `./fonts/${file}`));
  // __RR_FONTS__ is resolved at runtime against the script's own URL (injectCSS in src/index.ts)
  const res = await clientBuild({
    css: clientCss((_, file) => `__RR_FONTS__/${file}`),
    outdir: at('dist'),
    splitting: true,
    sourcemap: 'linked',
    naming: { entry: 'readingroom.[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
  });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    throw new Error('build failed');
  }
  console.log(`built dist/ in ${Math.round(performance.now() - t)}ms`);
}

if (import.meta.main) {
  await build();
  if (process.argv.includes('--watch')) {
    let timer;
    watch(at('src'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(e.message)), 80);
    });
    console.log('watching src/ …');
  }
}
