import { spawnSync } from 'bun';
/** Bundle a self-contained worker into the lazy Markdown chunk, including standalone exports. */
export function markdownWorkerSource(): string {
  const result = spawnSync([process.execPath, 'build', new URL('../src/markdown/worker.ts', import.meta.url).pathname, '--target=browser', '--minify']);
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}
