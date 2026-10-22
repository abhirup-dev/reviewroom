// Client build with Bun: dist/reviewroom.js (+ lazy chunks, mostly syntax grammars), dist/reviewroom.css,
// dist/fonts/, dist/emoji.json, the hub's page (dist/hub.js, dist/hub.css), and the CLI with its dependencies bundled in: dist/cli/reviewroom.js. `bun scripts/build.ts --watch` rebuilds on change. build-demo.ts reuses clientBuild().
import type { BunPlugin } from 'bun';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync, watch } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const at = (p: string) => root + p;

const styles = ['tokens', 'shell', 'panels', 'overlays', 'walkthrough', 'content', 'dockview', 'phone'];

const dockviewCss = () => readFileSync(at('node_modules/dockview/dist/styles/dockview.css'), 'utf8');

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

const sheet = (f: string) => `/* ${f}.css */\n` + readFileSync(at(`src/styles/${f}.css`), 'utf8');

/** The hub's page (src/hub/): the shared tokens and controls, without the review's panels. */
const hubCss = () => [fontFaces((_pkg, file) => `./fonts/${file}`), ...['tokens', 'shell', 'overlays', 'hub'].map(sheet)].join('\n');

/** All client CSS. `fontSrc(pkg, file)` says where each font is served from. */
export const clientCss = (fontSrc: FontSrc) => [fontFaces(fontSrc), dockviewCss(), ...styles.map(sheet)].join('\n');

// The id hashes the client output, so the client is built with a same-length stand-in (keeps source maps aligned) swapped for the id after.
const BUILD_PLACEHOLDER = 'rr-build-id!';

/** Bundle the client. The CSS is inlined into the JS (src/styles/bundle.css exists only in the build) and injected at boot. */
export function clientBuild({ css, plugins = [], ...opts }: { css: string; plugins?: BunPlugin[] } & Omit<Bun.BuildConfig, 'entrypoints' | 'plugins'>) {
  return Bun.build({
    entrypoints: [at('src/index.ts')],
    format: 'esm',
    target: 'browser',
    minify: true,
    files: { [realpathSync(at('src/styles')) + '/bundle.css']: css },
    define: { __RR_BUILD__: JSON.stringify(BUILD_PLACEHOLDER) },
    plugins,
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
  // the web app manifest (served at the hub root) and its icons. Its start_url and scope stay ./ and it has no id:
  // changing either orphans installed Home Screen icons
  for (const f of readdirSync(at('src/pwa'))) copyFileSync(at(`src/pwa/${f}`), at(`dist/${f}`));
  writeFileSync(at('dist/reviewroom.css'), clientCss((_pkg, file) => `./fonts/${file}`));
  // __RR_FONTS__ is resolved at runtime against the script's own URL (injectCSS in src/index.ts)
  const res = await clientBuild({
    css: clientCss((_pkg, file) => `__RR_FONTS__/${file}`),
    outdir: at('dist'),
    splitting: true,
    sourcemap: 'linked',
    metafile: true,
    naming: { entry: 'reviewroom.[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
  });
  writeFileSync(at('dist/hub.css'), hubCss());
  const hub = await Bun.build({ entrypoints: [at('src/hub/index.ts')], format: 'esm', target: 'browser', minify: true, outdir: at('dist'), naming: 'hub.[ext]' });
  // dist/cli/ sits as deep as cli/lib/, so the CLI's `../..` package-root lookup holds in both
  const cli = await Bun.build({ entrypoints: [at('cli/reviewroom.ts')], target: 'bun', format: 'esm', outdir: at('dist/cli'), naming: '[name].js' });
  for (const r of [res, hub, cli]) {
    if (r.success) continue;
    for (const log of r.logs) console.error(log);
    throw new Error('build failed');
  }
  chmodSync(at('dist/cli/reviewroom.js'), 0o755);
  await buildWorker(staticImports(res.metafile!, './reviewroom.js'));
  console.log(`built dist/ in ${Math.round(performance.now() - t)}ms`);
}

/**
 * The chunks `entry` loads before it runs (its static imports, transitively), as dist/-relative paths.
 */
function staticImports(meta: NonNullable<Bun.BuildOutput['metafile']>, entry: string) {
  const seen = new Set<string>();
  const walk = (out: string) => {
    for (const i of meta.outputs[out]?.imports ?? []) {
      if (i.kind !== 'import-statement' || seen.has(i.path)) continue;
      seen.add(i.path);
      walk(i.path);
    }
  };
  walk(entry);
  return new Set([...seen].map((p) => p.replace(/^\.\//, '')));
}

/**
 * The build id (a hash of the client's files), dist/build-info.json, and dist/sw.js with the id and precache list baked in.
 * The worker precaches the app shell: entries, CSS, fonts and the chunks the entry imports statically. The lazy chunks
 * (~900, mostly syntax grammars) and emoji.json (~0.4MB, only the emoji picker reads it) are cached at runtime.
 */
async function buildWorker(shellChunks: Set<string>) {
  const skip = /^(cli\/|sw\.js$|build-info\.json$|emoji\.json$|manifest\.webmanifest$)|\.map$/;
  const files = readdirSync(at('dist'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath}/${e.name}`.slice(at('dist/').length))
    .filter((f) => !skip.test(f))
    .sort();
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f + '\0').update(readFileSync(at(`dist/${f}`)));
  const id = h.digest('hex').slice(0, 12);
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    const js = readFileSync(at(`dist/${f}`), 'utf8');
    if (js.includes(BUILD_PLACEHOLDER)) writeFileSync(at(`dist/${f}`), js.replaceAll(BUILD_PLACEHOLDER, id));
  }
  writeFileSync(at('dist/build-info.json'), JSON.stringify({ id }) + '\n');
  const sw = await Bun.build({
    entrypoints: [at('src/sw.ts')],
    target: 'browser',
    minify: true,
    define: { __RR_BUILD__: JSON.stringify(id), __RR_PRECACHE__: JSON.stringify(files.filter((f) => !f.startsWith('chunks/') || shellChunks.has(f)).map((f) => `/_rr/${f}`)) },
    outdir: at('dist'),
    naming: 'sw.js',
  });
  if (!sw.success) {
    for (const log of sw.logs) console.error(log);
    throw new Error('build failed');
  }
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
