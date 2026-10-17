// `bun run demo-stack`: a live review of a stack of three PRs, without GitHub. examples/make-stack-repo.sh builds the
// repo (stack-1 squash-merged into main); the review's config.json gets the stack `reviewroom pr <n>` would detect.
//
//   bun scripts/demo-stack.ts [<dir> [pr options...]]   (default .demo/stack)
import { $ } from 'bun';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const at = path.resolve(process.argv[2] ?? path.join(root, '.demo', 'stack'));
const repo = path.join(at, 'repo');
const dir = path.join(at, 'review');
await $`bash ${path.join(root, 'examples', 'make-stack-repo.sh')} ${repo} --squashed`;
fs.mkdirSync(dir, { recursive: true });
const titles = ['store: Put and Delete', 'cache: a read-through cache over the store', 'cache: Forget; a missing key reads as ""'];
const prs = titles.map((title, i) => ({ number: i + 1, title, state: i ? 'open' : 'merged', headLabel: `stack-${i + 1}`, head: `stack-${i + 1}` }));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ repoPath: repo, base: 'main', head: 'stack-3', number: 2, title: titles[1], stack: { id: 1, source: 'chain', base: 'main', prs } }, null, 2));
await $`bun ${path.join(root, 'dist', 'cli', 'reviewroom.js')} pr --repo ${repo} --dir ${dir} ${process.argv.slice(3)}`;
