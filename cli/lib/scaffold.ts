import fs from 'node:fs';
import path from 'node:path';
import { makeProvider, type ReviewConfig } from './git.ts';
import { PKG } from './paths.ts';

export function scaffold(repo: string, dir: string, cfg: ReviewConfig, force = false) {
  const target = path.join(dir, 'review.html');
  if (fs.existsSync(target) && !force) return false;
  const prov = makeProvider(repo, cfg);
  const meta = prov.meta();
  const files = prov.files(prov.base, prov.head);
  let html = fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const list = files.map((f) => `          <li><rr-ref ref="rr:code/${esc(f.path)}"></rr-ref> - ${f.status}, +${f.additions} -${f.deletions}</li>`).join('\n');
  // function replacers: `$&`, `$'` in titles/paths must stay literal
  html = html.replaceAll('{{TITLE}}', () => esc(meta.title)).replace('{{FILES}}', () => list);
  fs.writeFileSync(target, html);
  return true;
}
