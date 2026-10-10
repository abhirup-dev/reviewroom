import fs from 'node:fs';
import path from 'node:path';
import { die } from '../lib/args.mjs';
import { ensureExcluded } from '../lib/git.mjs';
import { resolveDir, loadConfig } from '../lib/state.mjs';
import { scaffold } from '../lib/scaffold.mjs';

export function cmdInit(repo) {
  if (!repo) die('not inside a git repository');
  const dir = resolveDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir, repo);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  if (!scaffold(repo, dir, cfg)) console.error(`reviewroom: ${path.join(dir, 'review.html')} exists (use --force to overwrite)`);
  ensureExcluded(repo);
  console.log(dir);
}
