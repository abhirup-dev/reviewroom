import type { BunPlugin } from 'bun';
import { bundledLanguagesInfo } from 'shiki/langs';

/** A single-file build needs some grammars, but Shiki's full lazy registry is much larger than the player. */
export function stubShiki(languages: readonly string[]): BunPlugin {
  const keep = new Set(languages);
  const aliases = new Map(bundledLanguagesInfo.map(({ id, aliases }) => [id, aliases]));
  return {
    name: 'stub-shiki',
    setup(build) {
      build.onResolve({ filter: /^@shikijs\/(langs|themes)\/[\w-]+$/ }, ({ path }) => {
        const [, kind, name] = /^@shikijs\/(langs|themes)\/([\w-]+)$/.exec(path)!;
        if (kind === 'langs' && keep.has(name)) return undefined;
        return { path: name, namespace: kind === 'langs' ? 'plain-grammar' : 'stub-theme' };
      });
      // Pierre requires each registered language (including aliases) to resolve to a grammar.
      build.onLoad({ filter: /.*/, namespace: 'plain-grammar' }, ({ path: name }) => ({
        contents: 'export default ' + JSON.stringify([{ name, aliases: aliases.get(name), scopeName: `text.rr-${name}`, patterns: [] }]),
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'stub-theme' }, () => ({ contents: 'export default []', loader: 'js' }));
    },
  };
}
