// Client build with Bun: dist/reviewroom.js (+ lazy chunks, mostly syntax grammars), dist/reviewroom.css,
// dist/fonts/, dist/emoji.json, and the CLI with its dependencies bundled in: dist/cli/reviewroom.mjs. `bun scripts/build.ts --watch` rebuilds on change. build-demo.ts reuses clientBuild().
import type { BunPlugin } from 'bun';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync, watch } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const at = (p: string) => root + p;

const styles = ['tokens', 'shell', 'panels', 'overlays', 'content', 'dockview'];

// dockview only ships its stylesheet inside its UMD bundle; lift it out so it can be themed (and ordered first).
function dockviewCss() {
  const line = readFileSync(at('node_modules/dockview-core/dist/dockview-core.js'), 'utf8').split('\n').find((l) => l.includes('s.textContent = ".dv-'));
  if (!line) throw new Error('dockview stylesheet not found in dockview-core.js: the extraction in scripts/build.ts needs updating');
  return JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1));
}

// Fonts ship with the tool (latin, variable) so typography never depends on the network.
// [family, package, file, style]
export const fonts: [family: string, pkg: string, file: string, style: string][] = [
  ['Inter', 'inter', 'inter-latin-opsz-normal.woff2', 'normal'],
  ['Inter', 'inter', 'inter-latin-opsz-italic.woff2', 'italic'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-normal.woff2', 'normal'],
  ['Source Serif 4', 'source-serif-4', 'source-serif-4-latin-opsz-italic.woff2', 'italic'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2', 'normal'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-wght-italic.woff2', 'italic'],
];
export const fontFile = (pkg: string, file: string) => at(`node_modules/@fontsource-variable/${pkg}/files/${file}`);
type FontSrc = (pkg: string, file: string) => string;
const fontFaces = (src: FontSrc) =>
  fonts.map(([family, pkg, file, style]) => `@font-face{font-family:'${family}';font-style:${style};font-weight:100 900;font-display:swap;src:url(${src(pkg, file)}) format('woff2');}`).join('\n');

/** All client CSS. `fontSrc(pkg, file)` says where each font is served from. */
export const clientCss = (fontSrc: FontSrc) => [fontFaces(fontSrc), dockviewCss(), ...styles.map((f) => `/* ${f}.css */\n` + readFileSync(at(`src/styles/${f}.css`), 'utf8'))].join('\n');

const virtual = (name: string, contents: string): BunPlugin => ({
  name,
  setup(b) {
    b.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: name, namespace: 'rr' }));
    b.onLoad({ filter: /.*/, namespace: 'rr' }, () => ({ contents, loader: 'js' }));
  },
});

/** Bundle the client. The CSS is inlined into the JS (virtual:rr-css) and injected at boot. */
export function clientBuild({ css, plugins = [], ...opts }: { css: string; plugins?: BunPlugin[] } & Omit<Bun.BuildConfig, 'entrypoints' | 'plugins'>) {
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
  // the composer's emoji picker reads its data from here (its default is a CDN); GitHub's shortcodes for search
  copyFileSync(at('node_modules/emoji-picker-element-data/en/github/data.json'), at('dist/emoji.json'));
  writeFileSync(at('dist/reviewroom.css'), clientCss((_pkg, file) => `./fonts/${file}`));
  // __RR_FONTS__ is resolved at runtime against the script's own URL (injectCSS in src/index.ts)
  const res = await clientBuild({
    css: clientCss((_pkg, file) => `__RR_FONTS__/${file}`),
    outdir: at('dist'),
    splitting: true,
    sourcemap: 'linked',
    naming: { entry: 'reviewroom.[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
  });
  // dist/cli/ sits as deep as cli/lib/, so the CLI's `../..` package-root lookup holds in both
  const cli = await Bun.build({ entrypoints: [at('cli/reviewroom.ts')], target: 'node', format: 'esm', outdir: at('dist/cli'), naming: '[name].mjs' });
  for (const r of [res, cli]) {
    if (r.success) continue;
    for (const log of r.logs) console.error(log);
    throw new Error('build failed');
  }
  chmodSync(at('dist/cli/reviewroom.mjs'), 0o755);
  console.log(`built dist/ in ${Math.round(performance.now() - t)}ms`);
}

if (import.meta.main) {
  await build();
  if (process.argv.includes('--watch')) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(e.message)), 80);
    };
    watch(at('src'), { recursive: true }, rebuild);
    watch(at('cli'), { recursive: true }, rebuild);
    console.log('watching src/ and cli/ ...');
  }
}
