// Client build with Bun: dist/reviewroom.js (+ lazy chunks, mostly syntax grammars), dist/reviewroom.css,
// dist/fonts/, dist/emoji.json, the hub's page (dist/hub.js, dist/hub.css), and the CLI with its dependencies bundled in: dist/cli/reviewroom.js. `bun scripts/build.ts --watch` rebuilds on change. build-demo.ts reuses clientBuild().
import type { BunPlugin } from 'bun';
import { readFileSync, realpathSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync, watch } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const at = (p: string) => root + p;

// Each group preserves one original stylesheet byte for byte. Fragments within a group
// must stay interleaved: regrouping them by owner would change the cascade.
const shellStyles = [
  'src/kernel/styles/shell.css',
  'src/threads/styles/feedback-status.css',
  'src/review/styles/selection-cursor.css',
  'src/kernel/styles/buttons.css',
  'src/threads/styles/feedback-buttons.css',
  'src/kernel/styles/controls.css',
];

const panelsStyles = [
  'src/review/styles/panel-surfaces.css',
  'src/kernel/styles/panels.css',
  'src/threads/styles/conversation-button.css',
  'src/kernel/styles/side-head.css',
  'src/threads/styles/filter-author.css',
  'src/review/styles/sidebar.css',
  'src/review/styles/files.css',
  'src/review/styles/toc.css',
  'src/threads/styles/list.css',
  'src/review/styles/chip-icon.css',
  'src/review/styles/code.css',
  'src/threads/styles/inline.css',
  'src/review/styles/walkthrough.css',
  'src/threads/styles/rail.css',
  'src/review/styles/selection.css',
  'src/threads/styles/panel.css',
  'src/review/styles/responsive-panels.css',
  'src/threads/styles/ci.css',
  'src/review/styles/description.css',
  'src/threads/styles/markers.css',
  'src/kernel/styles/slot.css',
];

const overlaysStyles = [
  'src/kernel/styles/dialogs.css',
  'src/threads/styles/thread.css',
  'src/threads/styles/composer.css',
  'src/review/styles/references.css',
  'src/threads/styles/embeds.css',
  'src/review/styles/snippet.css',
  'src/review/styles/palette.css',
  'src/kernel/styles/menus.css',
  'src/review/styles/hover.css',
  'src/kernel/styles/toasts.css',
  'src/kernel/styles/tooltips.css',
  'src/threads/styles/composer-editor.css',
];

const styles = [
  ['src/kernel/styles/tokens.css'],
  shellStyles,
  panelsStyles,
  overlaysStyles,
  ['src/slides/styles/slides.css'],
  ['src/review/styles/content.css'],
  ['src/kernel/styles/dockview.css'],
];

// Hub cascade: tokens, shell controls, overlays, then hub-specific rules.
const hubStyles = [
  ['src/kernel/styles/tokens.css'],
  shellStyles,
  overlaysStyles,
  ['src/hub/styles/hub.css'],
];

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

const sheet = (path: string) => `/* ${path} */\n` + readFileSync(at(path), 'utf8');
const sheets = (groups: string[][]) => groups.map((group) => group.map(sheet).join('')).join('\n');

/** The hub's page (src/hub/): the shared tokens and controls, without the review's panels. */
const hubCss = () => [fontFaces((_pkg, file) => `./fonts/${file}`), sheets(hubStyles)].join('\n');

/** All client CSS. `fontSrc(pkg, file)` says where each font is served from. */
export const clientCss = (fontSrc: FontSrc) => [fontFaces(fontSrc), dockviewCss(), sheets(styles)].join('\n');

/** Bundle the client. The CSS is inlined into the JS (src/bundle.css exists only in the build) and injected at boot. */
export function clientBuild({ css, plugins = [], ...opts }: { css: string; plugins?: BunPlugin[] } & Omit<Bun.BuildConfig, 'entrypoints' | 'plugins'>) {
  return Bun.build({
    entrypoints: [at('src/main.ts')],
    format: 'esm',
    target: 'browser',
    minify: true,
    files: { [realpathSync(at('src')) + '/bundle.css']: css },
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
  writeFileSync(at('dist/reviewroom.css'), clientCss((_pkg, file) => `./fonts/${file}`));
  // __RR_FONTS__ is resolved at runtime against the script's own URL (injectCSS in src/main.ts)
  const res = await clientBuild({
    css: clientCss((_pkg, file) => `__RR_FONTS__/${file}`),
    outdir: at('dist'),
    splitting: true,
    sourcemap: 'linked',
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
